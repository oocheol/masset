//! Provider boundaries. No cookies, credential files, private HTTP endpoints, or API fallback.
//!
//! The user selected the documented native GPT Image 2 route. Runtime support
//! and actual model evidence remain separate; no paid or alternate fallback.

pub mod runtime;

pub use asset_core::models::{CancellationMode, ProviderCapability, ProviderStatus};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};
use thiserror::Error;

pub const REQUESTED_IMAGE_MODEL: &str = "gpt-image-2";
pub const VERIFIED_AT: &str = "2026-10-02";
const CLI_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceState {
    Verified,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeatureCapability {
    pub state: EvidenceState,
    pub evidence: String,
}

impl FeatureCapability {
    fn unknown(evidence: &str) -> Self {
        Self {
            state: EvidenceState::Unknown,
            evidence: evidence.into(),
        }
    }
    fn unsupported(evidence: &str) -> Self {
        Self {
            state: EvidenceState::Unsupported,
            evidence: evidence.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticStatus {
    Ready,
    AvailableUnverified,
    UnverifiedBlocked,
    Unsupported,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderDiagnostics {
    pub provider_id: String,
    pub display_name: String,
    pub status: DiagnosticStatus,
    pub authentication: String,
    pub requested_models: Vec<String>,
    pub verified_models: Vec<String>,
    pub generation: FeatureCapability,
    /// Empty is unknown, not an arbitrary list of common image sizes.
    pub supported_resolutions: Vec<[u32; 2]>,
    pub resolution: FeatureCapability,
    pub transparent_background: FeatureCapability,
    pub editing: FeatureCapability,
    pub masks: FeatureCapability,
    pub reference_image_limit: Option<u32>,
    pub reference_images: FeatureCapability,
    pub cancellation: FeatureCapability,
    pub max_concurrency: Option<u32>,
    /// A local scheduling policy is separate from the provider's unknown limit.
    pub local_concurrency_policy: u32,
    pub seed: FeatureCapability,
    pub actual_model_confirmation: FeatureCapability,
    pub checked_at: String,
    pub reason: String,
    pub evidence_urls: Vec<String>,
}

pub fn diagnostics() -> Vec<ProviderDiagnostics> {
    let unknown = || {
        FeatureCapability::unknown("Not yet verified by a live image round trip in this app's GPT Image 2 subscription route.")
    };
    let mut codex = ProviderDiagnostics {
        provider_id: "codex_subscription".into(),
        display_name: "Codex ChatGPT subscription · GPT Image 2".into(),
        status: DiagnosticStatus::AvailableUnverified,
        authentication: "official_codex_managed_chatgpt".into(),
        requested_models: vec![REQUESTED_IMAGE_MODEL.into()],
        verified_models: Vec::new(),
        generation: unknown(),
        supported_resolutions: Vec::new(),
        resolution: unknown(),
        transparent_background: unknown(),
        editing: unknown(),
        masks: unknown(),
        reference_image_limit: None,
        reference_images: unknown(),
        cancellation: unknown(),
        max_concurrency: None,
        local_concurrency_policy: 1,
        seed: FeatureCapability::unsupported("No verified native seed control; do not invent one."),
        actual_model_confirmation: unknown(),
        checked_at: VERIFIED_AT.into(),
        reason: "Official Codex docs identify built-in gpt-image-2 and subscription limits. The app-server adapter verifies managed ChatGPT auth and image-only controls before each job. A live image round trip has not yet been performed, and public image events omit the actual model ID.".into(),
        evidence_urls: vec![
            "https://learn.chatgpt.com/docs/image-generation".into(),
            "https://developers.openai.com/codex/app-server".into(),
            "https://developers.openai.com/codex/auth".into(),
        ],
    };
    // `turn/interrupt` is verified for agent turns, not a completed image job.
    codex.cancellation.evidence =
        "Public turn/interrupt exists; image-job cancellation was not exercised.".into();
    let mut siwc = codex.clone();
    siwc.provider_id = "sign_in_with_chatgpt".into();
    siwc.display_name = "External Sign in with ChatGPT".into();
    siwc.status = DiagnosticStatus::Unsupported;
    siwc.authentication = "external_oauth_not_configured".into();
    siwc.generation = FeatureCapability::unsupported(
        "Official preview limitations explicitly exclude image-generation tools.",
    );
    siwc.reason = "External app ChatGPT plan usage explicitly does not support image-generation tools; Codex native authentication is a separate route.".into();
    siwc.evidence_urls = vec![
        "https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations".into(),
    ];
    let mut api = codex.clone();
    api.provider_id = "openai_paid_api_optional".into();
    api.display_name = "Optional OpenAI API (disabled)".into();
    api.status = DiagnosticStatus::Disabled;
    api.authentication = "separate_api_account_explicit_consent_required".into();
    api.generation = FeatureCapability::unknown(
        "Official API supports GPT Image 2.5; this optional provider is not connected or called.",
    );
    api.reason = "Separate API billing is optional. No SDK, API key, or automatic paid fallback is used by this MVP.".into();
    api.evidence_urls =
        vec!["https://developers.openai.com/api/docs/guides/image-generation".into()];
    vec![codex, siwc, api]
}

/// Product contract: false means unavailable in this app. Detailed proof above
/// distinguishes a documented exclusion from a feature not yet verified.
pub fn capabilities() -> Vec<ProviderCapability> {
    diagnostics().into_iter().map(|proof| ProviderCapability {
        name: match proof.provider_id.as_str() {
            "codex_subscription" => "Codex 구독 · GPT Image 2".into(),
            "sign_in_with_chatgpt" => "외부 Sign in with ChatGPT · 이미지 생성 미지원".into(),
            _ => "별도 OpenAI API · 선택적 공급자 비활성화".into(),
        },
        reason: match proof.provider_id.as_str() {
            "codex_subscription" => "공식 Codex 런타임으로 GPT Image 2를 요청합니다. 구독 로그인·도구 제한을 확인한 뒤 생성하며 실제 모델 ID는 이벤트에 없으면 미확인으로 기록합니다. 실제 파일 생성·프로젝트 전체 실증은 아직 수행하지 않았습니다.".into(),
            "sign_in_with_chatgpt" => "외부 앱의 ChatGPT 구독 사용 경로는 공식 문서상 이미지 생성 도구를 지원하지 않습니다.".into(),
            _ => "별도 API 결제는 필수가 아닙니다. 이 공급자는 구현·연결되지 않았으며 API 키와 유료 호출을 사용하지 않습니다.".into(),
        },
        id: proof.provider_id.clone(),
        status: if proof.provider_id == "codex_subscription" { ProviderStatus::Unverified } else { ProviderStatus::Blocked },
        authentication: proof.authentication,
        requested_models: proof.requested_models,
        confirmed_model: None,
        // Root promotes this only after a real file decode/save/reopen proof.
        generation: false,
        editing: false,
        transparency: false,
        masks: false,
        reference_image_limit: proof.reference_image_limit,
        cancellation: CancellationMode::Unknown,
        concurrency: proof.max_concurrency,
        resolutions: Vec::new(),
        checked_at: proof.checked_at,
    }).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthStatus {
    Chatgpt,
    ApiKey,
    NotLoggedIn,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProbeStatus {
    pub executable: PathBuf,
    pub version: Option<String>,
    pub authentication: AuthStatus,
    pub generation_status: ProviderStatus,
    pub requested_image_model: String,
    pub confirmed_image_model: Option<String>,
    pub generation_attempted: bool,
    pub image_files_received: u32,
    pub failed_stage: String,
    pub reason: String,
}

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("Official Codex executable was not found at the configured absolute path")]
    RuntimeUnavailable,
    #[error("Official Codex status command could not be completed")]
    ProbeFailed,
    #[error("Official Codex status command exceeded its time limit")]
    ProbeTimeout,
    #[error("ChatGPT authentication is required; use the official Codex login flow")]
    ChatgptAuthenticationRequired,
    #[error("Requested image-model selection is unverified in the native Codex route")]
    ModelSelectionUnverified,
    #[error("The requested native image model must be gpt-image-2")]
    UnsupportedRequestedModel,
    #[error("The actual image model is unconfirmed; keep requested and confirmed model separate")]
    ActualModelUnconfirmed,
    #[error("The returned image model does not match the requested image model")]
    ModelMismatch,
    #[error("External Sign in with ChatGPT does not support image-generation tools")]
    SubscriptionImageGenerationUnsupported,
    #[error(
        "The optional paid API provider is disabled; no automatic billing fallback is permitted"
    )]
    PaidApiDisabled,
    #[error("Image artifact does not exist as a local file")]
    ImageFileMissing,
    #[error(transparent)]
    Runtime(#[from] runtime::RuntimeError),
}

impl ProviderError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::RuntimeUnavailable => "provider.runtime_unavailable",
            Self::ProbeFailed => "provider.probe_failed",
            Self::ProbeTimeout => "provider.probe_timeout",
            Self::ChatgptAuthenticationRequired => "provider.chatgpt_authentication_required",
            Self::ModelSelectionUnverified => "provider.image_model_selection_unverified",
            Self::UnsupportedRequestedModel => "provider.unsupported_requested_model",
            Self::ActualModelUnconfirmed => "provider.actual_image_model_unconfirmed",
            Self::ModelMismatch => "provider.image_model_mismatch",
            Self::SubscriptionImageGenerationUnsupported => {
                "provider.subscription_image_generation_unsupported"
            }
            Self::PaidApiDisabled => "provider.paid_api_disabled",
            Self::ImageFileMissing => "provider.image_file_missing",
            Self::Runtime(error) => error.code(),
        }
    }
}

/// Calls only public CLI diagnostics. Authentication remains owned by Codex.
/// Raw output is discarded, and no authentication file is inspected.
pub fn probe_codex(executable: &Path) -> Result<ProbeStatus, ProviderError> {
    if !executable.is_absolute() || !executable.is_file() {
        return Err(ProviderError::RuntimeUnavailable);
    }
    let version_output = run_status(executable, &["--version"])?;
    let version = safe_codex_version(&version_output.stdout);
    if !version_output.status.success() || version.is_none() {
        return Err(ProviderError::ProbeFailed);
    }
    let auth_output = run_status(executable, &["login", "status"])?;
    let auth = parse_auth_status(&auth_output);
    Ok(ProbeStatus {
        executable: executable.into(),
        version,
        authentication: auth,
        generation_status: if auth == AuthStatus::Chatgpt {
            ProviderStatus::Unverified
        } else {
            ProviderStatus::Blocked
        },
        requested_image_model: REQUESTED_IMAGE_MODEL.into(),
        confirmed_image_model: None,
        generation_attempted: false,
        image_files_received: 0,
        failed_stage: "generation_not_attempted".into(),
        reason: if auth == AuthStatus::Chatgpt {
            "ChatGPT CLI authentication confirmed. Native GPT Image 2 is documented; this read-only probe does not submit generation or prove decode, project save, reopen, or the actual image model.".into()
        } else {
            "Official runtime does not confirm ChatGPT subscription authentication; no image generation was attempted.".into()
        },
    })
}

/// Extracts only bounded ASCII Codex CLI SemVer metadata from version output.
/// This function neither logs nor retains raw output or credentials. Callers
/// should persist only the returned version and discard unrecognized output.
pub fn safe_codex_version(output: &[u8]) -> Option<String> {
    let raw = std::str::from_utf8(output).ok()?.trim();
    let version = raw.strip_prefix("codex-cli ")?;
    // Accept official alpha/beta/rc versions while retaining a bounded, single
    // ASCII SemVer value. Unrecognized text, extra lines and addresses cannot
    // become persisted runtime-version metadata.
    if version.len() > 64 || !version.is_ascii() {
        return None;
    }
    let (without_build, build) = match version.split_once('+') {
        Some((base, build)) => (base, Some(build)),
        None => (version, None),
    };
    if build.is_some_and(|value| !valid_semver_identifiers(value, false)) {
        return None;
    }
    let (core, prerelease) = match without_build.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (without_build, None),
    };
    let mut core_parts = core.split('.');
    for _ in 0..3 {
        let part = core_parts.next()?;
        if part.is_empty()
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|byte| byte.is_ascii_digit())
            || part.parse::<u64>().is_err()
        {
            return None;
        }
    }
    if core_parts.next().is_some()
        || prerelease.is_some_and(|value| !valid_semver_identifiers(value, true))
    {
        return None;
    }
    Some(format!("codex-cli {version}"))
}

