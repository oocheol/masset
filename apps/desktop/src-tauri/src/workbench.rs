use crate::project_lease::ProjectLease;
use anyhow::{anyhow, bail, Context, Result};
use asset_core::{models::*, Repository};
use asset_image_pipeline as raster;
use asset_scheduler::{FailureKind, ResourceLimits, SchedulerStore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;
mod commit;
mod provider;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Clone)]
pub struct Backend {
    inner: Arc<Inner>,
}
struct Inner {
    data: PathBuf,
    examples: PathBuf,
    worker: PathBuf,
    blender: Option<PathBuf>,
    blender_version: Option<String>,
    worker_sha256: Option<String>,
    current: Mutex<Option<PathBuf>>,
    project_lease: Mutex<Option<ProjectLease>>,
    requests: Mutex<()>,
    io: Mutex<()>,
    dispatch: Mutex<()>,
    initialize: Mutex<()>,
    runners: Mutex<BTreeMap<String, Runner>>,
    stop: AtomicBool,
    limits: ResourceLimits,
    provider_runtime: Mutex<Option<asset_providers::runtime::CodexRuntime>>,
    provider_connection: Mutex<Value>,
    codex_installer: asset_providers::installer::CodexInstaller,
}
struct Runner {
    cancel: Arc<AtomicBool>,
    pid: Option<u32>,
    execution_id: Option<String>,
}

