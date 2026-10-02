use super::*;
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::Instant;

fn job(id: &str, resource: JobResource, dependencies: &[&str]) -> Job {
    Job {
        id: id.into(),
        project_id: "scheduler-test".into(),
        asset_id: None,
        kind: "local_fixture".into(),
        label: id.into(),
        status: JobStatus::Pending,
        dependencies: dependencies.iter().map(|id| (*id).into()).collect(),
        resource,
        attempts: 0,
        created_at: now_text(),
        started_at: None,
        finished_at: None,
        error: None,
        progress: progress("queued"),
        payload: BTreeMap::new(),
        cache_key: None,
    }
}

fn status(store: &SchedulerStore, id: &str) -> JobStatus {
    store
        .jobs()
        .unwrap()
        .into_iter()
        .find(|j| j.id == id)
        .unwrap()
        .status
}

fn memory_store() -> SchedulerStore {
    SchedulerStore::open(Path::new(":memory:")).unwrap()
}

struct TempDb {
    directory: std::path::PathBuf,
}

impl TempDb {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("asset-scheduler-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        Self { directory }
    }
    fn path(&self) -> std::path::PathBuf {
        self.directory.join("한글 작업 큐.sqlite")
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        // Delete only the UUID directory created by this test, never project input.
        if self.directory.starts_with(std::env::temp_dir())
            && self
                .directory
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("asset-scheduler-test-")
        {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
}

#[test]
fn graph_missing_dependency_self_reference_and_cycles_are_atomic_errors() {
    let store = memory_store();
    assert!(store
        .enqueue(job("missing", JobResource::Cpu, &["absent"]))
        .is_err());
    assert!(store
        .enqueue(job("self", JobResource::Cpu, &["self"]))
        .is_err());
    assert!(store
        .enqueue_many(vec![
            job("a", JobResource::Cpu, &["b"]),
            job("b", JobResource::Cpu, &["a"]),
        ])
        .is_err());
    assert!(store.jobs().unwrap().is_empty());
}

#[test]
fn unordered_batch_is_a_dag_and_dependencies_gate_execution() {
    let store = memory_store();
    store
        .enqueue_many(vec![
            job("child", JobResource::Cpu, &["parent"]),
            job("parent", JobResource::Cpu, &[]),
        ])
        .unwrap();
    assert_eq!(status(&store, "child"), JobStatus::Pending);
    let claimed = store.claim_ready(&ResourceLimits::default()).unwrap();
    assert_eq!(
        claimed.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(),
        ["parent"]
    );
    store.complete("parent").unwrap();
    assert_eq!(status(&store, "child"), JobStatus::Ready);
    assert_eq!(
        store.claim_ready(&ResourceLimits::default()).unwrap()[0].id,
        "child"
    );
}

#[test]
fn repeated_claim_accounts_for_running_jobs_and_releases_after_completion() {
    let store = memory_store();
    for id in ["a", "b", "c"] {
        store.enqueue(job(id, JobResource::Cpu, &[])).unwrap();
    }
    let limits = ResourceLimits::default();
    assert_eq!(store.claim_ready(&limits).unwrap().len(), 2);
    assert!(store.claim_ready(&limits).unwrap().is_empty());
    let usage = store.running_resources().unwrap();
    assert_eq!(
        (usage.cpu_jobs, usage.cpu_threads, usage.ram_mb),
        (2, 2, 512)
    );
    store.complete("a").unwrap();
    assert_eq!(store.claim_ready(&limits).unwrap()[0].id, "c");
}

#[test]
fn blender_and_external_slots_are_independent_of_cpu_slot() {
    let store = memory_store();
    for (id, resource) in [
        ("cpu", JobResource::Cpu),
        ("blender", JobResource::Blender),
        ("external", JobResource::External),
        ("external2", JobResource::External),
    ] {
        store.enqueue(job(id, resource, &[])).unwrap();
    }
    let limits = ResourceLimits {
        cpu_threads: 3,
        ..ResourceLimits::default()
    };
    let claimed = store.claim_ready(&limits).unwrap();
    assert_eq!(
        claimed.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(),
        ["cpu", "blender", "external"]
    );
    assert_eq!(status(&store, "external2"), JobStatus::Ready);
}

#[test]
fn ram_gpu_threads_disk_and_disabled_slots_require_user_action_when_impossible() {
    for resources in [
        json!({"ramMb":2049}),
        json!({"gpuMb":1}),
        json!({"cpuThreads":3}),
        json!({"diskWeight":3}),
    ] {
        let store = memory_store();
        let mut request = job("too-large", JobResource::Cpu, &[]);
        request.payload.insert("resources".into(), resources);
        store
            .enqueue_many(vec![
                request,
                job("child", JobResource::Cpu, &["too-large"]),
            ])
            .unwrap();
        assert!(store
            .claim_ready(&ResourceLimits::default())
            .unwrap()
            .is_empty());
        assert_eq!(status(&store, "too-large"), JobStatus::WaitingUser);
        assert_eq!(status(&store, "child"), JobStatus::WaitingUser);
    }
    let store = memory_store();
    store
        .enqueue(job("external", JobResource::External, &[]))
        .unwrap();
    assert!(store
        .claim_ready(&ResourceLimits {
            external_jobs: 0,
            ..ResourceLimits::default()
        })
        .unwrap()
        .is_empty());
    assert_eq!(status(&store, "external"), JobStatus::WaitingUser);
}

#[test]
fn invalid_resource_reservations_are_rejected_instead_of_underaccounting() {
    for resources in [
        json!("invalid"),
        json!({"ramMb":-1}),
        json!({"ramMb":0}),
        json!({"cpuThreads":0}),
        json!({"cpuThreads":1.5}),
    ] {
        let store = memory_store();
        let mut invalid = job("invalid", JobResource::Cpu, &[]);
        invalid.payload.insert("resources".into(), resources);
        assert!(store.enqueue(invalid).is_err());
        assert!(store.jobs().unwrap().is_empty());
    }
}

#[test]
fn oldest_large_request_is_not_starved_by_new_small_requests() {
    let store = memory_store();
    let limits = ResourceLimits::default();
    store
        .enqueue(job("running-small", JobResource::Cpu, &[]))
        .unwrap();
    store.claim_ready(&limits).unwrap();
    let mut big = job("older-big", JobResource::Cpu, &[]);
    big.payload
        .insert("resources".into(), json!({"cpuThreads":2}));
    store.enqueue(big).unwrap();
    store
        .enqueue(job("new-small", JobResource::Cpu, &[]))
        .unwrap();
    store
        .enqueue(job("disjoint-external", JobResource::External, &[]))
        .unwrap();
    let claimed = store.claim_ready(&limits).unwrap();
    assert_eq!(
        claimed.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(),
        ["disjoint-external"]
    );
    store.complete("running-small").unwrap();
    assert_eq!(store.claim_ready(&limits).unwrap()[0].id, "older-big");
    assert_eq!(status(&store, "new-small"), JobStatus::Ready);
}

#[test]
fn failed_and_user_blocked_dependencies_propagate_without_hanging() {
    let store = memory_store();
    store
        .enqueue_many(vec![
            job("parent", JobResource::Cpu, &[]),
            job("child", JobResource::Cpu, &["parent"]),
            job("grandchild", JobResource::Cpu, &["child"]),
        ])
        .unwrap();
    store.claim_ready(&ResourceLimits::default()).unwrap();
    store
        .fail(
            "parent",
            FailureKind::Permission,
            "폴더 접근 권한이 없습니다.",
        )
        .unwrap();
    assert_eq!(status(&store, "grandchild"), JobStatus::WaitingUser);
    store.resume_user("parent").unwrap();
    assert_eq!(status(&store, "child"), JobStatus::Pending);
    store.claim_ready(&ResourceLimits::default()).unwrap();
    store
        .fail(
            "parent",
            FailureKind::Input,
            "입력 파일을 디코딩할 수 없습니다.",
        )
        .unwrap();
    assert_eq!(status(&store, "grandchild"), JobStatus::Failed);
}

#[test]
fn transient_retries_are_bounded_with_two_four_eight_second_delays() {
    let store = memory_store();
    store
        .enqueue(job("network", JobResource::External, &[]))
        .unwrap();
    for attempt in 1..=4 {
        let claimed = store.claim_ready(&ResourceLimits::default()).unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].attempts, attempt);
        let before = Utc::now().timestamp_millis();
        store
            .fail("network", FailureKind::Network, "제출 전 연결 실패.")
            .unwrap();
        if attempt <= 3 {
            assert_eq!(status(&store, "network"), JobStatus::RetryWait);
            let connection = store.connection().unwrap();
            let available_at: i64 = connection
                .query_row(
                    "SELECT available_at_ms FROM scheduler_jobs WHERE id='network'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let delay = available_at - before;
            assert!((delay - (1_i64 << attempt) * 1000).abs() < 500);
            assert!(delay >= 1900);
            // Advance persisted availability rather than sleeping for 14 seconds.
            connection
                .execute(
                    "UPDATE scheduler_jobs SET available_at_ms=0 WHERE id='network'",
                    [],
                )
                .unwrap();
        } else {
            assert_eq!(status(&store, "network"), JobStatus::Failed);
            assert!(store
                .claim_ready(&ResourceLimits::default())
                .unwrap()
                .is_empty());
        }
    }
}

#[test]
fn external_submission_disconnect_requires_explicit_resubmission() {
    let store = memory_store();
    store
        .enqueue_many(vec![
            job("external", JobResource::External, &[]),
            job("output", JobResource::Cpu, &["external"]),
        ])
        .unwrap();
    store.claim_ready(&ResourceLimits::default()).unwrap();
    store.mark_external_submitted("external").unwrap();
    store
        .fail(
            "external",
            FailureKind::Network,
            "제출 후 연결이 끊겼습니다.",
        )
        .unwrap();
    assert_eq!(status(&store, "external"), JobStatus::ExternalUnknown);
    assert_eq!(status(&store, "output"), JobStatus::WaitingUser);
    assert!(store
        .claim_ready(&ResourceLimits::default())
        .unwrap()
        .is_empty());
    assert!(store.resume_user("external").is_err());
    assert!(store.rerun("external").is_err());
    assert!(store.resume_external("external", false).is_err());
    store.resume_external("external", true).unwrap();
    assert_eq!(status(&store, "external"), JobStatus::Ready);
    assert_eq!(status(&store, "output"), JobStatus::Pending);
}

#[test]
fn cancel_cascades_locally_without_claiming_remote_cancellation() {
    let store = memory_store();
    store
        .enqueue_many(vec![
            job("external", JobResource::External, &[]),
            job("local-child", JobResource::Cpu, &["external"]),
            job("grandchild", JobResource::Cpu, &["local-child"]),
            job("unrelated", JobResource::Cpu, &[]),
        ])
        .unwrap();
    store.claim_ready(&ResourceLimits::default()).unwrap();
    let changed = store.cancel("external").unwrap();
    assert_eq!(changed.len(), 3);
    assert_eq!(status(&store, "external"), JobStatus::ExternalUnknown);
    assert_eq!(status(&store, "grandchild"), JobStatus::Cancelled);
    assert_eq!(status(&store, "unrelated"), JobStatus::Running);
    let error = store
        .jobs()
        .unwrap()
        .into_iter()
        .find(|j| j.id == "external")
        .unwrap()
        .error
        .unwrap();
    assert!(error.contains("원격 취소는 확인되지"));
}

#[test]
fn cancelled_running_worker_retains_reservations_until_observed_exit() {
    let store = memory_store();
    store
        .enqueue_many(vec![
            job("running", JobResource::Cpu, &[]),
            job("next", JobResource::Cpu, &[]),
        ])
        .unwrap();
    let limits = ResourceLimits {
        cpu_jobs: 1,
        cpu_threads: 1,
        ..ResourceLimits::default()
    };
    store.claim_ready(&limits).unwrap();
    store.cancel("running").unwrap();
    assert_eq!(status(&store, "running"), JobStatus::Cancelled);
    assert_eq!(store.running_resources().unwrap().cpu_jobs, 1);
    assert!(store.claim_ready(&limits).unwrap().is_empty());
    assert!(store.rerun("running").is_err());
    store.release_cancelled_resources("running").unwrap();
    assert_eq!(store.running_resources().unwrap().cpu_jobs, 0);
    assert_eq!(store.claim_ready(&limits).unwrap()[0].id, "next");
}

#[test]
fn restart_releases_old_local_cancel_hold_but_retains_unknown_remote_slot() {
    let temp = TempDb::new();
    {
        let store = SchedulerStore::open(&temp.path()).unwrap();
        store
            .enqueue_many(vec![
                job("local", JobResource::Cpu, &[]),
                job("remote", JobResource::External, &[]),
            ])
            .unwrap();
        store.claim_ready(&ResourceLimits::default()).unwrap();
        store.cancel("local").unwrap();
    }
    let store = SchedulerStore::open(&temp.path()).unwrap();
    store.recover().unwrap();
    let usage = store.running_resources().unwrap();
    assert_eq!(
        (usage.cpu_jobs, usage.external_jobs, usage.ram_mb),
        (0, 1, 0)
    );
    store
        .enqueue(job("new-remote", JobResource::External, &[]))
        .unwrap();
    assert!(store
        .claim_ready(&ResourceLimits::default())
        .unwrap()
        .is_empty());
}

#[test]
fn rerun_invalidates_downstream_only_and_keeps_successful_upstream() {
    let store = memory_store();
    store
        .enqueue_many(vec![
            job("upstream", JobResource::Cpu, &[]),
            job("edit", JobResource::Cpu, &["upstream"]),
            job("validate", JobResource::Cpu, &["edit"]),
            job("unrelated", JobResource::Cpu, &[]),
        ])
        .unwrap();
    store.claim_ready(&ResourceLimits::default()).unwrap();
    store.complete("upstream").unwrap();
    store.complete("unrelated").unwrap();
    store.claim_ready(&ResourceLimits::default()).unwrap();
    store.complete("edit").unwrap();
    store.claim_ready(&ResourceLimits::default()).unwrap();
    store.complete("validate").unwrap();
    assert_eq!(store.rerun("edit").unwrap(), ["edit", "validate"]);
    assert_eq!(status(&store, "upstream"), JobStatus::Succeeded);
    assert_eq!(status(&store, "unrelated"), JobStatus::Succeeded);
    assert_eq!(status(&store, "edit"), JobStatus::Ready);
    assert_eq!(status(&store, "validate"), JobStatus::Pending);
}

#[test]
fn reopen_recovers_local_work_preserves_completed_artifacts_and_never_resends_external() {
    let temp = TempDb::new();
    let artifact = temp.directory.join("완료된 로컬 작업.txt");
    std::fs::write(&artifact, b"original artifact bytes preserved by scheduler").unwrap();
    {
        let store = SchedulerStore::open(&temp.path()).unwrap();
        store
            .enqueue_many(vec![
                job("done", JobResource::Cpu, &[]),
                job("local", JobResource::Cpu, &[]),
                job("external", JobResource::External, &[]),
                job("waiting", JobResource::Cpu, &["local"]),
            ])
            .unwrap();
        store.claim_ready(&ResourceLimits::default()).unwrap();
        store.complete("done").unwrap();
    }
    let store = SchedulerStore::open(&temp.path()).unwrap();
    store.recover().unwrap();
    assert_eq!(status(&store, "done"), JobStatus::Succeeded);
    assert_eq!(status(&store, "local"), JobStatus::Ready);
    assert_eq!(status(&store, "external"), JobStatus::ExternalUnknown);
    assert_eq!(status(&store, "waiting"), JobStatus::Pending);
    assert_eq!(
        std::fs::read(&artifact).unwrap(),
        b"original artifact bytes preserved by scheduler"
    );
    let claimed = store.claim_ready(&ResourceLimits::default()).unwrap();
    assert_eq!(
        claimed.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(),
        ["local"]
    );
}

#[test]
fn independent_database_handles_cannot_double_claim_or_exceed_resources() {
    let temp = TempDb::new();
    let first = Arc::new(SchedulerStore::open(&temp.path()).unwrap());
    let second = Arc::new(SchedulerStore::open(&temp.path()).unwrap());
    for id in ["a", "b", "c", "d"] {
        first.enqueue(job(id, JobResource::Cpu, &[])).unwrap();
    }
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = [first.clone(), second]
        .into_iter()
        .map(|store| {
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                store.claim_ready(&ResourceLimits::default()).unwrap()
            })
        })
        .collect();
    let claimed: Vec<_> = handles
        .into_iter()
        .flat_map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(claimed.len(), 2);
    assert_eq!(
        claimed
            .iter()
            .map(|j| j.id.clone())
            .collect::<HashSet<_>>()
            .len(),
        2
    );
    assert_eq!(first.running_resources().unwrap().cpu_jobs, 2);
}

