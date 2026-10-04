//! Local single-image reconstruction and a trusted Blender finishing boundary.
//! Only verified project artifacts and bounded data reach the workers.
use super::*;
use serde::Deserialize;
use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};

const MODEL_ID: &str = "stabilityai/TripoSR";
const MODEL_REVISION: &str = "5b521936b01fbe1890f6f9baed0254ab6351c04a";
const MODEL_SHA256: &str = "429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee";
const CODE_REVISION: &str = "107cefdc244c39106fa830359024f6a2f1c78871";
const MINIMUM_MEMORY_MB: u64 = 16 * 1024;
const IMAGE_MEMORY_MB: u64 = 8 * 1024;

#[derive(Default)]
pub(super) struct SetupState {
    pub(super) cancel: AtomicBool,
    busy: AtomicBool,
    progress: Mutex<(String, String)>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    action: String,
    asset_ids: Vec<String>,
    name: String,
    quality: String,
    height_meters: f64,
    max_triangles: u64,
    texture_resolution: u32,
    preserve_materials: bool,
}

fn physical_memory_mb() -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut memory = 0u64;
        let mut length = std::mem::size_of::<u64>();
        // hw.memsize writes exactly one u64 into the bounded buffer.
        let ok = unsafe {
            libc::sysctlbyname(
                c"hw.memsize".as_ptr(),
                (&mut memory as *mut u64).cast(),
                &mut length,
                std::ptr::null_mut(),
                0,
            )
        };
        if ok == 0 && length == std::mem::size_of::<u64>() {
            return memory / (1024 * 1024);
        }
    }
    0
}

pub(super) fn memory_budget_mb() -> u64 {
    // Reserve at least half the Mac's physical memory for the OS and other apps.
    // Other platforms retain the existing conservative scheduler ceiling.
    let memory = physical_memory_mb();
    if memory >= MINIMUM_MEMORY_MB {
        (memory / 2).min(16 * 1024)
    } else {
        2048
    }
}

fn python() -> Option<PathBuf> {
    [
        "/usr/bin/python3",
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|p| p.is_file())
}

fn validate_request(request: &Request) -> Result<()> {
    if request.action != "quality3d"
        || request.asset_ids.is_empty()
        || request.asset_ids.len() > 5
        || request.asset_ids.iter().collect::<HashSet<_>>().len() != request.asset_ids.len()
        || !["draft", "standard", "high"].contains(&request.quality.as_str())
        || !request.height_meters.is_finite()
        || !(0.03..=100.).contains(&request.height_meters)
        || !(1000..=100000).contains(&request.max_triangles)
        || ![512, 1024, 2048].contains(&request.texture_resolution)
    {
        bail!("정밀 3D 입력 1~5개와 높이·폴리곤·텍스처 설정을 확인해 주세요.");
    }
    let name = request.name.trim();
    if name.is_empty()
        || name.chars().count() > 72
        || name
            .chars()
            .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
        || name == "."
        || name == ".."
    {
        bail!("모델 이름은 경로 문자 없이 1~72자로 입력해 주세요.");
    }
    Ok(())
}

fn process_environment(command: &mut Command) {
    command.env_clear();
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
    command
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("DO_NOT_TRACK", "1")
        .env("PYTHONNOUSERSITE", "1")
        .env("PYTHONUNBUFFERED", "1");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
}

fn last_stage(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(32768)))
        .ok()?;
    let mut bytes = Vec::new();
    file.take(32768).read_to_end(&mut bytes).ok()?;
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| {
            let value: Value = serde_json::from_str(line).ok()?;
            value["stage"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 240)
                .map(str::to_owned)
        })
        .last()
}

