//! SQLite-backed job state and conservative resource admission.
//!
//! A claim is a reservation, not proof that a worker or provider started. The
//! desktop coordinator owns process handles, artifact validation, and completion
//! events. This crate never starts generated code or contacts a provider.

use anyhow::{anyhow, bail, Context, Result};
use asset_core::models::{Job, JobProgress, JobResource, JobStatus};
use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

mod events;
pub use events::{EventPage, ExternalJobIdentity, JobEvent, JobEventKind, JobsPage, MAX_PAGE_SIZE};

pub const QUEUE_CAPACITY: usize = 512;
pub const MAX_QUEUE_CAPACITY: usize = 4096;
const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
const MAX_TRANSIENT_RETRIES: u32 = 3;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLimits {
    pub cpu_jobs: usize,
    pub blender_jobs: usize,
    pub external_jobs: usize,
    pub ram_mb: u64,
    pub gpu_mb: u64,
    pub cpu_threads: u32,
    pub disk_weight: u32,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            cpu_jobs: 2,
            blender_jobs: 1,
            external_jobs: 1,
            ram_mb: 2048,
            gpu_mb: 0,
            cpu_threads: 2,
            disk_weight: 2,
        }
    }
}

/// Only transient, definitely unsubmitted work is retried automatically.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    Network,
    RateLimit,
    Authentication,
    Permission,
    Unsupported,
    Input,
    Worker,
    ExternalResultUnknown,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUsage {
    pub cpu_jobs: usize,
    pub blender_jobs: usize,
    pub external_jobs: usize,
    pub ram_mb: u64,
    pub gpu_mb: u64,
    pub cpu_threads: u32,
    pub disk_weight: u32,
}

