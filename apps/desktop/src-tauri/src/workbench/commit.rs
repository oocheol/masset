//! Durable evidence between successful output persistence and queue completion.
//! The caller must hold project ownership; recovery runs before admission and
//! before SchedulerStore::recover. A crash before marker publication remains an
//! unfinished job. An absent/invalid marker never proves completion.
use anyhow::{ensure, Context, Result};
use asset_core::models::{
    Artifact, AssetSource, AssetVersion, Job, JobStatus, Project, ValidationReport,
    ValidationStatus,
};
use asset_core::Repository;
use asset_scheduler::SchedulerStore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const DIRECTORY: &str = ".workbench-commits";
const FORMAT: &str = "asset-studio/job-commit";
const SCHEMA_VERSION: u32 = 2;
const MAX_MARKER_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommitMarker {
    format: String,
    schema_version: u32,
    project_id: String,
    job_id: String,
    execution_id: String,
    attempts: u32,
    cache_key: Option<String>,
    kind: String,
    asset_id: Option<String>,
    versions: Vec<VersionProof>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionProof {
    asset_id: String,
    version_id: String,
    output_job_id: String,
    output_execution_id: Option<String>,
    version_cache_key: Value,
    source: AssetSource,
    requested_model: Option<String>,
    confirmed_model: Option<String>,
    provider_version: Option<String>,
    artifacts: Vec<Artifact>,
    // A validator's result must remain the exact report stamped by that job.
    // Producer reports may later be replaced by their downstream validator.
    validation: Option<ValidationReport>,
}

/// Call only after all output/validation writes for this attempt have succeeded.
/// Cancellation is checked against the authoritative queue before publication.
pub fn record_commit(root: &Path, task: &Job) -> Result<()> {
    let repository = Repository::open(root)?;
    let project = repository.project()?;
    ensure!(
        project.id == task.project_id,
        "commit belongs to another project"
    );
    ensure!(
        task.attempts > 0,
        "only an admitted job attempt can be committed"
    );
    let queue = SchedulerStore::open(&repository.root().join("scheduler.sqlite"))?;
    let current = queue
        .jobs()?
        .into_iter()
        .find(|job| job.id == task.id)
        .context("commit job is not in the project queue")?;
    ensure!(
        same_attempt(&current, task) && current.status == JobStatus::Running,
        "cancelled, uncertain or changed job attempts cannot publish a commit"
    );
    let marker = marker_for(&project, &repository, task)?;
    let directory =
        marker_directory(repository.root(), true)?.context("commit directory was not created")?;
    let destination = marker_path(&directory, task)?;
    if fs::symlink_metadata(&destination).is_ok() {
        ensure!(
            read_marker(&destination)? == marker,
            "existing commit evidence differs; it was preserved"
        );
        return Ok(());
    }
    let bytes = serde_json::to_vec_pretty(&marker)?;
    ensure!(
        bytes.len() as u64 <= MAX_MARKER_BYTES,
        "commit evidence exceeds its storage limit"
    );
    let temporary = directory.join(format!(".new-{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let written = file.write_all(&bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error).context("cannot write complete commit evidence");
    }
    // Project ownership and single admission per job prevent another publisher
    // for this exact attempt. Preserve any unexpected existing destination.
    if fs::symlink_metadata(&destination).is_ok() {
        let _ = fs::remove_file(&temporary);
        ensure!(
            read_marker(&destination)? == marker,
            "commit destination appeared with different evidence"
        );
        return Ok(());
    }
    if let Err(error) = fs::rename(&temporary, &destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error).context("cannot publish commit evidence");
    }
    #[cfg(unix)]
    File::open(&directory)?
        .sync_all()
        .context("cannot sync commit directory")?;
    Ok(())
}

/// Complete only running attempts with intact, matching, fully published proof.
/// Malformed/partial/stale/tampered markers are preserved and do not recover a
/// job. ExternalUnknown and Cancelled are never changed by this helper.
pub fn recover_commits(root: &Path) -> Result<usize> {
    let repository = Repository::open(root)?;
    let project = repository.project()?;
    let Some(directory) = marker_directory(repository.root(), false)? else {
        return Ok(0);
    };
    let queue = SchedulerStore::open(&repository.root().join("scheduler.sqlite"))?;
    let mut recovered = 0;
    for task in queue
        .jobs()?
        .into_iter()
        .filter(|job| job.status == JobStatus::Running)
    {
        let verified = (|| -> Result<()> {
            let marker = read_marker(&marker_path(&directory, &task)?)?;
            let expected = marker_for(&project, &repository, &task)?;
            ensure!(
                marker == expected,
                "commit marker is partial, stale or changed"
            );
            Ok(())
        })();
        if verified.is_ok() {
            // Caller holds the exclusive lease and blocks dispatch/requests;
            // no worker or cancellation may race this startup reconciliation.
            queue.complete(&task.id)?;
            recovered += 1;
        }
    }
    Ok(recovered)
}

fn same_attempt(left: &Job, right: &Job) -> bool {
    left.id == right.id
        && left.project_id == right.project_id
        && left.payload.get("executionId") == right.payload.get("executionId")
        && left.attempts == right.attempts
        && left.cache_key == right.cache_key
        && left.kind == right.kind
        && left.asset_id == right.asset_id
}

fn marker_for(project: &Project, repository: &Repository, task: &Job) -> Result<CommitMarker> {
    ensure!(
        task.project_id == project.id && task.attempts > 0,
        "commit job identity does not match the project"
    );
    let execution_id = execution_id(task)?;
    let mut versions = Vec::new();
    if task.kind == "image_validate" {
        let asset_id = task
            .asset_id
            .as_ref()
            .context("validator asset identity is missing")?;
        let producer = task
            .payload
            .get("processJobId")
            .and_then(Value::as_str)
            .context("validator producer identity is missing")?;
        let asset = project
            .assets
            .iter()
            .find(|asset| &asset.id == asset_id)
            .context("validated asset is no longer in the project")?;
        let version = asset
            .versions
            .iter()
            .filter(|version| {
                version.settings.get("jobId").and_then(Value::as_str) == Some(producer)
            })
            .max_by_key(|version| version.number)
            .context("validated version is missing")?;
        ensure!(
            version
                .settings
                .get("validationJobId")
                .and_then(Value::as_str)
                == Some(task.id.as_str())
                && version
                    .settings
                    .get("validationAttempt")
                    .and_then(Value::as_u64)
                    == Some(u64::from(task.attempts))
                && version
                    .settings
                    .get("validationExecutionId")
                    .and_then(Value::as_str)
                    == Some(execution_id),
            "validation was not persisted by this job attempt"
        );
        let report = valid_report(version)?;
        verify_files(repository, version)?;
        versions.push(proof(&asset.id, version, producer, Some(report.clone())));
    } else {
        for asset in &project.assets {
            for version in &asset.versions {
                if version.settings.get("jobId").and_then(Value::as_str) == Some(task.id.as_str())
                    && version.settings.get("executionId").and_then(Value::as_str)
                        == Some(execution_id)
                {
                    ensure!(
                        version.settings.get("cacheKey") == Some(&json!(task.cache_key)),
                        "output version does not match the committed cache identity"
                    );
                    valid_report(version)?;
                    verify_files(repository, version)?;
                    super::production::verify_delivery(task, version)?;
                    versions.push(proof(&asset.id, version, &task.id, None));
                }
            }
        }
    }
    ensure!(
        !versions.is_empty(),
        "a successful job needs persisted output or validation evidence"
    );
    versions.sort_by(|left, right| {
        (&left.asset_id, &left.version_id).cmp(&(&right.asset_id, &right.version_id))
    });
    Ok(CommitMarker {
        format: FORMAT.into(),
        schema_version: SCHEMA_VERSION,
        project_id: project.id.clone(),
        job_id: task.id.clone(),
        execution_id: execution_id.into(),
        attempts: task.attempts,
        cache_key: task.cache_key.clone(),
        kind: task.kind.clone(),
        asset_id: task.asset_id.clone(),
        versions,
    })
}

fn proof(
    asset_id: &str,
    version: &AssetVersion,
    output_job_id: &str,
    validation: Option<ValidationReport>,
) -> VersionProof {
    let mut artifacts = version.artifacts.clone();
    artifacts.sort_by(|left, right| (&left.path, &left.id).cmp(&(&right.path, &right.id)));
    VersionProof {
        asset_id: asset_id.into(),
        version_id: version.id.clone(),
        output_job_id: output_job_id.into(),
        output_execution_id: version
            .settings
            .get("executionId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        version_cache_key: version
            .settings
            .get("cacheKey")
            .cloned()
            .unwrap_or(Value::Null),
        source: version.source,
        requested_model: version.requested_model.clone(),
        confirmed_model: version.confirmed_model.clone(),
        provider_version: version.provider_version.clone(),
        artifacts,
        validation,
    }
}

fn valid_report(version: &AssetVersion) -> Result<&ValidationReport> {
    let report = version
        .validation
        .as_ref()
        .context("output has no persisted validation report")?;
    ensure!(
        report.valid
            && !report.checks.is_empty()
            && report
                .checks
                .iter()
                .all(|check| check.status != ValidationStatus::Fail)
            && version
                .artifacts
                .iter()
                .any(|artifact| artifact.id == report.artifact_id),
        "output does not have successful validation for an actual artifact"
    );
    Ok(report)
}

fn verify_files(repository: &Repository, version: &AssetVersion) -> Result<()> {
    ensure!(
        !version.artifacts.is_empty(),
        "committed version has no artifacts"
    );
    for artifact in &version.artifacts {
        repository.verify_artifact(artifact)?;
    }
    Ok(())
}

fn execution_id(task: &Job) -> Result<&str> {
    let value = task
        .payload
        .get("executionId")
        .and_then(Value::as_str)
        .context("commit job has no admitted execution identity")?;
    let identity = Uuid::parse_str(value).context("commit execution identity is not a UUID")?;
    ensure!(
        identity.to_string() == value,
        "commit execution identity must use its canonical UUID spelling"
    );
    Ok(value)
}

fn marker_path(directory: &Path, task: &Job) -> Result<PathBuf> {
    // No job identifier can become a path component or traverse outside storage.
    let identity = format!("{:x}", Sha256::digest(task.id.as_bytes()));
    Ok(directory.join(format!("{identity}-{}.json", execution_id(task)?)))
}

fn marker_directory(root: &Path, create: bool) -> Result<Option<PathBuf>> {
    let directory = root.join(DIRECTORY);
    let metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match fs::create_dir(&directory) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
            fs::symlink_metadata(&directory)?
        }
        Err(error) => return Err(error.into()),
    };
    ensure!(
        metadata.is_dir() && !is_link(&metadata),
        "commit directory must not be a link or reparse point"
    );
    ensure!(
        directory.canonicalize()? == directory,
        "commit directory path is not stable"
    );
    Ok(Some(directory))
}