fn valid_semver_identifiers(value: &str, reject_numeric_leading_zero: bool) -> bool {
    value.split('.').all(|part| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && !(reject_numeric_leading_zero
                && part.len() > 1
                && part.starts_with('0')
                && part.bytes().all(|byte| byte.is_ascii_digit()))
    })
}

fn parse_auth_status(output: &Output) -> AuthStatus {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stdout.lines().chain(stderr.lines()) {
        let line = line.trim();
        if output.status.success() && line == "Logged in using ChatGPT" {
            return AuthStatus::Chatgpt;
        }
        if line.starts_with("Logged in using an API key")
            || line.starts_with("Logged in using API key")
        {
            return AuthStatus::ApiKey;
        }
        if line == "Not logged in" {
            return AuthStatus::NotLoggedIn;
        }
    }
    AuthStatus::Unknown
}

fn run_status(executable: &Path, args: &[&str]) -> Result<Output, ProviderError> {
    let mut cmd = Command::new(executable);
    cmd.args(args)
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|_| ProviderError::ProbeFailed)?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|_| ProviderError::ProbeFailed)
            }
            Ok(None) if start.elapsed() < CLI_TIMEOUT => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ProviderError::ProbeTimeout);
            }
            Err(_) => return Err(ProviderError::ProbeFailed),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageGenerationRequest {
    pub prompt: String,
    pub requested_model: String,
    pub reference_paths: Vec<PathBuf>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub transparent_background: Option<bool>,
    pub mask_path: Option<PathBuf>,
    pub requires_confirmed_model: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageProvenance {
    CodexSubscription,
    OptionalPaidApi,
    ExternalImport,
    TestFixture,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageGenerationReceipt {
    pub requested_model: String,
    pub confirmed_model: Option<String>,
    pub provenance: ImageProvenance,
    pub image_path: PathBuf,
    pub provider_job_id: Option<String>,
}

/// The receiving pipeline must still decode the file, inspect dimensions, and
/// save/reopen it. This gate alone is never a completed generation proof.
pub fn validate_receipt(
    request: &ImageGenerationRequest,
    receipt: &ImageGenerationReceipt,
) -> Result<(), ProviderError> {
    if receipt.requested_model != request.requested_model {
        return Err(ProviderError::ModelMismatch);
    }
    match receipt.confirmed_model.as_deref() {
        Some(model) if model != request.requested_model => {
            return Err(ProviderError::ModelMismatch)
        }
        None if request.requires_confirmed_model => {
            return Err(ProviderError::ActualModelUnconfirmed)
        }
        _ => {}
    }
    if !receipt.image_path.is_file() {
        return Err(ProviderError::ImageFileMissing);
    }
    Ok(())
}

pub trait ImageGenerationProvider {
    fn provider_id(&self) -> &'static str;
    fn generate(
        &self,
        request: &ImageGenerationRequest,
    ) -> Result<ImageGenerationReceipt, ProviderError>;
}

#[derive(Debug, Clone)]
pub struct CodexSubscriptionProvider {
    pub executable: PathBuf,
    pub output_root: PathBuf,
    pub reasoning_model: Option<String>,
}

impl CodexSubscriptionProvider {
    pub fn new(executable: impl Into<PathBuf>, output_root: impl Into<PathBuf>) -> Self {
        Self {
            executable: executable.into(),
            output_root: output_root.into(),
            reasoning_model: None,
        }
    }
}

impl ImageGenerationProvider for CodexSubscriptionProvider {
    fn provider_id(&self) -> &'static str {
        "codex_subscription"
    }
    fn generate(
        &self,
        request: &ImageGenerationRequest,
    ) -> Result<ImageGenerationReceipt, ProviderError> {
        if request.requested_model != REQUESTED_IMAGE_MODEL {
            return Err(ProviderError::UnsupportedRequestedModel);
        }
        runtime::validate_native_request(request)?;
        let mut options = runtime::RuntimeOptions::new(&self.executable, &self.output_root);
        options.reasoning_model = self.reasoning_model.clone();
        let mut actor = runtime::CodexRuntime::connect(options)?;
        let outcome =
            actor.generate(request, &std::sync::atomic::AtomicBool::new(false), |_| {})?;
        let receipt = outcome
            .receipts
            .into_iter()
            .next()
            .ok_or(ProviderError::ImageFileMissing)?;
        validate_receipt(request, &receipt)?;
        Ok(receipt)
    }
}

#[derive(Debug, Default)]
pub struct OptionalPaidApiProvider;

impl ImageGenerationProvider for OptionalPaidApiProvider {
    fn provider_id(&self) -> &'static str {
        "openai_paid_api_optional"
    }
    fn generate(
        &self,
        _request: &ImageGenerationRequest,
    ) -> Result<ImageGenerationReceipt, ProviderError> {
        Err(ProviderError::PaidApiDisabled)
    }
}