#[derive(Clone, Debug)]
struct StoredJob {
    sequence: i64,
    available_at_ms: i64,
    job: Job,
    original_digest: Option<[u8; 32]>,
    original_available_at_ms: i64,
    original_status: JobStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerOptions {
    pub queue_capacity: usize,
}
impl Default for SchedulerOptions {
    fn default() -> Self {
        Self {
            queue_capacity: QUEUE_CAPACITY,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueReceipt {
    pub job_id: String,
    pub replayed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueBatchReceipt {
    pub job_ids: Vec<String>,
    pub replayed: bool,
}

#[derive(Clone, Debug)]
struct ResourceRequest {
    ram_mb: u64,
    gpu_mb: u64,
    cpu_threads: u32,
    disk_weight: u32,
}

impl ResourceRequest {
    fn for_job(job: &Job) -> Result<Self> {
        let defaults = match job.resource {
            JobResource::Cpu => Self {
                ram_mb: 256,
                gpu_mb: 0,
                cpu_threads: 1,
                disk_weight: 1,
            },
            JobResource::Blender => Self {
                ram_mb: 1024,
                gpu_mb: 0,
                cpu_threads: 2,
                disk_weight: 1,
            },
            JobResource::External => Self {
                ram_mb: 64,
                gpu_mb: 0,
                cpu_threads: 0,
                disk_weight: 0,
            },
        };
        let Some(value) = job.payload.get("resources") else {
            return Ok(defaults);
        };
        let object = value
            .as_object()
            .context("payload.resources must be an object")?;
        let number = |key: &str, fallback: u64| -> Result<u64> {
            match object.get(key) {
                None => Ok(fallback),
                Some(value) => value
                    .as_u64()
                    .with_context(|| format!("resources.{key} must be a nonnegative integer")),
            }
        };
        let request = Self {
            ram_mb: number("ramMb", defaults.ram_mb)?,
            gpu_mb: number("gpuMb", defaults.gpu_mb)?,
            cpu_threads: u32::try_from(number("cpuThreads", u64::from(defaults.cpu_threads))?)
                .context("resources.cpuThreads is too large")?,
            disk_weight: u32::try_from(number("diskWeight", u64::from(defaults.disk_weight))?)
                .context("resources.diskWeight is too large")?,
        };
        if request.ram_mb == 0 {
            bail!("resources.ramMb must reserve at least 1 MB");
        }
        if job.resource != JobResource::External && request.cpu_threads == 0 {
            bail!("local jobs must reserve at least one CPU thread");
        }
        Ok(request)
    }
}

impl ResourceUsage {
    fn reserve(&mut self, resource: &JobResource, request: &ResourceRequest) {
        match resource {
            JobResource::Cpu => self.cpu_jobs = self.cpu_jobs.saturating_add(1),
            JobResource::Blender => self.blender_jobs = self.blender_jobs.saturating_add(1),
            JobResource::External => self.external_jobs = self.external_jobs.saturating_add(1),
        }
        self.ram_mb = self.ram_mb.saturating_add(request.ram_mb);
        self.gpu_mb = self.gpu_mb.saturating_add(request.gpu_mb);
        self.cpu_threads = self.cpu_threads.saturating_add(request.cpu_threads);
        self.disk_weight = self.disk_weight.saturating_add(request.disk_weight);
    }

    fn fits(
        &self,
        resource: &JobResource,
        request: &ResourceRequest,
        limits: &ResourceLimits,
    ) -> bool {
        let slot = match resource {
            JobResource::Cpu => self.cpu_jobs < limits.cpu_jobs,
            JobResource::Blender => self.blender_jobs < limits.blender_jobs,
            JobResource::External => self.external_jobs < limits.external_jobs,
        };
        slot && self
            .ram_mb
            .checked_add(request.ram_mb)
            .is_some_and(|n| n <= limits.ram_mb)
            && self
                .gpu_mb
                .checked_add(request.gpu_mb)
                .is_some_and(|n| n <= limits.gpu_mb)
            && self
                .cpu_threads
                .checked_add(request.cpu_threads)
                .is_some_and(|n| n <= limits.cpu_threads)
            && self
                .disk_weight
                .checked_add(request.disk_weight)
                .is_some_and(|n| n <= limits.disk_weight)
    }
}

/// Resource barriers reserve scarce capacity for the oldest waiting job. Later
/// jobs on disjoint resources still run, without starving a larger old request.
#[derive(Default)]
struct FairnessBarrier {
    cpu: bool,
    blender: bool,
    external: bool,
    ram: bool,
    gpu: bool,
    threads: bool,
    disk: bool,
}

impl FairnessBarrier {
    fn conflicts(&self, resource: &JobResource, request: &ResourceRequest) -> bool {
        match resource {
            JobResource::Cpu if self.cpu => return true,
            JobResource::Blender if self.blender => return true,
            JobResource::External if self.external => return true,
            _ => {}
        }
        (self.ram && request.ram_mb > 0)
            || (self.gpu && request.gpu_mb > 0)
            || (self.threads && request.cpu_threads > 0)
            || (self.disk && request.disk_weight > 0)
    }

    fn reserve_scarce(
        &mut self,
        resource: &JobResource,
        request: &ResourceRequest,
        used: &ResourceUsage,
        limits: &ResourceLimits,
    ) {
        match resource {
            JobResource::Cpu if used.cpu_jobs >= limits.cpu_jobs => self.cpu = true,
            JobResource::Blender if used.blender_jobs >= limits.blender_jobs => self.blender = true,
            JobResource::External if used.external_jobs >= limits.external_jobs => {
                self.external = true
            }
            _ => {}
        }
        self.ram |= used.ram_mb.saturating_add(request.ram_mb) > limits.ram_mb;
        self.gpu |= used.gpu_mb.saturating_add(request.gpu_mb) > limits.gpu_mb;
        self.threads |= used.cpu_threads.saturating_add(request.cpu_threads) > limits.cpu_threads;
        self.disk |= used.disk_weight.saturating_add(request.disk_weight) > limits.disk_weight;
    }
}

pub struct SchedulerStore {
    connection: Mutex<Connection>,
}

impl SchedulerStore {
    /// The scheduler may share a project SQLite file: its tables are namespaced
    /// and do not change another module's `user_version`.
    pub fn open(path: &Path) -> Result<Self> {
        if path != Path::new(":memory:") {
            if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                std::fs::create_dir_all(parent).context("create scheduler database directory")?;
            }
        }
        let mut connection = Connection::open(path).context("open scheduler database")?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS scheduler_metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
             INSERT OR IGNORE INTO scheduler_metadata(key,value) VALUES ('schema_version',1);",
        )?;
        let version: i64 = tx.query_row(
            "SELECT value FROM scheduler_metadata WHERE key='schema_version'",
            [],
            |r| r.get(0),
        )?;
        if version != 1 && version != 2 {
            bail!("unsupported scheduler schema version {version}; database was preserved");
        }
        tx.execute_batch(
            "
             CREATE TABLE IF NOT EXISTS scheduler_jobs (
                 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                 id TEXT NOT NULL UNIQUE,
                 status TEXT NOT NULL,
                 resource TEXT NOT NULL,
                 available_at_ms INTEGER NOT NULL DEFAULT 0,
                 document TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS scheduler_jobs_state ON scheduler_jobs(status, sequence);
             CREATE TABLE IF NOT EXISTS scheduler_events (
                 cursor INTEGER PRIMARY KEY AUTOINCREMENT,
                 job_id TEXT NOT NULL,
                 document TEXT NOT NULL CHECK(length(document)<=4096)
             );
             CREATE INDEX IF NOT EXISTS scheduler_events_job ON scheduler_events(job_id,cursor);
             CREATE TABLE IF NOT EXISTS scheduler_requests (
                 request_id TEXT PRIMARY KEY,
                 fingerprint TEXT NOT NULL,
                 job_ids TEXT NOT NULL
             );
             INSERT OR IGNORE INTO scheduler_metadata(key,value) VALUES ('queue_capacity',512);",
        )?;
        if version == 1 {
            for stored in load_jobs(&tx)? {
                events::append_event(&tx, &stored.job, JobEventKind::Snapshot, None)?;
            }
            tx.execute(
                "UPDATE scheduler_metadata SET value=2 WHERE key='schema_version'",
                [],
            )?;
        }
        read_capacity(&tx)?;
        tx.commit()?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// Persists an explicit admission setting. Ordinary open() preserves it.
    pub fn open_with_options(path: &Path, options: &SchedulerOptions) -> Result<Self> {
        check_capacity(options.queue_capacity)?;
        let store = Self::open(path)?;
        store.set_queue_capacity(options.queue_capacity)?;
        Ok(store)
    }

    pub fn queue_capacity(&self) -> Result<usize> {
        let connection = self.connection()?;
        read_capacity(&connection)
    }

    pub fn set_queue_capacity(&self, capacity: usize) -> Result<()> {
        check_capacity(capacity)?;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if load_jobs(&tx)?
            .iter()
            .filter(|j| is_active_job(&j.job))
            .count()
            > capacity
        {
            bail!("cannot reduce queue capacity below currently active work");
        }
        tx.execute(
            "UPDATE scheduler_metadata SET value=?1 WHERE key='queue_capacity'",
            [capacity as i64],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn events_after(&self, cursor: u64, limit: usize) -> Result<EventPage> {
        let connection = self.connection()?;
        events::events_after(&connection, cursor, limit)
    }

    /// Keyset pagination by immutable enqueue sequence. Status changes do not
    /// move an item between pages; cursor=0 starts at the oldest job.
    pub fn jobs_page(&self, after_sequence: u64, limit: usize) -> Result<JobsPage> {
        let (after, fetch) = events::checked_page(after_sequence, limit)?;
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT sequence,available_at_ms,document,id,status,resource FROM scheduler_jobs WHERE sequence>?1 ORDER BY sequence LIMIT ?2")?;
        let mut jobs = statement
            .query_map(params![after, fetch], persisted_row)?
            .map(|row| decode_stored(row?))
            .collect::<Result<Vec<_>>>()?;
        let has_more = jobs.len() > limit;
        jobs.truncate(limit);
        let next_cursor = jobs
            .last()
            .map(|j| j.sequence as u64)
            .unwrap_or(after_sequence);
        Ok(JobsPage {
            jobs: jobs.into_iter().map(|j| j.job).collect(),
            next_cursor,
            has_more,
        })
    }

    /// A request identity deduplicates one user action, independently of cache
    /// reuse. New variations use new request ids; conflicting intent is rejected.
    pub fn enqueue_once(&self, request_id: &str, job: Job) -> Result<EnqueueReceipt> {
        let receipt = self.enqueue_many_once(request_id, vec![job])?;
        Ok(EnqueueReceipt {
            job_id: receipt.job_ids[0].clone(),
            replayed: receipt.replayed,
        })
    }

    /// Retries one whole action atomically, even if the response was lost. A
    /// replay returns the original ordered ids without reserving more capacity.
    pub fn enqueue_many_once(
        &self,
        request_id: &str,
        jobs: Vec<Job>,
    ) -> Result<EnqueueBatchReceipt> {
        if !valid_external_id(request_id) {
            bail!("request id must be 1..256 safe identifier bytes");
        }
        if jobs.is_empty() || jobs.len() > MAX_QUEUE_CAPACITY {
            bail!("idempotent batch must contain 1..={MAX_QUEUE_CAPACITY} jobs");
        }
        for job in &jobs {
            validate_new_job(job)?;
        }
        let fingerprint = intent_fingerprint(&jobs)?;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        use rusqlite::OptionalExtension;
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT fingerprint,job_ids FROM scheduler_requests WHERE request_id=?1",
                [request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((previous, document)) = existing {
            if previous != fingerprint {
                bail!("request id already belongs to a different job intent");
            }
            let job_ids: Vec<String> = serde_json::from_str(&document)
                .context("decode original idempotent batch receipt")?;
            if job_ids.len() != jobs.len() {
                bail!("idempotent receipt is inconsistent; database was preserved");
            }
            tx.commit()?;
            return Ok(EnqueueBatchReceipt {
                job_ids,
                replayed: true,
            });
        }
        let job_ids: Vec<_> = jobs.iter().map(|job| job.id.clone()).collect();
        enqueue_in_transaction(&tx, jobs, read_capacity(&tx)?)?;
        tx.execute(
            "INSERT INTO scheduler_requests(request_id,fingerprint,job_ids) VALUES (?1,?2,?3)",
            params![request_id, fingerprint, serde_json::to_string(&job_ids)?],
        )?;
        tx.commit()?;
        Ok(EnqueueBatchReceipt {
            job_ids,
            replayed: false,
        })
    }

    fn connection(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| anyhow!("scheduler database lock was poisoned"))
    }

    pub fn enqueue(&self, job: Job) -> Result<()> {
        self.enqueue_many(vec![job])
    }

    /// Atomic graph insertion also accepts dependencies among the incoming jobs.
    /// Single-job insertion requires all dependencies to already exist.
    pub fn enqueue_many(&self, jobs: Vec<Job>) -> Result<()> {
        if jobs.is_empty() {
            return Ok(());
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        enqueue_in_transaction(&tx, jobs, read_capacity(&tx)?)?;
        tx.commit()?;
        Ok(())
    }

    pub fn jobs(&self) -> Result<Vec<Job>> {
        let connection = self.connection()?;
        Ok(load_jobs(&connection)?.into_iter().map(|j| j.job).collect())
    }
}

fn enqueue_in_transaction(tx: &Connection, jobs: Vec<Job>, capacity: usize) -> Result<()> {
    let mut all = load_jobs(tx)?;
    let active = all.iter().filter(|j| is_active_job(&j.job)).count();
    if active.saturating_add(jobs.len()) > capacity {
        bail!("job queue capacity is {capacity}; finish or cancel queued jobs first");
    }
    let mut ids: HashSet<String> = all.iter().map(|j| j.job.id.clone()).collect();
    let now = now_text();
    for mut job in jobs {
        validate_new_job(&job)?;
        if !ids.insert(job.id.clone()) {
            bail!("duplicate job id {}", job.id)
        }
        job.status = JobStatus::Pending;
        job.attempts = 0;
        job.started_at = None;
        job.finished_at = None;
        job.error = None;
        if job.created_at.is_empty() {
            job.created_at = now.clone();
        }
        job.progress = progress("queued");
        job.payload.remove("executionId");
        job.payload.remove("externalSubmitted");
        job.payload.remove("cancellationAwaitingWorker");
        clear_external_identity(&mut job);
        all.push(StoredJob {
            sequence: 0,
            available_at_ms: 0,
            job,
            original_digest: None,
            original_available_at_ms: 0,
            original_status: JobStatus::Pending,
        });
    }
    validate_graph(&all)?;
    reconcile(&mut all, Utc::now().timestamp_millis());
    for stored in all.iter().filter(|j| j.sequence == 0) {
        insert_job(tx, stored)?;
    }
    save_jobs(tx, &all)?;
    Ok(())
}

impl SchedulerStore {
    /// Returns reservations in persisted FIFO order. Calling this again includes
    /// every earlier running reservation; separate store handles cannot double-claim.
    pub fn claim_ready(&self, limits: &ResourceLimits) -> Result<Vec<Job>> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut all = load_jobs(&tx)?;
        let now = Utc::now().timestamp_millis();
        reconcile(&mut all, now);
        let mut used = usage_for(&all)?;
        let mut barrier = FairnessBarrier::default();
        let mut claimed = Vec::new();
        for stored in &mut all {
            if stored.job.status != JobStatus::Ready {
                continue;
            }
            let request = ResourceRequest::for_job(&stored.job)?;
            if !ResourceUsage::default().fits(&stored.job.resource, &request, limits) {
                let (kind, slots) = match stored.job.resource {
                    JobResource::Cpu => ("CPU", limits.cpu_jobs),
                    JobResource::Blender => ("Blender", limits.blender_jobs),
                    JobResource::External => ("외부 생성", limits.external_jobs),
                };
                stored.job.status = JobStatus::WaitingUser;
                stored.job.error = Some(format!(
                    "작업 자원 예약이 설정 한도를 넘습니다: {kind} 동시 작업 한도 {slots}, RAM {}/{} MB, GPU {}/{} MB, CPU {}/{} 스레드, 디스크 가중치 {}/{}. 한도를 조정하고 재개하세요.",
                    request.ram_mb, limits.ram_mb, request.gpu_mb, limits.gpu_mb,
                    request.cpu_threads, limits.cpu_threads, request.disk_weight, limits.disk_weight,
                ));
                stored.job.progress = progress("waiting_resources");
                continue;
            }
            if barrier.conflicts(&stored.job.resource, &request) {
                continue;
            }
            if !used.fits(&stored.job.resource, &request, limits) {
                barrier.reserve_scarce(&stored.job.resource, &request, &used, limits);
                continue;
            }
            used.reserve(&stored.job.resource, &request);
            stored.job.status = JobStatus::Running;
            stored.job.attempts = stored.job.attempts.saturating_add(1);
            // Attempts reset on a deliberate rerun; artifact commit identity
            // must still distinguish every actual execution of the same job.
            stored.job.payload.insert(
                "executionId".into(),
                json!(uuid::Uuid::new_v4().to_string()),
            );
            stored.job.started_at = Some(now_text());
            stored.job.finished_at = None;
            stored.job.error = None;
            stored.job.progress = progress(if stored.job.resource == JobResource::External {
                "dispatching_external"
            } else {
                "running"
            });
            claimed.push(stored.job.clone());
        }
        reconcile(&mut all, now);
        save_jobs(&tx, &all)?;
        tx.commit()?;
        Ok(claimed)
    }

    pub fn running_resources(&self) -> Result<ResourceUsage> {
        let connection = self.connection()?;
        usage_for(&load_jobs(&connection)?)
    }

    /// Only call after validating the actual worker/provider artifact.
    pub fn complete(&self, id: &str) -> Result<()> {
        self.mutate(|all| {
            let stored = find_mut(all, id)?;
            if stored.job.status == JobStatus::Succeeded {
                return Ok(());
            }
            if !matches!(
                stored.job.status,
                JobStatus::Running | JobStatus::ExternalUnknown
            ) {
                bail!("job {id} cannot complete from {:?}", stored.job.status);
            }
            stored.job.status = JobStatus::Succeeded;
            stored.job.finished_at = Some(now_text());
            stored.job.error = None;
            stored.job.progress.stage = "succeeded".into();
            if let Some(total) = stored.job.progress.total {
                stored.job.progress.completed = Some(total);
            }
            stored.available_at_ms = 0;
            Ok(())
        })
    }

    pub fn fail(&self, id: &str, kind: FailureKind, message: &str) -> Result<()> {
        if message.trim().is_empty() {
            bail!("a meaningful failure message is required")
        }
        self.mutate(|all| {
            let stored = find_mut(all, id)?;
            if !matches!(stored.job.status, JobStatus::Running | JobStatus::Ready | JobStatus::ExternalUnknown) {
                bail!("job {id} cannot fail from {:?}", stored.job.status);
            }
            let submitted = stored.job.payload.get("externalSubmitted").and_then(Value::as_bool) == Some(true);
            let uncertain = stored.job.resource == JobResource::External
                && (kind == FailureKind::ExternalResultUnknown
                    || (submitted && matches!(kind, FailureKind::Network | FailureKind::RateLimit))
                    || stored.job.status == JobStatus::ExternalUnknown);
            stored.job.error = Some(message.to_owned());
            stored.available_at_ms = 0;
            if uncertain {
                stored.job.status = JobStatus::ExternalUnknown;
                stored.job.finished_at = None;
                stored.job.error = Some(format!("{message} 외부 요청의 완료·실패·취소 여부를 확인할 수 없습니다. 자동 재전송하지 않습니다."));
                stored.job.progress = progress("external_unknown");
            } else if matches!(kind, FailureKind::Network | FailureKind::RateLimit)
                && stored.job.attempts > 0 && stored.job.attempts <= MAX_TRANSIENT_RETRIES {
                let seconds = 1_i64 << stored.job.attempts;
                stored.available_at_ms = Utc::now().timestamp_millis() + seconds * 1000;
                stored.job.status = JobStatus::RetryWait;
                stored.job.finished_at = None;
                stored.job.progress = progress("retry_wait");
                stored.job.error = Some(format!("{message} {seconds}초 후 재시도합니다 ({}/{MAX_TRANSIENT_RETRIES}).", stored.job.attempts));
            } else if matches!(kind, FailureKind::Authentication | FailureKind::Permission | FailureKind::Unsupported) {
                stored.job.status = JobStatus::WaitingUser;
                stored.job.finished_at = None;
                stored.job.progress = progress("waiting_user");
            } else {
                stored.job.status = JobStatus::Failed;
                stored.job.finished_at = Some(now_text());
                stored.job.progress = progress("failed");
            }
            Ok(())
        })
    }

    /// Downstream queued/local work is cancelled. External running work remains
    /// unresolved; returned local ids allow the coordinator to kill process handles.
    pub fn cancel(&self, id: &str) -> Result<Vec<String>> {
        self.mutate_result(|all| {
            let affected = descendants(all, id)?;
            let mut changed = Vec::new();
            for stored in all.iter_mut().filter(|j| affected.contains(&j.job.id)) {
                if matches!(stored.job.status, JobStatus::Succeeded | JobStatus::Cancelled) { continue }
                changed.push(stored.job.id.clone());
                stored.available_at_ms = 0;
                if stored.job.resource == JobResource::External
                    && matches!(stored.job.status, JobStatus::Running | JobStatus::ExternalUnknown) {
                    stored.job.status = JobStatus::ExternalUnknown;
                    stored.job.finished_at = None;
                    stored.job.progress = progress("external_unknown");
                    stored.job.error = Some("로컬 대기와 후속 작업을 취소했습니다. 외부 요청의 원격 취소는 확인되지 않았으며 결과가 나올 수 있습니다.".into());
                } else {
                    let awaiting_worker = stored.job.status == JobStatus::Running;
                    stored.job.status = JobStatus::Cancelled;
                    stored.job.finished_at = Some(now_text());
                    stored.job.progress = progress(if awaiting_worker { "stopping_local_worker" } else { "cancelled" });
                    if awaiting_worker {
                        stored.job.payload.insert("cancellationAwaitingWorker".into(), Value::Bool(true));
                    }
                    stored.job.error = Some("사용자가 이 작업 또는 선행 작업을 취소했습니다.".into());
                }
            }
            Ok(changed)
        })
    }

    /// Resets only this job and its downstream graph. Existing artifacts and
    /// successful upstream jobs stay intact. Active worker handles must be stopped first.
    pub fn rerun(&self, id: &str) -> Result<Vec<String>> {
        self.mutate_with_capacity(|all, capacity| {
            let affected = descendants(all, id)?;
            if all.iter().any(|j| affected.contains(&j.job.id)
                && (matches!(j.job.status, JobStatus::Running | JobStatus::ExternalUnknown) || cancellation_hold(&j.job))) {
                bail!("stop active local workers first; unresolved external work requires explicit confirmation");
            }
            let outside_active = all.iter().filter(|j| !affected.contains(&j.job.id) && is_active_job(&j.job)).count();
            if outside_active.saturating_add(affected.len()) > capacity {
                bail!("rerun exceeds job queue capacity {capacity}");
            }
            let mut changed = Vec::new();
            for stored in all.iter_mut().filter(|j| affected.contains(&j.job.id)) {
                reset(stored);
                changed.push(stored.job.id.clone());
            }
            Ok(changed)
        })
    }

    /// Called once on desktop startup, after previous worker handles are gone.
    /// Local work can run again; every external running request remains uncertain.
    pub fn recover(&self) -> Result<()> {
        self.mutate(|all| {
            for stored in all.iter_mut().filter(|j| cancellation_hold(&j.job)) {
                stored.job.payload.remove("cancellationAwaitingWorker");
                stored.job.progress = progress("cancelled");
            }
            for stored in all.iter_mut().filter(|j| j.job.status == JobStatus::Running) {
                stored.job.finished_at = None;
                stored.available_at_ms = 0;
                if stored.job.resource == JobResource::External {
                    stored.job.status = JobStatus::ExternalUnknown;
                    stored.job.progress = progress("external_unknown");
                    stored.job.error = Some("앱이 종료되어 외부 요청 결과를 확인할 수 없습니다. 자동 재전송하지 않습니다.".into());
                } else {
                    stored.job.status = JobStatus::Pending;
                    stored.job.started_at = None;
                    stored.job.progress = progress("recovered_local");
                    stored.job.error = Some("중단된 로컬 작업을 복구했습니다. 원본과 완료 결과는 보존됩니다.".into());
                }
            }
            Ok(())
        })
    }

    /// Call only after observing that the cancelled local worker/process exited.
    /// The cancelled status alone is not evidence that its CPU/RAM is available.
    pub fn release_cancelled_resources(&self, id: &str) -> Result<()> {
        self.mutate(|all| {
            let stored = find_mut(all, id)?;
            if stored.job.resource == JobResource::External
                || stored.job.status != JobStatus::Cancelled
            {
                bail!("job {id} is not cancelled local work");
            }
            stored.job.payload.remove("cancellationAwaitingWorker");
            stored.job.progress = progress("cancelled");
            Ok(())
        })
    }

    pub fn resume_user(&self, id: &str) -> Result<()> {
        self.mutate(|all| {
            let stored = find_mut(all, id)?;
            if stored.job.status == JobStatus::ExternalUnknown {
                bail!("external result is unknown; resume_external requires explicit duplicate-request risk acknowledgement");
            }
            if stored.job.status != JobStatus::WaitingUser { bail!("job {id} is not waiting for user input") }
            reset(stored);
            Ok(())
        })
    }

    /// Explicit user permission for a new request. This does not cancel or prove
    /// failure of the old remote request; old output may still arrive.
    pub fn resume_external(&self, id: &str, acknowledge_duplicate_risk: bool) -> Result<()> {
        if !acknowledge_duplicate_risk {
            bail!("explicit acknowledgement of possible duplicate external generation is required")
        }
        self.mutate(|all| {
            let stored = find_mut(all, id)?;
            if stored.job.resource != JobResource::External
                || stored.job.status != JobStatus::ExternalUnknown
            {
                bail!("job {id} is not an unresolved external request");
            }
            reset(stored);
            stored.job.progress = progress("explicit_external_resubmission");
            Ok(())
        })
    }

    pub fn mark_external_submitted(&self, id: &str) -> Result<()> {
        self.mutate(|all| {
            let stored = find_mut(all, id)?;
            if stored.job.resource != JobResource::External
                || stored.job.status != JobStatus::Running
            {
                bail!("job {id} is not a running external request");
            }
            stored
                .job
                .payload
                .insert("externalSubmitted".into(), Value::Bool(true));
            stored.job.progress = progress("external_submitted");
            Ok(())
        })
    }

    /// The provider callback calls this as soon as turn/start returns an
    /// identity, before polling or downloading. A concurrent local cancellation
    /// may already have made the job uncertain; retaining its identity is vital.
    /// Submission and identity become durable together, with a matching event.
    pub fn set_external_identity(&self, id: &str, thread_id: &str, turn_id: &str) -> Result<()> {
        if !valid_external_id(thread_id) || !valid_external_id(turn_id) {
            bail!("external thread/turn ids must be 1..256 safe identifier bytes");
        }
        self.mutate(|all| {
            let stored = find_mut(all, id)?;
            if stored.job.resource != JobResource::External
                || !matches!(stored.job.status, JobStatus::Running | JobStatus::ExternalUnknown) {
                bail!("job {id} is not running or unresolved external work");
            }
            let identity = ExternalJobIdentity { thread_id: thread_id.into(), turn_id: turn_id.into() };
            if let Some(previous) = events::external_identity(&stored.job) {
                if previous != identity { bail!("external identity already belongs to a different request; resolve it before resubmitting"); }
                return Ok(());
            }
            stored.job.payload.insert("externalThreadId".into(), json!(thread_id));
            stored.job.payload.insert("externalTurnId".into(), json!(turn_id));
            stored.job.payload.insert("externalSubmitted".into(), json!(true));
            if stored.job.status == JobStatus::Running { stored.job.progress = progress("external_submitted"); }
            Ok(())
        })
    }

    /// The coordinator may call this only after the official provider reports a
    /// terminal interrupted/cancelled acknowledgement. A local abort or a sent
    /// interrupt request is insufficient evidence. It releases the external slot.
    pub fn confirm_external_cancelled(&self, id: &str) -> Result<()> {
        self.mutate(|all| {
            let stored = find_mut(all, id)?;
            if stored.job.resource != JobResource::External {
                bail!("job {id} is not external work");
            }
            if stored.job.status == JobStatus::Cancelled
                && stored
                    .job
                    .payload
                    .get("remoteCancellationConfirmed")
                    .and_then(Value::as_bool)
                    == Some(true)
            {
                return Ok(());
            }
            if stored.job.status != JobStatus::ExternalUnknown {
                bail!("job {id} is not an unresolved external cancellation");
            }
            stored.job.status = JobStatus::Cancelled;
            stored.job.finished_at = Some(now_text());
            stored.job.progress = progress("external_cancel_confirmed");
            stored.job.error =
                Some("공식 외부 서비스의 종료 응답으로 원격 취소를 확인했습니다.".into());
            stored
                .job
                .payload
                .insert("remoteCancellationConfirmed".into(), json!(true));
            stored.available_at_ms = 0;
            Ok(())
        })
    }

    /// Optional confirmed worker events. Unmeasured progress remains None/None.
    pub fn set_progress(
        &self,
        id: &str,
        stage: &str,
        completed: Option<u64>,
        total: Option<u64>,
    ) -> Result<()> {
        if stage.trim().is_empty() || stage.len() > 256 {
            bail!("progress stage must contain 1..256 bytes")
        }
        match (completed, total) {
            (Some(done), Some(count)) if count > 0 && done <= count => {}
            (None, None) => {}
            _ => {
                bail!("progress must be indeterminate or a confirmed count within a positive total")
            }
        }
        self.mutate(|all| {
            let stored = find_mut(all, id)?;
            if stored.job.status != JobStatus::Running {
                bail!("job {id} is not running")
            }
            stored.job.progress = JobProgress {
                stage: stage.into(),
                completed,
                total,
            };
            Ok(())
        })
    }

    fn mutate<F>(&self, operation: F) -> Result<()>
    where
        F: FnOnce(&mut Vec<StoredJob>) -> Result<()>,
    {
        self.mutate_result(operation)
    }

    fn mutate_result<T, F>(&self, operation: F) -> Result<T>
    where
        F: FnOnce(&mut Vec<StoredJob>) -> Result<T>,
    {
        self.mutate_with_capacity(|all, _capacity| operation(all))
    }

    fn mutate_with_capacity<T, F>(&self, operation: F) -> Result<T>
    where
        F: FnOnce(&mut Vec<StoredJob>, usize) -> Result<T>,
    {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut all = load_jobs(&tx)?;
        let result = operation(&mut all, read_capacity(&tx)?)?;
        reconcile(&mut all, Utc::now().timestamp_millis());
        save_jobs(&tx, &all)?;
        tx.commit()?;
        Ok(result)
    }
}

/// Computes identity only. The caller must explicitly request cache reuse; the
/// scheduler never substitutes a cached artifact for a new variation request.
pub fn cache_key(
    prompt: &str,
    input_hashes: &[String],
    options: &Value,
    provider_version: &str,
    tool_version: &str,
) -> Result<String> {
    if provider_version.trim().is_empty() || tool_version.trim().is_empty() {
        bail!("cache identity requires explicit provider and tool versions");
    }
    for hash in input_hashes {
        if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
            bail!("cache input hashes must be SHA-256 hexadecimal strings");
        }
    }
    let inputs: Vec<_> = input_hashes
        .iter()
        .map(|h| h.to_ascii_lowercase())
        .collect();
    let identity = json!({
        "cacheSchema": 1,
        "prompt": prompt,
        "inputHashes": inputs,
        "options": canonical(options),
        "providerVersion": provider_version,
        "toolVersion": tool_version,
    });
    let bytes = serde_json::to_vec(&canonical(&identity))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let sorted: BTreeMap<_, _> = map
                .iter()
                .map(|(key, value)| (key.clone(), canonical(value)))
                .collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
        value => value.clone(),
    }
}

fn progress(stage: &str) -> JobProgress {
    JobProgress {
        stage: stage.into(),
        completed: None,
        total: None,
    }
}

fn now_text() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn check_capacity(capacity: usize) -> Result<()> {
    if !(1..=MAX_QUEUE_CAPACITY).contains(&capacity) {
        bail!("queue capacity must be 1..={MAX_QUEUE_CAPACITY}");
    }
    Ok(())
}

fn read_capacity(connection: &Connection) -> Result<usize> {
    let value: i64 = connection.query_row(
        "SELECT value FROM scheduler_metadata WHERE key='queue_capacity'",
        [],
        |row| row.get(0),
    )?;
    let capacity = usize::try_from(value).context("invalid persisted queue capacity")?;
    check_capacity(capacity).context("invalid persisted queue capacity; database was preserved")?;
    Ok(capacity)
}

fn valid_external_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.contains("://")
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.' | b'/' | b':'))
}

fn clear_external_identity(job: &mut Job) {
    for key in [
        "externalThreadId",
        "externalTurnId",
        "remoteCancellationConfirmed",
    ] {
        job.payload.remove(key);
    }
}

/// Runtime ids/times are not user intent. Intra-batch dependencies and known
/// job-reference payload keys are normalized so retry-generated UUIDs are safe.
/// Everything else (prompt, options, seed, resource estimates) remains semantic.
fn intent_fingerprint(jobs: &[Job]) -> Result<String> {
    let mut ids = HashMap::new();
    for (index, job) in jobs.iter().enumerate() {
        if ids
            .insert(job.id.clone(), format!("batch:{index}"))
            .is_some()
        {
            bail!("duplicate job id {}", job.id);
        }
    }
    fn normalize_references(value: &mut Value, ids: &HashMap<String, String>) {
        match value {
            Value::Object(fields) => {
                for (key, child) in fields.iter_mut() {
                    if matches!(key.as_str(), "jobId" | "processJobId") {
                        if let Some(reference) = child.as_str().and_then(|id| ids.get(id)) {
                            *child = json!(reference);
                        }
                    } else {
                        normalize_references(child, ids);
                    }
                }
            }
            Value::Array(items) => {
                for child in items {
                    normalize_references(child, ids);
                }
            }
            _ => {}
        }
    }
    let mut intents = Vec::with_capacity(jobs.len());
    for job in jobs {
        let mut value = serde_json::to_value(job)?;
        let fields = value
            .as_object_mut()
            .context("job intent is not an object")?;
        for key in [
            "id",
            "status",
            "attempts",
            "createdAt",
            "startedAt",
            "finishedAt",
            "error",
            "progress",
        ] {
            fields.remove(key);
        }
        fields.insert(
            "dependencies".into(),
            json!(job
                .dependencies
                .iter()
                .map(|id| ids.get(id).unwrap_or(id))
                .collect::<Vec<_>>()),
        );
        if let Some(payload) = fields.get_mut("payload") {
            if let Some(fields) = payload.as_object_mut() {
                for key in [
                    "executionId",
                    "externalSubmitted",
                    "cancellationAwaitingWorker",
                    "externalThreadId",
                    "externalTurnId",
                    "remoteCancellationConfirmed",
                ] {
                    fields.remove(key);
                }
            }
            normalize_references(payload, &ids);
        }
        intents.push(value);
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&canonical(&json!(intents)))?)
    ))
}

fn is_active_job(job: &Job) -> bool {
    cancellation_hold(job)
        || !matches!(
            job.status,
            JobStatus::Succeeded | JobStatus::Failed | JobStatus::Cancelled
        )
}

fn cancellation_hold(job: &Job) -> bool {
    job.status == JobStatus::Cancelled
        && job.resource != JobResource::External
        && job
            .payload
            .get("cancellationAwaitingWorker")
            .and_then(Value::as_bool)
            == Some(true)
}

fn reset(stored: &mut StoredJob) {
    stored.job.status = JobStatus::Pending;
    stored.job.attempts = 0;
    stored.job.started_at = None;
    stored.job.finished_at = None;
    stored.job.error = None;
    stored.job.progress = progress("queued");
    stored.job.payload.remove("executionId");
    stored.job.payload.remove("externalSubmitted");
    stored.job.payload.remove("cancellationAwaitingWorker");
    clear_external_identity(&mut stored.job);
    stored.available_at_ms = 0;
}

fn validate_new_job(job: &Job) -> Result<()> {
    if job.id.trim().is_empty() || job.id.len() > 256 {
        bail!("job id must be 1..256 bytes")
    }
    if job.project_id.trim().is_empty() {
        bail!("job projectId is required")
    }
    if !matches!(job.status, JobStatus::Pending | JobStatus::Ready) {
        bail!("new job must be pending or ready")
    }
    if job.dependencies.len() > MAX_QUEUE_CAPACITY {
        bail!("too many job dependencies")
    }
    let unique: HashSet<_> = job.dependencies.iter().collect();
    if unique.len() != job.dependencies.len() {
        bail!("job {} has duplicate dependencies", job.id)
    }
    if job.dependencies.iter().any(|id| id == &job.id) {
        bail!("job {} cannot depend on itself", job.id)
    }
    ResourceRequest::for_job(job)?;
    if serde_json::to_vec(job)?.len() > MAX_DOCUMENT_BYTES {
        bail!("job document exceeds 1 MB queue storage limit")
    }
    Ok(())
}

fn validate_graph(all: &[StoredJob]) -> Result<()> {
    // Iterative Kahn traversal also handles deep historical graphs without stack
    // recursion on an imported project's untrusted metadata.
    let indexes: HashMap<_, _> = all
        .iter()
        .enumerate()
        .map(|(index, stored)| (stored.job.id.as_str(), index))
        .collect();
    if indexes.len() != all.len() {
        bail!("persisted graph contains duplicate job ids")
    }
    let mut indegree: Vec<_> = all.iter().map(|j| j.job.dependencies.len()).collect();
    let mut dependants = vec![Vec::new(); all.len()];
    for (index, stored) in all.iter().enumerate() {
        for dependency in &stored.job.dependencies {
            let Some(parent) = indexes.get(dependency.as_str()) else {
                bail!("job {} has missing dependency {dependency}", stored.job.id)
            };
            dependants[*parent].push(index);
        }
    }
    let mut queue: VecDeque<_> = indegree
        .iter()
        .enumerate()
        .filter(|(_, count)| **count == 0)
        .map(|(index, _)| index)
        .collect();
    let mut visited = 0;
    while let Some(index) = queue.pop_front() {
        visited += 1;
        for child in &dependants[index] {
            indegree[*child] -= 1;
            if indegree[*child] == 0 {
                queue.push_back(*child);
            }
        }
    }
    if visited != all.len() {
        bail!("dependency graph contains a cycle")
    }
    Ok(())
}

fn descendants(all: &[StoredJob], id: &str) -> Result<HashSet<String>> {
    if !all.iter().any(|j| j.job.id == id) {
        bail!("unknown job {id}")
    }
    let mut affected = HashSet::new();
    let mut queue = VecDeque::from([id.to_owned()]);
    while let Some(current) = queue.pop_front() {
        if !affected.insert(current.clone()) {
            continue;
        }
        for stored in all {
            if stored.job.dependencies.contains(&current) {
                queue.push_back(stored.job.id.clone());
            }
        }
    }
    Ok(affected)
}

fn find_mut<'a>(all: &'a mut [StoredJob], id: &str) -> Result<&'a mut StoredJob> {
    all.iter_mut()
        .find(|j| j.job.id == id)
        .with_context(|| format!("unknown job {id}"))
}

