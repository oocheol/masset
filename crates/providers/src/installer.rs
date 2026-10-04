//! Consent-gated installation of a pinned public Codex package.
//! This module never runs a package, authenticates an account, or reads secrets.
//! Uncommitted UUID directories are deliberately never offered as runtimes.

use flate2::read::MultiGzDecoder;
use reqwest::{blocking::Client, header, redirect::Policy, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use uuid::Uuid;

pub const CODEX_VERSION: &str = "0.160.0";
pub const CODEX_TARGET: &str = NATIVE_PACKAGE.target;
pub const CODEX_PACKAGE_BYTES: u64 = NATIVE_PACKAGE.bytes;
pub const CODEX_PACKAGE_SHA256: &str = NATIVE_PACKAGE.sha256;
const SOURCE_URL: &str = "https://github.com/openai/codex/releases/tag/rust-v0.160.0";
const LICENSE_URL: &str = "https://github.com/openai/codex/blob/rust-v0.160.0/LICENSE";

struct PinnedPackage {
    target: &'static str,
    url: &'static str,
    bytes: u64,
    sha256: &'static str,
    main: &'static str,
    host: &'static str,
    ripgrep: &'static str,
    zsh: Option<&'static str>,
}

const WINDOWS_PACKAGE: PinnedPackage = PinnedPackage {
    target: "x86_64-pc-windows-msvc",
    url: "https://github.com/openai/codex/releases/download/rust-v0.160.0/codex-package-x86_64-pc-windows-msvc.tar.gz",
    bytes: 157_444_460,
    sha256: "7f7fbbc8d6fd4ea2f3b13855ef47ea59663ba7e61fb2e9821df37163b8030891",
    main: "bin/codex.exe",
    host: "bin/codex-code-mode-host.exe",
    ripgrep: "codex-path/rg.exe",
    zsh: None,
};

// Official rust-v0.160.0 GitHub release asset 604060802. Its downloaded
// bytes/hash and regular-file layout were independently verified on macOS.
// This package's bin/codex is a native Mach-O, unlike ChatGPT.app's launcher.
const MACOS_PACKAGE: PinnedPackage = PinnedPackage {
    target: "aarch64-apple-darwin",
    url: "https://github.com/openai/codex/releases/download/rust-v0.160.0/codex-package-aarch64-apple-darwin.tar.gz",
    bytes: 129_976_298,
    sha256: "007df41b607dbbc8d204b9746ce7fed2d4ce6c813f44c32ceee54175ca796525",
    main: "bin/codex",
    host: "bin/codex-code-mode-host",
    ripgrep: "codex-path/rg",
    zsh: Some("codex-resources/zsh/bin/zsh"),
};

const NATIVE_PACKAGE: &PinnedPackage = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
    &MACOS_PACKAGE
} else {
    &WINDOWS_PACKAGE
};

fn supported_platform() -> bool {
    cfg!(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64")
    ))
}

fn package_for_target(target: &str) -> Result<&'static PinnedPackage, InstallerError> {
    match target {
        "x86_64-pc-windows-msvc" => Ok(&WINDOWS_PACKAGE),
        "aarch64-apple-darwin" => Ok(&MACOS_PACKAGE),
        _ => Err(InstallerError::PackageLayout),
    }
}

#[cfg(test)]
const PACKAGE_URL: &str = NATIVE_PACKAGE.url;
#[cfg(test)]
const MAIN_PATH: &str = NATIVE_PACKAGE.main;
#[cfg(test)]
const HOST_PATH: &str = NATIVE_PACKAGE.host;
const RECEIPT_NAME: &str = "install-receipt.json";
const MAX_UNPACKED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;
const MAX_METADATA_BYTES: u64 = 64 * 1024;
const MAX_INSTALL_DURATION: Duration = Duration::from_secs(15 * 60);
const BUFFER_BYTES: usize = 64 * 1024;

pub type SignatureVerifier = Arc<dyn Fn(&Path) -> bool + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallerManifest {
    pub version: String,
    pub target: String,
    pub url: String,
    pub bytes: u64,
    pub sha256: String,
    pub source_url: String,
    pub license: String,
    pub license_url: String,
}

pub fn official_manifest() -> InstallerManifest {
    NATIVE_PACKAGE.manifest()
}

impl PinnedPackage {
    fn manifest(&self) -> InstallerManifest {
        InstallerManifest {
            version: CODEX_VERSION.into(),
            target: self.target.into(),
            url: self.url.into(),
            bytes: self.bytes,
            sha256: self.sha256.into(),
            source_url: SOURCE_URL.into(),
            license: "Apache-2.0; bundled third-party notices".into(),
            license_url: LICENSE_URL.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstallerState {
    Idle,
    Downloading,
    Verifying,
    Extracting,
    Ready,
    Cancelled,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallerStatus {
    pub supported: bool,
    pub state: InstallerState,
    pub version: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub message: String,
    pub manifest: InstallerManifest,
}

pub type Status = InstallerStatus;

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
pub enum InstallerError {
    #[error("공식 Codex 다운로드·설치 동의가 필요합니다.")]
    ConsentRequired,
    #[error("공식 자동 설치는 Windows x64와 macOS Apple Silicon에서 지원합니다.")]
    UnsupportedPlatform,
    #[error("화면에 표시된 공식 버전과 해시를 다시 확인해 주세요.")]
    ManifestMismatch,
    #[error("이미 설치 작업이 진행 중입니다.")]
    Busy,
    #[error("설치 저장 폴더를 안전하게 사용할 수 없습니다.")]
    UnsafeRoot,
    #[error("허용된 공식 다운로드 주소가 아닙니다.")]
    UnsafeDownloadUrl,
    #[error("공식 설치 파일을 다운로드하지 못했습니다.")]
    DownloadFailed,
    #[error("설치 작업의 제한 시간이 지났습니다.")]
    Timeout,
    #[error("설치 파일의 크기가 공식 배포 정보와 다릅니다.")]
    SizeMismatch,
    #[error("설치 파일의 SHA-256이 공식 배포 정보와 다릅니다.")]
    HashMismatch,
    #[error("설치 압축 파일에 안전하지 않은 항목이 있습니다.")]
    UnsafeArchive,
    #[error("공식 Codex 패키지 구성을 확인하지 못했습니다.")]
    PackageLayout,
    #[error("공식 Codex 실행 파일의 서명을 확인하지 못했습니다.")]
    SignatureRejected,
    #[error("설치 파일을 저장하지 못했습니다.")]
    StorageFailed,
    #[error("설치를 취소했습니다.")]
    Cancelled,
    #[error("설치 작업을 시작하거나 완료하지 못했습니다.")]
    WorkerFailed,
}

impl InstallerError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ConsentRequired => "provider.install_consent_required",
            Self::UnsupportedPlatform => "provider.install_unsupported",
            Self::ManifestMismatch => "provider.install_manifest_mismatch",
            Self::Busy => "provider.install_busy",
            Self::UnsafeRoot => "provider.install_unsafe_root",
            Self::UnsafeDownloadUrl => "provider.install_unsafe_url",
            Self::DownloadFailed => "provider.install_download_failed",
            Self::Timeout => "provider.install_timeout",
            Self::SizeMismatch => "provider.install_size_mismatch",
            Self::HashMismatch => "provider.install_hash_mismatch",
            Self::UnsafeArchive => "provider.install_unsafe_archive",
            Self::PackageLayout => "provider.install_package_layout",
            Self::SignatureRejected => "provider.install_signature_rejected",
            Self::StorageFailed => "provider.install_storage_failed",
            Self::Cancelled => "provider.install_cancelled",
            Self::WorkerFailed => "provider.install_worker_failed",
        }
    }
}

#[derive(Clone)]
pub struct CodexInstaller {
    inner: Arc<Inner>,
}

struct Inner {
    root: PathBuf,
    manifest: InstallerManifest,
    control: Mutex<Control>,
}

struct Control {
    status: InstallerStatus,
    active: Option<Job>,
}

#[derive(Clone)]
struct Job {
    id: Uuid,
    cancelled: Arc<AtomicBool>,
    started: Instant,
}

enum PackageInput {
    Download,
    Cache(PathBuf),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallReceipt {
    schema_version: u32,
    installation_id: String,
    version: String,
    target: String,
    bytes: u64,
    sha256: String,
    entrypoint: String,
    host: String,
    signature_verified: bool,
    committed_at_ms: u64,
}

impl CodexInstaller {
    pub fn new(root: PathBuf) -> Self {
        Self::with_manifest(root, official_manifest())
    }

    fn with_manifest(root: PathBuf, manifest: InstallerManifest) -> Self {
        let status = InstallerStatus {
            supported: supported_platform(),
            state: InstallerState::Idle,
            version: manifest.version.clone(),
            downloaded_bytes: 0,
            total_bytes: manifest.bytes,
            message: "공식 Codex를 설치해 구독 계정을 연결할 수 있습니다.".into(),
            manifest: manifest.clone(),
        };
        let installer = Self {
            inner: Arc::new(Inner {
                root,
                manifest,
                control: Mutex::new(Control {
                    status,
                    active: None,
                }),
            }),
        };
        if !installer.installed_executables().is_empty() {
            let mut control = installer.control();
            control.status.state = InstallerState::Ready;
            control.status.downloaded_bytes = control.status.total_bytes;
            control.status.message = "공식 Codex 설치가 완료되었습니다.".into();
        }
        installer
    }

