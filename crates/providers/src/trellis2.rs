//! Local-only TRELLIS.2 preflight and direct-argv Windows/WSL2 launch helpers.
//! There is no remote transport, credential use, runtime installer or CPU/Metal fallback.
//! The coordinator owns process lifetime, cancellation, output validation and job scheduling.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use thiserror::Error;

pub const MODEL_ID: &str = "TRELLIS.2-4B";
pub const SOURCE_REVISION: &str = "75fbf0183001ed9876c8dbb35de6b68552ee08bd";
pub const MODEL_REVISION: &str = "af44b45f2e35a493886929c6d786e563ec68364d";
pub const MINIMUM_VRAM_MB: u64 = 24 * 1024;
const WSL_EXE: &str = r"C:\Windows\System32\wsl.exe";
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_GPU_OUTPUT: u64 = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Trellis2RuntimeConfig {
    pub runtime_root: String,
    pub distribution: String,
}

impl Trellis2RuntimeConfig {
    pub fn validate(&self) -> Result<(), Trellis2Error> {
        if self.distribution.is_empty()
            || self.distribution.len() > 80
            || !self
                .distribution
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
            || !valid_linux_root(&self.runtime_root)
        {
            return Err(Trellis2Error::InvalidRuntimeConfig);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Resolution {
    #[serde(rename = "512")]
    R512,
    #[serde(rename = "1024")]
    R1024,
    #[serde(rename = "1536")]
    R1536,
}

impl Resolution {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::R512 => "512",
            Self::R1024 => "1024",
            Self::R1536 => "1536",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Trellis2Options {
    pub resolution: Resolution,
    pub seed: u32,
    pub texture_size: u32,
    pub target_faces: u32,
}

impl Default for Trellis2Options {
    fn default() -> Self {
        Self {
            resolution: Resolution::R1024,
            seed: 0,
            texture_size: 2048,
            target_faces: 300_000,
        }
    }
}

impl Trellis2Options {
    pub fn validate(&self) -> Result<(), Trellis2Error> {
        if self.seed > 2_147_483_647
            || ![1024, 2048, 4096].contains(&self.texture_size)
            || !(100_000..=500_000).contains(&self.target_faces)
            || self.target_faces % 10_000 != 0
        {
            return Err(Trellis2Error::InvalidOptions);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trellis2Gpu {
    pub name: String,
    pub vram_mb: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trellis2Status {
    pub status: String,
    pub hardware_eligible: bool,
    pub configured: bool,
    pub available: bool,
    pub gpus: Vec<Trellis2Gpu>,
    pub minimum_vram_mb: u64,
    pub experimental: bool,
    pub requested_model: String,
    pub actual_model: Option<String>,
    pub licensing_status: String,
    pub reason: String,
}

impl Trellis2Status {
    fn initial() -> Self {
        Self {
            status: "hardwareUnverified".into(), hardware_eligible: false, configured: false,
            available: false, gpus: Vec::new(), minimum_vram_mb: MINIMUM_VRAM_MB,
            experimental: true, requested_model: MODEL_ID.into(), actual_model: None,
            licensing_status: "dependencies_require_review".into(),
            reason: "TRELLIS.2 로컬 제작에는 NVIDIA GPU 24 GiB 이상과 별도로 준비한 Linux CUDA 런타임이 필요합니다.".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum Trellis2Error {
    #[error("TRELLIS.2 로컬 런타임의 절대 Linux 경로와 WSL 배포판을 확인해 주세요.")]
    InvalidRuntimeConfig,
    #[error("TRELLIS.2 로컬 실행은 Windows WSL2에서만 연결할 수 있습니다. macOS/CPU 지원은 확인되지 않았습니다.")]
    UnsupportedPlatform,
    #[error("TRELLIS.2에는 NVIDIA GPU 24 GiB 이상의 메모리가 필요합니다.")]
    HardwareBlocked,
    #[error("Windows 기본 WSL 실행 파일 또는 앱 소유 워커를 확인할 수 없습니다.")]
    WorkerUnavailable,
    #[error("TRELLIS.2 입력과 결과 경로는 로컬 드라이브의 절대 경로여야 합니다.")]
    InvalidPath,
    #[error("TRELLIS.2 결과는 기존 파일을 덮어쓰지 않는 새 폴더에 저장해야 합니다.")]
    UnsafeOutput,
    #[error("TRELLIS.2 제작 설정이 지원 범위와 다릅니다.")]
    InvalidOptions,
    #[error("TRELLIS.2 로컬 취소 제어 파일을 안전하게 확인하거나 저장하지 못했습니다.")]
    InvalidCancellation,
}

impl Trellis2Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRuntimeConfig => "trellis2.invalid_runtime_config",
            Self::UnsupportedPlatform => "trellis2.unsupported_platform",
            Self::HardwareBlocked => "trellis2.hardware_blocked",
            Self::WorkerUnavailable => "trellis2.worker_unavailable",
            Self::InvalidPath => "trellis2.invalid_path",
            Self::UnsafeOutput => "trellis2.unsafe_output",
            Self::InvalidOptions => "trellis2.invalid_options",
            Self::InvalidCancellation => "trellis2.invalid_cancellation",
        }
    }
}

/// Cheap, read-only native GPU probe. It never starts WSL, imports Python or fetches files.
pub fn host_gpu() -> Trellis2Status {
    let mut status = Trellis2Status::initial();
    if !cfg!(target_os = "windows") {
        status.status = "unsupportedPlatform".into();
        status.reason = "이 앱의 TRELLIS.2 연결은 Windows WSL2 실험 기능입니다. macOS Metal/CPU 제작 경로는 없습니다.".into();
        return status;
    }
    let candidates = [
        r"C:\Windows\System32\nvidia-smi.exe",
        r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe",
    ];
    let Some(executable) = candidates.iter().find(|candidate| {
        fs::symlink_metadata(candidate)
            .is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink())
    }) else {
        status.status = "hardwareUnverified".into();
        status.reason =
            "공식 NVIDIA 드라이버의 nvidia-smi를 찾지 못해 GPU 메모리를 확인할 수 없습니다.".into();
        return status;
    };
    let result = gpu_output(executable).and_then(|text| parse_gpu_csv(&text));
    let Some(gpus) = result else {
        status.status = "hardwareUnverified".into();
        status.reason =
            "NVIDIA GPU 상태를 확인하지 못했습니다. 모델과 WSL은 실행하지 않았습니다.".into();
        return status;
    };
    status.hardware_eligible = gpus.iter().any(|gpu| gpu.vram_mb >= MINIMUM_VRAM_MB);
    status.gpus = gpus;
    if status.hardware_eligible {
        status.status = "runtimeMissing".into();
        status.reason = "GPU 메모리 조건은 충족합니다. 사전 준비한 Linux CUDA 런타임의 파일·라이선스 검증과 실제 제작 확인이 필요합니다.".into();
    } else {
        status.status = "hardwareBlocked".into();
        status.reason = "NVIDIA GPU 메모리가 24 GiB 미만이어서 TRELLIS.2 실행을 차단했습니다. 기존 로컬 이미지→3D를 이용할 수 있습니다.".into();
    }
    status
}

/// Configuration presence never makes an unverified runtime available.
pub fn local_status(config: Option<&Trellis2RuntimeConfig>) -> Trellis2Status {
    let mut status = host_gpu();
    if let Some(config) = config {
        status.configured = config.validate().is_ok();
        if !status.configured {
            status.status = "invalidRuntimeConfig".into();
            status.reason = Trellis2Error::InvalidRuntimeConfig.to_string();
        } else if status.hardware_eligible {
            status.status = "runtimeUnverified".into();
            status.reason = "로컬 런타임 경로가 설정됐습니다. WSL2, CUDA, 고정 모델 파일과 의존성 라이선스 확인이 필요합니다.".into();
        }
    }
    status
}

fn gpu_output(executable: &str) -> Option<String> {
    let mut command = Command::new(executable);
    command
        .args([
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut pipe = stdout;
        pipe.by_ref()
            .take(MAX_GPU_OUTPUT + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > MAX_GPU_OUTPUT {
            return None;
        }
        String::from_utf8(bytes).ok()
    });
    let started = Instant::now();
    let exited = loop {
        match child.try_wait() {
            Ok(Some(exit)) => break exit.success(),
            Ok(None) if started.elapsed() < PROBE_TIMEOUT => {
                thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let output = reader.join().ok().flatten();
    if exited {
        output
    } else {
        None
    }
}

fn parse_gpu_csv(text: &str) -> Option<Vec<Trellis2Gpu>> {
    if text.len() as u64 > MAX_GPU_OUTPUT {
        return None;
    }
    let mut gpus = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let (name, memory) = line.rsplit_once(',')?;
        let name = name.trim();
        if name.is_empty()
            || name.len() > 160
            || name.chars().any(char::is_control)
            || gpus.len() >= 16
        {
            return None;
        }
        let memory: u64 = memory.trim().parse().ok()?;
        if memory == 0 || memory > 1024 * 1024 {
            return None;
        }
        gpus.push(Trellis2Gpu {
            name: name.into(),
            vram_mb: memory,
        });
    }
    if gpus.is_empty() {
        None
    } else {
        Some(gpus)
    }
}

fn valid_linux_root(path: &str) -> bool {
    path.len() <= 1024
        && path.starts_with('/')
        && !path.starts_with("//")
        && path != "/"
        && !path.ends_with('/')
        && !path.chars().any(char::is_control)
        && !path.contains('\\')
        && path
            .split('/')
            .skip(1)
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Map only drive-qualified local Windows paths. UNC, relative paths and traversal are rejected.
/// The wrapper deliberately requires WSL's standard /mnt/<drive> automount layout.
pub fn windows_to_wsl(path: &Path) -> Result<String, Trellis2Error> {
    let text = path.to_str().ok_or(Trellis2Error::InvalidPath)?;
    let text = text.strip_prefix(r"\\?\").unwrap_or(text);
    let bytes = text.as_bytes();
    if bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || !matches!(bytes[2], b'\\' | b'/')
        || text.chars().any(char::is_control)
    {
        return Err(Trellis2Error::InvalidPath);
    }
    let tail = text[3..].replace('\\', "/");
    if tail.contains(':')
        || tail
            .split('/')
            .any(|part| part == "." || part == ".." || part.is_empty())
    {
        return Err(Trellis2Error::InvalidPath);
    }
    Ok(format!(
        "/mnt/{}/{}",
        (bytes[0] as char).to_ascii_lowercase(),
        tail
    ))
}

fn base_command(config: &Trellis2RuntimeConfig, worker: &Path) -> Result<Command, Trellis2Error> {
    config.validate()?;
    if !cfg!(target_os = "windows") {
        return Err(Trellis2Error::UnsupportedPlatform);
    }
    if !host_gpu().hardware_eligible {
        return Err(Trellis2Error::HardwareBlocked);
    }
    let worker_meta = fs::symlink_metadata(worker).map_err(|_| Trellis2Error::WorkerUnavailable)?;
    if !Path::new(WSL_EXE).is_file()
        || !worker_meta.is_file()
        || worker_meta.file_type().is_symlink()
    {
        return Err(Trellis2Error::WorkerUnavailable);
    }
    let python = format!("{}/venv/bin/python", config.runtime_root);
    let mapped_worker = windows_to_wsl(worker)?;
    let mut command = Command::new(WSL_EXE);
    command.args([
        "--distribution",
        &config.distribution,
        "--exec",
        &python,
        "-I",
        "-S",
        &mapped_worker,
        "--runtime-root",
        &config.runtime_root,
    ]);
    // WSLENV can forward arbitrary caller variables/secrets into Linux; do not inherit it.
    command.env_remove("WSLENV");
    command.stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    Ok(command)
}

/// Return a command for the coordinator's bounded process guard; this function does not spawn WSL.
pub fn probe(config: &Trellis2RuntimeConfig, worker: &Path) -> Result<Command, Trellis2Error> {
    let mut command = base_command(config, worker)?;
    command.arg("--probe");
    Ok(command)
}

/// Return a direct-argv worker command. Input is a fixed-schema JSON job, never executable asset code.
pub fn worker_command(
    config: &Trellis2RuntimeConfig,
    worker: &Path,
    input: &Path,
    output: &Path,
) -> Result<Command, Trellis2Error> {
    if fs::symlink_metadata(output).is_ok() {
        return Err(Trellis2Error::UnsafeOutput);
    }
    let metadata = fs::symlink_metadata(input).map_err(|_| Trellis2Error::InvalidPath)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(Trellis2Error::InvalidPath);
    }
    let mapped_input = windows_to_wsl(input)?;
    let mapped_output = windows_to_wsl(output)?;
    let mut command = base_command(config, worker)?;
    command.args(["--input", &mapped_input, "--output-dir", &mapped_output]);
    Ok(command)
}

/// Signal only this newly created job's Linux watchdog; never blindly kill a reused PID.
/// Stage the complete sibling marker even before worker-pid.json exists, covering startup races.
/// A false return means the caller's output parent does not exist.
/// The coordinator must not report Linux process termination without separate proof.
pub fn request_cancel(output: &Path) -> Result<bool, Trellis2Error> {
    let mapped_output = windows_to_wsl(output)?;
    let name = output
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(Trellis2Error::InvalidCancellation)?;
    let parent = output.parent().ok_or(Trellis2Error::InvalidCancellation)?;
    let parent_meta = match fs::symlink_metadata(parent) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(Trellis2Error::InvalidCancellation),
    };
    if !parent_meta.is_dir() || parent_meta.file_type().is_symlink() {
        return Err(Trellis2Error::InvalidCancellation);
    }
    let request =
        serde_json::json!({"schemaVersion": 1, "outputDir": mapped_output, "requested": true});
    publish_cancel_flag(
        &parent.join(format!("{name}.cancel-request.json")),
        &request,
    )?;
    Ok(true)
}

fn publish_cancel_flag(path: &Path, request: &Value) -> Result<(), Trellis2Error> {
    let validate_existing = || -> Result<(), Trellis2Error> {
        let meta = fs::symlink_metadata(path).map_err(|_| Trellis2Error::InvalidCancellation)?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 8192 {
            return Err(Trellis2Error::InvalidCancellation);
        }
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(|_| Trellis2Error::InvalidCancellation)?
            .take(8193)
            .read_to_end(&mut bytes)
            .map_err(|_| Trellis2Error::InvalidCancellation)?;
        if bytes.len() > 8192
            || serde_json::from_slice::<Value>(&bytes).ok().as_ref() != Some(request)
        {
            return Err(Trellis2Error::InvalidCancellation);
        }
        Ok(())
    };
    if fs::symlink_metadata(path).is_ok() {
        return validate_existing();
    }
    let temporary = path.with_file_name(format!(
        "{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .ok_or(Trellis2Error::InvalidCancellation)?,
        uuid::Uuid::new_v4().simple()
    ));
    let mut temporary_created = false;
    let result = (|| -> Result<(), Trellis2Error> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| Trellis2Error::InvalidCancellation)?;
        temporary_created = true;
        file.write_all(request.to_string().as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| Trellis2Error::InvalidCancellation)?;
        drop(file);
        // Exclusive hard-link publishes the complete JSON atomically; existing flags stay intact.
        match fs::hard_link(&temporary, path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => validate_existing(),
            Err(_) => Err(Trellis2Error::InvalidCancellation),
        }
    })();
    if temporary_created {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trellis2_wsl_mapping_preserves_unicode_and_spaces_as_one_argument() {
        assert_eq!(
            windows_to_wsl(Path::new(r"C:\Assets\새 결과\input job.json")).unwrap(),
            "/mnt/c/Assets/새 결과/input job.json"
        );
        assert_eq!(
            windows_to_wsl(Path::new(r"\\?\D:\job\result")).unwrap(),
            "/mnt/d/job/result"
        );
        for path in [
            r"\\server\share\input.json",
            r"relative.json",
            r"C:\x\..\y",
            r"C:\x\file:stream",
            r"/tmp/input",
        ] {
            assert_eq!(
                windows_to_wsl(Path::new(path)),
                Err(Trellis2Error::InvalidPath)
            );
        }
    }

    #[test]
    fn trellis2_runtime_paths_are_absolute_and_distro_is_not_shell_text() {
        Trellis2RuntimeConfig {
            runtime_root: "/home/user/trellis2 runtime".into(),
            distribution: "Ubuntu-24.04".into(),
        }
        .validate()
        .unwrap();
        for root in [
            "relative",
            "/",
            "//host/path",
            "/tmp/../other",
            "/tmp//other",
            "/tmp/other/",
        ] {
            assert_eq!(
                Trellis2RuntimeConfig {
                    runtime_root: root.into(),
                    distribution: "Ubuntu".into()
                }
                .validate(),
                Err(Trellis2Error::InvalidRuntimeConfig)
            );
        }
        for distribution in ["", "Ubuntu; curl attacker", "$(command)", "Ubuntu\n"] {
            assert_eq!(
                Trellis2RuntimeConfig {
                    runtime_root: "/opt/trellis2".into(),
                    distribution: distribution.into()
                }
                .validate(),
                Err(Trellis2Error::InvalidRuntimeConfig)
            );
        }
    }

    #[test]
    fn trellis2_gpu_memory_is_verified_from_bounded_numeric_rows() {
        let gpus = parse_gpu_csv("NVIDIA GeForce GTX 1650, 4096\nNVIDIA A100, 40960\n").unwrap();
        assert_eq!(gpus.len(), 2);
        assert_eq!(gpus[0].vram_mb, 4096);
        assert!(gpus.iter().any(|gpu| gpu.vram_mb >= MINIMUM_VRAM_MB));
        for invalid in ["NVIDIA, N/A", "NVIDIA, 0", "unknown", "NVIDIA, -4096", ""] {
            assert!(parse_gpu_csv(invalid).is_none());
        }
    }

    #[test]
    fn trellis2_options_do_not_advertise_cpu_or_invalid_texture_values() {
        Trellis2Options::default().validate().unwrap();
        let mut options = Trellis2Options::default();
        options.texture_size = 512;
        assert_eq!(options.validate(), Err(Trellis2Error::InvalidOptions));
        options.texture_size = 2048;
        options.seed = u32::MAX;
        assert_eq!(options.validate(), Err(Trellis2Error::InvalidOptions));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn trellis2_cancel_is_atomic_before_startup_and_does_not_read_partial_pid_json() {
        let temporary_root = fs::canonicalize(std::env::temp_dir()).unwrap();
        let root = temporary_root.join(format!("trellis2-cancel-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let output = root.join("new-output");
        assert!(request_cancel(&output).unwrap());
        let marker = root.join("new-output.cancel-request.json");
        let expected = serde_json::json!({"schemaVersion": 1, "outputDir": windows_to_wsl(&output).unwrap(), "requested": true});
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&marker).unwrap()).unwrap(),
            expected
        );
        fs::create_dir(&output).unwrap();
        fs::write(output.join("worker-pid.json"), b"{").unwrap();
        assert!(request_cancel(&output).unwrap());
        assert_eq!(fs::read(output.join("worker-pid.json")).unwrap(), b"{");
        let original = fs::read(&marker).unwrap();
        assert_eq!(
            publish_cancel_flag(&marker, &serde_json::json!({"otherJob":true})),
            Err(Trellis2Error::InvalidCancellation)
        );
        assert_eq!(fs::read(&marker).unwrap(), original);
        assert!(fs::read_dir(&root).unwrap().all(|entry| !entry
            .unwrap()
            .path()
            .extension()
            .is_some_and(|ext| ext == "tmp")));
        let canonical_root = fs::canonicalize(&root).unwrap();
        assert!(canonical_root.starts_with(&temporary_root));
        fs::remove_dir_all(canonical_root).unwrap();
    }
}