fn usage_for(all: &[StoredJob]) -> Result<ResourceUsage> {
    let mut usage = ResourceUsage::default();
    for stored in all {
        if stored.job.status == JobStatus::Running || cancellation_hold(&stored.job) {
            usage.reserve(
                &stored.job.resource,
                &ResourceRequest::for_job(&stored.job)?,
            );
        } else if stored.job.status == JobStatus::ExternalUnknown
            && stored.job.resource == JobResource::External
        {
            // The remote job may still be running. Keep its provider slot reserved,
            // without pretending a local worker is still allocating memory.
            usage.external_jobs = usage.external_jobs.saturating_add(1);
        }
    }
    Ok(usage)
}

/// Resolve the DAG until a fixed point, including dependency error propagation.
fn reconcile(all: &mut [StoredJob], now: i64) {
    for _ in 0..=all.len() {
        let states: HashMap<String, JobStatus> = all
            .iter()
            .map(|j| (j.job.id.clone(), j.job.status.clone()))
            .collect();
        let mut changed = false;
        for stored in all.iter_mut() {
            if stored.job.status == JobStatus::RetryWait && stored.available_at_ms <= now {
                stored.job.status = JobStatus::Pending;
                stored.job.progress = progress("retry_ready");
                changed = true;
            }
            let dependency_block = stored.job.status == JobStatus::WaitingUser
                && stored.job.progress.stage == "blocked_dependency";
            if !matches!(stored.job.status, JobStatus::Pending | JobStatus::Ready)
                && !dependency_block
            {
                continue;
            }
            let mut next = JobStatus::Ready;
            let mut error = None;
            // Terminal dependency failures take precedence over a waiting dependency.
            for dependency in &stored.job.dependencies {
                match states.get(dependency) {
                    Some(JobStatus::Failed) => {
                        next = JobStatus::Failed;
                        error = Some(format!("선행 작업 {dependency}이 실패했습니다. 입력을 수정한 뒤 해당 작업부터 재실행하세요."));
                        break;
                    }
                    Some(JobStatus::Cancelled) => {
                        next = JobStatus::Cancelled;
                        error = Some(format!(
                            "선행 작업 {dependency}이 취소되어 후속 작업을 취소했습니다."
                        ));
                        break;
                    }
                    None => {
                        next = JobStatus::Failed;
                        error = Some(format!("선행 작업 {dependency}을 찾을 수 없습니다."));
                        break;
                    }
                    _ => {}
                }
            }
            if !matches!(next, JobStatus::Failed | JobStatus::Cancelled) {
                for dependency in &stored.job.dependencies {
                    match states.get(dependency) {
                        Some(JobStatus::WaitingUser | JobStatus::ExternalUnknown) => {
                            next = JobStatus::WaitingUser;
                            error = Some(format!("선행 작업 {dependency}에 사용자 확인이 필요합니다. 외부 결과가 불명이면 자동 재전송하지 않습니다."));
                            break;
                        }
                        Some(JobStatus::Succeeded) => {}
                        _ => {
                            next = JobStatus::Pending;
                        }
                    }
                }
            }
            if stored.job.status != next {
                stored.job.status = next;
                changed = true;
                match stored.job.status {
                    JobStatus::Ready => {
                        stored.job.error = None;
                        stored.job.progress = progress("ready");
                    }
                    JobStatus::Pending => {
                        stored.job.error = None;
                        stored.job.progress = progress("waiting_dependencies");
                    }
                    JobStatus::Failed | JobStatus::Cancelled => {
                        stored.job.finished_at = Some(now_text());
                        stored.job.progress = progress("blocked_dependency");
                        stored.job.error = error;
                    }
                    JobStatus::WaitingUser => {
                        stored.job.finished_at = None;
                        stored.job.progress = progress("blocked_dependency");
                        stored.job.error = error;
                    }
                    _ => {}
                }
            }
        }
        if !changed {
            break;
        }
    }
}