    pub fn status(&self) -> InstallerStatus {
        self.control().status.clone()
    }

    pub fn busy(&self) -> bool {
        self.control().active.is_some()
    }

    pub fn start(
        &self,
        consent: bool,
        expected_version: &str,
        expected_sha256: &str,
        verify: SignatureVerifier,
    ) -> Result<InstallerStatus, InstallerError> {
        self.authorize(consent, expected_version, expected_sha256)?;
        self.launch(PackageInput::Download, verify)
    }

    /// Uses the same byte-size, hash, archive, layout, signature and atomic
    /// publication checks as a download. The existing cache file is read-only.
    pub fn start_from_cached_package(
        &self,
        consent: bool,
        expected_version: &str,
        expected_sha256: &str,
        package: PathBuf,
        verify: SignatureVerifier,
    ) -> Result<InstallerStatus, InstallerError> {
        self.authorize(consent, expected_version, expected_sha256)?;
        self.launch(PackageInput::Cache(package), verify)
    }

    pub fn cancel(&self) -> InstallerStatus {
        let mut control = self.control();
        if let Some(job) = &control.active {
            job.cancelled.store(true, Ordering::Release);
            // Keep the active phase until the worker exits, so clients continue
            // polling and cannot race a fresh install against the old worker.
            control.status.message = "설치 취소를 마무리하고 있습니다.".into();
        }
        control.status.clone()
    }

    /// Discovery only. The native bridge must recheck the main binary and
    /// resolved helper signatures before executing any returned path.
    pub fn installed_executables(&self) -> Vec<PathBuf> {
        let Ok(package) = package_for_target(&self.inner.manifest.target) else {
            return vec![];
        };
        let Ok(root) = safe_root(&self.inner.root, false) else {
            return vec![];
        };
        let Ok(entries) = fs::read_dir(&root) else {
            return vec![];
        };
        let mut installed = Vec::new();
        for entry in entries.take(1024).flatten() {
            let directory = entry.path();
            let Some(name) = directory.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            let prefix = format!("codex-{}-", self.inner.manifest.version);
            let Some(id) = name
                .strip_prefix(&prefix)
                .and_then(|s| Uuid::parse_str(s).ok())
            else {
                continue;
            };
            if name != format!("{prefix}{id}") || !contained_directory(&root, &directory) {
                continue;
            }
            let Ok(receipt) = read_json_file::<InstallReceipt>(&directory.join(RECEIPT_NAME))
            else {
                continue;
            };
            if receipt.schema_version != 1
                || receipt.installation_id != id.to_string()
                || receipt.version != self.inner.manifest.version
                || receipt.target != self.inner.manifest.target
                || receipt.bytes != self.inner.manifest.bytes
                || receipt.sha256 != self.inner.manifest.sha256
                || receipt.entrypoint != package.main
                || receipt.host != package.host
                || !receipt.signature_verified
                || validate_layout(&directory, &self.inner.manifest).is_err()
            {
                continue;
            }
            if let Ok(main) = contained_file(&directory, &directory.join(package.main)) {
                installed.push((receipt.committed_at_ms, main));
            }
        }
        installed.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        installed.into_iter().map(|(_, path)| path).collect()
    }

    fn authorize(&self, consent: bool, version: &str, hash: &str) -> Result<(), InstallerError> {
        if !consent {
            return Err(InstallerError::ConsentRequired);
        }
        if !supported_platform() {
            return Err(InstallerError::UnsupportedPlatform);
        }
        if version != self.inner.manifest.version || hash != self.inner.manifest.sha256 {
            return Err(InstallerError::ManifestMismatch);
        }
        Ok(())
    }

