//! Optional previews finish after the validated model is available. Only the
//! immutable scene produced by the matching core job may enter Blender.
use super::*;
use anyhow::ensure;

const IMAGES: [(&str, u32); 5] = [
    ("thumbnail.png", 1024),
    ("turntable-00.png", 512),
    ("turntable-01.png", 512),
    ("turntable-02.png", 512),
    ("turntable-03.png", 512),
];

pub(super) fn matching_version<'a>(project: &'a Project, task: &Job) -> Result<&'a AssetVersion> {
    let asset = asset_from(
        project,
        task.asset_id
            .as_deref()
            .context("미리보기 모델 ID가 없습니다.")?,
    )?;
    let version = asset
        .versions
        .iter()
        .find(|v| Some(v.id.as_str()) == task.payload.get("versionId").and_then(Value::as_str))
        .context("미리보기 대상 버전이 없습니다.")?;
    ensure!(
        version.settings.get("jobId") == task.payload.get("parentJobId")
            && version.settings.get("executionId") == task.payload.get("parentExecutionId")
            && version.settings.get("previewJobId") == Some(&json!(task.id)),
        "미리보기 대상의 제작 작업이 변경되었습니다."
    );
    Ok(version)
}

pub(super) fn source_artifact<'a>(version: &'a AssetVersion, task: &Job) -> Result<&'a Artifact> {
    version
        .artifacts
        .iter()
        .find(|a| {
            a.role == ArtifactRole::Source
                && a.format == "blend"
                && Some(a.path.as_str()) == task.payload.get("source").and_then(Value::as_str)
                && Some(a.sha256.as_str())
                    == task.payload.get("sourceSha256").and_then(Value::as_str)
                && Some(a.bytes) == task.payload.get("sourceBytes").and_then(Value::as_u64)
        })
        .context("제작된 장면 파일의 경로·크기·해시가 일치하지 않습니다.")
}

impl Backend {
    pub(super) fn record_preview_admission_failure(
        &self,
        repo: &mut Repository,
        parent: &Job,
        message: &str,
    ) -> Result<()> {
        let mut project = repo.project()?;
        for asset in &mut project.assets {
            for version in &mut asset.versions {
                if version.settings.get("jobId") == Some(&json!(parent.id))
                    && version.settings.get("executionId").and_then(Value::as_str)
                        == execution_id(parent)
                {
                    version
                        .settings
                        .insert("previewStatus".into(), json!("skipped"));
                    version.settings.insert(
                        "previewError".into(),
                        json!(message.chars().take(512).collect::<String>()),
                    );
                }
            }
        }
        repo.save_project(&project)?;
        Ok(())
    }

    // Called under the same project I/O boundary as queue finalization. A
    // failed optional render never changes the validated core model report.
    pub(super) fn record_preview_failure(
        &self,
        root: &Path,
        task: &Job,
        message: &str,
    ) -> Result<()> {
        let mut repo = Repository::open(root)?;
        let mut project = repo.project()?;
        matching_version(&project, task)?;
        let version = project
            .assets
            .iter_mut()
            .find(|a| Some(a.id.as_str()) == task.asset_id.as_deref())
            .unwrap()
            .versions
            .iter_mut()
            .find(|v| Some(v.id.as_str()) == task.payload.get("versionId").and_then(Value::as_str))
            .unwrap();
        if version.settings.get("previewStatus") != Some(&json!("ready")) {
            version
                .settings
                .insert("previewStatus".into(), json!("failed"));
            version.settings.insert(
                "previewError".into(),
                json!(message.chars().take(512).collect::<String>()),
            );
        }
        repo.save_project(&project)?;
        Ok(())
    }

    pub(super) fn enqueue_quality3d_preview(
        &self,
        repo: &mut Repository,
        parent: &Job,
    ) -> Result<()> {
        let mut project = repo.project()?;
        let (asset_id, version_id, name, scene) = project
            .assets
            .iter()
            .find_map(|asset| {
                asset
                    .versions
                    .iter()
                    .find(|v| {
                        v.settings.get("jobId") == Some(&json!(parent.id))
                            && v.settings.get("executionId").and_then(Value::as_str)
                                == execution_id(parent)
                    })
                    .and_then(|v| {
                        v.artifacts
                            .iter()
                            .find(|a| a.role == ArtifactRole::Source && a.format == "blend")
                            .map(|scene| {
                                (
                                    asset.id.clone(),
                                    v.id.clone(),
                                    asset.name.clone(),
                                    scene.clone(),
                                )
                            })
                    })
            })
            .context("미리보기에 사용할 제작 장면이 없습니다.")?;
        repo.verify_artifact(&scene)?;
        let mut preview = job(
            &project,
            "quality3d_preview",
            &format!("미리보기 · {name}"),
            Some(asset_id.clone()),
            JobResource::Blender,
            json!({"versionId":version_id,"source":scene.path,"sourceSha256":scene.sha256,
                "sourceBytes":scene.bytes,"name":name,"previewMode":"fast",
                "parentJobId":parent.id,"parentExecutionId":execution_id(parent),
                "resources":{"ramMb":1024,"cpuThreads":2,"diskWeight":1}}),
        )?;
        preview.dependencies = vec![parent.id.clone()];
        let receipt = SchedulerStore::open(&repo.root().join("scheduler.sqlite"))?.enqueue_once(
            &format!(
                "preview:{}:{}",
                parent.id,
                execution_id(parent).context("제작 실행 ID가 없습니다.")?
            ),
            preview,
        )?;
        let version = project
            .assets
            .iter_mut()
            .find(|a| a.id == asset_id)
            .unwrap()
            .versions
            .iter_mut()
            .find(|v| v.id == version_id)
            .unwrap();
        version
            .settings
            .insert("previewJobId".into(), json!(receipt.job_id));
        version
            .settings
            .insert("previewStatus".into(), json!("queued"));
        repo.save_project(&project)?;
        Ok(())
    }