impl Backend {
    pub fn new(data: PathBuf, examples: PathBuf, worker: PathBuf) -> Self {
        let codex_installer =
            asset_providers::installer::CodexInstaller::new(data.join("codex-runtimes"));
        let blender = find_blender();
        let blender_version = blender.as_deref().and_then(blender_version);
        let worker_sha256 = asset_core::sha256_file(&worker).ok().map(|result| result.0);
        let mut limits = ResourceLimits::default();
        limits.cpu_threads = thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(2)
            .clamp(2, 4);
        Self {
            inner: Arc::new(Inner {
                data,
                examples,
                worker,
                blender,
                blender_version,
                worker_sha256,
                current: Mutex::new(None),
                project_lease: Mutex::new(None),
                requests: Mutex::new(()),
                io: Mutex::new(()),
                dispatch: Mutex::new(()),
                initialize: Mutex::new(()),
                runners: Mutex::new(BTreeMap::new()),
                stop: AtomicBool::new(false),
                limits,
                provider_runtime: Mutex::new(None),
                provider_connection: Mutex::new(provider::unavailable_connection(
                    "공식 Codex 연결을 확인해 주세요.",
                )),
                codex_installer,
            }),
        }
    }
    pub fn start(&self) {
        let backend = self.clone();
        thread::spawn(move || {
            while !backend.inner.stop.load(Ordering::Relaxed) {
                {
                    let _dispatch = backend.inner.dispatch.lock().unwrap();
                    if backend.inner.stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let selected = { backend.inner.current.lock().unwrap().clone() };
                    if let Some(root) = selected {
                        // Running jobs are confined to this project. Switching projects is
                        // refused while a worker is active, keeping global budgets bounded.
                        if let Ok(mut queue) = SchedulerStore::open(&root.join("scheduler.sqlite"))
                        {
                            if let Ok(jobs) = queue.claim_ready(&backend.inner.limits) {
                                for job in jobs {
                                    let cancel = Arc::new(AtomicBool::new(false));
                                    backend.inner.runners.lock().unwrap().insert(
                                        job.id.clone(),
                                        Runner {
                                            cancel: cancel.clone(),
                                            pid: None,
                                            execution_id: execution_id(&job).map(str::to_owned),
                                        },
                                    );
                                    let worker_backend = backend.clone();
                                    let worker_root = root.clone();
                                    thread::spawn(move || {
                                        let outcome =
                                            worker_backend.run_job(&worker_root, &job, &cancel);
                                        worker_backend.finish_job(&worker_root, &job, outcome);
                                    });
                                }
                            }
                        }
                    }
                }
                thread::sleep(Duration::from_millis(150));
            }
        });
    }
    fn finish_job(&self, root: &Path, task: &Job, outcome: Result<()>) {
        let completion_guard = self.inner.io.lock().unwrap();
        let outcome = outcome.and_then(|_| commit::record_commit(root, task));
        if let Ok(mut queue) = SchedulerStore::open(&root.join("scheduler.sqlite")) {
            let active = queue
                .jobs()
                .ok()
                .and_then(|jobs| jobs.into_iter().find(|job| job.id == task.id));
            // A terminal queue status may precede the old worker's exit. Never
            // finalize or release resources belonging to a successor execution.
            if let Some(active) = active.filter(|job| same_execution(job, task)) {
                if active.status == JobStatus::Running {
                    match outcome {
                        Ok(()) => {
                            let _ = queue.complete(&task.id);
                        }
                        Err(error) => {
                            let _ = queue.fail(&task.id, FailureKind::Worker, &error.to_string());
                        }
                    }
                }
                let _ = queue.release_cancelled_resources(&task.id);
            }
        }
        drop(completion_guard);
        {
            let mut runners = self.inner.runners.lock().unwrap();
            if runners
                .get(&task.id)
                .is_some_and(|runner| runner_matches(runner, task))
            {
                runners.remove(&task.id);
            }
        }
        self.release_lease_if_stopped();
    }
    pub fn shutdown(&self) {
        self.inner.stop.store(true, Ordering::SeqCst);
        let _request = self.inner.requests.lock().unwrap();
        // A preparation already admitted under this mutex must be observed
        // before cancellation; otherwise it could start after an early cancel.
        self.inner.codex_installer.cancel();
        // Stop admission before observing runners. The lease stays held until
        // the last local worker actually exits, including during cancellation.
        let _dispatch = self.inner.dispatch.lock().unwrap();
        for runner in self.inner.runners.lock().unwrap().values() {
            runner.cancel.store(true, Ordering::SeqCst);
            // The worker owns its live process handle and Job Object. A stored
            // numeric PID may already have been reused after the worker exits.
        }
        self.release_lease_if_stopped_locked();
    }
    fn release_lease_if_stopped(&self) {
        if self.inner.stop.load(Ordering::SeqCst) {
            let _dispatch = self.inner.dispatch.lock().unwrap();
            self.release_lease_if_stopped_locked();
        }
    }
    fn release_lease_if_stopped_locked(&self) {
        if self.inner.stop.load(Ordering::SeqCst) && self.inner.runners.lock().unwrap().is_empty() {
            // Direct snapshot callers also finish before project ownership
            // is released; they do not pass through the request mutex.
            let _io = self.inner.io.lock().unwrap();
            self.inner.project_lease.lock().unwrap().take();
        }
    }
    pub fn current_root(&self) -> Option<PathBuf> {
        self.inner.current.lock().unwrap().clone()
    }
    pub fn ensure_update_idle(&self) -> Result<()> {
        let _request = self.inner.requests.lock().unwrap();
        let _dispatch = self.inner.dispatch.lock().unwrap();
        if self.inner.codex_installer.busy() {
            bail!("Codex 준비를 완료하거나 취소한 다음 앱을 업데이트해 주세요.");
        }
        self.ensure_workers_idle()
            .map_err(|_| anyhow!("제작 작업을 완료하거나 취소한 다음 업데이트해 주세요."))
    }
    pub fn prepare_update_shutdown(&self) -> Result<()> {
        let _request = self.inner.requests.lock().unwrap();
        let _dispatch = self.inner.dispatch.lock().unwrap();
        if self.inner.codex_installer.busy() {
            bail!("Codex 준비를 완료하거나 취소한 다음 앱을 업데이트해 주세요.");
        }
        self.ensure_workers_idle()?;
        self.inner.stop.store(true, Ordering::SeqCst);
        self.release_lease_if_stopped_locked();
        Ok(())
    }
    fn root(&self) -> Result<PathBuf> {
        self.current_root()
            .ok_or_else(|| anyhow!("프로젝트를 먼저 열어 주세요."))
    }
    fn select(&self, root: PathBuf) -> Result<()> {
        let _dispatch = self.inner.dispatch.lock().unwrap();
        let _io = self.inner.io.lock().unwrap();
        self.select_locked(root)
    }
    fn ensure_workers_idle(&self) -> Result<()> {
        if !self.inner.runners.lock().unwrap().is_empty() {
            bail!("실행 중인 작업을 완료하거나 취소한 다음 프로젝트를 바꿔 주세요.");
        }
        Ok(())
    }
    fn ensure_local_io_idle(&self) -> Result<()> {
        if !self.inner.runners.lock().unwrap().is_empty() {
            bail!("실행 중인 작업이 끝나면 가져오기·내보내기를 사용할 수 있습니다. 이미지 메모리와 디스크 작업을 안전하게 분배하기 위한 제한입니다.");
        }
        Ok(())
    }
    fn select_locked(&self, root: PathBuf) -> Result<()> {
        self.ensure_workers_idle()?;
        if !root.join("project.sqlite").is_file() {
            bail!("프로젝트 데이터베이스를 찾을 수 없습니다.");
        }
        let normalized = root.canonicalize()?;
        let mut selected_lease = self.inner.project_lease.lock().unwrap();
        if selected_lease
            .as_ref()
            .is_some_and(|lease| lease.root() == normalized.as_path())
        {
            // Opening the same selected project is not crash recovery.
            Repository::open(&root)?;
            return Ok(());
        }
        let lease = ProjectLease::acquire(&root).context(
            "프로젝트 잠금을 얻지 못했습니다. 다른 앱의 사용 여부와 폴더 권한을 확인해 주세요.",
        )?;
        let root = lease.root().to_owned();
        // Even migrations and mirror reconciliation run only for the owner.
        Repository::open(&root)?;
        // Recovery is only valid after acquiring exclusive project ownership.
        commit::recover_commits(&root)?;
        SchedulerStore::open(&root.join("scheduler.sqlite"))?.recover()?;
        fs::create_dir_all(&self.inner.data)?;
        atomic_new_replace(
            &self.inner.data.join("recent.json"),
            &serde_json::to_vec(&json!({"root":root}))?,
        )?;
        *self.inner.current.lock().unwrap() = Some(root);
        *selected_lease = Some(lease);
        Ok(())
    }
    pub fn snapshot(&self) -> Result<Value> {
        let _guard = self.inner.io.lock().unwrap();
        if self.inner.stop.load(Ordering::SeqCst) {
            bail!("작업 백엔드가 종료되었습니다. 앱을 다시 열어 주세요.");
        }
        let root = self.root()?;
        let mut repo = Repository::open(&root)?;
        let mut project = repo.project()?;
        let jobs = SchedulerStore::open(&root.join("scheduler.sqlite"))?.jobs()?;
        if project.jobs != jobs {
            project.jobs = jobs;
            repo.save_project(&project)?;
            project = repo.project()?;
        }
        let providers = self.provider_capabilities(&project);
        Ok(serde_json::to_value(ProjectSnapshot {
            root: root.to_string_lossy().into(),
            project,
            providers,
        })?)
    }
    pub fn request(&self, request: Value) -> Result<Value> {
        let action = text_field(&request, "action")?;
        if matches!(
            action,
            "provider_status"
                | "provider_login"
                | "provider_setup_status"
                | "provider_setup_install"
                | "provider_setup_cancel"
                | "provider_setup_open"
        ) {
            if self.inner.stop.load(Ordering::SeqCst) {
                bail!("작업 백엔드가 종료되었습니다.")
            }
            return match action {
                "provider_status" => self.provider_status(),
                "provider_login" => self.provider_login(),
                _ => self.provider_setup(&request),
            };
        }
        // Serialize command batches and project selection, while admitted
        // background workers still execute independently under resource limits.
        let _request = self.inner.requests.lock().unwrap();
        if self.inner.stop.load(Ordering::SeqCst) {
            bail!("작업 백엔드가 종료되었습니다. 앱을 다시 열어 주세요.");
        }
        match action {
            "environment" => Ok(serde_json::to_value(EnvironmentInfo {
                blender_path: self
                    .inner
                    .blender
                    .as_ref()
                    .map(|p| p.to_string_lossy().into()),
                blender_version: self.inner.blender_version.clone(),
                platform: std::env::consts::OS.into(),
                native: true,
            })?),
            "bootstrap" => {
                let _initialize = self.inner.initialize.lock().unwrap();
                if self.current_root().is_none() {
                    let recent = fs::read(self.inner.data.join("recent.json"))
                        .ok()
                        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                        .and_then(|v| v["root"].as_str().map(PathBuf::from));
                    if let Some(root) = recent.filter(|p| p.join("project.sqlite").exists()) {
                        self.select(root)?;
                    } else {
                        let root = self
                            .inner
                            .data
                            .join("projects")
                            .join(Uuid::new_v4().to_string());
                        Repository::create(&root, "로컬 예제 묶음")?;
                        self.select(root)?;
                        self.import_fixtures(12)?;
                    }
                }
                self.snapshot()
            }
            "create" => {
                let root = PathBuf::from(text_field(&request, "root")?);
                {
                    let _dispatch = self.inner.dispatch.lock().unwrap();
                    let _io = self.inner.io.lock().unwrap();
                    self.ensure_workers_idle()?;
                    Repository::create(&root, text_field(&request, "name")?)?;
                    self.select_locked(root)?;
                }
                self.snapshot()
            }
            "open" => {
                self.select(PathBuf::from(text_field(&request, "root")?))?;
                self.snapshot()
            }
            "snapshot" => self.snapshot(),
            "update" => {
                {
                    let _guard = self.inner.io.lock().unwrap();
                    let mut repo = Repository::open(&self.root()?)?;
                    let mut project = repo.project()?;
                    if let Some(spec) = request.get("spec") {
                        project.spec = serde_json::from_value(spec.clone())?;
                        validate_spec(&project.spec)?;
                    }
                    if let Some(style) = request.get("styleGuide") {
                        project.style_guide = serde_json::from_value(style.clone())?;
                        if project.style_guide.palette.len() > 32 {
                            bail!("팔레트는 최대 32색입니다.")
                        }
                    }
                    if let Some(id) = request["assetId"].as_str() {
                        let asset = project
                            .assets
                            .iter_mut()
                            .find(|a| a.id == id)
                            .context("선택한 에셋이 없습니다.")?;
                        if let Some(name) = request["name"].as_str() {
                            if name.trim().is_empty() || name.len() > 240 {
                                bail!("에셋 이름을 확인해 주세요.")
                            };
                            asset.name = name.to_owned();
                        }
                        if let Some(tags) = request.get("tags") {
                            asset.tags = serde_json::from_value(tags.clone())?;
                            if asset.tags.len() > 32 {
                                bail!("태그는 최대 32개입니다.")
                            }
                        }
                        if let Some(version_id) = request["activeVersionId"].as_str() {
                            let version = asset
                                .versions
                                .iter()
                                .find(|v| v.id == version_id)
                                .context("버전을 찾을 수 없습니다.")?;
                            if asset.kind != AssetKind::Model {
                                if let Some(artifact) =
                                    version.artifacts.iter().find(|a| is_raster(&a.format))
                                {
                                    repo.verify_artifact(artifact)?;
                                    let info =
                                        raster::inspect(&repo.artifact_path(&artifact.path)?)?;
                                    asset.width = Some(info.width);
                                    asset.height = Some(info.height)
                                }
                            }
                            asset.active_version_id = version_id.into();
                        }
                    }
                    repo.save_project(&project)?;
                }
                self.snapshot()
            }
            "import" => {
                let _dispatch = self.inner.dispatch.lock().unwrap();
                self.ensure_local_io_idle()?;
                let paths: Vec<String> = serde_json::from_value(request["paths"].clone())?;
                if paths.len() > 128 {
                    bail!("한 번에 최대 128개 파일을 가져올 수 있습니다.")
                }
                for path in paths {
                    self.import_raster(&PathBuf::from(path), AssetSource::Import)?;
                }
                self.snapshot()
            }
            "fixture" => {
                let _dispatch = self.inner.dispatch.lock().unwrap();
                self.ensure_local_io_idle()?;
                self.import_fixtures(request["count"].as_u64().unwrap_or(12).min(12) as usize)?;
                self.snapshot()
            }
            "process" => {
                let root = self.root()?;
                let project = Repository::open(&root)?.project()?;
                let asset = asset_from(&project, text_field(&request, "assetId")?)?;
                if asset.kind == AssetKind::Model {
                    bail!("이미지를 선택해 주세요.")
                }
                let operation = request
                    .get("operation")
                    .context("처리 옵션이 필요합니다.")?
                    .clone();
                let _: ImageOperation = serde_json::from_value(operation.clone())?;
                let source = active_raster(asset)?.path.clone();
                let original = asset
                    .versions
                    .first()
                    .and_then(|v| v.artifacts.iter().find(|a| is_raster(&a.format)))
                    .context("원본이 없습니다.")?
                    .path
                    .clone();
                let pixels = artifact_pixels(&project, &source)?
                    .max(artifact_pixels(&project, &original)?)
                    .max(operation_pixels(&operation)?);
                let version_id = Uuid::new_v4().to_string();
                let mut job = job(
                    &project,
                    "image_process",
                    "이미지 후처리",
                    Some(asset.id.clone()),
                    JobResource::Cpu,
                    json!({"source":source,"original":original,"operation":operation,"versionId":version_id,"resources":{"ramMb":image_ram_mb(pixels,56,256),"cpuThreads":1,"diskWeight":1}}),
                )?;
                job.dependencies = active_dependencies(&project, &asset.id);
                let mut validation = job_from(
                    &project,
                    "image_validate",
                    "결과 파일 검사",
                    Some(asset.id.clone()),
                    JobResource::Cpu,
                    json!({"versionId":version_id,"resources":{"ramMb":128,"cpuThreads":1,"diskWeight":1}}),
                )?;
                validation.dependencies = vec![job.id.clone()];
                validation
                    .payload
                    .insert("processJobId".into(), json!(job.id));
                SchedulerStore::open(&root.join("scheduler.sqlite"))?
                    .enqueue_many(vec![job, validation])?;
                self.snapshot()
            }
            "material" => {
                let root = self.root()?;
                let project = Repository::open(&root)?.project()?;
                let asset = asset_from(&project, text_field(&request, "assetId")?)?;
                let strength = request["strength"].as_f64().unwrap_or(2.0);
                if !strength.is_finite() || strength <= 0.0 || strength > 16.0 {
                    bail!("노멀맵 강도는 0 초과 16 이하입니다.")
                }
                let pixels = artifact_pixels(&project, &active_raster(asset)?.path)?;
                let task = job(
                    &project,
                    "normal_map",
                    "휴리스틱 노멀맵",
                    Some(asset.id.clone()),
                    JobResource::Cpu,
                    json!({"source":active_raster(asset)?.path,"strength":strength,"directX":request["directX"].as_bool().unwrap_or(false),"resources":{"ramMb":image_ram_mb(pixels,16,256),"cpuThreads":1,"diskWeight":1}}),
                )?;
                SchedulerStore::open(&root.join("scheduler.sqlite"))?.enqueue(task)?;
                self.snapshot()
            }
            "atlas" => {
                let root = self.root()?;
                let project = Repository::open(&root)?.project()?;
                let ids: Vec<String> = serde_json::from_value(request["assetIds"].clone())?;
                if ids.is_empty() || ids.len() > 256 {
                    bail!("아틀라스에 사용할 이미지 1~256개를 선택해 주세요.")
                }
                let options: AtlasOptions = serde_json::from_value(request["options"].clone())?;
                if options.width == 0
                    || options.height == 0
                    || options.width > 8192
                    || options.height > 8192
                    || options.padding >= options.width
                    || options.padding >= options.height
                {
                    bail!("아틀라스 크기는 1~8192px이고 여백은 캔버스보다 작아야 합니다.")
                }
                let inputs:Vec<Value>=ids.iter().map(|id|Ok(json!({"assetId":id,"path":active_raster(asset_from(&project,id)?)?.path}))).collect::<Result<_>>()?;
                let input_pixels = inputs
                    .iter()
                    .map(|input| artifact_pixels(&project, text_field(input, "path")?))
                    .collect::<Result<Vec<_>>>()?
                    .into_iter()
                    .max()
                    .unwrap_or(0);
                let pixels = input_pixels + u64::from(options.width) * u64::from(options.height);
                let task = job(
                    &project,
                    "atlas",
                    "아틀라스 패킹",
                    None,
                    JobResource::Cpu,
                    json!({"inputs":inputs,"options":options,"frameRate":frame_rate(&request)?,"pivot":project.spec.pivot,"resources":{"ramMb":image_ram_mb(pixels,16,512),"cpuThreads":1,"diskWeight":1}}),
                )?;
                SchedulerStore::open(&root.join("scheduler.sqlite"))?.enqueue(task)?;
                self.snapshot()
            }
            "split" => {
                let root = self.root()?;
                let project = Repository::open(&root)?.project()?;
                let asset = asset_from(&project, text_field(&request, "assetId")?)?;
                let pixels = artifact_pixels(&project, &active_raster(asset)?.path)?;
                let task = job(
                    &project,
                    "split",
                    "스프라이트시트 분할",
                    Some(asset.id.clone()),
                    JobResource::Cpu,
                    json!({"source":active_raster(asset)?.path,"frameWidth":dimension_field(&request,"frameWidth")?,"frameHeight":dimension_field(&request,"frameHeight")?,"frameRate":frame_rate(&request)?,"pivot":project.spec.pivot,"resources":{"ramMb":image_ram_mb(pixels,16,256),"cpuThreads":1,"diskWeight":1}}),
                )?;
                SchedulerStore::open(&root.join("scheduler.sqlite"))?.enqueue(task)?;
                self.snapshot()
            }
            "model" => {
                if self.inner.blender.is_none() {
                    bail!("Blender 실행 파일을 찾을 수 없습니다. Blender를 설치하거나 BLENDER_EXECUTABLE을 설정한 뒤 앱을 다시 실행해 주세요.")
                }
                let root = self.root()?;
                let project = Repository::open(&root)?.project()?;
                if !project.style_guide.approved {
                    bail!("스타일 가이드를 승인한 다음 제작해 주세요.")
                }
                let params: Vec<ModelParameters> =
                    serde_json::from_value(request["models"].clone())?;
                if params.is_empty() || params.len() > 32 {
                    bail!("한 번에 1~32개 모델을 제작할 수 있습니다.")
                }
                let tasks:Vec<Job>=params.iter().map(|model|{validate_model(model)?; job(&project,"blender_model",&format!("3D 제작 · {}",model.name),None,JobResource::Blender,json!({"parameters":model,"styleGuide":project.style_guide,"spec":project.spec,"prompt":request["prompt"].as_str().unwrap_or(""),"toolVersion":self.inner.blender_version,"workerSha256":self.inner.worker_sha256,"resources":{"ramMb":1024,"cpuThreads":2,"diskWeight":1}}))}).collect::<Result<_>>()?;
                SchedulerStore::open(&root.join("scheduler.sqlite"))?.enqueue_many(tasks)?;
                self.snapshot()
            }
            "reuse" => {
                {
                    let _guard = self.inner.io.lock().unwrap();
                    let root = self.root()?;
                    let mut repo = Repository::open(&root)?;
                    let mut project = repo.project()?;
                    let queue = SchedulerStore::open(&root.join("scheduler.sqlite"))?;
                    let task = queue
                        .jobs()?
                        .into_iter()
                        .find(|job| job.id == request["jobId"].as_str().unwrap_or(""))
                        .context("재사용할 작업을 찾을 수 없습니다.")?;
                    if task.status != JobStatus::Succeeded {
                        bail!("성공한 작업의 저장된 결과만 재사용할 수 있습니다.")
                    }
                    let cache_key = task
                        .cache_key
                        .as_ref()
                        .context("이 작업에는 재사용 가능한 결과가 없습니다.")?;
                    let mut selected = Vec::new();
                    for asset in &project.assets {
                        if let Some(version) = asset
                            .versions
                            .iter()
                            .filter(|v| {
                                v.settings.get("jobId") == Some(&json!(task.id))
                                    && v.settings.get("cacheKey") == Some(&json!(cache_key))
                            })
                            .max_by_key(|v| v.number)
                        {
                            for artifact in &version.artifacts {
                                repo.verify_artifact(artifact).context(
                                    "저장된 결과가 변경되거나 사라져 재사용할 수 없습니다.",
                                )?;
                            }
                            let size = version
                                .artifacts
                                .iter()
                                .find(|a| is_raster(&a.format))
                                .filter(|_| asset.kind != AssetKind::Model)
                                .map(|a| raster::inspect(&repo.artifact_path(&a.path)?))
                                .transpose()?
                                .map(|info| (info.width, info.height));
                            selected.push((asset.id.clone(), version.id.clone(), size));
                        }
                    }
                    if selected.is_empty() {
                        bail!("해시와 작업 설정이 일치하는 저장된 결과를 찾을 수 없습니다.")
                    }
                    for (id, version_id, size) in selected {
                        let asset = project.assets.iter_mut().find(|a| a.id == id).unwrap();
                        asset.active_version_id = version_id;
                        if let Some((width, height)) = size {
                            asset.width = Some(width);
                            asset.height = Some(height)
                        }
                    }
                    repo.save_project(&project)?;
                }
                self.snapshot()
            }
            "export" => {
                let _dispatch = self.inner.dispatch.lock().unwrap();
                self.ensure_local_io_idle()?;
                let _guard = self.inner.io.lock().unwrap();
                let root = self.root()?;
                let repo = Repository::open(&root)?;
                let mut ids: Vec<String> = request
                    .get("assetIds")
                    .map(|v| serde_json::from_value(v.clone()))
                    .transpose()?
                    .unwrap_or_default();
                // Sprite metadata references its actual input pixels; include their
                // assets so selected-atlas exports keep those references portable.
                if !ids.is_empty() {
                    let project = repo.project()?;
                    let mut cursor = 0;
                    while cursor < ids.len() {
                        let asset = asset_from(&project, &ids[cursor])?;
                        let dependencies: Vec<String> = asset
                            .versions
                            .iter()
                            .flat_map(|v| {
                                v.settings
                                    .get("inputs")
                                    .and_then(Value::as_array)
                                    .into_iter()
                                    .flatten()
                                    .filter_map(|i| i["assetId"].as_str().map(str::to_owned))
                            })
                            .collect();
                        for dependency in dependencies {
                            if !ids.contains(&dependency) {
                                ids.push(dependency)
                            }
                        }
                        cursor += 1;
                    }
                }
                let path =
                    repo.export_bundle(&PathBuf::from(text_field(&request, "destination")?), &ids)?;
                // Optional raster format is local conversion, with additional manifest files.
                if let Some(format) = request["format"].as_str().filter(|f| *f != "png") {
                    self.convert_bundle(&path, format)?;
                }
                Ok(json!({"path":path}))
            }
            "cancel" => {
                {
                    let _io = self.inner.io.lock().unwrap();
                    let root = self.root()?;
                    let ids = SchedulerStore::open(&root.join("scheduler.sqlite"))?
                        .cancel(text_field(&request, "jobId")?)?;
                    for id in ids {
                        if let Some(runner) = self.inner.runners.lock().unwrap().get(&id) {
                            runner.cancel.store(true, Ordering::SeqCst);
                        }
                    }
                }
                self.snapshot()
            }
            "rerun" => {
                let root = self.root()?;
                {
                    let _dispatch = self.inner.dispatch.lock().unwrap();
                    // Queue failure/success alone does not prove that the
                    // corresponding worker and its process handles exited.
                    if !self.inner.runners.lock().unwrap().is_empty() {
                        bail!("실행 중인 작업이 모두 종료되면 재실행할 수 있습니다. 작업을 완료하거나 취소한 뒤 다시 시도해 주세요.");
                    }
                    SchedulerStore::open(&root.join("scheduler.sqlite"))?
                        .rerun(text_field(&request, "jobId")?)?;
                }
                self.snapshot()
            }
            "provider_status" => self.provider_status(),
            "provider_login" => self.provider_login(),
            "generate" => {
                self.enqueue_generation(&request)?;
                self.snapshot()
            }
            "job_events" => {
                let root = self.root()?;
                Ok(serde_json::to_value(
                    SchedulerStore::open(&root.join("scheduler.sqlite"))?.events_after(
                        request["cursor"].as_u64().unwrap_or(0),
                        request["limit"].as_u64().unwrap_or(100).clamp(1, 256) as usize,
                    )?,
                )?)
            }
            _ => bail!("지원하지 않는 작업입니다: {}", action),
        }
    }
    fn import_fixtures(&self, count: usize) -> Result<()> {
        let names = [
            "moon-crystal",
            "forest-potion",
            "brass-key",
            "ember-blade",
            "oak-shield",
            "wild-mushroom",
            "travel-satchel",
            "star-compass",
            "ancient-scroll",
            "river-stone",
            "harvest-leaf",
            "copper-lantern",
        ];
        for name in names.iter().take(count) {
            self.import_raster(
                &self.inner.examples.join(format!("{name}.png")),
                AssetSource::Fixture,
            )?;
        }
        Ok(())
    }
    fn import_raster(&self, path: &Path, source: AssetSource) -> Result<()> {
        // Reject unsupported inputs before reserving storage, then validate the
        // immutable copy again: an external file can change between these steps.
        raster::inspect(path).context("PNG, WebP, JPEG 이미지 파일인지 확인해 주세요.")?;
        let _guard = self.inner.io.lock().unwrap();
        let mut repo = Repository::open(&self.root()?)?;
        let mut artifact = repo.copy_in(
            path,
            "originals",
            path.file_name()
                .and_then(|n| n.to_str())
                .context("파일명을 읽을 수 없습니다.")?,
        )?;
        artifact.role = ArtifactRole::Source;
        let copied = repo.artifact_path(&artifact.path)?;
        let info = raster::inspect(&copied)?;
        let actual_format = image::ImageReader::open(&copied)?
            .with_guessed_format()?
            .format()
            .context("이미지 형식을 확인할 수 없습니다.")?;
        let extension_matches = matches!(
            (actual_format, artifact.format.as_str()),
            (image::ImageFormat::Png, "png")
                | (image::ImageFormat::Jpeg, "jpg" | "jpeg")
                | (image::ImageFormat::WebP, "webp")
        );
        if !extension_matches {
            bail!("파일 확장자와 실제 이미지 형식이 다릅니다. 원본을 보존하고 올바른 확장자의 복사본을 가져와 주세요.")
        }
        let version_id = Uuid::new_v4().to_string();
        let validation = image_report(&artifact.id, &info)?;
        let version = AssetVersion {
            id: version_id.clone(),
            number: 1,
            created_at: now(),
            prompt: String::new(),
            source,
            requested_model: None,
            confirmed_model: None,
            provider_version: None,
            artifacts: vec![artifact],
            settings: BTreeMap::from([
                ("width".into(), json!(info.width)),
                ("height".into(), json!(info.height)),
            ]),
            validation: Some(validation),
        };
        let asset = Asset {
            id: Uuid::new_v4().to_string(),
            name: path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("이미지")
                .to_owned(),
            kind: AssetKind::Image,
            folder: if source == AssetSource::Fixture {
                "로컬 예제".into()
            } else {
                "가져온 이미지".into()
            },
            tags: if source == AssetSource::Fixture {
                vec!["예제".into(), "판타지".into()]
            } else {
                vec![]
            },
            active_version_id: version_id,
            versions: vec![version],
            width: Some(info.width),
            height: Some(info.height),
            mesh: None,
        };
        repo.add_asset(asset)
    }
    fn run_job(&self, root: &Path, task: &Job, cancel: &AtomicBool) -> Result<()> {
        if cancel.load(Ordering::Relaxed) {
            bail!("작업이 취소되었습니다.")
        }
        let work = root
            .join("cache")
            .join(format!("{}-{}", task.id, Uuid::new_v4()));
        fs::create_dir_all(&work)?;
        let payload = serde_json::to_value(&task.payload)?;
        SchedulerStore::open(&root.join("scheduler.sqlite"))?.set_progress(
            &task.id,
            "파일 처리",
            None,
            None,
        )?;
        match task.kind.as_str() {
            "image_process" => {
                let source = resolve_artifact(root, text_field(&payload, "source")?)?;
                let original = resolve_artifact(root, text_field(&payload, "original")?)?;
                let output = work.join("processed.png");
                let info = raster::process_with_original(
                    &source,
                    &original,
                    &output,
                    &payload["operation"],
                )?;
                if cancel.load(Ordering::Relaxed) {
                    bail!("작업이 취소되었습니다.")
                }
                let _guard = self.inner.io.lock().unwrap();
                if cancel.load(Ordering::Relaxed) {
                    bail!("작업이 취소되었습니다.")
                };
                let mut repo = Repository::open(root)?;
                let project = repo.project()?;
                let asset = asset_from(
                    &project,
                    task.asset_id.as_deref().context("에셋 ID가 없습니다.")?,
                )?;
                let mut artifact = repo.copy_in(&output, "outputs", "processed.png")?;
                artifact.role = ArtifactRole::Output;
                repo.verify_artifact(&artifact)?;
                let copied_info = raster::inspect(&repo.artifact_path(&artifact.path)?)?;
                if copied_info.width != info.width || copied_info.height != info.height {
                    bail!("처리 파일의 검증 결과가 저장 파일과 다릅니다.");
                }
                let report = image_report(&artifact.id, &copied_info)?;
                let mut settings = task.payload.clone();
                settings.insert("jobId".into(), json!(task.id));
                settings.insert("cacheKey".into(), json!(task.cache_key));
                settings.insert("width".into(), json!(info.width));
                settings.insert("height".into(), json!(info.height));
                let version = AssetVersion {
                    id: Uuid::new_v4().to_string(),
                    number: asset.versions.iter().map(|v| v.number).max().unwrap_or(0) + 1,
                    created_at: now(),
                    prompt: asset
                        .versions
                        .first()
                        .map(|v| v.prompt.clone())
                        .unwrap_or_default(),
                    source: asset
                        .versions
                        .first()
                        .map(|v| v.source)
                        .unwrap_or(AssetSource::Import),
                    requested_model: None,
                    confirmed_model: None,
                    provider_version: Some("local-raster-0.1.0".into()),
                    artifacts: vec![artifact],
                    settings,
                    validation: Some(report),
                };
                repo.add_version(&asset.id, version)?;
                let mut updated = repo.project()?;
                let asset = updated
                    .assets
                    .iter_mut()
                    .find(|a| Some(&a.id) == task.asset_id.as_ref())
                    .unwrap();
                asset.width = Some(info.width);
                asset.height = Some(info.height);
                repo.save_project(&updated)?;
            }
            "image_validate" => {
                let _guard = self.inner.io.lock().unwrap();
                if cancel.load(Ordering::Relaxed) {
                    bail!("작업이 취소되었습니다.")
                };
                let mut repo = Repository::open(root)?;
                let mut project = repo.project()?;
                let asset = project
                    .assets
                    .iter_mut()
                    .find(|a| Some(&a.id) == task.asset_id.as_ref())
                    .context("에셋이 없습니다.")?;
                let version = asset
                    .versions
                    .iter_mut()
                    .filter(|v| v.settings.get("jobId") == payload.get("processJobId"))
                    .max_by_key(|v| v.number)
                    .context("검사할 버전이 없습니다.")?;
                let artifact = version
                    .artifacts
                    .iter()
                    .find(|a| is_raster(&a.format))
                    .context("검사할 이미지가 없습니다.")?;
                let info = raster::inspect(&resolve_artifact(root, &artifact.path)?)?;
                version.validation = Some(image_report(&artifact.id, &info)?);
                version
                    .settings
                    .insert("validationJobId".into(), json!(task.id));
                version
                    .settings
                    .insert("validationAttempt".into(), json!(task.attempts));
                version.settings.insert(
                    "validationExecutionId".into(),
                    task.payload
                        .get("executionId")
                        .cloned()
                        .context("실행 식별자가 없습니다.")?,
                );
                repo.save_project(&project)?;
            }
            "normal_map" => {
                let input = resolve_artifact(root, text_field(&payload, "source")?)?;
                let output = work.join("normal.png");
                let info = raster::derive_normal(
                    &input,
                    &output,
                    payload["strength"].as_f64().unwrap_or(2.0) as f32,
                    payload["directX"].as_bool().unwrap_or(false),
                )?;
                let _guard = self.inner.io.lock().unwrap();
                if cancel.load(Ordering::Relaxed) {
                    bail!("작업이 취소되었습니다.")
                };
                let mut repo = Repository::open(root)?;
                let mut artifact = repo.copy_in(&output, "outputs", "normal.png")?;
                artifact.role = ArtifactRole::Output;
                let mut settings = task.payload.clone();
                settings.insert("mapType".into(), json!("normal"));
                settings.insert("colorSpace".into(), json!("linear"));
                settings.insert(
                    "normalConvention".into(),
                    json!(if payload["directX"] == true {
                        "DirectX"
                    } else {
                        "OpenGL"
                    }),
                );
                settings.insert(
                    "derivation".into(),
                    json!("Luminance-derived height heuristic; not physical surface measurement"),
                );
                record_generated(
                    &mut repo,
                    new_asset(
                        "노멀맵 · 휴리스틱".into(),
                        AssetKind::Texture,
                        AssetSource::Procedural,
                        vec![artifact.clone()],
                        Some((info.width, info.height)),
                        None,
                        Some(image_report(&artifact.id, &info)?),
                        settings,
                    ),
                    task,
                )?;
            }
            "atlas" => {
                let inputs = payload["inputs"]
                    .as_array()
                    .context("아틀라스 입력이 없습니다.")?;
                let paths: Vec<PathBuf> = inputs
                    .iter()
                    .map(|v| resolve_artifact(root, text_field(v, "path")?))
                    .collect::<Result<_>>()?;
                let options: AtlasOptions = serde_json::from_value(payload["options"].clone())?;
                let output = work.join("atlas.png");
                let packed = raster::pack_atlas(
                    &paths,
                    &output,
                    options.width,
                    options.height,
                    options.padding,
                )?;
                if cancel.load(Ordering::Relaxed) {
                    bail!("작업이 취소되었습니다.")
                }
                let _guard = self.inner.io.lock().unwrap();
                if cancel.load(Ordering::Relaxed) {
                    bail!("작업이 취소되었습니다.")
                };
                let mut repo = Repository::open(root)?;
                let mut image_artifact = repo.copy_in(&output, "outputs", "atlas.png")?;
                image_artifact.role = ArtifactRole::Output;
                // Make source paths portable and include an asset id for every frame.
                let mut metadata = serde_json::to_value(&packed)?;
                if let Some(frames) = metadata["frames"].as_array_mut() {
                    for (frame, input) in frames.iter_mut().zip(inputs) {
                        frame["file"] = input["path"].clone();
                        frame["assetId"] = input["assetId"].clone();
                        frame["pivot"] = json!({"x":payload["pivot"][0],"y":payload["pivot"][1]});
                    }
                }
                metadata["image"] = json!(image_artifact.path);
                metadata["size"] = json!({"width":packed.image.width,"height":packed.image.height});
                metadata["frameRate"] = payload["frameRate"].clone();
                metadata["pivot"] = payload["pivot"].clone();
                let metadata_path = work.join("atlas.json");
                fs::write(&metadata_path, serde_json::to_vec_pretty(&metadata)?)?;
                let mut meta_artifact = repo.copy_in(&metadata_path, "outputs", "atlas.json")?;
                meta_artifact.role = ArtifactRole::Metadata;
                record_generated(
                    &mut repo,
                    new_asset(
                        "아틀라스".into(),
                        AssetKind::Sprite,
                        AssetSource::Procedural,
                        vec![image_artifact.clone(), meta_artifact],
                        Some((packed.image.width, packed.image.height)),
                        None,
                        Some(image_report(&image_artifact.id, &packed.image)?),
                        task.payload.clone(),
                    ),
                    task,
                )?;
            }
            "split" => {
                let source = resolve_artifact(root, text_field(&payload, "source")?)?;
                let output = work.join("frames");
                let width = dimension_field(&payload, "frameWidth")?;
                let height = dimension_field(&payload, "frameHeight")?;
                let frames = raster::split_sheet(&source, &output, width, height)?;
                for (index, path) in frames.iter().enumerate() {
                    if cancel.load(Ordering::Relaxed) {
                        bail!("작업이 취소되었습니다.")
                    };
                    let info = raster::inspect(path)?;
                    let _guard = self.inner.io.lock().unwrap();
                    if cancel.load(Ordering::Relaxed) {
                        bail!("작업이 취소되었습니다.")
                    }
                    let mut repo = Repository::open(root)?;
                    let mut artifact =
                        repo.copy_in(path, "outputs", &format!("frame-{index:03}.png"))?;
                    artifact.role = ArtifactRole::Output;
                    let mut settings = task.payload.clone();
                    settings.insert("frameIndex".into(), json!(index));
                    settings.insert("frameRate".into(), payload["frameRate"].clone());
                    settings.insert("pivot".into(), payload["pivot"].clone());
                    record_generated(
                        &mut repo,
                        new_asset(
                            format!("프레임 {index:03}"),
                            AssetKind::Sprite,
                            AssetSource::Procedural,
                            vec![artifact.clone()],
                            Some((info.width, info.height)),
                            None,
                            Some(image_report(&artifact.id, &info)?),
                            settings,
                        ),
                        task,
                    )?;
                }
            }
            "blender_model" => self.run_blender(root, task, &work, cancel)?,
            "image_generate" => self.run_generation(root, task, &work, cancel)?,
            _ => bail!("지원되지 않는 작업 유형입니다."),
        }
        Ok(())
    }
    fn run_blender(&self, root: &Path, task: &Job, work: &Path, cancel: &AtomicBool) -> Result<()> {
        let params = task
            .payload
            .get("parameters")
            .context("모델 매개변수가 없습니다.")?;
        let parameters: ModelParameters = serde_json::from_value(params.clone())?;
        validate_model(&parameters)?;
        let input = work.join("input.json");
        fs::write(&input, serde_json::to_vec(params)?)?;
        let style_file = work.join("style.json");
        fs::write(
            &style_file,
            serde_json::to_vec(
                task.payload
                    .get("styleGuide")
                    .context("스타일 가이드가 없습니다.")?,
            )?,
        )?;
        let output = work.join("result");
        let stdout = fs::File::create(work.join("worker.log"))?;
        let stderr = stdout.try_clone()?;
        let mut command = Command::new(
            self.inner
                .blender
                .as_ref()
                .context("Blender를 찾을 수 없습니다.")?,
        );
        command
            .args([
                "--background",
                "--factory-startup",
                "--disable-autoexec",
                "--threads",
                "2",
                "--python",
            ])
            .arg(&self.inner.worker)
            .args(["--", "--input"])
            .arg(&input)
            .arg("--output-dir")
            .arg(&output)
            .arg("--style-file")
            .arg(&style_file)
            .env_clear()
            .stdout(stdout)
            .stderr(stderr);
        for key in [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "PATH",
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        SchedulerStore::open(&root.join("scheduler.sqlite"))?.set_progress(
            &task.id,
            "Blender · 메시 / 렌더링",
            None,
            None,
        )?;
        let mut child = crate::process_guard::spawn_guarded(&mut command)
            .context("Blender 작업자를 시작할 수 없습니다.")?;
        if let Some(runner) = self.inner.runners.lock().unwrap().get_mut(&task.id) {
            if runner_matches(runner, task) {
                runner.pid = Some(child.id());
            }
        }
        let start = Instant::now();
        loop {
            if cancel.load(Ordering::Relaxed) || self.inner.stop.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                bail!("Blender 작업이 취소되었습니다. 기존 완료 파일은 보존했습니다.")
            }
            if start.elapsed() > Duration::from_secs(600) {
                let _ = child.kill();
                let _ = child.wait();
                bail!("Blender 작업이 10분 제한을 초과했습니다.")
            }
            if let Some(status) = child.try_wait()? {
                if !status.success() {
                    bail!("Blender 작업자 오류. 프로젝트 cache의 worker.log에서 상세 내용을 확인해 주세요.")
                }
                break;
            }
            thread::sleep(Duration::from_millis(150));
        }
        let report: Value = serde_json::from_slice(&fs::read(output.join("validation.json"))?)?;
        if report["valid"] != true {
            bail!("생성된 메시가 검증을 통과하지 못했습니다.")
        }
        let mesh: MeshInfo = serde_json::from_value(report["mesh"].clone())?;
        let spec: AssetSpec = serde_json::from_value(
            task.payload
                .get("spec")
                .context("제작 규격이 없습니다.")?
                .clone(),
        )?;
        if mesh.triangles > spec.polygon_budget {
            bail!(
                "메시가 폴리곤 예산을 초과했습니다: {} / {}",
                mesh.triangles,
                spec.polygon_budget
            )
        }
        let _guard = self.inner.io.lock().unwrap();
        if cancel.load(Ordering::Relaxed) {
            bail!("작업이 취소되었습니다.")
        };
        let mut repo = Repository::open(root)?;
        let mut artifacts = Vec::new();
        for (name, role) in [
            ("model.glb", ArtifactRole::Output),
            ("source.blend", ArtifactRole::Source),
            ("thumbnail.png", ArtifactRole::Thumbnail),
            ("validation.json", ArtifactRole::Metadata),
            ("turntable-00.png", ArtifactRole::Thumbnail),
            ("turntable-01.png", ArtifactRole::Thumbnail),
            ("turntable-02.png", ArtifactRole::Thumbnail),
            ("turntable-03.png", ArtifactRole::Thumbnail),
        ] {
            let mut artifact = repo.copy_in(&output.join(name), "outputs", name)?;
            artifact.role = role;
            artifacts.push(artifact);
        }
        let glb_id = artifacts
            .iter()
            .find(|a| a.format == "glb")
            .unwrap()
            .id
            .clone();
        let validation = ValidationReport {
            id: Uuid::new_v4().to_string(),
            artifact_id: glb_id,
            created_at: now(),
            checks: serde_json::from_value(report["checks"].clone())?,
            valid: true,
        };
        let mut settings = task.payload.clone();
        settings.insert("blenderVersion".into(), report["blenderVersion"].clone());
        settings.insert("appliedStyleGuide".into(), report["styleGuide"].clone());
        record_generated(
            &mut repo,
            new_asset(
                parameters.name,
                AssetKind::Model,
                AssetSource::Procedural,
                artifacts,
                None,
                Some(mesh),
                Some(validation),
                settings,
            ),
            task,
        )?;
        Ok(())
    }
    fn convert_bundle(&self, path: &Path, format: &str) -> Result<()> {
        if !["webp", "jpeg", "jpg"].contains(&format) {
            bail!("지원되는 내보내기 형식은 PNG, WebP, JPEG입니다.")
        }
        let manifest_path = path.join("manifest.json");
        let mut manifest: ExportManifest = serde_json::from_slice(&fs::read(&manifest_path)?)?;
        fs::create_dir_all(path.join("converted"))?;
        for asset in &manifest.assets {
            if asset.kind == AssetKind::Model {
                continue;
            }
            let version = asset
                .versions
                .iter()
                .find(|v| v.id == asset.active_version_id)
                .context("활성 버전이 없습니다.")?;
            if let Some(input) = version.artifacts.iter().find(|a| is_raster(&a.format)) {
                let output_id = Uuid::new_v4().to_string();
                let output = path
                    .join("converted")
                    .join(format!("{}.{}", output_id, format));
                raster::convert(&resolve_artifact(path, &input.path)?, &output, format)?;
                manifest.files.push(Artifact {
                    id: Uuid::new_v4().to_string(),
                    path: format!("converted/{}.{}", output_id, format),
                    format: format.into(),
                    sha256: asset_core::sha256_file(&output)?.0,
                    bytes: fs::metadata(&output)?.len(),
                    role: ArtifactRole::Output,
                });
            }
        }
        atomic_new_replace(&manifest_path, &serde_json::to_vec_pretty(&manifest)?)?;
        Ok(())
    }
}