    fn control(&self) -> MutexGuard<'_, Control> {
        self.inner
            .control
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn launch(
        &self,
        input: PackageInput,
        verify: SignatureVerifier,
    ) -> Result<InstallerStatus, InstallerError> {
        let job = Job {
            id: Uuid::new_v4(),
            cancelled: Arc::new(AtomicBool::new(false)),
            started: Instant::now(),
        };
        let initial = {
            let mut control = self.control();
            if control.active.is_some() {
                return Err(InstallerError::Busy);
            }
            control.active = Some(job.clone());
            control.status.state = InstallerState::Downloading;
            control.status.downloaded_bytes = 0;
            control.status.message = "공식 Codex 설치 파일을 준비하고 있습니다.".into();
            control.status.clone()
        };
        let installer = self.clone();
        let worker_job = job.clone();
        if thread::Builder::new()
            .name("codex-package-installer".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    installer.prepare_and_commit(&worker_job, input, verify)
                }))
                .unwrap_or(Err(InstallerError::WorkerFailed));
                if let Err(error) = result {
                    installer.finish_error(&worker_job, error);
                }
            })
            .is_err()
        {
            self.finish_error(&job, InstallerError::WorkerFailed);
            return Err(InstallerError::WorkerFailed);
        }
        Ok(initial)
    }

    fn phase(&self, job: &Job, state: InstallerState, message: &str) {
        let mut control = self.control();
        if control
            .active
            .as_ref()
            .is_some_and(|active| active.id == job.id)
            && !job.cancelled.load(Ordering::Acquire)
        {
            control.status.state = state;
            control.status.message = message.into();
        }
    }

    fn progress(&self, job: &Job, bytes: u64) {
        let mut control = self.control();
        if control
            .active
            .as_ref()
            .is_some_and(|active| active.id == job.id)
            && !job.cancelled.load(Ordering::Acquire)
        {
            control.status.downloaded_bytes = bytes.min(self.inner.manifest.bytes);
        }
    }

    fn finish_error(&self, job: &Job, error: InstallerError) {
        let mut control = self.control();
        if control
            .active
            .as_ref()
            .is_some_and(|active| active.id == job.id)
        {
            let cancelled =
                job.cancelled.load(Ordering::Acquire) || error == InstallerError::Cancelled;
            control.status.state = if cancelled {
                InstallerState::Cancelled
            } else {
                InstallerState::Error
            };
            control.status.message = if cancelled {
                InstallerError::Cancelled
            } else {
                error
            }
            .to_string();
            control.active = None;
        }
    }

    fn prepare_and_commit(
        &self,
        job: &Job,
        input: PackageInput,
        verify: SignatureVerifier,
    ) -> Result<(), InstallerError> {
        check_job(job)?;
        let package = package_for_target(&self.inner.manifest.target)?;
        let root = safe_root(&self.inner.root, true)?;
        let workspace = root.join(format!("installing-{}", job.id));
        fs::create_dir(&workspace).map_err(|_| InstallerError::StorageFailed)?;
        if !contained_directory(&root, &workspace) {
            return Err(InstallerError::UnsafeRoot);
        }
        let archive_path = workspace.join("package.tar.gz");
        match input {
            PackageInput::Download => self.download(job, &archive_path)?,
            PackageInput::Cache(path) => {
                if !local_absolute_path(&path) || !plain_file(&path) {
                    return Err(InstallerError::UnsafeArchive);
                }
                let source = File::open(&path).map_err(|_| InstallerError::StorageFailed)?;
                if source
                    .metadata()
                    .map_err(|_| InstallerError::StorageFailed)?
                    .len()
                    != self.inner.manifest.bytes
                {
                    return Err(InstallerError::SizeMismatch);
                }
                self.receive_package(job, source, &archive_path)?;
            }
        }
        self.phase(
            job,
            InstallerState::Verifying,
            "설치 파일의 SHA-256을 확인하고 있습니다.",
        );
        verify_package_hash(&archive_path, &self.inner.manifest, job)?;
        self.phase(
            job,
            InstallerState::Extracting,
            "안전하게 설치 파일을 풀고 있습니다.",
        );
        // First inspect raw headers and bounded PAX metadata. This prevents
        // tar's normal metadata handling from allocating unbounded headers.
        inspect_archive(&archive_path, job)?;
        let bundle = workspace.join("package");
        fs::create_dir(&bundle).map_err(|_| InstallerError::StorageFailed)?;
        unpack_archive(&archive_path, &bundle, job)?;
        validate_layout(&bundle, &self.inner.manifest)?;
        self.phase(
            job,
            InstallerState::Verifying,
            "공식 실행 파일의 서명을 확인하고 있습니다.",
        );
        check_job(job)?;
        let main = contained_file(&bundle, &bundle.join(package.main))?;
        if !verify(&main) {
            return Err(InstallerError::SignatureRejected);
        }
        check_job(job)?;
        self.commit(job, &root, &bundle)
    }

    fn receive_package<R: Read>(
        &self,
        job: &Job,
        mut source: R,
        destination: &Path,
    ) -> Result<(), InstallerError> {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map_err(|_| InstallerError::StorageFailed)?;
        let mut received = 0_u64;
        let mut buffer = [0_u8; BUFFER_BYTES];
        loop {
            check_job(job)?;
            let remaining = self.inner.manifest.bytes.saturating_sub(received);
            let amount = buffer.len().min(remaining.saturating_add(1) as usize);
            let n = source.read(&mut buffer[..amount]).map_err(|_| {
                if job.cancelled.load(Ordering::Acquire) {
                    InstallerError::Cancelled
                } else {
                    InstallerError::DownloadFailed
                }
            })?;
            check_job(job)?;
            if n == 0 {
                break;
            }
            received = received
                .checked_add(n as u64)
                .ok_or(InstallerError::SizeMismatch)?;
            if received > self.inner.manifest.bytes {
                return Err(InstallerError::SizeMismatch);
            }
            output
                .write_all(&buffer[..n])
                .map_err(|_| InstallerError::StorageFailed)?;
            self.progress(job, received);
        }
        if received != self.inner.manifest.bytes {
            return Err(InstallerError::SizeMismatch);
        }
        output
            .sync_all()
            .map_err(|_| InstallerError::StorageFailed)?;
        Ok(())
    }

    fn download(&self, job: &Job, destination: &Path) -> Result<(), InstallerError> {
        let client = Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            // Blocking reqwest applies this to each response read operation.
            .timeout(Duration::from_secs(20))
            .user_agent("Masset-Codex-Installer")
            .build()
            .map_err(|_| InstallerError::DownloadFailed)?;
        let mut url =
            Url::parse(&self.inner.manifest.url).map_err(|_| InstallerError::UnsafeDownloadUrl)?;
        if url.as_str() != package_for_target(&self.inner.manifest.target)?.url
            || !official_download_url(&url)
        {
            return Err(InstallerError::UnsafeDownloadUrl);
        }
        for redirects in 0..=5 {
            check_job(job)?;
            let response = client
                .get(url.clone())
                .header(header::ACCEPT_ENCODING, "identity")
                .send()
                .map_err(|_| InstallerError::DownloadFailed)?;
            check_job(job)?;
            if response.status().is_redirection() {
                let location = response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or(InstallerError::UnsafeDownloadUrl)?;
                url = checked_redirect(&url, location, redirects, response.status().as_u16())?;
                continue;
            }
            if response.status().as_u16() != 200 {
                return Err(InstallerError::DownloadFailed);
            }
            if response
                .content_length()
                .is_some_and(|bytes| bytes != self.inner.manifest.bytes)
            {
                return Err(InstallerError::SizeMismatch);
            }
            if response
                .headers()
                .get(header::CONTENT_ENCODING)
                .is_some_and(|value| value != "identity")
            {
                return Err(InstallerError::DownloadFailed);
            }
            return self.receive_package(job, response, destination);
        }
        Err(InstallerError::UnsafeDownloadUrl)
    }

    fn commit(&self, job: &Job, root: &Path, bundle: &Path) -> Result<(), InstallerError> {
        // Cancellation and publication are serialized. Once a receipt is
        // published, cancel cannot change that completed installation to cancelled.
        let mut control = self.control();
        check_job(job)?;
        let package = package_for_target(&self.inner.manifest.target)?;
        if !control
            .active
            .as_ref()
            .is_some_and(|active| active.id == job.id)
        {
            return Err(InstallerError::Cancelled);
        }
        let final_dir = root.join(format!("codex-{}-{}", self.inner.manifest.version, job.id));
        if final_dir.exists() || !contained_directory(root, bundle) {
            return Err(InstallerError::UnsafeRoot);
        }
        fs::rename(bundle, &final_dir).map_err(|_| InstallerError::StorageFailed)?;
        if !contained_directory(root, &final_dir) {
            return Err(InstallerError::UnsafeRoot);
        }
        let receipt = InstallReceipt {
            schema_version: 1,
            installation_id: job.id.to_string(),
            version: self.inner.manifest.version.clone(),
            target: self.inner.manifest.target.clone(),
            bytes: self.inner.manifest.bytes,
            sha256: self.inner.manifest.sha256.clone(),
            entrypoint: package.main.into(),
            host: package.host.into(),
            signature_verified: true,
            committed_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| InstallerError::StorageFailed)?
                .as_millis()
                .try_into()
                .map_err(|_| InstallerError::StorageFailed)?,
        };
        let temporary = final_dir.join(format!("receipt-{}.tmp", job.id));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| InstallerError::StorageFailed)?;
        serde_json::to_writer(&mut file, &receipt).map_err(|_| InstallerError::StorageFailed)?;
        file.sync_all().map_err(|_| InstallerError::StorageFailed)?;
        drop(file);
        let published = final_dir.join(RECEIPT_NAME);
        if published.exists() {
            return Err(InstallerError::UnsafeRoot);
        }
        fs::rename(&temporary, &published).map_err(|_| InstallerError::StorageFailed)?;
        control.status.state = InstallerState::Ready;
        control.status.downloaded_bytes = control.status.total_bytes;
        control.status.message = "공식 Codex 설치가 완료되었습니다. 계정을 연결해 주세요.".into();
        control.active = None;
        Ok(())
    }
}

fn check_job(job: &Job) -> Result<(), InstallerError> {
    if job.cancelled.load(Ordering::Acquire) {
        Err(InstallerError::Cancelled)
    } else if job.started.elapsed() > MAX_INSTALL_DURATION {
        Err(InstallerError::Timeout)
    } else {
        Ok(())
    }
}

fn official_download_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(
            url.host_str(),
            Some("github.com" | "release-assets.githubusercontent.com")
        )
        && url.port().is_none_or(|port| port == 443)
        && url.fragment().is_none()
}

fn checked_redirect(
    current: &Url,
    location: &str,
    redirects: usize,
    status: u16,
) -> Result<Url, InstallerError> {
    if redirects >= 5
        || !matches!(status, 301 | 302 | 303 | 307 | 308)
        || !official_download_url(current)
    {
        return Err(InstallerError::UnsafeDownloadUrl);
    }
    let next = current
        .join(location)
        .map_err(|_| InstallerError::UnsafeDownloadUrl)?;
    if !official_download_url(&next)
        || (current.host_str() == Some("release-assets.githubusercontent.com")
            && next.host_str() != current.host_str())
    {
        return Err(InstallerError::UnsafeDownloadUrl);
    }
    Ok(next)
}

fn local_absolute_path(path: &Path) -> bool {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return false;
    }
    #[cfg(windows)]
    {
        use std::path::Prefix;
        if !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        {
            return false;
        }
    }
    true
}

fn link_like(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn plain_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file() && !link_like(&metadata))
}

fn safe_root(path: &Path, create: bool) -> Result<PathBuf, InstallerError> {
    if !local_absolute_path(path) {
        return Err(InstallerError::UnsafeRoot);
    }
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.is_dir() && !link_like(&metadata) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            _ => return Err(InstallerError::UnsafeRoot),
        }
    }
    if create {
        fs::create_dir_all(path).map_err(|_| InstallerError::StorageFailed)?;
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| InstallerError::UnsafeRoot)?;
    if !metadata.is_dir() || link_like(&metadata) {
        return Err(InstallerError::UnsafeRoot);
    }
    fs::canonicalize(path).map_err(|_| InstallerError::UnsafeRoot)
}

fn contained_directory(root: &Path, directory: &Path) -> bool {
    if !local_absolute_path(directory) {
        return false;
    }
    let Ok(metadata) = fs::symlink_metadata(directory) else {
        return false;
    };
    if !metadata.is_dir() || link_like(&metadata) {
        return false;
    }
    fs::canonicalize(directory).is_ok_and(|canonical| canonical.starts_with(root))
        && no_links_below(root, directory)
}

fn no_links_below(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) {
            return false;
        }
        current.push(component.as_os_str());
        if !fs::symlink_metadata(&current).is_ok_and(|metadata| !link_like(&metadata)) {
            return false;
        }
    }
    true
}

fn contained_file(root: &Path, path: &Path) -> Result<PathBuf, InstallerError> {
    let canonical_root = fs::canonicalize(root).map_err(|_| InstallerError::PackageLayout)?;
    if !plain_file(path) || !no_links_below(root, path) {
        return Err(InstallerError::PackageLayout);
    }
    let canonical = fs::canonicalize(path).map_err(|_| InstallerError::PackageLayout)?;
    if !canonical.starts_with(&canonical_root) {
        return Err(InstallerError::PackageLayout);
    }
    Ok(canonical)
}

fn read_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, InstallerError> {
    if !plain_file(path) {
        return Err(InstallerError::PackageLayout);
    }
    let file = File::open(path).map_err(|_| InstallerError::PackageLayout)?;
    if file
        .metadata()
        .map_err(|_| InstallerError::PackageLayout)?
        .len()
        > MAX_METADATA_BYTES
    {
        return Err(InstallerError::PackageLayout);
    }
    serde_json::from_reader(file.take(MAX_METADATA_BYTES + 1))
        .map_err(|_| InstallerError::PackageLayout)
}