fn read_marker(path: &Path) -> Result<CommitMarker> {
    let current = fs::symlink_metadata(path)?;
    ensure!(
        current.is_file() && !is_link(&current),
        "commit marker must be a regular file"
    );
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000).share_mode(0x0000_0003);
    }
    let file = options.open(path)?;
    let opened = file.metadata()?;
    ensure!(
        opened.is_file() && !is_link(&opened) && opened.len() <= MAX_MARKER_BYTES,
        "commit marker exceeds its limit or is not a regular file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(
            opened.dev() == current.dev() && opened.ino() == current.ino(),
            "commit marker was replaced while opening"
        );
    }
    let mut bytes = Vec::new();
    file.take(MAX_MARKER_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_MARKER_BYTES,
        "commit marker grew beyond its limit"
    );
    let marker: CommitMarker =
        serde_json::from_slice(&bytes).context("incomplete or invalid commit marker")?;
    ensure!(
        marker.format == FORMAT
            && marker.schema_version == SCHEMA_VERSION
            && !marker.versions.is_empty(),
        "unrecognized or empty commit marker"
    );
    Ok(marker)
}

#[cfg(windows)]
fn is_link(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
fn is_link(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use super::*;
    use asset_core::models::*;
    use asset_scheduler::ResourceLimits;
    use std::collections::BTreeMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestProject {
        base: PathBuf,
        directory: PathBuf,
        root: PathBuf,
    }
    impl TestProject {
        fn new() -> Self {
            let base = std::env::temp_dir().canonicalize().unwrap();
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let directory = base.join(format!(
                "asset-commit-proof-{}-{stamp}-{}",
                std::process::id(),
                Uuid::new_v4()
            ));
            fs::create_dir(&directory).unwrap();
            let root = directory.join("한글 프로젝트");
            Repository::create(&root, "완료 증거 검증").unwrap();
            let root = root.canonicalize().unwrap();
            Self {
                base,
                directory,
                root,
            }
        }

        fn running(&self, kind: &str, resource: JobResource) -> Job {
            let project = Repository::open(&self.root).unwrap().project().unwrap();
            let task = Job {
                id: Uuid::new_v4().to_string(),
                project_id: project.id,
                asset_id: None,
                kind: kind.into(),
                label: "완료 증거 테스트".into(),
                status: JobStatus::Pending,
                dependencies: vec![],
                resource,
                attempts: 0,
                created_at: now(),
                started_at: None,
                finished_at: None,
                error: None,
                progress: JobProgress {
                    stage: "pending".into(),
                    completed: None,
                    total: None,
                },
                payload: BTreeMap::new(),
                cache_key: Some("a".repeat(64)),
            };
            let queue = SchedulerStore::open(&self.root.join("scheduler.sqlite")).unwrap();
            queue.enqueue(task).unwrap();
            queue
                .claim_ready(&ResourceLimits::default())
                .unwrap()
                .remove(0)
        }

        fn output(&self, task: &Job) -> (String, String) {
            let source = self.directory.join(format!("input-{}.png", Uuid::new_v4()));
            fs::write(
                &source,
                include_bytes!("../../../../../tests/core/fixtures/reference.png"),
            )
            .unwrap();
            let mut repository = Repository::open(&self.root).unwrap();
            let mut artifact = repository
                .copy_in(&source, "outputs", "result.png")
                .unwrap();
            artifact.role = ArtifactRole::Output;
            let path = artifact.path.clone();
            let report = ValidationReport {
                id: Uuid::new_v4().to_string(),
                artifact_id: artifact.id.clone(),
                created_at: now(),
                valid: true,
                checks: vec![ValidationCheck {
                    code: "DECODE".into(),
                    status: ValidationStatus::Pass,
                    message: "실제 PNG 파일".into(),
                    measured: None,
                }],
            };
            let version = AssetVersion {
                id: Uuid::new_v4().to_string(),
                number: 1,
                created_at: now(),
                prompt: "테스트".into(),
                source: AssetSource::Procedural,
                requested_model: None,
                confirmed_model: None,
                provider_version: None,
                artifacts: vec![artifact],
                settings: BTreeMap::from([
                    ("jobId".into(), json!(task.id)),
                    ("executionId".into(), task.payload["executionId"].clone()),
                    ("cacheKey".into(), json!(task.cache_key)),
                ]),
                validation: Some(report),
            };
            let asset = Asset {
                id: Uuid::new_v4().to_string(),
                name: "완료 이미지".into(),
                kind: AssetKind::Image,
                folder: "검증".into(),
                tags: vec![],
                active_version_id: version.id.clone(),
                versions: vec![version],
                width: Some(1),
                height: Some(1),
                mesh: None,
            };
            let asset_id = asset.id.clone();
            repository.add_asset(asset).unwrap();
            (asset_id, path)
        }

        fn status(&self, task: &Job) -> JobStatus {
            SchedulerStore::open(&self.root.join("scheduler.sqlite"))
                .unwrap()
                .jobs()
                .unwrap()
                .into_iter()
                .find(|job| job.id == task.id)
                .unwrap()
                .status
        }

        fn marker(&self, task: &Job) -> PathBuf {
            marker_path(&self.root.join(DIRECTORY), task).unwrap()
        }
    }
    impl Drop for TestProject {
        fn drop(&mut self) {
            let Ok(metadata) = fs::symlink_metadata(&self.directory) else {
                return;
            };
            if is_link(&metadata) {
                return;
            }
            let Ok(resolved) = self.directory.canonicalize() else {
                return;
            };
            if resolved.parent() == Some(self.base.as_path())
                && resolved.file_name() == self.directory.file_name()
            {
                let _ = fs::remove_dir_all(resolved);
            }
        }
    }

    #[test]
    fn valid_marker_recovers_only_the_same_running_attempt() {
        let project = TestProject::new();
        let task = project.running("normal_map", JobResource::Cpu);
        project.output(&task);
        record_commit(&project.root, &task).unwrap();
        assert_eq!(recover_commits(&project.root).unwrap(), 1);
        assert_eq!(project.status(&task), JobStatus::Succeeded);
        assert_eq!(recover_commits(&project.root).unwrap(), 0);
    }

    #[test]
    fn tampered_files_do_not_recover() {
        let project = TestProject::new();
        let task = project.running("normal_map", JobResource::Cpu);
        let (_, path) = project.output(&task);
        record_commit(&project.root, &task).unwrap();
        fs::write(project.root.join(path), b"tampered").unwrap();
        assert_eq!(recover_commits(&project.root).unwrap(), 0);
        assert_eq!(project.status(&task), JobStatus::Running);
    }

    #[test]
    fn old_execution_marker_is_not_used_after_rerun() {
        let project = TestProject::new();
        let task = project.running("normal_map", JobResource::Cpu);
        project.output(&task);
        record_commit(&project.root, &task).unwrap();
        let queue = SchedulerStore::open(&project.root.join("scheduler.sqlite")).unwrap();
        queue.complete(&task.id).unwrap();
        queue.rerun(&task.id).unwrap();
        let next = queue
            .claim_ready(&ResourceLimits::default())
            .unwrap()
            .remove(0);
        assert_ne!(next.payload["executionId"], task.payload["executionId"]);
        assert_eq!(recover_commits(&project.root).unwrap(), 0);
        assert_eq!(project.status(&task), JobStatus::Running);
        assert!(record_commit(&project.root, &task).is_err());
        assert!(record_commit(&project.root, &next).is_err());
        // Old versions from the same job do not become evidence for this
        // execution. A fresh, verified output can create its own marker.
        project.output(&next);
        record_commit(&project.root, &next).unwrap();
        let marker = read_marker(&project.marker(&next)).unwrap();
        assert_eq!(marker.versions.len(), 1);
        assert_eq!(recover_commits(&project.root).unwrap(), 1);
    }

    #[test]
    fn incomplete_or_partial_marker_never_proves_completion() {
        let project = TestProject::new();
        let task = project.running("split", JobResource::Cpu);
        project.output(&task);
        project.output(&task);
        record_commit(&project.root, &task).unwrap();
        let path = project.marker(&task);
        let mut marker = read_marker(&path).unwrap();
        marker.versions.pop();
        fs::write(&path, serde_json::to_vec(&marker).unwrap()).unwrap();
        assert_eq!(recover_commits(&project.root).unwrap(), 0);
        fs::write(&path, b"{\"schemaVersion\":2,").unwrap();
        assert_eq!(recover_commits(&project.root).unwrap(), 0);
        assert_eq!(project.status(&task), JobStatus::Running);
    }

    #[test]
    fn no_marker_or_no_outputs_never_proves_success() {
        let project = TestProject::new();
        let task = project.running("normal_map", JobResource::Cpu);
        assert!(record_commit(&project.root, &task).is_err());
        project.output(&task);
        assert_eq!(recover_commits(&project.root).unwrap(), 0);
        assert_eq!(project.status(&task), JobStatus::Running);
    }

    #[test]
    fn cancelled_and_external_unknown_are_not_resurrected() {
        for resource in [JobResource::Cpu, JobResource::External] {
            let project = TestProject::new();
            let task = project.running("image_generate", resource);
            project.output(&task);
            record_commit(&project.root, &task).unwrap();
            let queue = SchedulerStore::open(&project.root.join("scheduler.sqlite")).unwrap();
            queue.cancel(&task.id).unwrap();
            let before = project.status(&task);
            assert!(matches!(
                before,
                JobStatus::Cancelled | JobStatus::ExternalUnknown
            ));
            assert_eq!(recover_commits(&project.root).unwrap(), 0);
            assert_eq!(project.status(&task), before);
        }
    }

    #[test]
    fn changed_cache_identity_or_missing_version_is_not_recovered() {
        let project = TestProject::new();
        let task = project.running("normal_map", JobResource::Cpu);
        let (id, _) = project.output(&task);
        record_commit(&project.root, &task).unwrap();
        let path = project.marker(&task);
        let mut marker = read_marker(&path).unwrap();
        marker.cache_key = Some("b".repeat(64));
        fs::write(&path, serde_json::to_vec(&marker).unwrap()).unwrap();
        assert_eq!(recover_commits(&project.root).unwrap(), 0);
        marker.cache_key = task.cache_key.clone();
        marker.versions[0].version_id = Uuid::new_v4().to_string();
        fs::write(&path, serde_json::to_vec(&marker).unwrap()).unwrap();
        assert_eq!(recover_commits(&project.root).unwrap(), 0);
        assert!(Repository::open(&project.root)
            .unwrap()
            .project()
            .unwrap()
            .assets
            .iter()
            .any(|a| a.id == id));
    }

    #[test]
    fn validation_requires_this_attempt_stamp_and_successful_report() {
        let project = TestProject::new();
        let producer = project.running("image_process", JobResource::Cpu);
        let (asset_id, _) = project.output(&producer);
        SchedulerStore::open(&project.root.join("scheduler.sqlite"))
            .unwrap()
            .complete(&producer.id)
            .unwrap();
        let mut validation = project.running("image_validate", JobResource::Cpu);
        // Use the existing running task's identity but persist the intended
        // target in its queue before admission through a fresh pending job.
        let queue = SchedulerStore::open(&project.root.join("scheduler.sqlite")).unwrap();
        queue.cancel(&validation.id).unwrap();
        queue.release_cancelled_resources(&validation.id).unwrap();
        validation.id = Uuid::new_v4().to_string();
        validation.status = JobStatus::Pending;
        validation.attempts = 0;
        validation.started_at = None;
        validation.payload.remove("executionId");
        validation.asset_id = Some(asset_id.clone());
        validation
            .payload
            .insert("processJobId".into(), json!(producer.id));
        queue.enqueue(validation).unwrap();
        let task = queue
            .claim_ready(&ResourceLimits::default())
            .unwrap()
            .remove(0);
        assert!(record_commit(&project.root, &task).is_err());
        let mut repository = Repository::open(&project.root).unwrap();
        let mut snapshot = repository.project().unwrap();
        let version = &mut snapshot
            .assets
            .iter_mut()
            .find(|asset| asset.id == asset_id)
            .unwrap()
            .versions[0];
        version
            .settings
            .insert("validationJobId".into(), json!(task.id));
        version
            .settings
            .insert("validationAttempt".into(), json!(task.attempts));
        version.settings.insert(
            "validationExecutionId".into(),
            task.payload["executionId"].clone(),
        );
        let report = version.validation.as_mut().unwrap();
        report.valid = false;
        report.checks[0].status = ValidationStatus::Fail;
        repository.save_project(&snapshot).unwrap();
        assert!(record_commit(&project.root, &task).is_err());
        let mut snapshot = repository.project().unwrap();
        let report = snapshot
            .assets
            .iter_mut()
            .find(|asset| asset.id == asset_id)
            .unwrap()
            .versions[0]
            .validation
            .as_mut()
            .unwrap();
        report.valid = true;
        report.checks[0].status = ValidationStatus::Pass;
        repository.save_project(&snapshot).unwrap();
        record_commit(&project.root, &task).unwrap();
        assert_eq!(recover_commits(&project.root).unwrap(), 1);
        assert_eq!(project.status(&task), JobStatus::Succeeded);
    }
}
