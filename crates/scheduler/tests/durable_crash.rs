//! Starts a real native child and exits without Rust destructors while SQLite
//! has an uncommitted write. This verifies disk/WAL recovery, not just Drop.
use anyhow::Result;
use asset_core::models::{Job, JobProgress, JobResource, JobStatus};
use asset_scheduler::{ResourceLimits, SchedulerStore};
use rusqlite::{params, Connection};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;

const CHILD_ENV: &str = "ASSET_SCHEDULER_CRASH_FIXTURE";
const EXIT_CODE: i32 = 73;

fn fixture_job(id: &str, resource: JobResource) -> Job {
    Job {
        id: id.into(),
        project_id: "crash-fixture".into(),
        asset_id: None,
        kind: "native_crash_fixture".into(),
        label: id.into(),
        status: JobStatus::Pending,
        dependencies: vec![],
        resource,
        attempts: 0,
        created_at: chrono::Utc::now().to_rfc3339(),
        started_at: None,
        finished_at: None,
        error: None,
        progress: JobProgress {
            stage: "queued".into(),
            completed: None,
            total: None,
        },
        payload: BTreeMap::new(),
        cache_key: None,
    }
}

#[test]
fn abrupt_exit_fixture_child() -> Result<()> {
    let Some(directory) = std::env::var_os(CHILD_ENV).map(PathBuf::from) else {
        return Ok(());
    };
    let path = directory.join("crash.sqlite");
    let store = SchedulerStore::open(&path)?;
    store.enqueue(fixture_job("validated-output", JobResource::Cpu))?;
    store.claim_ready(&ResourceLimits::default())?;
    std::fs::write(
        directory.join("validated-output.txt"),
        b"actual preserved fixture bytes\0\r\n",
    )?;
    store.complete("validated-output")?;
    store.enqueue_many(vec![
        fixture_job("local-interrupted", JobResource::Cpu),
        fixture_job("external-interrupted", JobResource::External),
    ])?;
    store.claim_ready(&ResourceLimits::default())?;
    // Local fixture identity only; no external service is contacted or simulated.
    store.set_external_identity("external-interrupted", "fixture-thread", "fixture-turn")?;
    let mut connection = Connection::open(&path)?;
    let tx = connection.transaction()?;
    tx.execute(
        "UPDATE scheduler_jobs SET status='failed' WHERE id='local-interrupted'",
        [],
    )?;
    tx.execute(
        "INSERT INTO scheduler_events(job_id,document) VALUES (?1,?2)",
        params!["uncommitted", json!({"mustNotSurvive":true}).to_string()],
    )?;
    // std::process::exit skips all Rust destructors, including transaction Drop.
    // OS closes the SQLite handles; recovery must discard the unfinished write.
    std::process::exit(EXIT_CODE);
}

struct CrashDirectory(PathBuf);
impl CrashDirectory {
    fn new() -> Result<Self> {
        let path =
            std::env::temp_dir().join(format!("asset-scheduler-crash-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path)?;
        Ok(Self(path))
    }
}
impl Drop for CrashDirectory {
    fn drop(&mut self) {
        if self.0.starts_with(std::env::temp_dir())
            && self
                .0
                .file_name()
                .is_some_and(|p| p.to_string_lossy().starts_with("asset-scheduler-crash-"))
        {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[test]
fn committed_jobs_events_and_identity_survive_abrupt_process_exit() -> Result<()> {
    let directory = CrashDirectory::new()?;
    let mut child = Command::new(std::env::current_exe()?);
    child
        .args(["--exact", "abrupt_exit_fixture_child", "--nocapture"])
        .env(CHILD_ENV, &directory.0);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        child.creation_flags(0x0800_0000);
    }
    let result = child.output()?;
    assert_eq!(
        result.status.code(),
        Some(EXIT_CODE),
        "child must exit abruptly after its uncommitted write: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let store = SchedulerStore::open(&directory.0.join("crash.sqlite"))?;
    let before = store.events_after(0, 256)?;
    assert_eq!(before.events.len(), 8);
    assert!(before.events.iter().all(|e| e.job_id != "uncommitted"));
    assert_eq!(
        before
            .events
            .last()
            .unwrap()
            .external_identity
            .as_ref()
            .unwrap()
            .turn_id,
        "fixture-turn"
    );
    store.recover()?;
    let jobs = store.jobs()?;
    let find = |id: &str| jobs.iter().find(|j| j.id == id).unwrap();
    assert_eq!(find("validated-output").status, JobStatus::Succeeded);
    assert_eq!(find("local-interrupted").status, JobStatus::Ready);
    assert_eq!(
        find("external-interrupted").status,
        JobStatus::ExternalUnknown
    );
    assert_eq!(
        find("external-interrupted").payload["externalTurnId"],
        json!("fixture-turn")
    );
    assert_eq!(store.running_resources()?.external_jobs, 1);
    assert_eq!(
        std::fs::read(directory.0.join("validated-output.txt"))?,
        b"actual preserved fixture bytes\0\r\n"
    );
    let recovery = store.events_after(before.next_cursor, 256)?;
    assert_eq!(recovery.events.len(), 2);
    assert!(recovery
        .events
        .iter()
        .all(|e| e.cursor > before.next_cursor));
    let cursor = recovery.next_cursor;
    drop(store);
    let reopened = SchedulerStore::open(&directory.0.join("crash.sqlite"))?;
    assert!(reopened.events_after(cursor, 256)?.events.is_empty());
    let claimed = reopened.claim_ready(&ResourceLimits::default())?;
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].id, "local-interrupted");
    println!(
        "{}",
        json!({"kind":"scheduler_abrupt_exit_recovery","nativePlatform":std::env::consts::OS,"abruptExitCode":EXIT_CODE,"committedEvents":before.events.len(),"uncommittedWritesDiscarded":true,"externalIdentityRetained":true,"externalResubmitted":false,"preservedArtifactBytes":std::fs::metadata(directory.0.join("validated-output.txt"))?.len()})
    );
    Ok(())
}