    pub(super) fn run_quality3d_preview(
        &self,
        root: &Path,
        task: &Job,
        work: &Path,
        cancel: &AtomicBool,
    ) -> Result<()> {
        let payload = serde_json::to_value(&task.payload)?;
        let queue = SchedulerStore::open(&root.join("scheduler.sqlite"))?;
        let parent = queue
            .get_job(text_field(&payload, "parentJobId")?)?
            .context("모델 제작 작업이 없습니다.")?;
        ensure!(
            parent.status == JobStatus::Succeeded
                && parent.payload.get("executionId") == task.payload.get("parentExecutionId"),
            "완료된 같은 제작 실행에만 미리보기를 추가할 수 있습니다."
        );
        let source = {
            let _io = self.inner.io.lock().unwrap();
            let repo = Repository::open(root)?;
            let project = repo.project()?;
            let version = matching_version(&project, task)?;
            let scene = source_artifact(version, task)?;
            repo.verify_artifact(scene)?;
            resolve_artifact(root, &scene.path)?
        };
        let input = work.join("preview-input.json");
        fs::write(
            &input,
            serde_json::to_vec(&json!({"sourcePath":source,
            "sourceSha256":task.payload["sourceSha256"],"name":task.payload["name"],"previewMode":"fast"}))?,
        )?;
        let output = work.join("previews");
        let mut command = Command::new(self.inner.blender.as_ref().context("Blender가 없습니다.")?);
        command
            .args([
                "--background",
                "--factory-startup",
                "--disable-autoexec",
                "--threads",
                "2",
                "--python",
            ])
            .arg(self.quality3d_worker("blender-quality", "preview_worker.py")?)
            .args(["--", "--input"])
            .arg(&input)
            .arg("--output-dir")
            .arg(&output);
        self.quality3d_process(
            root,
            task,
            command,
            &work.join("preview-worker.log"),
            "모델 미리보기",
            600,
            cancel,
        )?;
        let report_path = output.join("preview-validation.json");
        ensure!(
            fs::metadata(&report_path)?.len() <= 1024 * 1024,
            "미리보기 보고서가 너무 큽니다."
        );
        let report: Value = serde_json::from_slice(&fs::read(&report_path)?)?;
        ensure!(
            report["valid"] == true
                && report["originalSourcePreserved"] == true
                && report["scriptAutoExecution"] == false
                && report.get("sourceSha256") == task.payload.get("sourceSha256"),
            "미리보기 검증에 실패했습니다."
        );
        for (name, size) in IMAGES {
            let info = raster::inspect(&output.join(name))?;
            ensure!(
                info.width == size && info.height == size && info.non_empty,
                "미리보기 이미지의 크기 또는 픽셀이 올바르지 않습니다."
            );
        }
        let _io = self.inner.io.lock().unwrap();
        ensure!(
            !cancel.load(Ordering::SeqCst) && !self.inner.stop.load(Ordering::SeqCst),
            "미리보기가 취소되었습니다."
        );
        let mut repo = Repository::open(root)?;
        let mut project = repo.project()?;
        let current = queue
            .get_job(&task.id)?
            .context("미리보기 작업이 없습니다.")?;
        ensure!(
            current.status == JobStatus::Running && same_execution(&current, task),
            "미리보기 실행이 바뀌어 결과를 추가하지 않았습니다."
        );
        let version = matching_version(&project, task)?;
        repo.verify_artifact(source_artifact(version, task)?)?;
        let mut artifacts = Vec::new();
        for (name, _) in IMAGES {
            let mut artifact = repo.copy_in(&output.join(name), "outputs", name)?;
            artifact.role = ArtifactRole::Thumbnail;
            artifacts.push(artifact);
        }
        let mut metadata = repo.copy_in(&report_path, "outputs", "preview-validation.json")?;
        metadata.role = ArtifactRole::Metadata;
        artifacts.push(metadata);
        let version = project
            .assets
            .iter_mut()
            .find(|a| Some(a.id.as_str()) == task.asset_id.as_deref())
            .unwrap()
            .versions
            .iter_mut()
            .find(|v| Some(v.id.as_str()) == task.payload.get("versionId").and_then(Value::as_str))
            .unwrap();
        version.settings.insert(
            "previewArtifactIds".into(),
            json!(artifacts.iter().map(|a| &a.id).collect::<Vec<_>>()),
        );
        version.artifacts.extend(artifacts);
        version
            .settings
            .insert("previewStatus".into(), json!("ready"));
        version
            .settings
            .insert("previewExecutionId".into(), json!(execution_id(task)));
        version.settings.insert("previewReport".into(), report);
        repo.save_project(&project)?;
        Ok(())
    }
}