fn state_text(job: &Job) -> Result<(String, String)> {
    let status = serde_json::to_value(&job.status)?
        .as_str()
        .context("job status is not a string")?
        .to_owned();
    let resource = serde_json::to_value(&job.resource)?
        .as_str()
        .context("job resource is not a string")?
        .to_owned();
    Ok((status, resource))
}

type PersistedRow = (i64, i64, String, String, String, String);

fn persisted_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PersistedRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
    ))
}

fn decode_stored(row: PersistedRow) -> Result<StoredJob> {
    let (sequence, available_at_ms, document, id, status, resource) = row;
    if sequence <= 0 || document.len() > MAX_DOCUMENT_BYTES {
        bail!("persisted scheduler row is invalid; database was preserved");
    }
    let job: Job = serde_json::from_str(&document)
        .context("decode persisted job; original database was preserved")?;
    if job.id != id || state_text(&job)? != (status, resource) {
        bail!("persisted scheduler metadata is inconsistent; database was preserved");
    }
    ResourceRequest::for_job(&job).context("persisted resource reservation is invalid")?;
    let digest: [u8; 32] = Sha256::digest(serde_json::to_vec(&job)?).into();
    Ok(StoredJob {
        sequence,
        available_at_ms,
        original_digest: Some(digest),
        original_available_at_ms: available_at_ms,
        original_status: job.status,
        job,
    })
}