#[test]
fn queue_is_bounded_and_cancel_frees_local_capacity() {
    let store = memory_store();
    store
        .enqueue_many(
            (0..QUEUE_CAPACITY)
                .map(|i| job(&format!("j{i}"), JobResource::Cpu, &[]))
                .collect(),
        )
        .unwrap();
    assert!(store
        .enqueue(job("overflow", JobResource::Cpu, &[]))
        .is_err());
    store.cancel("j0").unwrap();
    store.enqueue(job("new", JobResource::Cpu, &[])).unwrap();
    assert_eq!(store.jobs().unwrap().len(), QUEUE_CAPACITY + 1);
}

#[test]
fn known_failure_never_retries_and_progress_requires_confirmed_counts() {
    for kind in [
        FailureKind::Authentication,
        FailureKind::Permission,
        FailureKind::Unsupported,
        FailureKind::Input,
        FailureKind::Worker,
    ] {
        let store = memory_store();
        store.enqueue(job("local", JobResource::Cpu, &[])).unwrap();
        store.claim_ready(&ResourceLimits::default()).unwrap();
        assert!(store
            .set_progress("local", "render", Some(1), None)
            .is_err());
        assert!(store
            .set_progress("local", "render", Some(2), Some(1))
            .is_err());
        store
            .set_progress("local", "validated pixels", Some(1), Some(2))
            .unwrap();
        store
            .fail(
                "local",
                kind,
                "이 작업을 진행하려면 설정 또는 입력을 수정하세요.",
            )
            .unwrap();
        assert!(store
            .claim_ready(&ResourceLimits::default())
            .unwrap()
            .is_empty());
        assert_ne!(status(&store, "local"), JobStatus::RetryWait);
    }
}