fn worker_failure(path: &Path) -> Option<&'static str> {
    let mut file = fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(32768)))
        .ok()?;
    let mut bytes = Vec::new();
    file.take(32768).read_to_end(&mut bytes).ok()?;
    String::from_utf8_lossy(&bytes).lines().filter_map(|line| {
        let value: Value = serde_json::from_str(line).ok()?;
        if value["type"] != "failed" { return None; }
        match value["code"].as_str()? {
            "unsupported_background" => Some("배경이 투명한 PNG·WebP가 필요합니다. 2D 편집기에서 배경을 제거하고 PNG로 저장한 뒤 다시 선택하세요."),
            "multiple_objects" => Some("한 이미지에 분리된 물체가 여러 개 있습니다. 물체별로 자르거나 배경 마스크를 수정한 뒤 다시 선택하세요."),
            "empty_foreground" => Some("보이는 물체가 있는 투명 배경 이미지를 선택하세요."),
            "source_changed" => Some("참고 이미지의 해시가 변경됐습니다. 새 사본을 가져온 뒤 다시 선택하세요."),
            "python_unsupported" => Some("이번 로컬 모델에는 Apple Silicon용 CPython 3.9가 필요합니다. 시스템 Python 버전을 확인해 주세요."),
            "runtime_integrity" => Some("로컬 모델 또는 실행 환경의 검증이 실패했습니다. 로컬 모델 준비 상태를 확인해 주세요."),
            "invalid_image" => Some("이미지는 16~8192px, 최대 1,600만 픽셀·64MiB의 단일 PNG·JPEG·WebP여야 합니다."),
            _ => None,
        }
    }).last()
}

fn release_owned_setup_lock(runtime: &Path, pid: u32) {
    // The known setup process group has been killed and reaped by the caller.
    // Only its own lock in this dedicated, marked runtime may be removed.
    let lock = runtime.join(".setup-lock");
    if runtime.join(".image3d-runtime.json").is_file()
        && fs::read_to_string(&lock)
            .ok()
            .is_some_and(|s| s.trim() == pid.to_string())
    {
        let _ = fs::remove_file(lock);
    }
}

impl Backend {
    pub(super) fn join_quality3d_setup(&self) {
        if let Some(handle) = self.inner.quality3d_setup.thread.lock().unwrap().take() {
            let _ = handle.join();
        }
    }
    fn quality3d_pipeline_hash(&self) -> Result<String> {
        let mut digest = Sha256::new();
        for (folder, name) in [
            ("blender-quality", "worker.py"),
            ("blender-quality", "audit.py"),
            ("image3d", "worker.py"),
            ("image3d", "image_input.py"),
            ("image3d", "runtime_common.py"),
            ("image3d", "image3d_adapter.py"),
            ("image3d", "glb_color.py"),
            ("image3d", "runtime-lock.json"),
        ] {
            digest.update(folder.as_bytes());
            digest.update(name.as_bytes());
            digest.update(
                asset_core::sha256_file(&self.quality3d_worker(folder, name)?)?
                    .0
                    .as_bytes(),
            );
        }
        Ok(format!("{:x}", digest.finalize()))
    }
    fn quality3d_worker(&self, folder: &str, name: &str) -> Result<PathBuf> {
        let workers = self
            .inner
            .worker
            .parent()
            .and_then(Path::parent)
            .context("3D 작업자 경로가 없습니다.")?;
        let path = workers.join(folder).join(name);
        if !path.is_file() {
            bail!("정밀 3D 작업자가 설치되지 않았습니다. 최신 Mac 앱을 설치해 주세요.");
        }
        Ok(path)
    }

    fn quality3d_runtime(&self) -> PathBuf {
        self.inner.data.join("image3d/triposr-cpu-v1")
    }

    fn quality3d_ready(&self) -> Option<Value> {
        let path = self.quality3d_runtime().join("ready.json");
        if fs::metadata(&path).ok()?.len() > 1024 * 1024 {
            return None;
        }
        let ready: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
        if ready["modelId"] != MODEL_ID
            || ready["modelRevision"] != MODEL_REVISION
            || ready["modelSha256"] != MODEL_SHA256
            || ready["codeRevision"] != CODE_REVISION
            || ready["state"] != "ready"
            || ready["installVerified"] != true
            || !Path::new(ready["interpreterPath"].as_str()?).is_file()
        {
            return None;
        }
        Some(ready)
    }

    pub(super) fn ensure_quality3d_setup_idle(&self) -> Result<()> {
        if self.inner.quality3d_setup.busy.load(Ordering::SeqCst) {
            bail!("로컬 3D 모델 준비를 완료하거나 취소한 다음 앱을 업데이트해 주세요.");
        }
        Ok(())
    }