fn load_jobs(connection: &Connection) -> Result<Vec<StoredJob>> {
    let mut statement = connection.prepare("SELECT sequence, available_at_ms, document, id, status, resource FROM scheduler_jobs ORDER BY sequence")?;
    let rows = statement.query_map([], persisted_row)?;
    let all: Vec<_> = rows.map(|row| decode_stored(row?)).collect::<Result<_>>()?;
    validate_graph(&all)
        .context("persisted dependency graph is invalid; database was preserved")?;
    Ok(all)
}

fn insert_job(connection: &Connection, stored: &StoredJob) -> Result<()> {
    let (status, resource) = state_text(&stored.job)?;
    let document = serde_json::to_string(&stored.job)?;
    if document.len() > MAX_DOCUMENT_BYTES {
        bail!("job document exceeds 1 MB queue storage limit");
    }
    connection.execute(
        "INSERT INTO scheduler_jobs(id,status,resource,available_at_ms,document) VALUES (?1,?2,?3,?4,?5)",
        params![stored.job.id, status, resource, stored.available_at_ms, document],
    )?;
    events::append_event(connection, &stored.job, JobEventKind::Enqueued, None)?;
    Ok(())
}

fn save_jobs(connection: &Connection, all: &[StoredJob]) -> Result<()> {
    let mut statement = connection.prepare("UPDATE scheduler_jobs SET status=?2,resource=?3,available_at_ms=?4,document=?5 WHERE id=?1")?;
    for stored in all {
        // Newly inserted rows have already been saved and have one enqueue event.
        if stored.sequence == 0 {
            continue;
        }
        let document = serde_json::to_string(&stored.job)?;
        let digest: [u8; 32] = Sha256::digest(document.as_bytes()).into();
        if stored.original_digest == Some(digest)
            && stored.available_at_ms == stored.original_available_at_ms
        {
            continue;
        }
        if document.len() > MAX_DOCUMENT_BYTES {
            bail!("job document exceeds 1 MB queue storage limit");
        }
        let (status, resource) = state_text(&stored.job)?;
        let updated = statement.execute(params![
            stored.job.id,
            status,
            resource,
            stored.available_at_ms,
            document
        ])?;
        if updated != 1 {
            bail!(
                "persisted job {} disappeared during transaction",
                stored.job.id
            );
        }
        let kind = if stored.job.status != stored.original_status {
            JobEventKind::StateChanged
        } else {
            JobEventKind::Updated
        };
        events::append_event(connection, &stored.job, kind, Some(stored.original_status))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