#[test]
fn cache_identity_covers_prompt_input_order_options_and_versions_without_automatic_reuse() {
    let inputs = vec!["ab".repeat(32), "cd".repeat(32)];
    let options = json!({"a":1,"nested":{"z":2,"b":3}});
    let same = json!({"nested":{"b":3,"z":2},"a":1});
    let original = cache_key("prompt", &inputs, &options, "provider-v1", "tool-v1").unwrap();
    assert_eq!(
        original,
        cache_key("prompt", &inputs, &same, "provider-v1", "tool-v1").unwrap()
    );
    assert_ne!(
        original,
        cache_key("variation", &inputs, &options, "provider-v1", "tool-v1").unwrap()
    );
    assert_ne!(
        original,
        cache_key("prompt", &inputs, &options, "provider-v2", "tool-v1").unwrap()
    );
    assert_ne!(
        original,
        cache_key("prompt", &inputs, &options, "provider-v1", "tool-v2").unwrap()
    );
    assert_ne!(
        original,
        cache_key(
            "prompt",
            &inputs.iter().cloned().rev().collect::<Vec<_>>(),
            &options,
            "provider-v1",
            "tool-v1"
        )
        .unwrap()
    );
    assert!(cache_key("prompt", &["invalid".into()], &options, "p", "t").is_err());
    let store = memory_store();
    for id in ["first", "second"] {
        let mut queued = job(id, JobResource::Cpu, &[]);
        queued.cache_key = Some(original.clone());
        store.enqueue(queued).unwrap();
    }
    assert_eq!(
        store.claim_ready(&ResourceLimits::default()).unwrap().len(),
        2
    );
}