fn find_blender() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("BLENDER_EXECUTABLE")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
    {
        return Some(path);
    }
    #[cfg(windows)]
    {
        let base = Path::new("C:/Program Files/Blender Foundation");
        if let Ok(entries) = fs::read_dir(base) {
            let mut paths: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path().join("blender.exe"))
                .filter(|p| p.is_file())
                .collect();
            paths.sort();
            if let Some(path) = paths.pop() {
                return Some(path);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let path = PathBuf::from("/Applications/Blender.app/Contents/MacOS/Blender");
        if path.is_file() {
            return Some(path);
        }
    }
    None
}
fn blender_version(path: &Path) -> Option<String> {
    let mut cmd = Command::new(path);
    cmd.arg("--version");
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    cmd.output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.lines().next().map(str::to_owned))
}
fn text_field<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("필수 항목이 없습니다: {key}"))
}
fn frame_rate(request: &Value) -> Result<f64> {
    let rate = request
        .get("frameRate")
        .map(|value| value.as_f64().context("재생 속도는 숫자로 입력해 주세요."))
        .transpose()?
        .unwrap_or(12.0);
    if !rate.is_finite() || !(1.0..=240.0).contains(&rate) {
        bail!("재생 속도는 1~240fps입니다.")
    }
    Ok(rate)
}
fn dimension_field(request: &Value, key: &str) -> Result<u32> {
    let size = request[key]
        .as_u64()
        .filter(|size| (1..=8192).contains(size))
        .context("프레임 크기는 1~8192px의 정수입니다.")?;
    Ok(u32::try_from(size)?)
}
fn artifact_pixels(project: &Project, path: &str) -> Result<u64> {
    for asset in &project.assets {
        for version in &asset.versions {
            if version
                .artifacts
                .iter()
                .any(|artifact| artifact.path == path)
            {
                let width = version
                    .settings
                    .get("width")
                    .and_then(Value::as_u64)
                    .or(asset.width.map(u64::from))
                    .context("이미지 너비 기록이 없습니다.")?;
                let height = version
                    .settings
                    .get("height")
                    .and_then(Value::as_u64)
                    .or(asset.height.map(u64::from))
                    .context("이미지 높이 기록이 없습니다.")?;
                if !(1..=8192).contains(&width) || !(1..=8192).contains(&height) {
                    bail!("이미지 크기 기록을 확인해 주세요.")
                }
                return Ok(width.saturating_mul(height));
            }
        }
    }
    bail!("이미지 파일 기록이 없습니다.")
}
fn operation_pixels(operation: &Value) -> Result<u64> {
    if operation["type"] == "resize" {
        let width = dimension_field(operation, "width")?;
        let height = dimension_field(operation, "height")?;
        return Ok(u64::from(width) * u64::from(height));
    }
    Ok(0)
}
fn image_ram_mb(pixels: u64, bytes_per_pixel: u64, floor: u64) -> u64 {
    // Admission estimate includes simultaneous decoded/filter buffers. It is
    // deliberately distinct from an OS-enforced process memory ceiling.
    (pixels.saturating_mul(bytes_per_pixel).div_ceil(1024 * 1024) + 64).max(floor)
}
fn asset_from<'a>(project: &'a Project, id: &str) -> Result<&'a Asset> {
    project
        .assets
        .iter()
        .find(|a| a.id == id)
        .context("선택한 에셋을 찾을 수 없습니다.")
}
fn active_raster(asset: &Asset) -> Result<&Artifact> {
    asset
        .versions
        .iter()
        .find(|v| v.id == asset.active_version_id)
        .and_then(|v| v.artifacts.iter().find(|a| is_raster(&a.format)))
        .context("활성 이미지 파일이 없습니다.")
}
fn is_raster(format: &str) -> bool {
    ["png", "webp", "jpg", "jpeg"].contains(&format.to_ascii_lowercase().as_str())
}
fn resolve_artifact(root: &Path, relative: &str) -> Result<PathBuf> {
    if root.join("project.sqlite").is_file() {
        let repo = Repository::open(root)?;
        let project = repo.project()?;
        let artifact = project
            .assets
            .iter()
            .flat_map(|asset| &asset.versions)
            .flat_map(|version| &version.artifacts)
            .find(|artifact| artifact.path == relative)
            .context("프로젝트에 기록되지 않은 파일은 처리할 수 없습니다.")?;
        repo.verify_artifact(artifact).context(
            "입력 파일이 변경되거나 손상되었습니다. 원본을 복원하거나 새 파일로 가져와 주세요.",
        )?;
        return repo.artifact_path(relative);
    }
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        bail!("프로젝트 밖의 파일 경로를 사용할 수 없습니다.")
    };
    let path = root.join(relative);
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(root.canonicalize()?) {
        bail!("프로젝트 밖의 파일 참조입니다.")
    };
    Ok(path)
}
fn image_report(id: &str, info: &raster::ImageInfo) -> Result<ValidationReport> {
    let checks: Vec<ValidationCheck> = serde_json::from_value(serde_json::to_value(&info.checks)?)?;
    Ok(ValidationReport {
        id: Uuid::new_v4().to_string(),
        artifact_id: id.into(),
        created_at: now(),
        valid: checks.iter().all(|c| c.status != ValidationStatus::Fail),
        checks,
    })
}
fn execution_id(task: &Job) -> Option<&str> {
    task.payload.get("executionId").and_then(Value::as_str)
}
fn same_execution(current: &Job, expected: &Job) -> bool {
    current.id == expected.id
        && current.project_id == expected.project_id
        && execution_id(expected).is_some_and(|identity| execution_id(current) == Some(identity))
}
fn runner_matches(runner: &Runner, expected: &Job) -> bool {
    execution_id(expected).is_some_and(|identity| runner.execution_id.as_deref() == Some(identity))
}
fn job_from(
    project: &Project,
    kind: &str,
    label: &str,
    asset_id: Option<String>,
    resource: JobResource,
    payload: Value,
) -> Result<Job> {
    job(project, kind, label, asset_id, resource, payload)
}
fn job(
    project: &Project,
    kind: &str,
    label: &str,
    asset_id: Option<String>,
    resource: JobResource,
    mut payload: Value,
) -> Result<Job> {
    let cache_key = cache_identity(project, kind, &payload)?;
    if let Some(identity) = &cache_key {
        payload["cacheKey"] = json!(identity);
    }
    Ok(Job {
        id: Uuid::new_v4().to_string(),
        project_id: project.id.clone(),
        asset_id,
        kind: kind.into(),
        label: label.into(),
        status: JobStatus::Pending,
        dependencies: vec![],
        resource,
        attempts: 0,
        created_at: now(),
        started_at: None,
        finished_at: None,
        error: None,
        progress: JobProgress {
            stage: "대기".into(),
            completed: None,
            total: None,
        },
        payload: serde_json::from_value(payload)?,
        cache_key,
    })
}
fn cache_identity(project: &Project, kind: &str, payload: &Value) -> Result<Option<String>> {
    if kind == "image_validate" {
        return Ok(None);
    }
    let mut inputs = Vec::new();
    let mut prompt = payload["prompt"].as_str().unwrap_or("").to_owned();
    let mut paths = Vec::new();
    for key in ["source", "original"] {
        if let Some(path) = payload[key].as_str() {
            paths.push(path)
        }
    }
    if let Some(atlas_inputs) = payload["inputs"].as_array() {
        for input in atlas_inputs {
            paths.push(text_field(input, "path")?)
        }
    }
    for path in paths {
        let version = project
            .assets
            .iter()
            .flat_map(|asset| &asset.versions)
            .find(|version| {
                version
                    .artifacts
                    .iter()
                    .any(|artifact| artifact.path == path)
            })
            .context("캐시 입력 파일 기록이 없습니다.")?;
        let artifact = version
            .artifacts
            .iter()
            .find(|artifact| artifact.path == path)
            .unwrap();
        inputs.push(artifact.sha256.clone());
        if !version.prompt.is_empty() {
            prompt.push_str(&version.prompt);
            prompt.push('\n')
        }
    }
    let mut options = payload.clone();
    if let Some(options) = options.as_object_mut() {
        for key in [
            "source",
            "original",
            "inputs",
            "versionId",
            "resources",
            "toolVersion",
            "workerSha256",
            "prompt",
            "cacheKey",
        ] {
            options.remove(key);
        }
        options.insert("kind".into(), json!(kind));
    }
    let (provider_version, tool_version) = if kind == "image_generate" {
        (
            text_field(payload, "toolVersion")?.to_owned(),
            "official-codex-native-image:gpt-image-2".to_owned(),
        )
    } else if kind == "blender_model" {
        let version = text_field(payload, "toolVersion")?;
        let worker = text_field(payload, "workerSha256")?;
        (
            version.to_owned(),
            format!("fixed-blender-worker-sha256:{worker}"),
        )
    } else {
        (
            "local-raster-0.1.0".to_owned(),
            format!(
                "asset-image-pipeline-0.1.0-sha256:{:x}",
                Sha256::digest(include_bytes!(
                    "../../../../crates/image-pipeline/src/lib.rs"
                ))
            ),
        )
    };
    Ok(Some(asset_scheduler::cache_key(
        &prompt,
        &inputs,
        &options,
        &provider_version,
        &tool_version,
    )?))
}
fn active_dependencies(project: &Project, asset_id: &str) -> Vec<String> {
    project
        .jobs
        .iter()
        .filter(|j| {
            j.asset_id.as_deref() == Some(asset_id)
                && matches!(
                    j.status,
                    JobStatus::Pending
                        | JobStatus::Ready
                        | JobStatus::Running
                        | JobStatus::RetryWait
                )
        })
        .map(|j| j.id.clone())
        .collect()
}
fn record_generated(repo: &mut Repository, mut generated: Asset, task: &Job) -> Result<()> {
    generated.versions[0].settings.insert(
        "executionId".into(),
        task.payload
            .get("executionId")
            .cloned()
            .context("실행 식별자가 없습니다.")?,
    );
    generated.versions[0]
        .settings
        .insert("jobId".into(), json!(task.id));
    generated.versions[0]
        .settings
        .insert("cacheKey".into(), json!(task.cache_key));
    generated.versions[0].prompt = task
        .payload
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if let Some(version) = task
        .payload
        .get("toolVersion")
        .and_then(Value::as_str)
        .filter(|_| generated.versions[0].source != AssetSource::CodexSubscription)
    {
        generated.versions[0].provider_version = Some(version.to_owned())
    }
    let project = repo.project()?;
    let frame = generated.versions[0].settings.get("frameIndex");
    let previous = project.assets.iter().find(|asset| {
        asset.versions.iter().any(|version| {
            version.settings.get("jobId") == Some(&json!(task.id))
                && version.settings.get("frameIndex") == frame
        })
    });
    if let Some(previous) = previous {
        let mut version = generated.versions.remove(0);
        version.number = previous
            .versions
            .iter()
            .map(|v| v.number)
            .max()
            .unwrap_or(0)
            + 1;
        repo.add_version(&previous.id, version)?;
        let mut updated = repo.project()?;
        let asset = updated
            .assets
            .iter_mut()
            .find(|a| a.id == previous.id)
            .unwrap();
        asset.width = generated.width;
        asset.height = generated.height;
        asset.mesh = generated.mesh;
        repo.save_project(&updated)?;
    } else {
        repo.add_asset(generated)?
    }
    Ok(())
}
fn new_asset(
    name: String,
    kind: AssetKind,
    source: AssetSource,
    artifacts: Vec<Artifact>,
    size: Option<(u32, u32)>,
    mesh: Option<MeshInfo>,
    validation: Option<ValidationReport>,
    mut settings: BTreeMap<String, Value>,
) -> Asset {
    if let Some((width, height)) = size {
        settings.insert("width".into(), json!(width));
        settings.insert("height".into(), json!(height));
    }
    let version_id = Uuid::new_v4().to_string();
    Asset {
        id: Uuid::new_v4().to_string(),
        name,
        kind,
        folder: if kind == AssetKind::Model {
            "3D 모델".into()
        } else {
            "제작 결과".into()
        },
        tags: vec![],
        active_version_id: version_id.clone(),
        width: size.map(|s| s.0),
        height: size.map(|s| s.1),
        mesh,
        versions: vec![AssetVersion {
            id: version_id,
            number: 1,
            created_at: now(),
            prompt: String::new(),
            source,
            requested_model: None,
            confirmed_model: None,
            provider_version: Some(if kind == AssetKind::Model {
                "Blender procedural worker".into()
            } else {
                "local-raster-0.1.0".into()
            }),
            artifacts,
            settings,
            validation,
        }],
    }
}
fn validate_spec(spec: &AssetSpec) -> Result<()> {
    if spec.width == 0
        || spec.height == 0
        || spec.width > 8192
        || spec.height > 8192
        || spec
            .pivot
            .iter()
            .any(|x| !x.is_finite() || *x < 0.0 || *x > 1.0)
        || spec.polygon_budget == 0
    {
        bail!("크기, 피벗, 폴리곤 예산을 확인해 주세요.")
    };
    Ok(())
}
fn validate_model(p: &ModelParameters) -> Result<()> {
    if [p.width, p.height, p.depth]
        .iter()
        .any(|v| !v.is_finite() || *v < 0.03 || *v > 100.0)
        || !p.bevel.is_finite()
        || p.bevel < 0.0
        || p.bevel > p.width.min(p.depth).min(p.height) / 4.0
        || p.name.trim().is_empty()
        || p.name.chars().count() > 80
        || p.name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || p.color.len() != 7
        || !p.color.starts_with('#')
        || !p.color[1..].chars().all(|c| c.is_ascii_hexdigit())
    {
        bail!("모델 이름, 치수(0.03~100m), 베벨, 색상 값을 확인해 주세요.")
    };
    Ok(())
}
fn atomic_new_replace(path: &Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    fs::write(&temp, bytes)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
        }
        let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 1 | 8) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(not(windows))]
    fs::rename(temp, path)?;
    Ok(())
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    struct TestBackend {
        base: PathBuf,
        directory: PathBuf,
        root: PathBuf,
        backend: Backend,
    }

    impl TestBackend {
        fn new() -> Self {
            let base = std::env::temp_dir().canonicalize().unwrap();
            let directory = base.join(format!("asset-worker-lifecycle-{}", Uuid::new_v4()));
            fs::create_dir(&directory).unwrap();
            // Keep the actual backend/SQLite/lease/raster path while excluding
            // any discovery, invocation or submission to an external provider.
            let backend = Backend {
                inner: Arc::new(Inner {
                    data: directory.join("appdata"),
                    examples: directory.join("unused-examples"),
                    worker: directory.join("unused-worker.py"),
                    blender: None,
                    blender_version: None,
                    worker_sha256: None,
                    current: Mutex::new(None),
                    project_lease: Mutex::new(None),
                    requests: Mutex::new(()),
                    io: Mutex::new(()),
                    dispatch: Mutex::new(()),
                    initialize: Mutex::new(()),
                    runners: Mutex::new(BTreeMap::new()),
                    stop: AtomicBool::new(false),
                    limits: ResourceLimits::default(),
                    provider_runtime: Mutex::new(None),
                    provider_connection: Mutex::new(provider::unavailable_connection(
                        "단위 테스트는 외부 생성을 요청하지 않습니다.",
                    )),
                    codex_installer: asset_providers::installer::CodexInstaller::new(
                        directory.join("appdata/codex-runtimes"),
                    ),
                }),
            };
            backend
                .request(json!({"action":"create","root":directory.join("한글 프로젝트"),"name":"실행 수명 검증"}))
                .unwrap();
            let root = backend.current_root().unwrap();
            Self {
                base,
                directory,
                root,
                backend,
            }
        }

        fn queue(&self) -> SchedulerStore {
            SchedulerStore::open(&self.root.join("scheduler.sqlite")).unwrap()
        }

        fn claimed(&self) -> Job {
            let project = Repository::open(&self.root).unwrap().project().unwrap();
            let task = job(
                &project,
                "normal_map",
                "실행 수명 테스트",
                None,
                JobResource::Cpu,
                json!({}),
            )
            .unwrap();
            let queue = self.queue();
            queue.enqueue(task).unwrap();
            let task = queue
                .claim_ready(&ResourceLimits::default())
                .unwrap()
                .remove(0);
            self.install_runner(&task);
            task
        }

        fn install_runner(&self, task: &Job) -> Arc<AtomicBool> {
            let cancel = Arc::new(AtomicBool::new(false));
            self.backend.inner.runners.lock().unwrap().insert(
                task.id.clone(),
                Runner {
                    cancel: cancel.clone(),
                    pid: None,
                    execution_id: execution_id(task).map(str::to_owned),
                },
            );
            cancel
        }
    }

    impl Drop for TestBackend {
        fn drop(&mut self) {
            self.backend.shutdown();
            // Synthetic runners have no thread or process. Actual raster
            // runners are allowed to finish before owned test files are removed.
            let deadline = Instant::now() + Duration::from_secs(3);
            while !self.backend.inner.runners.lock().unwrap().is_empty()
                && Instant::now() < deadline
            {
                thread::sleep(Duration::from_millis(10));
            }
            if !self.backend.inner.runners.lock().unwrap().is_empty() {
                return;
            }
            self.backend.inner.project_lease.lock().unwrap().take();
            let Ok(metadata) = fs::symlink_metadata(&self.directory) else {
                return;
            };
            if metadata.file_type().is_symlink() {
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
    fn rerun_waits_for_the_failed_worker_to_exit() {
        let fixture = TestBackend::new();
        let task = fixture.claimed();
        fixture
            .queue()
            .fail(&task.id, FailureKind::Worker, "워커 종료 전 기록된 실패")
            .unwrap();
        assert!(fixture
            .backend
            .request(json!({"action":"rerun","jobId":task.id}))
            .is_err());
        let persisted = fixture.queue().jobs().unwrap().remove(0);
        assert_eq!(persisted.status, JobStatus::Failed);
        assert_eq!(execution_id(&persisted), execution_id(&task));
        fixture
            .backend
            .finish_job(&fixture.root, &task, Err(anyhow!("이전 실행 종료")));
        assert!(fixture.backend.inner.runners.lock().unwrap().is_empty());
        fixture
            .backend
            .request(json!({"action":"rerun","jobId":task.id}))
            .unwrap();
        let next = fixture
            .queue()
            .claim_ready(&ResourceLimits::default())
            .unwrap()
            .remove(0);
        assert_ne!(execution_id(&next), execution_id(&task));
    }

    #[test]
    fn old_finalizer_cannot_mutate_or_remove_a_successor_execution() {
        let fixture = TestBackend::new();
        let old = fixture.claimed();
        let queue = fixture.queue();
        queue
            .fail(&old.id, FailureKind::Worker, "이전 실행 실패")
            .unwrap();
        // Bypass command admission deliberately to verify the finalizer's
        // independent protection against a replaced execution in the store.
        queue.rerun(&old.id).unwrap();
        let next = queue
            .claim_ready(&ResourceLimits::default())
            .unwrap()
            .remove(0);
        let successor_cancel = fixture.install_runner(&next);
        fixture
            .backend
            .finish_job(&fixture.root, &old, Err(anyhow!("늦게 도착한 이전 실패")));
        fixture.backend.finish_job(&fixture.root, &old, Ok(()));
        let current = queue.jobs().unwrap().remove(0);
        assert_eq!(current.status, JobStatus::Running);
        assert_eq!(execution_id(&current), execution_id(&next));
        {
            let runners = fixture.backend.inner.runners.lock().unwrap();
            let runner = runners.get(&next.id).unwrap();
            assert!(runner_matches(runner, &next));
            assert!(Arc::ptr_eq(&runner.cancel, &successor_cancel));
        }
        queue.cancel(&next.id).unwrap();
        fixture
            .backend
            .finish_job(&fixture.root, &old, Err(anyhow!("이전 실행의 자원 해제")));
        assert_eq!(
            queue.jobs().unwrap().remove(0).payload["cancellationAwaitingWorker"],
            json!(true)
        );
        fixture
            .backend
            .finish_job(&fixture.root, &next, Err(anyhow!("새 실행 종료")));
        assert!(fixture.backend.inner.runners.lock().unwrap().is_empty());
        assert!(!queue
            .jobs()
            .unwrap()
            .remove(0)
            .payload
            .contains_key("cancellationAwaitingWorker"));
    }

    #[test]
    fn actual_backend_raster_process_then_validation_survives_reopen() {
        let fixture = TestBackend::new();
        let original = fixture.directory.join("사용자 원본.png");
        fs::write(
            &original,
            include_bytes!("../../../../tests/core/fixtures/reference.png"),
        )
        .unwrap();
        let original_hash = asset_core::sha256_file(&original).unwrap();
        let imported = fixture
            .backend
            .request(json!({"action":"import","paths":[original]}))
            .unwrap();
        let asset_id = imported["project"]["assets"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        fixture
            .backend
            .request(json!({"action":"process","assetId":asset_id,"operation":{"type":"resize","width":7,"height":9,"pixelArt":false}}))
            .unwrap();
        fixture.backend.start();
        let deadline = Instant::now() + Duration::from_secs(10);
        let jobs = loop {
            let snapshot = fixture.backend.snapshot().unwrap();
            let jobs: Vec<Job> =
                serde_json::from_value(snapshot["project"]["jobs"].clone()).unwrap();
            if jobs.iter().all(|job| job.status == JobStatus::Succeeded) {
                break jobs;
            }
            assert!(
                jobs.iter().all(|job| !matches!(
                    job.status,
                    JobStatus::Failed | JobStatus::Cancelled | JobStatus::ExternalUnknown
                )),
                "raster producer/validator failed: {jobs:?}"
            );
            assert!(
                Instant::now() < deadline,
                "raster jobs did not finish: {jobs:?}"
            );
            thread::sleep(Duration::from_millis(30));
        };
        assert_eq!(jobs.len(), 2);
        assert!(jobs.iter().any(|job| job.kind == "image_process"));
        let validator = jobs
            .iter()
            .find(|job| job.kind == "image_validate")
            .unwrap();
        fixture.backend.shutdown();
        let repository = Repository::open(&fixture.root).unwrap();
        let reopened = repository.project().unwrap();
        let asset = asset_from(&reopened, &asset_id).unwrap();
        assert_eq!(asset.versions.len(), 2);
        assert_eq!((asset.width, asset.height), (Some(7), Some(9)));
        let version = asset
            .versions
            .iter()
            .max_by_key(|version| version.number)
            .unwrap();
        assert!(version.validation.as_ref().unwrap().valid);
        assert_eq!(version.settings["validationJobId"], json!(validator.id));
        assert_eq!(
            version.settings["validationExecutionId"],
            validator.payload["executionId"]
        );
        for artifact in asset.versions.iter().flat_map(|version| &version.artifacts) {
            repository.verify_artifact(artifact).unwrap();
        }
        let info = raster::inspect(
            &repository
                .artifact_path(&version.artifacts[0].path)
                .unwrap(),
        )
        .unwrap();
        assert_eq!((info.width, info.height), (7, 9));
        assert_eq!(asset_core::sha256_file(&original).unwrap(), original_hash);
    }
}