    pub(super) fn quality3d_status(&self) -> Value {
        let supported = cfg!(all(target_os = "macos", target_arch = "aarch64"));
        let busy = self.inner.quality3d_setup.busy.load(Ordering::SeqCst);
        let ready = self.quality3d_ready();
        let installed = ready.is_some();
        let progress = self.inner.quality3d_setup.progress.lock().unwrap().clone();
        let state = if !supported {
            "unsupported"
        } else if busy {
            "preparing"
        } else if installed {
            "ready"
        } else if ["error", "cancelled"].contains(&progress.0.as_str()) {
            &progress.0
        } else {
            "missing"
        };
        let message = if !supported {
            "이번 로컬 이미지→3D 경로는 Apple Silicon Mac에서 검증합니다. Windows·Intel은 추후 확인합니다.".into()
        } else if busy {
            "로컬 3D 모델과 실행 환경을 준비하고 있습니다. 이미지 파일은 전송하지 않습니다.".into()
        } else if installed {
            "로컬 TripoSR이 준비됐습니다. 이미지 한 장에서 추정한 모델을 새 파일로 제작합니다."
                .into()
        } else if !progress.1.is_empty() {
            progress.1
        } else {
            "최초 한 번 모델 가중치 약 1.68GB와 실행 라이브러리를 내려받습니다. 이후 생성은 CPU에서 로컬로 실행합니다.".into()
        };
        json!({"supported":supported,"installed":installed,"busy":busy,"state":state,"message":message,
            "stage":progress.0,"modelId":MODEL_ID,"modelRevision":MODEL_REVISION,"device":"cpu",
            "pythonVersion":ready.as_ref().and_then(|v| v["pythonVersion"].as_str()),
            "weightBytes":1677246742u64,"memoryMb":physical_memory_mb(),"minimumMemoryMb":MINIMUM_MEMORY_MB,
            "blenderReady":self.inner.blender.is_some()})
    }