#[test]
fn independent_local_hash_work_overlaps_with_real_threads_inside_resource_limits() {
    let store = Arc::new(memory_store());
    store
        .enqueue_many(vec![
            job("hash-a", JobResource::Cpu, &[]),
            job("hash-b", JobResource::Cpu, &[]),
        ])
        .unwrap();
    let claimed = store.claim_ready(&ResourceLimits::default()).unwrap();
    let barrier = Arc::new(Barrier::new(claimed.len()));
    let started = Instant::now();
    let handles: Vec<_> = claimed
        .into_iter()
        .enumerate()
        .map(|(index, queued)| {
            let store = store.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                let input = vec![index as u8; 1024 * 1024];
                barrier.wait();
                let started_at = Instant::now();
                let mut digest = Sha256::new();
                for _ in 0..32 {
                    digest.update(&input);
                }
                let hash = format!("{:x}", digest.finalize());
                let finished_at = Instant::now();
                store.complete(&queued.id).unwrap();
                (started_at, finished_at, hash)
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert!(
        results[0].0 < results[1].1 && results[1].0 < results[0].1,
        "independent work intervals must overlap"
    );
    assert_ne!(results[0].2, results[1].2);
    assert_eq!(store.running_resources().unwrap().cpu_jobs, 0);
    assert!(store
        .jobs()
        .unwrap()
        .iter()
        .all(|j| j.status == JobStatus::Succeeded));
    println!(
        "{}",
        json!({"kind":"scheduler_hash_overlap","jobs":2,"confirmedOverlap":true,"wallMs":started.elapsed().as_millis(),"actualBuffersBytes":2*1024*1024,"configuredCpuThreads":2})
    );
}

#[test]
fn durable_event_cursor_and_small_pages_survive_reopen() {
    let temporary = TempDb::new();
    let store = SchedulerStore::open(&temporary.path()).unwrap();
    let mut input = job("first", JobResource::Cpu, &[]);
    input
        .payload
        .insert("prompt".into(), json!("private prompt never in an event"));
    store
        .enqueue_many(vec![
            input,
            job("second", JobResource::Cpu, &[]),
            job("third", JobResource::Cpu, &[]),
        ])
        .unwrap();
    let first = store.events_after(0, 2).unwrap();
    assert_eq!(first.events.len(), 2);
    assert!(first.has_more);
    assert_eq!(first.next_cursor, first.events[1].cursor);
    assert!(first.events.windows(2).all(|w| w[0].cursor < w[1].cursor));
    assert_eq!(first.events[0].kind, JobEventKind::Enqueued);
    let json = serde_json::to_string(&first).unwrap();
    assert!(json.contains("nextCursor"));
    assert!(!json.contains("private prompt"));
    drop(store);
    let store = SchedulerStore::open(&temporary.path()).unwrap();
    let next = store.events_after(first.next_cursor, 1).unwrap();
    assert_eq!(next.events[0].job_id, "third");
    assert!(!next.has_more);
    assert_eq!(
        store.events_after(next.next_cursor, 1).unwrap().next_cursor,
        next.next_cursor
    );
    let limits = ResourceLimits {
        cpu_jobs: 1,
        ..ResourceLimits::default()
    };
    store.claim_ready(&limits).unwrap();
    let running = store.events_after(next.next_cursor, 1).unwrap();
    assert_eq!(running.events[0].previous_status, Some(JobStatus::Ready));
    assert_eq!(running.events[0].status, JobStatus::Running);
    assert_eq!(running.events[0].attempts, 1);
    assert!(running.events[0].cursor > next.next_cursor);
    for limit in [0, MAX_PAGE_SIZE + 1] {
        assert!(store.events_after(0, limit).is_err());
        assert!(store.jobs_page(0, limit).is_err());
    }
    assert!(store.events_after(u64::MAX, 1).is_err());
    assert!(store.jobs_page(u64::MAX, 1).is_err());
}

#[test]
fn keyset_job_pagination_is_stable_across_state_changes_and_new_insertions() {
    let store = memory_store();
    store
        .enqueue_many(
            (0..5)
                .map(|i| job(&format!("job-{i}"), JobResource::Cpu, &[]))
                .collect(),
        )
        .unwrap();
    let first = store.jobs_page(0, 2).unwrap();
    assert_eq!(
        first.jobs.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(),
        ["job-0", "job-1"]
    );
    assert!(first.has_more);
    store.claim_ready(&ResourceLimits::default()).unwrap();
    store.complete("job-0").unwrap();
    store
        .enqueue(job("new-job", JobResource::Cpu, &[]))
        .unwrap();
    let second = store.jobs_page(first.next_cursor, 2).unwrap();
    let third = store.jobs_page(second.next_cursor, 2).unwrap();
    assert_eq!(
        second
            .jobs
            .iter()
            .map(|j| j.id.as_str())
            .collect::<Vec<_>>(),
        ["job-2", "job-3"]
    );
    assert_eq!(
        third.jobs.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(),
        ["job-4", "new-job"]
    );
    assert!(!third.has_more);
    assert!(store
        .jobs_page(third.next_cursor, 2)
        .unwrap()
        .jobs
        .is_empty());
}

#[test]
fn event_write_failure_rolls_back_claim_enqueue_and_request_identity() {
    let store = memory_store();
    store.enqueue(job("first", JobResource::Cpu, &[])).unwrap();
    let cursor = store.events_after(0, 32).unwrap().next_cursor;
    store.connection().unwrap().execute_batch("CREATE TRIGGER reject_scheduler_event BEFORE INSERT ON scheduler_events BEGIN SELECT RAISE(ABORT,'injected event write failure'); END;").unwrap();
    assert!(store.claim_ready(&ResourceLimits::default()).is_err());
    assert_eq!(status(&store, "first"), JobStatus::Ready);
    assert_eq!(store.jobs().unwrap()[0].attempts, 0);
    assert_eq!(store.events_after(0, 32).unwrap().next_cursor, cursor);
    assert!(store
        .enqueue_once("request-atomic", job("second", JobResource::Cpu, &[]))
        .is_err());
    assert_eq!(store.jobs().unwrap().len(), 1);
    let requests: i64 = store
        .connection()
        .unwrap()
        .query_row("SELECT count(*) FROM scheduler_requests", [], |r| r.get(0))
        .unwrap();
    assert_eq!(requests, 0);
    store
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_scheduler_event;")
        .unwrap();
    let receipt = store
        .enqueue_once("request-atomic", job("second", JobResource::Cpu, &[]))
        .unwrap();
    assert!(!receipt.replayed);
    assert_eq!(store.events_after(cursor, 10).unwrap().events.len(), 1);
}

#[test]
fn only_changed_rows_are_written_and_repeated_completion_creates_no_event() {
    let store = memory_store();
    store
        .enqueue_many(vec![
            job("first", JobResource::Cpu, &[]),
            job("second", JobResource::Cpu, &[]),
        ])
        .unwrap();
    store.connection().unwrap().execute_batch("CREATE TABLE update_audit(id TEXT); CREATE TRIGGER audit_changed_jobs AFTER UPDATE ON scheduler_jobs BEGIN INSERT INTO update_audit VALUES (NEW.id); END;").unwrap();
    store
        .claim_ready(&ResourceLimits {
            cpu_jobs: 1,
            ..ResourceLimits::default()
        })
        .unwrap();
    store.complete("first").unwrap();
    let cursor = store.events_after(0, 32).unwrap().next_cursor;
    store.complete("first").unwrap();
    store.recover().unwrap();
    let updates: Vec<String> = {
        let connection = store.connection().unwrap();
        let mut statement = connection.prepare("SELECT id FROM update_audit").unwrap();
        statement
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    assert_eq!(updates, ["first", "first"]);
    assert_eq!(store.events_after(0, 32).unwrap().next_cursor, cursor);
}

#[test]
fn admission_capacity_is_persisted_shared_and_counts_cancelled_worker_holds() {
    let temporary = TempDb::new();
    let store = SchedulerStore::open_with_options(
        &temporary.path(),
        &SchedulerOptions { queue_capacity: 2 },
    )
    .unwrap();
    let second = SchedulerStore::open(&temporary.path()).unwrap();
    assert_eq!(second.queue_capacity().unwrap(), 2);
    store
        .enqueue_many(vec![
            job("a", JobResource::Cpu, &[]),
            job("b", JobResource::Cpu, &[]),
        ])
        .unwrap();
    let before = store.events_after(0, 32).unwrap().next_cursor;
    assert!(second
        .enqueue(job("overflow", JobResource::Cpu, &[]))
        .is_err());
    assert!(second.set_queue_capacity(1).is_err());
    assert_eq!(store.events_after(0, 32).unwrap().next_cursor, before);
    store.claim_ready(&ResourceLimits::default()).unwrap();
    store.cancel("a").unwrap();
    assert!(second
        .enqueue(job("replacement", JobResource::Cpu, &[]))
        .is_err());
    store.release_cancelled_resources("a").unwrap();
    second.set_queue_capacity(1).unwrap();
    assert_eq!(store.queue_capacity().unwrap(), 1);
    store.complete("b").unwrap();
    assert!(store.rerun("a").is_ok());
    assert!(store.rerun("b").is_err());
    for capacity in [0, MAX_QUEUE_CAPACITY + 1] {
        assert!(store.set_queue_capacity(capacity).is_err());
    }
    drop(store);
    drop(second);
    assert_eq!(
        SchedulerStore::open(&temporary.path())
            .unwrap()
            .queue_capacity()
            .unwrap(),
        1
    );
}

fn idempotent_batch(prefix: &str) -> Vec<Job> {
    let a = format!("{prefix}-process");
    let b = format!("{prefix}-validate");
    let mut first = job(&a, JobResource::Cpu, &[]);
    first.label = "process".into();
    first
        .payload
        .insert("prompt".into(), json!("one user action"));
    let mut second = job(&b, JobResource::Cpu, &[&a]);
    second.label = "validate".into();
    second.payload.insert("processJobId".into(), json!(a));
    vec![first, second]
}

#[test]
fn one_request_deduplicates_a_whole_graph_and_new_request_creates_a_variation() {
    let temporary = TempDb::new();
    let store = SchedulerStore::open_with_options(
        &temporary.path(),
        &SchedulerOptions { queue_capacity: 2 },
    )
    .unwrap();
    let first = store
        .enqueue_many_once("action-1", idempotent_batch("original"))
        .unwrap();
    assert!(!first.replayed);
    let cursor = store.events_after(0, 32).unwrap().next_cursor;
    let repeated = store
        .enqueue_many_once("action-1", idempotent_batch("retry-new-uuid"))
        .unwrap();
    assert!(repeated.replayed);
    assert_eq!(repeated.job_ids, first.job_ids);
    assert_eq!(store.jobs().unwrap().len(), 2);
    assert_eq!(store.events_after(0, 32).unwrap().next_cursor, cursor);
    let mut different = idempotent_batch("different");
    different[0]
        .payload
        .insert("prompt".into(), json!("different semantic action"));
    assert!(store.enqueue_many_once("action-1", different).is_err());
    assert!(store
        .enqueue_many_once("action-2", idempotent_batch("variation"))
        .is_err());
    store.cancel("original-process").unwrap();
    assert!(
        !store
            .enqueue_many_once("action-2", idempotent_batch("variation"))
            .unwrap()
            .replayed
    );
    drop(store);
    let reopened = SchedulerStore::open(&temporary.path()).unwrap();
    assert_eq!(
        reopened
            .enqueue_many_once("action-1", idempotent_batch("reopened"))
            .unwrap()
            .job_ids,
        first.job_ids
    );
    assert!(reopened.enqueue_many_once("empty", vec![]).is_err());
}

#[test]
fn concurrent_request_replays_cannot_duplicate_admission() {
    let temporary = TempDb::new();
    let a = SchedulerStore::open(&temporary.path()).unwrap();
    let b = SchedulerStore::open(&temporary.path()).unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let handles = [a, b]
        .into_iter()
        .enumerate()
        .map(|(i, store)| {
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                store
                    .enqueue_many_once("shared-action", idempotent_batch(&format!("worker-{i}")))
                    .unwrap()
            })
        })
        .collect::<Vec<_>>();
    let receipts = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(receipts[0].job_ids, receipts[1].job_ids);
    assert_ne!(receipts[0].replayed, receipts[1].replayed);
    let store = SchedulerStore::open(&temporary.path()).unwrap();
    assert_eq!(store.jobs().unwrap().len(), 2);
    assert_eq!(store.events_after(0, 32).unwrap().events.len(), 2);
}

#[test]
fn external_identity_is_durable_even_when_local_cancel_wins_the_race() {
    let temporary = TempDb::new();
    let store = SchedulerStore::open(&temporary.path()).unwrap();
    store
        .enqueue(job("external", JobResource::External, &[]))
        .unwrap();
    store.claim_ready(&ResourceLimits::default()).unwrap();
    assert!(store.confirm_external_cancelled("external").is_err());
    store.cancel("external").unwrap();
    store
        .set_external_identity("external", "thread-123", "turn-1")
        .unwrap();
    assert_eq!(status(&store, "external"), JobStatus::ExternalUnknown);
    assert_eq!(store.running_resources().unwrap().external_jobs, 1);
    let event = store.events_after(0, 32).unwrap().events.pop().unwrap();
    assert_eq!(event.external_identity.unwrap().turn_id, "turn-1");
    let cursor = event.cursor;
    store
        .set_external_identity("external", "thread-123", "turn-1")
        .unwrap();
    assert_eq!(store.events_after(0, 32).unwrap().next_cursor, cursor);
    assert!(store
        .set_external_identity("external", "different-thread", "turn-2")
        .is_err());
    assert!(store
        .set_external_identity("external", "https://provider.invalid/token", "turn")
        .is_err());
    drop(store);
    let store = SchedulerStore::open(&temporary.path()).unwrap();
    store.recover().unwrap();
    let identity = events::external_identity(&store.jobs().unwrap()[0]).unwrap();
    assert_eq!(identity.thread_id, "thread-123");
    store.confirm_external_cancelled("external").unwrap();
    assert_eq!(status(&store, "external"), JobStatus::Cancelled);
    assert_eq!(store.running_resources().unwrap().external_jobs, 0);
    let confirmed_cursor = store.events_after(0, 32).unwrap().next_cursor;
    store.confirm_external_cancelled("external").unwrap();
    assert_eq!(
        store.events_after(0, 32).unwrap().next_cursor,
        confirmed_cursor
    );
    assert!(store.complete("external").is_err());
}

#[test]
fn migration_records_an_honest_current_snapshot_and_preserves_other_tables() {
    let temporary = TempDb::new();
    let connection = Connection::open(temporary.path()).unwrap();
    connection.execute_batch("CREATE TABLE scheduler_metadata(key TEXT PRIMARY KEY,value INTEGER NOT NULL); INSERT INTO scheduler_metadata VALUES('schema_version',1); CREATE TABLE scheduler_jobs(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,resource TEXT NOT NULL,available_at_ms INTEGER NOT NULL,document TEXT NOT NULL); CREATE TABLE project_owned(value TEXT); INSERT INTO project_owned VALUES('preserved'); PRAGMA user_version=37;").unwrap();
    let mut original = job("old", JobResource::Cpu, &[]);
    original.status = JobStatus::Succeeded;
    connection.execute("INSERT INTO scheduler_jobs(id,status,resource,available_at_ms,document) VALUES (?1,'succeeded','cpu',0,?2)", params![original.id, serde_json::to_string(&original).unwrap()]).unwrap();
    drop(connection);
    let store = SchedulerStore::open(&temporary.path()).unwrap();
    let events = store.events_after(0, 32).unwrap().events;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, JobEventKind::Snapshot);
    assert_eq!(events[0].status, JobStatus::Succeeded);
    assert_eq!(events[0].previous_status, None);
    assert_eq!(
        store
            .connection()
            .unwrap()
            .query_row("SELECT value FROM project_owned", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "preserved"
    );
    assert_eq!(
        store
            .connection()
            .unwrap()
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        37
    );
    drop(store);
    assert_eq!(
        SchedulerStore::open(&temporary.path())
            .unwrap()
            .events_after(0, 32)
            .unwrap()
            .events
            .len(),
        1
    );
}

#[test]
fn external_submission_identity_and_event_rollback_together() {
    let store = memory_store();
    store
        .enqueue(job("external", JobResource::External, &[]))
        .unwrap();
    store.claim_ready(&ResourceLimits::default()).unwrap();
    let cursor = store.events_after(0, 32).unwrap().next_cursor;
    store.connection().unwrap().execute_batch("CREATE TRIGGER reject_identity_event BEFORE INSERT ON scheduler_events BEGIN SELECT RAISE(ABORT,'identity event failure'); END;").unwrap();
    assert!(store
        .set_external_identity("external", "thread-a", "turn-a")
        .is_err());
    let job = store.jobs().unwrap().remove(0);
    assert!(!job.payload.contains_key("externalSubmitted"));
    assert!(events::external_identity(&job).is_none());
    assert_eq!(store.events_after(0, 32).unwrap().next_cursor, cursor);
    store
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_identity_event;")
        .unwrap();
    store
        .set_external_identity("external", "thread-a", "turn-a")
        .unwrap();
    let event = store.events_after(cursor, 1).unwrap().events.pop().unwrap();
    assert_eq!(event.status, JobStatus::Running);
    assert_eq!(event.progress.stage, "external_submitted");
    assert_eq!(event.external_identity.unwrap().turn_id, "turn-a");
    store
        .fail("external", FailureKind::Network, "transport disconnected")
        .unwrap();
    assert_eq!(status(&store, "external"), JobStatus::ExternalUnknown);
    store.resume_external("external", true).unwrap();
    assert!(events::external_identity(&store.jobs().unwrap()[0]).is_none());
    store.claim_ready(&ResourceLimits::default()).unwrap();
    store
        .set_external_identity("external", "thread-b", "turn-b")
        .unwrap();
}

#[test]
fn newer_schema_is_rejected_without_replacing_its_data() {
    let temporary = TempDb::new();
    let connection = Connection::open(temporary.path()).unwrap();
    connection.execute_batch("CREATE TABLE scheduler_metadata(key TEXT PRIMARY KEY,value INTEGER NOT NULL); INSERT INTO scheduler_metadata VALUES('schema_version',99); CREATE TABLE future_owned(value TEXT); INSERT INTO future_owned VALUES('future data');").unwrap();
    drop(connection);
    assert!(SchedulerStore::open(&temporary.path()).is_err());
    let connection = Connection::open(temporary.path()).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT value FROM scheduler_metadata WHERE key='schema_version'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        99
    );
    assert_eq!(
        connection
            .query_row("SELECT value FROM future_owned", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "future data"
    );
    let scheduler_jobs: i64 = connection
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='scheduler_jobs'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(scheduler_jobs, 0);
}

#[test]
fn rerun_gets_a_new_execution_uuid_despite_reset_attempts_and_clears_remote_identity() {
    let store = memory_store();
    let mut input = job("external", JobResource::External, &[]);
    input.payload.insert(
        "executionId".into(),
        json!("caller-cannot-select-execution"),
    );
    store.enqueue_once("one-action", input.clone()).unwrap();
    assert!(!store.jobs().unwrap()[0].payload.contains_key("executionId"));
    let first = store
        .claim_ready(&ResourceLimits::default())
        .unwrap()
        .remove(0);
    let first_id = first.payload["executionId"].as_str().unwrap();
    assert!(uuid::Uuid::parse_str(first_id).is_ok());
    assert_eq!(first.attempts, 1);
    store
        .set_external_identity("external", "old-thread", "old-turn")
        .unwrap();
    store.complete("external").unwrap();
    store.rerun("external").unwrap();
    let queued = store.jobs().unwrap().remove(0);
    assert_eq!(queued.attempts, 0);
    assert!(!queued.payload.contains_key("executionId"));
    assert!(!queued.payload.contains_key("externalSubmitted"));
    assert!(events::external_identity(&queued).is_none());
    let second = store
        .claim_ready(&ResourceLimits::default())
        .unwrap()
        .remove(0);
    let second_id = second.payload["executionId"].as_str().unwrap();
    assert_eq!(second.attempts, 1);
    assert!(uuid::Uuid::parse_str(second_id).is_ok());
    assert_ne!(first_id, second_id);
    assert!(events::external_identity(&second).is_none());
    store
        .set_external_identity("external", "new-thread", "new-turn")
        .unwrap();
    input.payload.insert(
        "executionId".into(),
        json!(uuid::Uuid::new_v4().to_string()),
    );
    let replay = store.enqueue_once("one-action", input).unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.job_id, "external");
    assert_eq!(
        store.jobs().unwrap()[0].payload["executionId"],
        second.payload["executionId"]
    );
}