fn validate_layout(root: &Path, manifest: &InstallerManifest) -> Result<(), InstallerError> {
    let package = package_for_target(&manifest.target)?;
    let metadata_path = contained_file(root, &root.join("codex-package.json"))?;
    let metadata: serde_json::Value = read_json_file(&metadata_path)?;
    if metadata["layoutVersion"] != 1
        || metadata["version"] != manifest.version
        || metadata["target"] != manifest.target
        || metadata["variant"] != "codex"
        || metadata["entrypoint"] != package.main
        || metadata["resourcesDir"] != "codex-resources"
        || metadata["pathDir"] != "codex-path"
    {
        return Err(InstallerError::PackageLayout);
    }
    for directory in ["bin", "codex-resources", "codex-path"] {
        if !contained_directory(root, &root.join(directory)) {
            return Err(InstallerError::PackageLayout);
        }
    }
    for executable in [package.main, package.host, package.ripgrep]
        .into_iter()
        .chain(package.zsh)
    {
        let path = contained_file(root, &root.join(executable))?;
        let metadata = fs::metadata(path).map_err(|_| InstallerError::PackageLayout)?;
        if metadata.len() == 0 {
            return Err(InstallerError::PackageLayout);
        }
        #[cfg(unix)]
        if package.target == MACOS_PACKAGE.target {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o100 == 0 {
                return Err(InstallerError::PackageLayout);
            }
        }
    }
    Ok(())
}

fn verify_package_hash(
    path: &Path,
    manifest: &InstallerManifest,
    job: &Job,
) -> Result<(), InstallerError> {
    if !plain_file(path) {
        return Err(InstallerError::UnsafeArchive);
    }
    let mut source = File::open(path).map_err(|_| InstallerError::StorageFailed)?;
    if source
        .metadata()
        .map_err(|_| InstallerError::StorageFailed)?
        .len()
        != manifest.bytes
    {
        return Err(InstallerError::SizeMismatch);
    }
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; BUFFER_BYTES];
    let mut read = 0_u64;
    loop {
        check_job(job)?;
        let n = source
            .read(&mut buffer)
            .map_err(|_| InstallerError::StorageFailed)?;
        if n == 0 {
            break;
        }
        read = read
            .checked_add(n as u64)
            .ok_or(InstallerError::SizeMismatch)?;
        if read > manifest.bytes {
            return Err(InstallerError::SizeMismatch);
        }
        hash.update(&buffer[..n]);
    }
    if read != manifest.bytes {
        return Err(InstallerError::SizeMismatch);
    }
    if format!("{:x}", hash.finalize()) != manifest.sha256 {
        return Err(InstallerError::HashMismatch);
    }
    Ok(())
}

struct BoundedReader<R> {
    source: R,
    remaining: u64,
}

impl<R: Read> Read for BoundedReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            let mut extra = [0_u8; 1];
            return if self.source.read(&mut extra)? == 0 {
                Ok(0)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "archive bound exceeded",
                ))
            };
        }
        let limit = buffer.len().min(self.remaining as usize);
        let n = self.source.read(&mut buffer[..limit])?;
        self.remaining -= n as u64;
        Ok(n)
    }
}

fn archive_reader(path: &Path) -> Result<BoundedReader<MultiGzDecoder<File>>, InstallerError> {
    Ok(BoundedReader {
        source: MultiGzDecoder::new(File::open(path).map_err(|_| InstallerError::StorageFailed)?),
        remaining: MAX_UNPACKED_BYTES,
    })
}

fn archive_path(raw: &[u8]) -> Result<PathBuf, InstallerError> {
    let raw = std::str::from_utf8(raw).map_err(|_| InstallerError::UnsafeArchive)?;
    if raw.is_empty()
        || raw.len() > 4096
        || raw.starts_with('/')
        || raw.contains('\\')
        || raw.contains(':')
    {
        return Err(InstallerError::UnsafeArchive);
    }
    let raw = raw.strip_suffix('/').unwrap_or(raw);
    if raw.eq_ignore_ascii_case(RECEIPT_NAME) {
        return Err(InstallerError::UnsafeArchive);
    }
    let mut result = PathBuf::new();
    for segment in raw.split('/') {
        let stem = segment.split('.').next().unwrap_or("").to_ascii_uppercase();
        if segment.is_empty()
            || matches!(segment, "." | "..")
            || segment.len() > 255
            || segment.ends_with(['.', ' '])
            || segment
                .chars()
                .any(|c| c.is_control() || "<>\"|?*".contains(c))
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(InstallerError::UnsafeArchive);
        }
        result.push(segment);
    }
    if result.is_absolute()
        || result
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(InstallerError::UnsafeArchive);
    }
    Ok(result)
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

fn pax_path(data: &[u8]) -> Result<Option<PathBuf>, InstallerError> {
    let mut offset = 0_usize;
    let mut seen = HashSet::new();
    let mut path = None;
    while offset < data.len() {
        let rest = &data[offset..];
        let separator = rest
            .iter()
            .position(|b| *b == b' ')
            .ok_or(InstallerError::UnsafeArchive)?;
        let length: usize = std::str::from_utf8(&rest[..separator])
            .ok()
            .and_then(|s| s.parse().ok())
            .ok_or(InstallerError::UnsafeArchive)?;
        if length <= separator + 3 || length > rest.len() || rest[length - 1] != b'\n' {
            return Err(InstallerError::UnsafeArchive);
        }
        let record = &rest[separator + 1..length - 1];
        let equal = record
            .iter()
            .position(|b| *b == b'=')
            .ok_or(InstallerError::UnsafeArchive)?;
        let key =
            std::str::from_utf8(&record[..equal]).map_err(|_| InstallerError::UnsafeArchive)?;
        if !seen.insert(key.to_owned()) {
            return Err(InstallerError::UnsafeArchive);
        }
        match key {
            "path" => path = Some(archive_path(&record[equal + 1..])?),
            // These standard Python PAX fields cannot change manual file I/O.
            "mtime" | "atime" | "ctime" | "uid" | "gid" | "uname" | "gname" => {}
            _ => return Err(InstallerError::UnsafeArchive),
        }
        offset = offset
            .checked_add(length)
            .ok_or(InstallerError::UnsafeArchive)?;
    }
    Ok(path)
}

fn inspect_archive(path: &Path, job: &Job) -> Result<(), InstallerError> {
    let mut archive = tar::Archive::new(archive_reader(path)?);
    let mut seen = HashSet::new();
    let mut total = 0_u64;
    let mut count = 0_usize;
    let mut pending_pax: Option<Option<PathBuf>> = None;
    for entry in archive
        .entries()
        .map_err(|_| InstallerError::UnsafeArchive)?
        .raw(true)
    {
        check_job(job)?;
        let mut entry = entry.map_err(|_| InstallerError::UnsafeArchive)?;
        count += 1;
        if count > MAX_ENTRIES {
            return Err(InstallerError::UnsafeArchive);
        }
        let kind = entry.header().entry_type();
        let size = entry.size();
        if kind.is_pax_local_extensions() {
            if pending_pax.is_some() || size > MAX_METADATA_BYTES {
                return Err(InstallerError::UnsafeArchive);
            }
            let mut data = Vec::with_capacity(size as usize);
            entry
                .read_to_end(&mut data)
                .map_err(|_| InstallerError::UnsafeArchive)?;
            pending_pax = Some(pax_path(&data)?);
            continue;
        }
        if !kind.is_file() && !kind.is_dir() {
            return Err(InstallerError::UnsafeArchive);
        }
        if entry.header().link_name_bytes().is_some() || (kind.is_dir() && size != 0) {
            return Err(InstallerError::UnsafeArchive);
        }
        let header_path = archive_path(&entry.path_bytes())?;
        let relative = match pending_pax.take().flatten() {
            Some(path) => path,
            None => header_path,
        };
        if !seen.insert(path_key(&relative)) {
            return Err(InstallerError::UnsafeArchive);
        }
        total = total
            .checked_add(size)
            .filter(|total| *total <= MAX_UNPACKED_BYTES)
            .ok_or(InstallerError::UnsafeArchive)?;
        drain_entry(&mut entry, job)?;
    }
    if pending_pax.is_some() {
        return Err(InstallerError::UnsafeArchive);
    }
    drain_entry(&mut archive.into_inner(), job)?;
    Ok(())
}

fn drain_entry<R: Read>(reader: &mut R, job: &Job) -> Result<(), InstallerError> {
    let mut buffer = [0_u8; BUFFER_BYTES];
    loop {
        check_job(job)?;
        if reader
            .read(&mut buffer)
            .map_err(|_| InstallerError::UnsafeArchive)?
            == 0
        {
            return Ok(());
        }
    }
}

