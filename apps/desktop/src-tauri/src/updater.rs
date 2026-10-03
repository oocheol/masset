use crate::workbench::Backend;
use anyhow::{bail, ensure, Result};
use futures_util::future::{AbortHandle, Abortable};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri_plugin_updater::{Update, UpdaterExt};

const RELEASE_ROOT: &str = "https://github.com/oocheol/masset/releases";
const UPDATE_ENDPOINT: &str =
    "https://github.com/oocheol/masset/releases/latest/download/latest.json";
const MAX_INSTALLER_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatus {
    pub supported: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub state: &'static str,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub sha256: Option<String>,
    pub release_url: Option<String>,
    pub message: String,
    pub checked_at: Option<String>,
}

#[derive(Clone)]
pub struct AppUpdater {
    status: Arc<Mutex<AppUpdateStatus>>,
    available: Arc<Mutex<Option<Update>>>,
    busy: Arc<AtomicBool>,
}

struct Operation(Arc<AtomicBool>);
impl Drop for Operation {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl AppUpdater {
    pub fn new(current_version: String, qa_mode: bool) -> Self {
        let supported = cfg!(all(windows, target_arch = "x86_64")) && !qa_mode;
        Self {
            status: Arc::new(Mutex::new(AppUpdateStatus {
                supported,
                current_version,
                latest_version: None,
                state: if supported { "idle" } else { "unsupported" },
                downloaded_bytes: 0,
                total_bytes: None,
                sha256: None,
                release_url: None,
                checked_at: None,
                message: if supported {
                    "앱에서 새 버전을 확인할 수 있습니다."
                } else {
                    "자동 업데이트는 Windows 설치형에서 제공합니다."
                }
                .into(),
            })),
            available: Arc::new(Mutex::new(None)),
            busy: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn status(&self) -> AppUpdateStatus {
        self.status.lock().unwrap().clone()
    }

    fn operation(&self) -> Result<Operation> {
        ensure!(
            self.status().supported,
            "이 환경에서는 앱 업데이트를 지원하지 않습니다."
        );
        ensure!(
            !self.busy.swap(true, Ordering::SeqCst),
            "업데이트 작업이 이미 진행 중입니다."
        );
        Ok(Operation(self.busy.clone()))
    }

    fn error(&self, message: &str) {
        let mut state = self.status.lock().unwrap();
        state.state = "error";
        state.message = message.into();
    }

    pub async fn check(&self, app: &tauri::AppHandle) -> Result<AppUpdateStatus> {
        let _operation = self.operation()?;
        {
            let mut state = self.status.lock().unwrap();
            state.state = "checking";
            state.message = "새 버전을 확인하고 있습니다.".into();
            state.downloaded_bytes = 0;
        }
        let result = async {
            let updater = app
                .updater_builder()
                .endpoints(vec![UPDATE_ENDPOINT.parse()?])?
                .timeout(Duration::from_secs(30))
                .build()?;
            let update = updater.check().await?;
            if let Some(update) = &update {
                let status = self.status();
                let (bytes, hash) = validate_update(update, &status.current_version)?;
                let mut state = self.status.lock().unwrap();
                state.latest_version = Some(update.version.clone());
                state.total_bytes = Some(bytes);
                state.sha256 = Some(hash);
                state.release_url = Some(format!("{RELEASE_ROOT}/tag/v{}", update.version));
                state.state = "available";
                state.message = "새 버전이 있습니다. 파일 정보를 확인하고 업데이트하세요.".into();
            } else {
                let mut state = self.status.lock().unwrap();
                state.state = "up_to_date";
                state.latest_version = None;
                state.total_bytes = None;
                state.sha256 = None;
                state.release_url = None;
                state.message = "현재 최신 버전을 사용하고 있습니다.".into();
            }
            *self.available.lock().unwrap() = update;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        self.status.lock().unwrap().checked_at = Some(chrono::Utc::now().to_rfc3339());
        if result.is_err() {
            *self.available.lock().unwrap() = None;
            self.error("버전을 확인하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.");
        }
        // Never return provider response bodies, request headers or redirect URLs.
        Ok(self.status())
    }

    pub async fn install(
        &self,
        app: &tauri::AppHandle,
        backend: &Backend,
        expected_version: &str,
        expected_sha256: &str,
    ) -> Result<AppUpdateStatus> {
        let _operation = self.operation()?;
        let mut update = self
            .available
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| anyhow::anyhow!("먼저 새 버전을 확인해 주세요."))?;
        update.timeout = Some(Duration::from_secs(300));
        let status = self.status();
        let (expected_bytes, sha256) = validate_update(&update, &status.current_version)?;
        ensure!(
            update.version == expected_version && sha256 == expected_sha256,
            "확인한 버전 또는 파일이 바뀌었습니다. 새 버전을 다시 확인해 주세요."
        );
        backend.ensure_update_idle()?;
        {
            let mut state = self.status.lock().unwrap();
            state.state = "downloading";
            state.downloaded_bytes = 0;
            state.message = "업데이트를 다운로드하고 서명을 확인합니다.".into();
        }
        let progress = self.status.clone();
        let (abort, registration) = AbortHandle::new_pair();
        let oversized = Arc::new(AtomicBool::new(false));
        let oversized_chunk = oversized.clone();
        // Abort at the next future yield; the plugin owns chunk collection.
        // This is not an OS memory ceiling. The oversized flag also rejects
        // bytes if the entire inner future completes within the current poll.
        let download = update.download(
            move |chunk, _| {
                let mut state = progress.lock().unwrap();
                state.downloaded_bytes = state.downloaded_bytes.saturating_add(chunk as u64);
                if state.downloaded_bytes > expected_bytes
                    || state.downloaded_bytes > MAX_INSTALLER_BYTES
                {
                    oversized_chunk.store(true, Ordering::SeqCst);
                    abort.abort();
                }
            },
            || {},
        );
        let bytes = match Abortable::new(download, registration).await {
            Ok(Ok(bytes)) if !oversized.load(Ordering::SeqCst) => bytes,
            _ => {
                if oversized.load(Ordering::SeqCst) {
                    self.error("파일 크기가 안내된 범위를 넘어 다운로드를 중단했습니다. 설치하지 않았습니다.");
                    return Ok(self.status());
                }
                self.error("다운로드 또는 서명 검증에 실패했습니다. 기존 앱은 그대로 유지됩니다.");
                return Ok(self.status());
            }
        };
        // Tauri verifies both the payload signature and the signed app version.
        if bytes.len() as u64 != expected_bytes || format!("{:x}", Sha256::digest(&bytes)) != sha256
        {
            self.error("다운로드한 파일의 크기 또는 SHA-256이 다릅니다. 설치하지 않았습니다.");
            return Ok(self.status());
        }
        // Recheck under the backend's admission locks before any installer runs.
        if backend.prepare_update_shutdown().is_err() {
            self.error("제작 작업이 진행 중입니다. 작업이 끝난 후 업데이트해 주세요.");
            return Ok(self.status());
        }
        {
            let mut state = self.status.lock().unwrap();
            state.state = "installing";
            state.message = "업데이트를 설치한 뒤 앱을 다시 실행합니다.".into();
        }
        let _ = app; // The platform updater owns restart after the installer.
        if update.install(&bytes).is_err() {
            self.error("설치를 시작하지 못했습니다. 프로젝트는 보존되어 있습니다. 앱을 다시 실행해 주세요.");
        }
        Ok(self.status())
    }
}

fn validate_update(update: &Update, current_version: &str) -> Result<(u64, String)> {
    validate_metadata(
        &update.version,
        current_version,
        update.download_url.as_str(),
        &update.raw_json["platforms"]["windows-x86_64"],
    )
}

pub fn validate_metadata(
    version: &str,
    current: &str,
    url: &str,
    metadata: &serde_json::Value,
) -> Result<(u64, String)> {
    let next = semver::Version::parse(version)?;
    let current = semver::Version::parse(current)?;
    ensure!(
        next.pre.is_empty() && next.build.is_empty() && next.cmp_precedence(&current).is_gt(),
        "유효한 신규 정식 버전이 아닙니다."
    );
    let expected_url =
        format!("{RELEASE_ROOT}/download/v{version}/AssetStudio_{version}_x64-setup.exe");
    ensure!(url == expected_url, "공식 릴리스의 설치 파일만 허용합니다.");
    let bytes = metadata["bytes"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("파일 크기가 없습니다."))?;
    ensure!(
        (1024..=MAX_INSTALLER_BYTES).contains(&bytes),
        "설치 파일 크기가 허용 범위를 벗어납니다."
    );
    let hash = metadata["sha256"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("SHA-256이 없습니다."))?;
    ensure!(
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "SHA-256이 올바르지 않습니다."
    );
    if metadata["signature"]
        .as_str()
        .is_none_or(|value| value.is_empty() || value.len() > 8192)
    {
        bail!("업데이트 서명이 없습니다.");
    }
    Ok((bytes, hash.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn metadata() -> serde_json::Value {
        serde_json::json!({"bytes":8000000,"sha256":"a".repeat(64),"signature":"fixture"})
    }
    #[test]
    fn signed_channel_rejects_downgrades_prereleases_and_other_origins() {
        let url = format!("{RELEASE_ROOT}/download/v0.1.2/AssetStudio_0.1.2_x64-setup.exe");
        assert!(validate_metadata("0.1.2", "0.1.1", &url, &metadata()).is_ok());
        for version in ["0.1.1", "0.1.0", "0.1.2-alpha.1", "0.1.2+other"] {
            assert!(validate_metadata(version, "0.1.1", &url, &metadata()).is_err());
        }
        for other in [
            url.replace("oocheol", "other"),
            format!("{url}?payload=other"),
            url.replace("https:", "http:"),
            url.replace("github.com", "github.com.evil.example"),
        ] {
            assert!(validate_metadata("0.1.2", "0.1.1", &other, &metadata()).is_err());
        }
    }
    #[test]
    fn update_requires_bounded_size_digest_and_signature() {
        let url = format!("{RELEASE_ROOT}/download/v0.1.2/AssetStudio_0.1.2_x64-setup.exe");
        for bad in [
            serde_json::json!({}),
            serde_json::json!({"bytes":MAX_INSTALLER_BYTES+1,"sha256":"a".repeat(64),"signature":"fixture"}),
            serde_json::json!({"bytes":8000000,"sha256":"not-a-digest","signature":"fixture"}),
            serde_json::json!({"bytes":8000000,"sha256":"a".repeat(64),"signature":""}),
        ] {
            assert!(validate_metadata("0.1.2", "0.1.1", &url, &bad).is_err());
        }
    }
}