#[test]
fn retry_and_crash_recovery_claims_get_distinct_durable_execution_ids() {
    let temporary = TempDb::new();
    let store = SchedulerStore::open(&temporary.path()).unwrap();
    store.enqueue(job("local", JobResource::Cpu, &[])).unwrap();
    let first = store
        .claim_ready(&ResourceLimits::default())
        .unwrap()
        .remove(0);
    store
        .fail("local", FailureKind::Network, "definite pre-submit failure")
        .unwrap();
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE scheduler_jobs SET available_at_ms=0 WHERE id='local'",
            [],
        )
        .unwrap();
    let retry = store
        .claim_ready(&ResourceLimits::default())
        .unwrap()
        .remove(0);
    assert_eq!(retry.attempts, 2);
    assert_ne!(first.payload["executionId"], retry.payload["executionId"]);
    drop(store);
    let recovered = SchedulerStore::open(&temporary.path()).unwrap();
    // Keep the interrupted id until the next claim so commit recovery can match
    // an already committed result before deciding to run local work again.
    assert_eq!(
        recovered.jobs().unwrap()[0].payload["executionId"],
        retry.payload["executionId"]
    );
    recovered.recover().unwrap();
    let next = recovered
        .claim_ready(&ResourceLimits::default())
        .unwrap()
        .remove(0);
    assert_eq!(next.attempts, 3);
    let ids = [
        first.payload["executionId"].as_str().unwrap(),
        retry.payload["executionId"].as_str().unwrap(),
        next.payload["executionId"].as_str().unwrap(),
    ];
    assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 3);
    drop(recovered);
    assert_eq!(
        SchedulerStore::open(&temporary.path())
            .unwrap()
            .jobs()
            .unwrap()[0]
            .payload["executionId"],
        next.payload["executionId"]
    );
}