fn ensure_directories(root: &Path, relative: &Path) -> Result<PathBuf, InstallerError> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(InstallerError::UnsafeArchive);
        }
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !link_like(&metadata) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|_| InstallerError::UnsafeArchive)?;
            }
            _ => return Err(InstallerError::UnsafeArchive),
        }
        if !contained_directory(root, &current) {
            return Err(InstallerError::UnsafeArchive);
        }
    }
    Ok(current)
}

fn unpack_archive(path: &Path, root: &Path, job: &Job) -> Result<(), InstallerError> {
    let root = safe_root(root, false)?;
    let mut archive = tar::Archive::new(archive_reader(path)?);
    let mut seen = HashSet::new();
    let mut canonical_seen = HashSet::new();
    let mut total = 0_u64;
    let mut count = 0_usize;
    for entry in archive
        .entries()
        .map_err(|_| InstallerError::UnsafeArchive)?
    {
        check_job(job)?;
        let mut entry = entry.map_err(|_| InstallerError::UnsafeArchive)?;
        count += 1;
        if count > MAX_ENTRIES {
            return Err(InstallerError::UnsafeArchive);
        }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err(InstallerError::UnsafeArchive);
        }
        let relative = archive_path(&entry.path_bytes())?;
        if !seen.insert(path_key(&relative)) {
            return Err(InstallerError::UnsafeArchive);
        }
        total = total
            .checked_add(entry.size())
            .filter(|total| *total <= MAX_UNPACKED_BYTES)
            .ok_or(InstallerError::UnsafeArchive)?;
        let target = if kind.is_dir() {
            ensure_directories(&root, &relative)?
        } else {
            if let Some(parent) = relative.parent() {
                ensure_directories(&root, parent)?;
            }
            let target = root.join(relative);
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|_| InstallerError::UnsafeArchive)?;
            let expected = entry.size();
            let mut written = 0_u64;
            let mut buffer = [0_u8; BUFFER_BYTES];
            loop {
                check_job(job)?;
                let n = entry
                    .read(&mut buffer)
                    .map_err(|_| InstallerError::UnsafeArchive)?;
                if n == 0 {
                    break;
                }
                written = written
                    .checked_add(n as u64)
                    .filter(|n| *n <= expected)
                    .ok_or(InstallerError::UnsafeArchive)?;
                output
                    .write_all(&buffer[..n])
                    .map_err(|_| InstallerError::StorageFailed)?;
            }
            if written != expected {
                return Err(InstallerError::UnsafeArchive);
            }
            // Manual extraction never applies archive ownership, ACLs or
            // special bits. Preserve executability for macOS native helpers
            // and resources, without setuid/setgid or group/world write bits.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let archive_mode = entry
                    .header()
                    .mode()
                    .map_err(|_| InstallerError::UnsafeArchive)?;
                let mode = if archive_mode & 0o111 != 0 {
                    0o755
                } else {
                    0o644
                };
                output
                    .set_permissions(fs::Permissions::from_mode(mode))
                    .map_err(|_| InstallerError::StorageFailed)?;
            }
            output
                .sync_all()
                .map_err(|_| InstallerError::StorageFailed)?;
            target
        };
        let canonical = fs::canonicalize(&target).map_err(|_| InstallerError::UnsafeArchive)?;
        if !canonical.starts_with(&root) || !canonical_seen.insert(path_key(&canonical)) {
            return Err(InstallerError::UnsafeArchive);
        }
    }
    drain_entry(&mut archive.into_inner(), job)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::{
        io::Cursor,
        sync::{atomic::AtomicUsize, mpsc},
    };

    struct FixtureRoot(PathBuf);

    impl FixtureRoot {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("masset-codex-installer-fixture-{}", Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            Self(fs::canonicalize(root).unwrap())
        }
    }

    impl Drop for FixtureRoot {
        fn drop(&mut self) {
            let temporary = fs::canonicalize(std::env::temp_dir()).unwrap();
            let prefix = "masset-codex-installer-fixture-";
            if self.0.parent() == Some(temporary.as_path())
                && self
                    .0
                    .file_name()
                    .and_then(|s| s.to_str())
                    .is_some_and(|name| name.starts_with(prefix))
                && contained_directory(&temporary, &self.0)
            {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    fn fixture_job() -> Job {
        Job {
            id: Uuid::new_v4(),
            cancelled: Arc::new(AtomicBool::new(false)),
            started: Instant::now(),
        }
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut writer = GzEncoder::new(Vec::new(), Compression::fast());
        writer.write_all(bytes).unwrap();
        writer.finish().unwrap()
    }

    fn header(path: &str, kind: u8, size: u64) -> tar::Header {
        let mut header = tar::Header::new_ustar();
        header.set_entry_type(tar::EntryType::new(kind));
        header.set_mode(0o755);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_size(size);
        // Bypass Header::set_path's validation to construct malicious fixtures.
        assert!(path.len() < 100);
        header.as_mut_bytes()[..path.len()].copy_from_slice(path.as_bytes());
        header.set_cksum();
        header
    }

    fn pax_record(key: &str, value: &str) -> Vec<u8> {
        let body = format!(" {key}={value}\n");
        let mut length = body.len() + 1;
        loop {
            let next = body.len() + length.to_string().len();
            if next == length {
                return format!("{length}{body}").into_bytes();
            }
            length = next;
        }
    }

    fn fixture_package(extra: Option<(&str, u8, &[u8])>) -> Vec<u8> {
        fixture_package_for(NATIVE_PACKAGE, extra)
    }

    fn fixture_package_for(package: &PinnedPackage, extra: Option<(&str, u8, &[u8])>) -> Vec<u8> {
        let mut archive = tar::Builder::new(Vec::new());
        for directory in ["bin/", "codex-resources/", "codex-path/"] {
            archive
                .append(&header(directory, b'5', 0), Cursor::new([]))
                .unwrap();
        }
        let metadata = serde_json::json!({
            "layoutVersion":1,"version":CODEX_VERSION,"target":package.target,"variant":"codex",
            "entrypoint":package.main,"resourcesDir":"codex-resources","pathDir":"codex-path",
        })
        .to_string();
        let mut files = vec![
            ("codex-package.json", metadata.as_bytes()),
            (package.main, b"fixture-main-never-executed".as_slice()),
            (package.host, b"fixture-host-never-executed".as_slice()),
            (package.ripgrep, b"fixture-rg-never-executed".as_slice()),
            (
                "codex-resources/NOTICE",
                b"fixture-third-party-notices".as_slice(),
            ),
        ];
        if let Some(zsh) = package.zsh {
            files.push((zsh, b"fixture-zsh-never-executed".as_slice()));
        }
        for (path, bytes) in files {
            // Python's canonical tar writer emits fractional-mtime PAX headers.
            let pax = pax_record("mtime", "1.5");
            archive
                .append(
                    &header("././@PaxHeader", b'x', pax.len() as u64),
                    Cursor::new(pax),
                )
                .unwrap();
            let mut file_header = header(path, b'0', bytes.len() as u64);
            if matches!(path, "codex-package.json" | "codex-resources/NOTICE") {
                file_header.set_mode(0o644);
                file_header.set_cksum();
            }
            archive.append(&file_header, Cursor::new(bytes)).unwrap();
        }
        if let Some((path, kind, bytes)) = extra {
            let mut extra_header = header(path, kind, bytes.len() as u64);
            if matches!(kind, b'1' | b'2') {
                extra_header.set_link_name("outside-original").unwrap();
                extra_header.set_cksum();
            }
            archive.append(&extra_header, Cursor::new(bytes)).unwrap();
        }
        archive.finish().unwrap();
        gzip(&archive.into_inner().unwrap())
    }

    fn fixture_installer(root: &FixtureRoot, bytes: &[u8]) -> (CodexInstaller, PathBuf) {
        fixture_installer_for(root, bytes, NATIVE_PACKAGE)
    }

    fn fixture_installer_for(
        root: &FixtureRoot,
        bytes: &[u8],
        pinned: &PinnedPackage,
    ) -> (CodexInstaller, PathBuf) {
        let package = root.0.join(format!("cache-{}.tar.gz", Uuid::new_v4()));
        fs::write(&package, bytes).unwrap();
        let mut manifest = pinned.manifest();
        manifest.bytes = bytes.len() as u64;
        manifest.sha256 = format!("{:x}", Sha256::digest(bytes));
        // Only private fixtures can substitute this tiny manifest. Public APIs
        // always use the pinned official bytes/hash and require human consent.
        (
            CodexInstaller::with_manifest(root.0.join("managed"), manifest),
            package,
        )
    }

    fn wait_finished(installer: &CodexInstaller) -> InstallerStatus {
        wait_finished_with_timeout(installer, Duration::from_secs(10))
    }

    fn wait_finished_with_timeout(
        installer: &CodexInstaller,
        timeout: Duration,
    ) -> InstallerStatus {
        let deadline = Instant::now() + timeout;
        while installer.busy() {
            assert!(Instant::now() < deadline, "fixture worker must terminate");
            thread::sleep(Duration::from_millis(10));
        }
        installer.status()
    }

    #[test]
    fn consent_and_pinned_manifest_are_checked_without_starting_work() {
        let root = FixtureRoot::new();
        let installer = CodexInstaller::new(root.0.join("managed"));
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let verify: SignatureVerifier = Arc::new(move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
            true
        });
        assert!(matches!(
            installer.start(false, CODEX_VERSION, CODEX_PACKAGE_SHA256, verify.clone()),
            Err(InstallerError::ConsentRequired)
        ));
        for (version, hash) in [
            ("0.159.0", CODEX_PACKAGE_SHA256),
            (CODEX_VERSION, "untrusted-hash"),
        ] {
            let error = installer
                .start(true, version, hash, verify.clone())
                .unwrap_err();
            assert_eq!(
                error,
                if installer.status().supported {
                    InstallerError::ManifestMismatch
                } else {
                    InstallerError::UnsupportedPlatform
                }
            );
        }
        assert!(!installer.busy());
        assert_eq!(installer.status().state, InstallerState::Idle);
        assert!(!installer.inner.root.exists());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let status = serde_json::to_value(installer.status()).unwrap();
        assert_eq!(status["manifest"]["bytes"], CODEX_PACKAGE_BYTES);
        assert_eq!(status["manifest"]["sha256"], CODEX_PACKAGE_SHA256);
        assert_eq!(status["manifest"]["target"], CODEX_TARGET);
        assert!(status.get("downloadedBytes").is_some());
        assert!(status["manifest"].get("sourceUrl").is_some());
    }

    #[test]
    fn download_origins_reject_credentials_ports_lookalikes_and_fragments() {
        for address in [
            PACKAGE_URL,
            "https://release-assets.githubusercontent.com/example?public_signed_asset=fixture",
        ] {
            assert!(official_download_url(&Url::parse(address).unwrap()));
        }
        for address in [
            "http://github.com/openai/codex",
            "https://github.com.attacker.invalid/openai/codex",
            "https://secret@github.com/openai/codex",
            "https://github.com:444/openai/codex",
            "https://github.com/openai/codex#fragment",
            "https://objects.githubusercontent.com/openai/codex",
            "https://release-assets.githubusercontent.com.attacker.invalid/file",
        ] {
            assert!(!official_download_url(&Url::parse(address).unwrap()));
        }
    }

    #[test]
    fn redirects_are_bounded_and_cannot_leave_the_fixed_origin_chain() {
        let github = Url::parse(PACKAGE_URL).unwrap();
        let assets =
            "https://release-assets.githubusercontent.com/example?public_signed_asset=fixture";
        assert!(checked_redirect(&github, assets, 4, 302).is_ok());
        assert_eq!(
            checked_redirect(&github, assets, 5, 302),
            Err(InstallerError::UnsafeDownloadUrl)
        );
        assert_eq!(
            checked_redirect(&github, assets, 0, 304),
            Err(InstallerError::UnsafeDownloadUrl)
        );
        assert_eq!(
            checked_redirect(&github, "https://attacker.invalid/file", 0, 302),
            Err(InstallerError::UnsafeDownloadUrl)
        );
        assert_eq!(
            checked_redirect(&github, "https://secret@github.com/file", 0, 302),
            Err(InstallerError::UnsafeDownloadUrl)
        );
        assert_eq!(
            checked_redirect(&Url::parse(assets).unwrap(), PACKAGE_URL, 0, 302),
            Err(InstallerError::UnsafeDownloadUrl)
        );
        assert!(checked_redirect(&github, "/openai/codex/public-redirect", 0, 307).is_ok());
    }

    #[test]
    fn streaming_receive_rejects_extra_or_missing_bytes_without_unbounded_writes() {
        for extra in [true, false] {
            let root = FixtureRoot::new();
            let expected = b"package-fixture";
            let (installer, _) = fixture_installer(&root, expected);
            let source = if extra {
                [expected.as_slice(), b"x"].concat()
            } else {
                expected[..expected.len() - 1].to_vec()
            };
            let destination = root.0.join("bounded-cache.tar.gz");
            let error = installer
                .receive_package(&fixture_job(), Cursor::new(source), &destination)
                .unwrap_err();
            assert_eq!(error, InstallerError::SizeMismatch);
            assert!(fs::metadata(destination).unwrap().len() <= expected.len() as u64);
            assert!(installer.installed_executables().is_empty());
        }
    }

    #[test]
    fn size_and_sha_failures_cannot_reach_signature_or_registration() {
        for mismatch in ["size", "hash"] {
            let root = FixtureRoot::new();
            let bytes = fixture_package(None);
            let (installer, package) = fixture_installer(&root, &bytes);
            if mismatch == "size" {
                fs::write(&package, &bytes[..bytes.len() - 1]).unwrap();
            } else {
                let mut altered = bytes.clone();
                altered[0] ^= 1;
                fs::write(&package, altered).unwrap();
            }
            let calls = Arc::new(AtomicUsize::new(0));
            let observed = calls.clone();
            installer
                .launch(
                    PackageInput::Cache(package),
                    Arc::new(move |_| {
                        observed.fetch_add(1, Ordering::SeqCst);
                        true
                    }),
                )
                .unwrap();
            let status = wait_finished(&installer);
            assert_eq!(status.state, InstallerState::Error);
            assert_eq!(
                status.message,
                if mismatch == "size" {
                    InstallerError::SizeMismatch
                } else {
                    InstallerError::HashMismatch
                }
                .to_string()
            );
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert!(installer.installed_executables().is_empty());
        }
    }

    #[test]
    fn paths_links_duplicates_and_archive_limits_are_rejected_before_signature() {
        let duplicate_main = MAIN_PATH.to_uppercase();
        for (path, kind) in [
            ("../outside-original", b'0'),
            ("/outside-original", b'0'),
            ("C:/outside-original", b'0'),
            ("bin/../../outside-original", b'0'),
            ("bin/secret:stream", b'0'),
            ("bin/linked", b'1'),
            ("bin/linked", b'2'),
            ("bin/pipe", b'6'),
            (duplicate_main.as_str(), b'0'),
            (RECEIPT_NAME, b'0'),
        ] {
            let root = FixtureRoot::new();
            let payload = if matches!(kind, b'1' | b'2' | b'6') {
                b"".as_slice()
            } else {
                b"unsafe".as_slice()
            };
            let bytes = fixture_package(Some((path, kind, payload)));
            let (installer, package) = fixture_installer(&root, &bytes);
            let original = root.0.join("outside-original");
            fs::write(&original, b"fixture-original").unwrap();
            let calls = Arc::new(AtomicUsize::new(0));
            let observed = calls.clone();
            installer
                .launch(
                    PackageInput::Cache(package),
                    Arc::new(move |_| {
                        observed.fetch_add(1, Ordering::SeqCst);
                        true
                    }),
                )
                .unwrap();
            let status = wait_finished(&installer);
            assert_eq!(status.state, InstallerState::Error);
            assert_eq!(status.message, InstallerError::UnsafeArchive.to_string());
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert!(installer.installed_executables().is_empty());
            assert_eq!(fs::read(original).unwrap(), b"fixture-original");
        }
        for header in [
            header("huge-file", b'0', MAX_UNPACKED_BYTES + 1),
            header("././@PaxHeader", b'x', MAX_METADATA_BYTES + 1),
        ] {
            let root = FixtureRoot::new();
            let mut bytes = header.as_bytes().to_vec();
            bytes.extend_from_slice(&[0_u8; 1024]);
            let archive = root.0.join("bounded.tar.gz");
            fs::write(&archive, gzip(&bytes)).unwrap();
            assert_eq!(
                inspect_archive(&archive, &fixture_job()),
                Err(InstallerError::UnsafeArchive)
            );
        }
        let mut reader = BoundedReader {
            source: Cursor::new(b"123456"),
            remaining: 5,
        };
        assert!(reader.read_to_end(&mut Vec::new()).is_err());
    }

    #[test]
    fn pax_paths_and_windows_filename_aliases_cannot_bypass_validation() {
        for path in [
            "..",
            "./bin/file",
            "bin//file",
            "bin\\file",
            "bin/NUL.dll",
            "bin/COM1.exe",
            "bin/name.",
            "bin/name ",
            "bin/file:stream",
            "bin/LPT9",
            "bin/a\0b",
        ] {
            assert!(archive_path(path.as_bytes()).is_err());
        }
        assert!(pax_path(&pax_record("path", "../outside-original")).is_err());
        assert!(pax_path(&pax_record("size", "99999999999")).is_err());
        assert!(pax_path(&pax_record("linkpath", "outside-original")).is_err());
        assert!(pax_path(&pax_record("GNU.sparse.map", "0,99999999")).is_err());
        assert_eq!(
            pax_path(&pax_record("path", MAIN_PATH)).unwrap(),
            Some(PathBuf::from(MAIN_PATH))
        );
        assert!(pax_path(b"999999 path=bin/file\n").is_err());
    }

    #[test]
    fn signature_rejection_and_uncommitted_directories_are_never_discovered() {
        let root = FixtureRoot::new();
        let bytes = fixture_package(None);
        let (installer, package) = fixture_installer(&root, &bytes);
        installer
            .launch(PackageInput::Cache(package.clone()), Arc::new(|_| false))
            .unwrap();
        let status = wait_finished(&installer);
        assert_eq!(status.state, InstallerState::Error);
        assert_eq!(
            status.message,
            InstallerError::SignatureRejected.to_string()
        );
        assert!(installer.installed_executables().is_empty());
        assert_eq!(fs::read(&package).unwrap(), bytes);
    }

    #[test]
    fn receipt_is_published_after_verification_and_new_installs_preserve_previous_files() {
        let root = FixtureRoot::new();
        let bytes = fixture_package(None);
        let (installer, package) = fixture_installer(&root, &bytes);
        fs::create_dir_all(installer.inner.root.join("bin")).unwrap();
        let original = installer.inner.root.join(MAIN_PATH);
        fs::write(&original, b"existing-fixture-main").unwrap();
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let release = Mutex::new(release_rx);
        installer
            .launch(
                PackageInput::Cache(package.clone()),
                Arc::new(move |main| {
                    assert_eq!(
                        main.file_name().unwrap(),
                        Path::new(MAIN_PATH).file_name().unwrap()
                    );
                    assert!(main
                        .parent()
                        .unwrap()
                        .join(Path::new(HOST_PATH).file_name().unwrap())
                        .is_file());
                    entered_tx.send(()).unwrap();
                    release
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap();
                    true
                }),
            )
            .unwrap();
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(installer.busy());
        assert_eq!(installer.status().state, InstallerState::Verifying);
        assert!(installer.installed_executables().is_empty());
        release_tx.send(()).unwrap();
        assert_eq!(wait_finished(&installer).state, InstallerState::Ready);
        let first = installer.installed_executables();
        assert_eq!(first.len(), 1);
        let first_bytes = fs::read(&first[0]).unwrap();
        assert_eq!(fs::read(&original).unwrap(), b"existing-fixture-main");
        assert_eq!(fs::read(&package).unwrap(), bytes);
        installer
            .launch(PackageInput::Cache(package.clone()), Arc::new(|_| true))
            .unwrap();
        assert_eq!(wait_finished(&installer).state, InstallerState::Ready);
        let all = installer.installed_executables();
        assert_eq!(all.len(), 2);
        assert_ne!(all[0], all[1]);
        assert_eq!(fs::read(&first[0]).unwrap(), first_bytes);
        assert_eq!(fs::read(&original).unwrap(), b"existing-fixture-main");
        assert_eq!(fs::read(&package).unwrap(), bytes);
    }

    #[test]
    fn cancellation_waits_for_worker_and_allows_restart_only_after_termination() {
        let root = FixtureRoot::new();
        let (installer, package) = fixture_installer(&root, &fixture_package(None));
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let release = Mutex::new(release_rx);
        installer
            .launch(
                PackageInput::Cache(package.clone()),
                Arc::new(move |_| {
                    entered_tx.send(()).unwrap();
                    release
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap();
                    true
                }),
            )
            .unwrap();
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let pending = installer.cancel();
        assert!(installer.busy());
        assert_eq!(pending.state, InstallerState::Verifying);
        assert!(pending.message.contains("취소"));
        assert!(matches!(
            installer.launch(PackageInput::Cache(package.clone()), Arc::new(|_| true)),
            Err(InstallerError::Busy)
        ));
        assert!(installer.installed_executables().is_empty());
        release_tx.send(()).unwrap();
        assert_eq!(wait_finished(&installer).state, InstallerState::Cancelled);
        assert!(!installer.busy());
        assert!(installer.installed_executables().is_empty());
        installer
            .launch(PackageInput::Cache(package), Arc::new(|_| true))
            .unwrap();
        assert_eq!(wait_finished(&installer).state, InstallerState::Ready);
        assert_eq!(installer.installed_executables().len(), 1);
        assert_eq!(installer.cancel().state, InstallerState::Ready);
    }

    #[test]
    fn cancelled_jobs_and_truncated_gzip_cannot_commit_a_receipt() {
        let root = FixtureRoot::new();
        let bytes = fixture_package(None);
        let archive = root.0.join("truncated.tar.gz");
        fs::write(&archive, &bytes[..bytes.len() - 6]).unwrap();
        assert_eq!(
            inspect_archive(&archive, &fixture_job()),
            Err(InstallerError::UnsafeArchive)
        );
        let job = fixture_job();
        job.cancelled.store(true, Ordering::Release);
        assert_eq!(
            inspect_archive(&archive, &job),
            Err(InstallerError::Cancelled)
        );
        let (installer, package) = fixture_installer(&root, &bytes);
        installer
            .launch(
                PackageInput::Cache(package),
                Arc::new(|_| panic!("fixture panic in signature callback")),
            )
            .unwrap();
        assert_eq!(wait_finished(&installer).state, InstallerState::Error);
        assert!(installer.installed_executables().is_empty());
        assert_eq!(
            installer.status().message,
            InstallerError::WorkerFailed.to_string()
        );
    }

    #[test]
    fn altered_receipt_layout_or_traversal_is_not_a_discoverable_install() {
        let root = FixtureRoot::new();
        let (installer, package) = fixture_installer(&root, &fixture_package(None));
        installer
            .launch(PackageInput::Cache(package), Arc::new(|_| true))
            .unwrap();
        assert_eq!(wait_finished(&installer).state, InstallerState::Ready);
        let executable = installer.installed_executables().remove(0);
        let directory = executable.parent().unwrap().parent().unwrap();
        let receipt = directory.join(RECEIPT_NAME);
        let original = fs::read(&receipt).unwrap();
        for (field, value) in [
            ("entrypoint", serde_json::json!("../outside-original")),
            ("host", serde_json::json!("../outside-original")),
            ("target", serde_json::json!("x86_64-apple-darwin")),
            ("sha256", serde_json::json!("untrusted-hash")),
            ("signatureVerified", serde_json::json!(false)),
        ] {
            let mut altered: serde_json::Value = serde_json::from_slice(&original).unwrap();
            altered[field] = value;
            fs::write(&receipt, serde_json::to_vec(&altered).unwrap()).unwrap();
            assert!(installer.installed_executables().is_empty());
        }
        fs::write(&receipt, &original).unwrap();
        assert_eq!(installer.installed_executables().len(), 1);
        fs::remove_file(directory.join(HOST_PATH)).unwrap();
        assert!(installer.installed_executables().is_empty());
    }

    #[test]
    fn both_platform_layouts_commit_matching_receipts_and_reject_cross_target_discovery() {
        for (pinned, other) in [
            (&WINDOWS_PACKAGE, &MACOS_PACKAGE),
            (&MACOS_PACKAGE, &WINDOWS_PACKAGE),
        ] {
            let root = FixtureRoot::new();
            let bytes = fixture_package_for(pinned, None);
            let (installer, package) = fixture_installer_for(&root, &bytes, pinned);
            installer
                .launch(
                    PackageInput::Cache(package.clone()),
                    Arc::new(move |main| {
                        assert_eq!(
                            main.file_name().unwrap(),
                            Path::new(pinned.main).file_name().unwrap()
                        );
                        true
                    }),
                )
                .unwrap();
            assert_eq!(wait_finished(&installer).state, InstallerState::Ready);
            let executable = installer.installed_executables().remove(0);
            let directory = executable.parent().unwrap().parent().unwrap();
            let receipt: InstallReceipt = read_json_file(&directory.join(RECEIPT_NAME)).unwrap();
            assert_eq!(receipt.target, pinned.target);
            assert_eq!(receipt.entrypoint, pinned.main);
            assert_eq!(receipt.host, pinned.host);
            assert!(receipt.signature_verified);
            assert_eq!(
                CodexInstaller::with_manifest(
                    installer.inner.root.clone(),
                    installer.inner.manifest.clone()
                )
                .installed_executables(),
                vec![executable.clone()]
            );
            let mut wrong_target = installer.inner.manifest.clone();
            wrong_target.target = other.target.into();
            assert_eq!(
                validate_layout(directory, &wrong_target),
                Err(InstallerError::PackageLayout)
            );
            assert!(
                CodexInstaller::with_manifest(installer.inner.root.clone(), wrong_target)
                    .installed_executables()
                    .is_empty()
            );
            assert_eq!(fs::read(package).unwrap(), bytes);
        }
        assert!(package_for_target("x86_64-apple-darwin").is_err());
        assert!(package_for_target("aarch64-pc-windows-msvc").is_err());
        assert!(package_for_target("aarch64-unknown-linux-gnu").is_err());
    }

    #[test]
    fn macos_layout_requires_native_main_host_ripgrep_and_bundled_shell() {
        for required in [
            MACOS_PACKAGE.main,
            MACOS_PACKAGE.host,
            MACOS_PACKAGE.ripgrep,
        ]
        .into_iter()
        .chain(MACOS_PACKAGE.zsh)
        {
            let root = FixtureRoot::new();
            let bytes = fixture_package_for(&MACOS_PACKAGE, None);
            let archive = root.0.join("macos.tar.gz");
            fs::write(&archive, bytes).unwrap();
            let extracted = root.0.join("package");
            fs::create_dir(&extracted).unwrap();
            let job = fixture_job();
            inspect_archive(&archive, &job).unwrap();
            unpack_archive(&archive, &extracted, &job).unwrap();
            let manifest = MACOS_PACKAGE.manifest();
            validate_layout(&extracted, &manifest).unwrap();
            let executable = extracted.join(required);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&executable, fs::Permissions::from_mode(0o644)).unwrap();
                assert_eq!(
                    validate_layout(&extracted, &manifest),
                    Err(InstallerError::PackageLayout)
                );
                fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
            }
            fs::write(&executable, []).unwrap();
            assert_eq!(
                validate_layout(&extracted, &manifest),
                Err(InstallerError::PackageLayout)
            );
            fs::remove_file(executable).unwrap();
            assert_eq!(
                validate_layout(&extracted, &manifest),
                Err(InstallerError::PackageLayout)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn extraction_preserves_executability_without_special_or_group_write_bits() {
        use std::os::unix::fs::PermissionsExt;
        let root = FixtureRoot::new();
        let archive = root.0.join("permissions.tar.gz");
        let mut builder = tar::Builder::new(Vec::new());
        for (path, mode) in [("native-helper", 0o6777), ("metadata.json", 0o666)] {
            let mut file_header = header(path, b'0', 7);
            file_header.set_mode(mode);
            file_header.set_cksum();
            builder
                .append(&file_header, Cursor::new(b"fixture"))
                .unwrap();
        }
        builder.finish().unwrap();
        fs::write(&archive, gzip(&builder.into_inner().unwrap())).unwrap();
        let extracted = root.0.join("package");
        fs::create_dir(&extracted).unwrap();
        let job = fixture_job();
        inspect_archive(&archive, &job).unwrap();
        unpack_archive(&archive, &extracted, &job).unwrap();
        for (path, expected) in [("native-helper", 0o755), ("metadata.json", 0o644)] {
            assert_eq!(
                fs::metadata(extracted.join(path))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o7777,
                expected
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_roots_cached_packages_and_helpers_are_rejected() {
        use std::os::unix::fs::symlink;
        let root = FixtureRoot::new();
        let original = root.0.join("original");
        fs::create_dir(&original).unwrap();
        let linked_root = root.0.join("linked-root");
        symlink(&original, &linked_root).unwrap();
        assert_eq!(
            safe_root(&linked_root.join("managed"), true),
            Err(InstallerError::UnsafeRoot)
        );
        assert!(!original.join("managed").exists());

        let bytes = fixture_package(None);
        let (installer, package) = fixture_installer(&root, &bytes);
        let linked_cache = root.0.join("linked-cache.tar.gz");
        symlink(&package, &linked_cache).unwrap();
        installer
            .launch(
                PackageInput::Cache(linked_cache),
                Arc::new(|_| panic!("symlinked archive cannot reach signature verification")),
            )
            .unwrap();
        assert_eq!(
            wait_finished(&installer).message,
            InstallerError::UnsafeArchive.to_string()
        );
        installer
            .launch(PackageInput::Cache(package.clone()), Arc::new(|_| true))
            .unwrap();
        assert_eq!(wait_finished(&installer).state, InstallerState::Ready);
        let executable = installer.installed_executables().remove(0);
        let host = executable
            .parent()
            .unwrap()
            .join(Path::new(HOST_PATH).file_name().unwrap());
        let original_host = original.join("host");
        fs::rename(&host, &original_host).unwrap();
        symlink(&original_host, &host).unwrap();
        assert!(installer.installed_executables().is_empty());
        assert_eq!(fs::read(package).unwrap(), bytes);
    }

    #[test]
    fn archive_entry_and_job_time_limits_are_enforced() {
        let root = FixtureRoot::new();
        let archive = root.0.join("too-many-entries.tar.gz");
        let mut builder = tar::Builder::new(Vec::new());
        for index in 0..=MAX_ENTRIES {
            builder
                .append(&header(&format!("file-{index}"), b'0', 0), Cursor::new([]))
                .unwrap();
        }
        builder.finish().unwrap();
        fs::write(&archive, gzip(&builder.into_inner().unwrap())).unwrap();
        assert_eq!(
            inspect_archive(&archive, &fixture_job()),
            Err(InstallerError::UnsafeArchive)
        );
        let mut job = fixture_job();
        job.started = Instant::now() - MAX_INSTALL_DURATION - Duration::from_secs(1);
        assert_eq!(
            inspect_archive(&archive, &job),
            Err(InstallerError::Timeout)
        );
    }

    // Opt-in native artifact verification, using only a task-specific download
    // and output directory. Never launches Codex or accesses an account.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    #[ignore = "requires the pinned official archive and a task-only evidence directory"]
    fn official_macos_package_prepares_with_native_signatures_and_receipt() {
        use std::{os::unix::fs::PermissionsExt, process::Command};
        let package = PathBuf::from(
            std::env::var_os("MASSET_CODEX_INSTALLER_PACKAGE").expect("official archive path"),
        );
        let evidence = PathBuf::from(
            std::env::var_os("MASSET_CODEX_INSTALLER_EVIDENCE_DIR")
                .expect("task-only evidence path"),
        );
        let evidence = safe_root(&evidence, false).unwrap();
        let proof = evidence.join(format!("native-installer-proof-{}", Uuid::new_v4()));
        fs::create_dir(&proof).unwrap();
        let managed = proof.join("managed");
        let installer = CodexInstaller::new(managed.clone());
        let signature_results = Arc::new(Mutex::new(Vec::new()));
        let observed = signature_results.clone();
        assert!(installer.status().supported);
        assert_eq!(official_manifest(), MACOS_PACKAGE.manifest());
        installer
            .start_from_cached_package(
                true,
                CODEX_VERSION,
                CODEX_PACKAGE_SHA256,
                package.clone(),
                Arc::new(move |main| {
                    let bundle = main.parent().unwrap().parent().unwrap();
                    let requirement = "=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"2DC432GLL2\"";
                    let mut valid = true;
                    for relative in [MACOS_PACKAGE.main, MACOS_PACKAGE.host] {
                        let path = bundle.join(relative);
                        assert_eq!(path.metadata().unwrap().permissions().mode() & 0o7777, 0o755);
                        for (tool, args) in [
                            ("/usr/bin/lipo", vec![path.as_os_str(), "-verify_arch".as_ref(), "arm64".as_ref()]),
                            ("/usr/bin/codesign", vec!["--verify".as_ref(), "--strict".as_ref(), "-R".as_ref(), requirement.as_ref(), path.as_os_str()]),
                        ] {
                            let output = Command::new(tool).args(args).output().unwrap();
                            valid &= output.status.success();
                            observed.lock().unwrap().push(serde_json::json!({
                                "path":relative,"tool":tool,"exit":output.status.code(),
                                "stdout":String::from_utf8_lossy(&output.stdout),
                                "stderr":String::from_utf8_lossy(&output.stderr),
                            }));
                        }
                    }
                    valid
                }),
            )
            .unwrap();
        let status = wait_finished_with_timeout(&installer, Duration::from_secs(120));
        let signature_results = signature_results.lock().unwrap();
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(proof.join("verification.json"))
            .unwrap();
        serde_json::to_writer_pretty(
            &mut output,
            &serde_json::json!({
                "status":status,"nativeSignatures":*signature_results,
                "sourceArchive":package,"managedRoot":managed,
            }),
        )
        .unwrap();
        println!("Native installer evidence: {}", proof.display());
        assert_eq!(status.state, InstallerState::Ready, "{}", status.message);
        assert_eq!(signature_results.len(), 4);
        let installed = installer.installed_executables();
        assert_eq!(installed.len(), 1);
        let bundle = installed[0].parent().unwrap().parent().unwrap();
        let receipt: InstallReceipt = read_json_file(&bundle.join(RECEIPT_NAME)).unwrap();
        assert_eq!(receipt.target, MACOS_PACKAGE.target);
        assert_eq!(receipt.entrypoint, MACOS_PACKAGE.main);
        assert_eq!(receipt.host, MACOS_PACKAGE.host);
        assert_eq!(receipt.bytes, MACOS_PACKAGE.bytes);
        assert_eq!(receipt.sha256, MACOS_PACKAGE.sha256);
        for relative in [
            MACOS_PACKAGE.main,
            MACOS_PACKAGE.host,
            MACOS_PACKAGE.ripgrep,
        ]
        .into_iter()
        .chain(MACOS_PACKAGE.zsh)
        {
            assert_eq!(
                bundle
                    .join(relative)
                    .metadata()
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o7777,
                0o755
            );
        }
        assert_eq!(
            CodexInstaller::new(managed).installed_executables(),
            installed
        );
        verify_package_hash(&package, &official_manifest(), &fixture_job()).unwrap();
    }
}