    pub(super) fn quality3d_setup_request(&self, request: &Value) -> Result<Value> {
        match text_field(request, "action")? {
            "quality3d_status" => Ok(self.quality3d_status()),
            "quality3d_cancel_setup" => {
                self.inner
                    .quality3d_setup
                    .cancel
                    .store(true, Ordering::SeqCst);
                Ok(self.quality3d_status())
            }
            "quality3d_prepare" => {
                let _admission = self.inner.requests.lock().unwrap();
                if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                    bail!("로컬 이미지→3D는 현재 Apple Silicon Mac 검증 경로입니다.");
                }
                if request["confirmed"] != true {
                    bail!("모델·라이브러리 다운로드에 동의해 주세요.");
                }
                if self.inner.stop.load(Ordering::SeqCst) {
                    bail!("앱이 종료되었습니다.");
                }
                if self.quality3d_ready().is_some() {
                    return Ok(self.quality3d_status());
                }
                if physical_memory_mb() < MINIMUM_MEMORY_MB {
                    bail!("로컬 이미지→3D에는 최소 16GB 메모리가 필요합니다. 기존 모델 다듬기는 계속 사용할 수 있습니다.");
                }
                self.ensure_workers_idle()?;
                let interpreter = python().context("Apple Silicon용 CPython 3.9가 필요합니다. 시스템 Python 또는 설치한 Python 버전을 확인해 주세요.")?;
                let script = self.quality3d_worker("image3d", "setup.py")?;
                if self.inner.quality3d_setup.busy.swap(true, Ordering::SeqCst) {
                    return Ok(self.quality3d_status());
                }
                self.inner
                    .quality3d_setup
                    .cancel
                    .store(false, Ordering::SeqCst);
                *self.inner.quality3d_setup.progress.lock().unwrap() =
                    ("실행 환경 준비".into(), String::new());
                let backend = self.clone();
                let handle = thread::spawn(move || {
                    let outcome = backend.prepare_quality3d(&interpreter, &script);
                    if let Err(error) = outcome {
                        let cancelled = backend.inner.quality3d_setup.cancel.load(Ordering::SeqCst);
                        *backend.inner.quality3d_setup.progress.lock().unwrap() = (
                            if cancelled { "cancelled" } else { "error" }.into(),
                            error.to_string(),
                        );
                    }
                    backend
                        .inner
                        .quality3d_setup
                        .busy
                        .store(false, Ordering::SeqCst);
                    backend.release_lease_if_stopped();
                });
                *self.inner.quality3d_setup.thread.lock().unwrap() = Some(handle);
                Ok(self.quality3d_status())
            }
            _ => bail!("지원되지 않는 모델 준비 요청입니다."),
        }
    }

    fn prepare_quality3d(&self, python: &Path, script: &Path) -> Result<()> {
        let log_root = self.inner.data.join("image3d/setup-logs");
        fs::create_dir_all(&log_root)?;
        let log_path = log_root.join(format!("{}.log", Uuid::new_v4()));
        let output = fs::File::create(&log_path)?;
        let mut command = Command::new(python);
        command
            .arg(script)
            .arg("--runtime-root")
            .arg(self.quality3d_runtime())
            .arg("--python-executable")
            .arg(python)
            .stdout(output.try_clone()?)
            .stderr(output);
        process_environment(&mut command);
        let mut child = crate::process_guard::spawn_guarded(&mut command)?;
        let start = Instant::now();
        loop {
            if self.inner.quality3d_setup.cancel.load(Ordering::SeqCst)
                || self.inner.stop.load(Ordering::SeqCst)
            {
                let _ = child.kill();
                let _ = child.wait();
                release_owned_setup_lock(&self.quality3d_runtime(), child.id());
                bail!("모델 준비를 취소했습니다. 다운로드한 파일은 재시도를 위해 보존했습니다.");
            }
            if start.elapsed() > Duration::from_secs(1800) {
                let _ = child.kill();
                let _ = child.wait();
                release_owned_setup_lock(&self.quality3d_runtime(), child.id());
                bail!(
                    "모델 준비가 30분 제한을 초과했습니다. 네트워크와 디스크 공간을 확인해 주세요."
                );
            }
            if let Some(stage) = last_stage(&log_path) {
                *self.inner.quality3d_setup.progress.lock().unwrap() = (stage, String::new());
            }
            if let Some(status) = child.try_wait()? {
                if !status.success() {
                    if let Some(message) = worker_failure(&log_path) {
                        bail!("{message}");
                    }
                    bail!("로컬 3D 모델 준비가 실패했습니다. 앱 데이터의 image3d/setup-logs에서 원인을 확인해 주세요.");
                }
                break;
            }
            thread::sleep(Duration::from_millis(500));
        }
        if self.quality3d_ready().is_none() {
            bail!("모델 준비 정보·고정 리비전·실행 파일이 일치하지 않습니다.");
        }
        *self.inner.quality3d_setup.progress.lock().unwrap() = ("ready".into(), String::new());
        Ok(())
    }

    pub(super) fn enqueue_quality3d(&self, input: &Value) -> Result<Value> {
        let request: Request = serde_json::from_value(input.clone())?;
        validate_request(&request)?;
        self.ensure_quality3d_setup_idle()?;
        self.quality3d_worker("blender-quality", "worker.py")?;
        if self.inner.blender.is_none() {
            bail!("정밀 3D 텍스처·파일 제작에 Blender가 필요합니다.");
        }
        let root = self.root()?;
        let project = Repository::open(&root)?.project()?;
        if request.max_triangles > project.spec.polygon_budget {
            bail!(
                "폴리곤 수는 프로젝트 예산 {} 이하로 설정해 주세요.",
                project.spec.polygon_budget
            );
        }
        let mut jobs = Vec::new();
        let pipeline_hash = self.quality3d_pipeline_hash()?;
        for (index, id) in request.asset_ids.iter().enumerate() {
            let asset = asset_from(&project, id)?;
            let version = asset
                .versions
                .iter()
                .find(|v| v.id == asset.active_version_id)
                .context("활성 버전이 없습니다.")?;
            let model = asset.kind == AssetKind::Model;
            let source = version
                .artifacts
                .iter()
                .find(|a| {
                    a.role == ArtifactRole::Output
                        && if model {
                            a.format == "glb"
                        } else {
                            ["png", "jpg", "jpeg", "webp"].contains(&a.format.as_str())
                        }
                })
                .or_else(|| {
                    version.artifacts.iter().find(|a| {
                        if model {
                            a.format == "glb"
                        } else {
                            ["png", "jpg", "jpeg", "webp"].contains(&a.format.as_str())
                        }
                    })
                })
                .context("참고 자료는 PNG·JPEG·WebP 또는 텍스처가 포함된 GLB여야 합니다.")?;
            let path = resolve_artifact(&root, &source.path)?;
            if asset_core::sha256_file(&path)?.0 != source.sha256 {
                bail!("참고 원본의 해시가 변경됐습니다. 새 사본을 다시 가져와 주세요.");
            }
            if model {
                glb::inspect(&path)?;
            } else {
                let status = self.quality3d_status();
                if status["supported"] != true || status["installed"] != true {
                    bail!(
                        "로컬 TripoSR 모델을 먼저 준비해 주세요. 다른 항목도 제출하지 않았습니다."
                    );
                }
                if self.inner.limits.ram_mb < IMAGE_MEMORY_MB {
                    bail!("로컬 이미지→3D 메모리 예산이 부족합니다.");
                }
                raster::inspect(&path)?;
            }
            let name = if request.asset_ids.len() > 1 {
                format!("{} {:02}", request.name.trim(), index + 1)
            } else {
                request.name.trim().to_owned()
            };
            let payload = json!({"source":source.path,"sourceSha256":source.sha256,"sourceAssetId":asset.id,"sourceVersionId":version.id,
                "pipelineSha256":pipeline_hash,"modelId":MODEL_ID,"modelRevision":MODEL_REVISION,"toolVersion":self.inner.blender_version,
                "name":name,"quality":request.quality,"heightMeters":request.height_meters,"maxTriangles":request.max_triangles,
                "textureResolution":request.texture_resolution,"preserveMaterials":request.preserve_materials,"sourceKind":if model { "model" } else { "image3d" },
                "spec":project.spec,"workerSha256":asset_core::sha256_file(&self.quality3d_worker("blender-quality", "worker.py")?)?.0,
                "resources":{"ramMb":if model { 2048 } else { IMAGE_MEMORY_MB },"cpuThreads":2,"diskWeight":2}});
            let mut task = job(
                &project,
                "quality3d",
                &format!("정밀 3D · {name}"),
                if model { Some(id.clone()) } else { None },
                JobResource::Blender,
                payload,
            )?;
            task.dependencies = active_dependencies(&project, id);
            jobs.push(task);
        }
        SchedulerStore::open(&root.join("scheduler.sqlite"))?.enqueue_many(jobs)?;
        self.snapshot()
    }

    fn quality3d_process(
        &self,
        root: &Path,
        task: &Job,
        mut command: Command,
        log: &Path,
        label: &str,
        timeout: u64,
        cancel: &AtomicBool,
    ) -> Result<()> {
        let output = fs::File::create(log)?;
        command.stdout(output.try_clone()?).stderr(output);
        process_environment(&mut command);
        let mut child = crate::process_guard::spawn_guarded(&mut command)?;
        if let Some(runner) = self.inner.runners.lock().unwrap().get_mut(&task.id) {
            if runner_matches(runner, task) {
                runner.pid = Some(child.id());
            }
        }
        let start = Instant::now();
        let mut previous = String::new();
        loop {
            if cancel.load(Ordering::SeqCst) || self.inner.stop.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                bail!("정밀 3D 작업을 취소했습니다. 원본과 완료된 중간 파일은 보존했습니다.");
            }
            if start.elapsed() > Duration::from_secs(timeout) {
                let _ = child.kill();
                let _ = child.wait();
                bail!("{label} 시간 제한을 초과했습니다. 더 낮은 품질로 새 작업을 제출해 주세요.");
            }
            let stage = last_stage(log).unwrap_or_else(|| label.to_owned());
            if stage != previous {
                SchedulerStore::open(&root.join("scheduler.sqlite"))?
                    .set_progress(&task.id, &stage, None, None)?;
                previous = stage;
            }
            if let Some(status) = child.try_wait()? {
                if !status.success() {
                    if let Some(message) = worker_failure(log) {
                        bail!("{message}");
                    }
                    bail!("{label} 실패. 프로젝트 cache의 작업 로그를 확인해 주세요.");
                }
                return Ok(());
            }
            thread::sleep(Duration::from_millis(300));
        }
    }

    pub(super) fn run_quality3d(
        &self,
        root: &Path,
        task: &Job,
        work: &Path,
        cancel: &AtomicBool,
    ) -> Result<()> {
        let payload = serde_json::to_value(&task.payload)?;
        let source = resolve_artifact(root, text_field(&payload, "source")?)?;
        if asset_core::sha256_file(&source)?.0 != text_field(&payload, "sourceSha256")? {
            bail!("참고 자료의 해시가 변경됐습니다.");
        }
        let image = task.payload["sourceKind"] == "image3d";
        let mut model = source.clone();
        let mut generation = Value::Null;
        if image {
            let ready = self
                .quality3d_ready()
                .context("로컬 3D 모델 준비를 확인해 주세요.")?;
            let input = work.join("image3d-input.json");
            fs::write(
                &input,
                serde_json::to_vec(
                    &json!({"name":task.payload["name"],"sourcePath":source,"sourceSha256":task.payload["sourceSha256"],"quality":task.payload["quality"],"cpuThreads":2}),
                )?,
            )?;
            let raw = work.join("reconstruction");
            let mut command = Command::new(text_field(&ready, "interpreterPath")?);
            command
                .arg(self.quality3d_worker("image3d", "worker.py")?)
                .arg("--runtime-root")
                .arg(self.quality3d_runtime())
                .arg("--input")
                .arg(input)
                .arg("--output-dir")
                .arg(&raw);
            self.quality3d_process(
                root,
                task,
                command,
                &work.join("image3d.log"),
                "로컬 이미지 형상 추정",
                1800,
                cancel,
            )?;
            model = raw.join("mesh.glb");
            glb::inspect(&model)?;
            generation = serde_json::from_slice(&fs::read(raw.join("generation.json"))?)?;
        }
        let input = work.join("quality-input.json");
        fs::write(
            &input,
            serde_json::to_vec(
                &json!({"sourcePath":model,"sourceSha256":asset_core::sha256_file(&model)?.0,"name":task.payload["name"],
            "heightMeters":task.payload["heightMeters"],"maxTriangles":task.payload["maxTriangles"],"textureResolution":task.payload["textureResolution"],
            "sourceKind":task.payload["sourceKind"],"preserveMaterials":task.payload["preserveMaterials"]}),
            )?,
        )?;
        let output = work.join("result");
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
            .arg(self.quality3d_worker("blender-quality", "worker.py")?)
            .args(["--", "--input"])
            .arg(input)
            .arg("--output-dir")
            .arg(&output);
        self.quality3d_process(
            root,
            task,
            command,
            &work.join("quality-worker.log"),
            "UV · 텍스처 · LOD 제작",
            1200,
            cancel,
        )?;
        let report: Value = serde_json::from_slice(&fs::read(output.join("validation.json"))?)?;
        if report["valid"] != true {
            bail!("정밀 3D 결과의 파일 검증이 실패했습니다.");
        }
        let final_glb = output.join("game-ready.model.glb");
        let mesh = glb::inspect(&final_glb)?;
        glb::inspect(&output.join("high-detail.glb"))?;
        let lod = glb::inspect(&output.join("lod1.glb"))?;
        if lod.triangles > mesh.triangles {
            bail!("LOD 모델의 삼각형 수가 게임 모델보다 많습니다.");
        }
        if mesh.triangles
            > task.payload["maxTriangles"]
                .as_u64()
                .context("폴리곤 예산이 없습니다.")?
        {
            bail!("게임 모델이 폴리곤 예산을 초과했습니다.");
        }
        if asset_core::sha256_file(&source)?.0 != text_field(&payload, "sourceSha256")? {
            bail!("원본 보존 검사에 실패했습니다.");
        }
        let _io = self.inner.io.lock().unwrap();
        if cancel.load(Ordering::SeqCst) {
            bail!("작업이 취소되었습니다.");
        }
        let mut repo = Repository::open(root)?;
        let mut artifacts = Vec::new();
        for (name, role) in [
            ("game-ready.model.glb", ArtifactRole::Output),
            ("high-detail.glb", ArtifactRole::Source),
            ("lod1.glb", ArtifactRole::Output),
            ("source.blend", ArtifactRole::Source),
            ("basecolor.png", ArtifactRole::Output),
            ("normal.png", ArtifactRole::Output),
            ("orm.png", ArtifactRole::Output),
            ("emission.png", ArtifactRole::Output),
            ("thumbnail.png", ArtifactRole::Thumbnail),
            ("validation.json", ArtifactRole::Metadata),
            ("turntable-00.png", ArtifactRole::Thumbnail),
            ("turntable-01.png", ArtifactRole::Thumbnail),
            ("turntable-02.png", ArtifactRole::Thumbnail),
            ("turntable-03.png", ArtifactRole::Thumbnail),
        ] {
            let path = output.join(name);
            if !path.is_file() && ["normal.png", "orm.png", "emission.png"].contains(&name) {
                continue;
            }
            if ["png"].contains(&path.extension().and_then(|s| s.to_str()).unwrap_or("")) {
                raster::inspect(&path)?;
            }
            let mut artifact = repo.copy_in(&path, "outputs", name)?;
            artifact.role = role;
            artifacts.push(artifact);
        }
        if image {
            for name in ["mesh.glb", "prepared-input.png", "generation.json"] {
                let mut artifact =
                    repo.copy_in(&work.join("reconstruction").join(name), "outputs", name)?;
                artifact.role = if name.ends_with("json") {
                    ArtifactRole::Metadata
                } else {
                    ArtifactRole::Source
                };
                artifacts.push(artifact);
            }
        }
        let glb_id = artifacts
            .first()
            .context("결과 GLB가 없습니다.")?
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
        settings.insert("quality3dFiles".into(), json!({"game":artifacts[0].id,
            "high":artifacts.iter().find(|a| a.format=="glb" && a.role==ArtifactRole::Source).map(|a|&a.id),
            "lod1":artifacts.iter().filter(|a|a.format=="glb" && a.role==ArtifactRole::Output).nth(1).map(|a|&a.id)}));
        settings.insert("qualityReport".into(), report);
        settings.insert("localReconstruction".into(), generation);
        let mut asset = new_asset(
            text_field(&payload, "name")?.into(),
            AssetKind::Model,
            if image {
                AssetSource::LocalImage3d
            } else {
                AssetSource::Procedural
            },
            artifacts,
            None,
            Some(mesh),
            Some(validation),
            settings,
        );
        asset.versions[0].provider_version =
            Some("local image3d + Blender quality worker v1".into());
        if image {
            asset.versions[0].requested_model = Some(MODEL_ID.into());
            asset.versions[0].confirmed_model = Some(format!("{MODEL_ID}@{MODEL_REVISION}"));
        }
        record_generated(&mut repo, asset, task)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        serde_json::from_value(json!({"action":"quality3d","assetIds":["image1"],"name":"Weapon","quality":"standard","heightMeters":1.,"maxTriangles":10000,"textureResolution":1024,"preserveMaterials":true})).unwrap()
    }
    #[test]
    fn admission_rejects_unsafe_data_before_workers() {
        assert!(validate_request(&request()).is_ok());
        let mut r = request();
        r.asset_ids.push("image1".into());
        assert!(validate_request(&r).is_err());
        let mut r = request();
        r.name = "../escape".into();
        assert!(validate_request(&r).is_err());
        let mut r = request();
        r.height_meters = f64::NAN;
        assert!(validate_request(&r).is_err());
        let mut r = request();
        r.max_triangles = 100001;
        assert!(validate_request(&r).is_err());
        let mut r = request();
        r.texture_resolution = 8192;
        assert!(validate_request(&r).is_err());
    }
    #[test]
    fn generated_script_fields_are_not_a_contract() {
        let mut value=serde_json::to_value(json!({"action":"quality3d","assetIds":["a"],"name":"A","quality":"standard","heightMeters":1.,"maxTriangles":10000,"textureResolution":1024,"preserveMaterials":true})).unwrap();
        value["script"] = json!("arbitrary.py");
        assert!(serde_json::from_value::<Request>(value).is_err());
    }
}