/// Explicit CI-only fixture. It is absent from the production provider list and
/// records TestFixture provenance, so a mock cannot pass as a subscription run.
#[cfg(any(test, feature = "test-provider"))]
pub mod test_provider {
    use super::*;
    pub struct FixtureProvider {
        pub image_path: PathBuf,
    }
    impl ImageGenerationProvider for FixtureProvider {
        fn provider_id(&self) -> &'static str {
            "ci_test_fixture"
        }
        fn generate(
            &self,
            request: &ImageGenerationRequest,
        ) -> Result<ImageGenerationReceipt, ProviderError> {
            let receipt = ImageGenerationReceipt {
                requested_model: request.requested_model.clone(),
                confirmed_model: Some("test-fixture".into()),
                provenance: ImageProvenance::TestFixture,
                image_path: self.image_path.clone(),
                provider_job_id: None,
            };
            validate_receipt(request, &receipt)?;
            Ok(receipt)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> ImageGenerationRequest {
        ImageGenerationRequest {
            prompt: "A small blue asset".into(),
            requested_model: REQUESTED_IMAGE_MODEL.into(),
            reference_paths: vec![],
            width: None,
            height: None,
            transparent_background: None,
            mask_path: None,
            requires_confirmed_model: true,
        }
    }

    #[test]
    fn subscription_never_substitutes_or_enables_paid_api() {
        let provider = CodexSubscriptionProvider::new("missing-codex", "missing-output");
        assert!(matches!(
            provider.generate(&request()),
            Err(ProviderError::Runtime(
                runtime::RuntimeError::ActualModelUnconfirmed
            ))
        ));
        assert!(matches!(
            OptionalPaidApiProvider.generate(&request()),
            Err(ProviderError::PaidApiDisabled)
        ));
        let mut old_model = request();
        old_model.requested_model = "gpt-image-2.5-sunburst".into();
        assert!(matches!(
            provider.generate(&old_model),
            Err(ProviderError::UnsupportedRequestedModel)
        ));
    }

    #[test]
    fn requested_model_is_not_actual_model_evidence() {
        let mut receipt = ImageGenerationReceipt {
            requested_model: REQUESTED_IMAGE_MODEL.into(),
            confirmed_model: None,
            provenance: ImageProvenance::CodexSubscription,
            image_path: PathBuf::from("not-created.png"),
            provider_job_id: None,
        };
        assert!(matches!(
            validate_receipt(&request(), &receipt),
            Err(ProviderError::ActualModelUnconfirmed)
        ));
        receipt.confirmed_model = Some("gpt-image-2.5-sunburst".into());
        assert!(matches!(
            validate_receipt(&request(), &receipt),
            Err(ProviderError::ModelMismatch)
        ));
        receipt.confirmed_model = Some(REQUESTED_IMAGE_MODEL.into());
        assert!(matches!(
            validate_receipt(&request(), &receipt),
            Err(ProviderError::ImageFileMissing)
        ));
    }

    #[test]
    fn fixture_cannot_prove_a_subscription_model() {
        let fixture = test_provider::FixtureProvider {
            image_path: PathBuf::from("not-created.png"),
        };
        assert!(matches!(
            fixture.generate(&request()),
            Err(ProviderError::ModelMismatch)
        ));
        assert!(!capabilities().iter().any(|cap| cap.id == "ci_test_fixture"));
    }

    #[test]
    fn version_parser_keeps_only_version_and_drops_unrecognized_output() {
        assert_eq!(
            safe_codex_version(b"codex-cli 0.147.0\n"),
            Some("codex-cli 0.147.0".into())
        );
        assert_eq!(
            safe_codex_version(b"codex-cli 0.147.0\naccount=private"),
            None
        );
        assert_eq!(safe_codex_version(b"codex-cli private-token"), None);
        assert_eq!(safe_codex_version(b"secret token"), None);
    }

    #[test]
    fn version_parser_accepts_bounded_semver_prerelease_and_build_metadata() {
        for version in [
            "0.159.0-alpha.12.1",
            "0.159.0-beta.2",
            "0.159.0-rc.1+build.001",
            "0.0.0",
        ] {
            let output = format!("codex-cli {version}\r\n");
            assert_eq!(
                safe_codex_version(output.as_bytes()),
                Some(format!("codex-cli {version}"))
            );
        }
        let bounded_version = format!("0.1.0-{}", "a".repeat(58));
        assert_eq!(bounded_version.len(), 64);
        assert_eq!(
            safe_codex_version(format!("codex-cli {bounded_version}").as_bytes()),
            Some(format!("codex-cli {bounded_version}"))
        );
    }

    #[test]
    fn version_parser_rejects_malformed_semver_and_unbounded_output() {
        for version in [
            "0.159",
            "0.159.0.1",
            "00.159.0",
            "0.0159.0",
            "0.159.00",
            "0.159.0-",
            "0.159.0-alpha..12",
            "0.159.0-alpha.01",
            "0.159.0-alpha_12",
            "0.159.0+",
            "0.159.0+build..1",
            "0.159.0+build+extra",
            "0.159.0-alpha/12",
            "0.159.0-alpha:12",
            "0.159.0-alpha\n12",
            "0.159.0-alpha 12",
            "0.159.0-한글",
            "18446744073709551616.1.0",
        ] {
            let output = format!("codex-cli {version}");
            assert_eq!(safe_codex_version(output.as_bytes()), None);
        }
        let unbounded_version = format!("0.1.0-{}", "a".repeat(59));
        assert_eq!(unbounded_version.len(), 65);
        assert_eq!(
            safe_codex_version(format!("codex-cli {unbounded_version}").as_bytes()),
            None
        );
        assert_eq!(safe_codex_version(b"codex-cli 0.159.0-\xff"), None);
    }

    #[test]
    fn auth_parser_does_not_confuse_api_login_with_subscription_auth() {
        fn status(success: bool) -> std::process::ExitStatus {
            #[cfg(windows)]
            {
                use std::os::windows::process::ExitStatusExt;
                std::process::ExitStatus::from_raw(if success { 0 } else { 1 })
            }
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                std::process::ExitStatus::from_raw(if success { 0 } else { 256 })
            }
        }
        let mut output = Output {
            status: status(true),
            stdout: Vec::new(),
            stderr: b"Logged in using ChatGPT\n".to_vec(),
        };
        assert_eq!(parse_auth_status(&output), AuthStatus::Chatgpt);
        output.stderr = b"Logged in using an API key - redacted-example\n".to_vec();
        assert_eq!(parse_auth_status(&output), AuthStatus::ApiKey);
        output.stderr = b"Login succeeded; account example@example.test\n".to_vec();
        assert_eq!(parse_auth_status(&output), AuthStatus::Unknown);
        output.stderr = b"Not logged in\n".to_vec();
        assert_eq!(parse_auth_status(&output), AuthStatus::NotLoggedIn);
        output.stderr = b"Logged in using ChatGPT\n".to_vec();
        output.status = status(false);
        assert_eq!(parse_auth_status(&output), AuthStatus::Unknown);
    }

    #[test]
    fn capabilities_keep_unknown_limits_and_explicit_blocks() {
        let product = capabilities();
        assert_eq!(product[0].status, ProviderStatus::Unverified);
        assert!(!product[0].generation);
        assert!(product[1..]
            .iter()
            .all(|cap| cap.status == ProviderStatus::Blocked && !cap.generation));
        let caps = diagnostics();
        assert!(caps.iter().all(|cap| cap.status != DiagnosticStatus::Ready));
        assert_eq!(caps[0].max_concurrency, None);
        assert_eq!(caps[0].reference_image_limit, None);
        assert_eq!(caps[0].generation.state, EvidenceState::Unknown);
        assert_eq!(caps[1].generation.state, EvidenceState::Unsupported);
        assert_eq!(caps[2].status, DiagnosticStatus::Disabled);
        let roundtrip: Vec<ProviderDiagnostics> =
            serde_json::from_str(&serde_json::to_string(&caps).unwrap()).unwrap();
        assert_eq!(caps, roundtrip);
    }
}
