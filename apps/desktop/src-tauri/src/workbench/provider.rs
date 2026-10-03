use super::*;
use asset_providers::runtime::{
    CodexRuntime, ProviderEvent, RuntimeError, RuntimeOptions, RuntimeStatus,
    DEFAULT_REASONING_MODEL,
};
use asset_providers::{AuthStatus, ImageGenerationRequest, ImageProvenance, REQUESTED_IMAGE_MODEL};

pub(super) fn unavailable_connection(reason: &str) -> Value {
    json!({"available":false,"authenticated":false,"ready":false,"runtimeVersion":null,
        "reasoningModel":DEFAULT_REASONING_MODEL,"catalogSource":"unknown","inferenceAccess":"unknown",
        "requestedModel":"gpt-image-2","confirmedModel":null,"reason":reason,"usage":[],"checkedAt":now()})
}

fn connection(status: &RuntimeStatus) -> Value {
    let authenticated = status.authentication == AuthStatus::Chatgpt;
    let ready = authenticated
        && status.controls_verified
        && status.official_provider_verified
        && status.native_image_generation;
    json!({"available":true,"authenticated":authenticated,"ready":ready,"runtimeVersion":status.version,
        "reasoningModel":status.reasoning_model,"catalogSource":"application_pinned_catalog","inferenceAccess":"unknown",
        "requestedModel":status.requested_image_model,"confirmedModel":status.confirmed_image_model,
        "reason":if ready {format!("공식 Codex 구독 인증과 이미지 도구를 확인했습니다. 추론 모델은 {}이며 이미지 목표는 GPT Image 2입니다. 앱 고정 목록의 모델 이름은 계정 이용 권한을 증명하지 않으며, 실제 이미지 수신은 아직 확인되지 않았습니다.",status.reasoning_model.as_deref().unwrap_or("확인 필요"))}
        else if !authenticated {"공식 Codex에서 ChatGPT 계정으로 로그인해 주세요.".to_owned()}
        else {"공식 이미지 도구와 실행 제한을 확인하지 못해 생성을 차단했습니다.".to_owned()},
        "usage":status.rate_limits,"checkedAt":now()})
}

fn executable() -> Option<PathBuf> {
    // An explicit runtime selection is preserved; it cannot silently fall back.
    if let Some(path) = std::env::var_os("CODEX_EXECUTABLE") {
        let path = PathBuf::from(path);
        return (path.is_absolute() && path.is_file() && official_runtime_file(&path))
            .then_some(path);
    }
    let mut candidates = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        candidates.push(local.join("Programs/OpenAI/Codex/bin/codex.exe"));
        if let Ok(entries) = fs::read_dir(local.join("OpenAI/Codex/bin")) {
            let mut versioned: Vec<_> = entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path().join("codex.exe"))
                .filter(|path| path.is_file())
                .collect();
            versioned.sort();
            candidates.extend(versioned.into_iter().take(32));
        }
    }
    #[cfg(target_os = "macos")]
    candidates.push(PathBuf::from(
        "/Applications/Codex.app/Contents/Resources/codex",
    ));
    candidates
        .into_iter()
        .filter(|path| path.is_absolute() && path.is_file() && official_runtime_file(path))
        .filter_map(|path| {
            let version = asset_providers::probe_codex(&path).ok()?.version?;
            Some((runtime_version_rank(&version)?, path))
        })
        .max_by(|left, right| {
            left.0
                .cmp_precedence(&right.0)
                .then_with(|| left.1.cmp(&right.1))
        })
        .map(|(_, path)| path)
}

fn runtime_version_rank(value: &str) -> Option<semver::Version> {
    let safe = asset_providers::safe_codex_version(value.as_bytes())?;
    let version = safe.strip_prefix("codex-cli ")?;
    semver::Version::parse(version).ok()
}

#[cfg(windows)]
fn official_runtime_file(path: &Path) -> bool {
    use base64::Engine as _;
    use std::io::Read;
    let Some(system_root) = std::env::var_os("SystemRoot") else {
        return false;
    };
    let windows_power_shell = PathBuf::from(system_root).join("System32/WindowsPowerShell/v1.0");
    // The path is passed through a dedicated environment variable, never
    // interpolated into PowerShell code. Only a fixed success marker is read.
    let script = "$ErrorActionPreference='Stop'; $assetSignature=Get-AuthenticodeSignature -LiteralPath $env:ASSET_CODEX_SIGNATURE_PATH; if ($assetSignature.Status -eq 'Valid' -and $assetSignature.SignerCertificate.Subject.Contains('O=\"OpenAI OpCo, LLC\"')) { [Console]::Write('verified') }";
    // PowerShell's -Command parsing does not preserve CRT-escaped embedded
    // double quotes. Encode this constant script as UTF-16LE instead.
    let script_bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded_script = base64::engine::general_purpose::STANDARD.encode(script_bytes);
    let mut child = match Command::new(windows_power_shell.join("powershell.exe"))
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &encoded_script,
        ])
        .env("ASSET_CODEX_SIGNATURE_PATH", path)
        // A parent PowerShell 7 module path cannot load its .NET modules in 5.1.
        // Resolve this security cmdlet only from the OS's own module directory.
        .env("PSModulePath", windows_power_shell.join("Modules"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return false,
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut bytes = Vec::new();
                let read = child
                    .stdout
                    .take()
                    .is_some_and(|out| out.take(4096).read_to_end(&mut bytes).is_ok());
                return status.success() && read && bytes == b"verified";
            }
            Ok(None) if started.elapsed() < Duration::from_secs(15) => {
                thread::sleep(Duration::from_millis(25))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

#[cfg(not(windows))]
fn official_runtime_file(_: &Path) -> bool {
    true
}

impl Backend {
    pub(super) fn provider_status(&self) -> Result<Value> {
        let result = (|| -> Result<Value> {
            let path = executable().context("공식 Codex 실행 파일을 찾을 수 없습니다. Codex 설치 또는 CODEX_EXECUTABLE 설정을 확인해 주세요.")?;
            let mut runtime = self.inner.provider_runtime.lock().unwrap();
            if runtime.is_none() {
                *runtime = Some(CodexRuntime::connect(RuntimeOptions::new(
                    path,
                    self.inner.data.join("provider-session"),
                ))?);
            }
            let status = runtime.as_mut().unwrap().refresh_status()?;
            Ok(connection(&status))
        })();
        let value = match result {
            Ok(value) => value,
            Err(error) => {
                self.inner.provider_runtime.lock().unwrap().take();
                unavailable_connection(&error.to_string())
            }
        };
        *self.inner.provider_connection.lock().unwrap() = value.clone();
        Ok(value)
    }

    pub(super) fn provider_login(&self) -> Result<Value> {
        let status = self.provider_status()?;
        if status["authenticated"] == true {
            return Ok(status);
        }
        let mut runtime = self.inner.provider_runtime.lock().unwrap();
        let actor = runtime
            .as_mut()
            .context("공식 Codex 런타임을 먼저 연결해 주세요.")?;
        let login = actor.begin_login()?;
        if let Err(error) = open_official_login(&login.auth_url) {
            let _ = actor.cancel_login(&login.login_id);
            return Err(error);
        }
        let mut status = connection(actor.status());
        status["reason"] = json!("브라우저에서 공식 로그인을 완료한 후 연결 확인을 눌러 주세요.");
        // Neither the login URL nor its ID crosses the frontend/project boundary.
        *self.inner.provider_connection.lock().unwrap() = status.clone();
        Ok(status)
    }

    pub(super) fn provider_capabilities(&self, project: &Project) -> Vec<ProviderCapability> {
        let mut capabilities = asset_providers::capabilities();
        if let Some(codex) = capabilities
            .iter_mut()
            .find(|p| p.id == "codex_subscription")
        {
            let status = self.inner.provider_connection.lock().unwrap();
            let proven = project.assets.iter().flat_map(|a| &a.versions).any(|v| {
                v.source == AssetSource::CodexSubscription
                    && v.requested_model.as_deref() == Some("gpt-image-2")
                    && v.validation.as_ref().is_some_and(|report| report.valid)
            });
            codex.requested_models = vec!["gpt-image-2".into()];
            codex.confirmed_model = None;
            codex.generation = proven;
            codex.status = if proven {
                ProviderStatus::Verified
            } else if status["ready"] == true {
                ProviderStatus::Unverified
            } else {
                ProviderStatus::Blocked
            };
            codex.reason = if proven {
                "이 프로젝트에서 구독 이미지 파일 디코딩·저장을 검증했습니다. 실제 이미지 모델은 확인되지 않았습니다.".into()
            } else {
                status["reason"]
                    .as_str()
                    .unwrap_or("연결 확인이 필요합니다.")
                    .into()
            };
            codex.name = "Codex · ChatGPT 구독".into();
        }
        capabilities
    }

    pub(super) fn enqueue_generation(&self, request: &Value) -> Result<()> {
        let prompt = text_field(request, "prompt")?.trim();
        if prompt.is_empty() || prompt.len() > 16000 {
            bail!("이미지 설명은 1~16000바이트로 입력해 주세요.")
        }
        let count = request["count"].as_u64().unwrap_or(1);
        if !(1..=20).contains(&count) {
            bail!("이미지는 한 번에 1~20개까지 요청할 수 있습니다.")
        }
        let request_id = text_field(request, "requestId")?;
        Uuid::parse_str(request_id).context("생성 요청 식별자가 올바르지 않습니다.")?;
        let status = self.inner.provider_connection.lock().unwrap().clone();
        if status["ready"] != true {
            bail!(
                "{}",
                status["reason"]
                    .as_str()
                    .unwrap_or("구독 연결을 확인해 주세요.")
            )
        }
        let root = self.root()?;
        let project = Repository::open(&root)?.project()?;
        if !project.style_guide.approved {
            bail!("스타일 가이드를 승인한 뒤 생성해 주세요.")
        }
        let name = request["name"].as_str().unwrap_or("생성 이미지").trim();
        if name.len() > 240 {
            bail!("이미지 이름이 너무 깁니다.")
        }
        let tasks = (0..count).map(|index| job(&project,"image_generate",&format!("구독 이미지 · {}",index+1),None,JobResource::External,
            json!({"prompt":prompt,"name":if count==1{name.to_owned()}else{format!("{name} {}",index+1)},
                "variationIndex":index,"variationCount":count,"requestedModel":REQUESTED_IMAGE_MODEL,"reasoningModel":status["reasoningModel"],
                "styleGuide":project.style_guide,"spec":project.spec,"toolVersion":status["runtimeVersion"],
                "resources":{"ramMb":image_ram_mb(raster::MAX_PIXELS,16,384),"cpuThreads":1,"diskWeight":1}}))).collect::<Result<Vec<_>>>()?;
        SchedulerStore::open(&root.join("scheduler.sqlite"))?
            .enqueue_many_once(request_id, tasks)?;
        Ok(())
    }

    pub(super) fn run_generation(
        &self,
        root: &Path,
        task: &Job,
        work: &Path,
        cancel: &AtomicBool,
    ) -> Result<()> {
        let mut queue = SchedulerStore::open(&root.join("scheduler.sqlite"))?;
        let options = RuntimeOptions::new(
            executable().context("공식 Codex 런타임을 찾을 수 없습니다.")?,
            work.join("received"),
        );
        queue.set_progress(&task.id, "공식 구독 연결 확인", None, None)?;
        let mut runtime = match CodexRuntime::connect(options) {
            Ok(runtime) => runtime,
            Err(error) => {
                queue.fail(&task.id, failure_kind(&error), &failure_message(&error))?;
                return Err(error.into());
            }
        };
        let payload = serde_json::to_value(&task.payload)?;
        if payload["requestedModel"].as_str() != Some(REQUESTED_IMAGE_MODEL)
            || payload["reasoningModel"].as_str() != runtime.status().reasoning_model.as_deref()
            || payload["toolVersion"].as_str() != runtime.status().version.as_deref()
        {
            queue.fail(&task.id,FailureKind::Unsupported,"대기 중 공급자 모델 또는 런타임 버전이 바뀌었습니다. 현재 연결을 확인하고 새 요청을 만들어 주세요.")?;
            bail!("대기 작업의 공급자 설정이 현재 런타임과 다릅니다.")
        }
        let request = ImageGenerationRequest {
            prompt:format!("Create one image asset using the native image generation tool. User description: {}\nApproved style guide: {}\nRequested visual specification (report actual output dimensions): {}\nVariation {} of {}. Do not run commands or other tools. Return the generated image.",
                text_field(&payload,"prompt")?,payload["styleGuide"],payload["spec"],payload["variationIndex"].as_u64().unwrap_or(0)+1,payload["variationCount"]),
            requested_model:text_field(&payload,"requestedModel")?.into(),reference_paths:vec![],width:None,height:None,
            transparent_background:None,mask_path:None,requires_confirmed_model:false,
        };
        // Persist intent before submission: a crash during turn/start cannot
        // silently enqueue another subscription charge on restart.
        queue.mark_external_submitted(&task.id)?;
        let mut event_error = None;
        let outcome = runtime.generate(&request,cancel,|event| {
            let result = match event {
                ProviderEvent::Started{thread_id,turn_id} => queue.set_external_identity(&task.id,&thread_id,&turn_id),
                ProviderEvent::ImageGenerationStarted{..} => queue.set_progress(&task.id,"이미지 생성 중",None,None),
                ProviderEvent::FileReady{receipt} => persist_receipt(work,task,&receipt).and_then(|_|queue.set_progress(&task.id,"이미지 파일 수신 · 검증 대기",None,None)),
                ProviderEvent::Interrupted{thread_id,turn_id} => persist_event(work,"turn-interrupted",&json!({"jobId":task.id,"threadId":thread_id,"turnId":turn_id,"runtimeTurnInterrupted":true,"remoteImageCancellationConfirmed":null})).and_then(|_|queue.cancel(&task.id).map(|_|())),
                ProviderEvent::InterruptAcknowledged{..} => Ok(()),
                ProviderEvent::Failed{code,failure} => persist_event(work,"failed",&json!({"jobId":task.id,"attempt":task.attempts,"executionId":task.payload.get("executionId"),"code":code,"failure":failure,"automaticResubmission":false})),
                _ => Ok(()),
            };
            if let Err(error) = result {if !cancel.load(Ordering::SeqCst) {event_error=Some(error.to_string());cancel.store(true,Ordering::SeqCst);}}
        });
        if let Some(error) = event_error {
            let _ = queue.fail(
                &task.id,
                FailureKind::ExternalResultUnknown,
                "공급자 진행 이력을 저장하지 못했습니다.",
            );
            bail!("공급자 진행 이력 저장 실패: {error}")
        }
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                if let RuntimeError::OutcomeUnknown {
                    stage,
                    thread_id,
                    turn_id,
                } = &error
                {
                    let _ = persist_event(
                        work,
                        "unknown",
                        &json!({"jobId":task.id,"attempt":task.attempts,"stage":stage,"threadId":thread_id,"turnId":turn_id,"automaticResubmission":false}),
                    );
                }
                if !matches!(error, RuntimeError::Interrupted) {
                    let _ = queue.fail(&task.id, failure_kind(&error), &failure_message(&error));
                }
                return Err(error.into());
            }
        };
        if cancel.load(Ordering::SeqCst) {
            bail!("취소한 생성 결과는 자동으로 에셋에 반영하지 않았습니다.")
        }
        queue.set_progress(&task.id, "파일 디코딩 · 해시 · 프로젝트 저장", None, None)?;
        for (index, receipt) in outcome.receipts.iter().enumerate() {
            asset_providers::validate_receipt(&request, receipt)?;
            if receipt.provenance != ImageProvenance::CodexSubscription {
                bail!("구독 경로가 아닌 생성 결과를 거부했습니다.")
            }
            let info = raster::inspect(&receipt.image_path)?;
            let _guard = self.inner.io.lock().unwrap();
            if cancel.load(Ordering::SeqCst) {
                bail!("이미지 작업이 취소되었습니다.")
            }
            let mut repo = Repository::open(root)?;
            let format = image::ImageReader::open(&receipt.image_path)?
                .with_guessed_format()?
                .format()
                .context("수신 이미지 형식을 확인할 수 없습니다.")?;
            let extension = match format {
                image::ImageFormat::Png => "png",
                image::ImageFormat::Jpeg => "jpg",
                image::ImageFormat::WebP => "webp",
                _ => bail!("지원하지 않는 수신 이미지 형식입니다."),
            };
            let mut artifact = repo.copy_in(
                &receipt.image_path,
                "versions",
                &format!("subscription-{}-{index}.{extension}", task.id),
            )?;
            artifact.role = ArtifactRole::Output;
            let copied_info = raster::inspect(&repo.artifact_path(&artifact.path)?)?;
            if copied_info.width != info.width || copied_info.height != info.height {
                bail!("수신 파일의 검증 결과가 저장 파일과 다릅니다.")
            }
            repo.verify_artifact(&artifact)?;
            let mut report = image_report(&artifact.id, &copied_info)?;
            let requested_width = payload["spec"]["width"].as_u64().unwrap_or(0);
            let requested_height = payload["spec"]["height"].as_u64().unwrap_or(0);
            if u64::from(info.width) != requested_width
                || u64::from(info.height) != requested_height
            {
                report.checks.push(ValidationCheck{code:"requested-size".into(),status:ValidationStatus::Warn,
                    message:format!("수신 크기 {}×{}px, 프로젝트 목표 {}×{}px. 로컬 크기 조정으로 새 버전을 만들 수 있습니다.",info.width,info.height,requested_width,requested_height),measured:None});
            }
            let mut asset = new_asset(
                payload["name"].as_str().unwrap_or("생성 이미지").into(),
                AssetKind::Image,
                AssetSource::CodexSubscription,
                vec![artifact],
                Some((info.width, info.height)),
                None,
                Some(report),
                BTreeMap::from([
                    ("styleGuide".into(), payload["styleGuide"].clone()),
                    ("spec".into(), payload["spec"].clone()),
                    ("providerThreadId".into(), json!(outcome.thread_id)),
                    ("providerTurnId".into(), json!(outcome.turn_id)),
                    (
                        "plannerModel".into(),
                        json!(runtime.status().reasoning_model),
                    ),
                    (
                        "plannerCatalogCommit".into(),
                        json!(runtime.status().reasoning_catalog_commit),
                    ),
                    ("submittedPrompt".into(), json!(request.prompt)),
                    ("transport".into(), json!("official_codex_app_server")),
                    (
                        "modelEvidence".into(),
                        json!(
                            "requested only; actual image model absent from public runtime event"
                        ),
                    ),
                ]),
            );
            asset.versions[0].requested_model = Some(receipt.requested_model.clone());
            asset.versions[0].confirmed_model = receipt.confirmed_model.clone();
            asset.versions[0].provider_version = runtime.status().version.clone();
            record_generated(&mut repo, asset, task)?;
        }
        Ok(())
    }
}

fn persist_event(work: &Path, label: &str, value: &Value) -> Result<()> {
    use std::io::Write;
    let path = work.join(format!("provider-{label}-{}.json", Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.sync_all()?;
    Ok(())
}

fn persist_receipt(
    work: &Path,
    task: &Job,
    receipt: &asset_providers::ImageGenerationReceipt,
) -> Result<()> {
    let canonical = receipt.image_path.canonicalize()?;
    let owned = work.canonicalize()?;
    let relative = canonical
        .strip_prefix(&owned)
        .context("공급자 파일이 이 작업의 수신 폴더 밖에 있습니다.")?;
    let (sha256, bytes) = asset_core::sha256_file(&canonical)?;
    persist_event(
        work,
        "receipt",
        &json!({"jobId":task.id,"attempt":task.attempts,"executionId":task.payload.get("executionId"),"relativePath":relative,
        "sha256":sha256,"bytes":bytes,"requestedModel":receipt.requested_model,"confirmedModel":receipt.confirmed_model,
        "provenance":receipt.provenance,"providerJobId":receipt.provider_job_id,"receivedAt":now()}),
    )
}

fn failure_kind(error: &RuntimeError) -> FailureKind {
    match error {
        RuntimeError::GenerationFailed { failure } if failure.hints.authentication_failure => {
            FailureKind::Authentication
        }
        RuntimeError::GenerationFailed { failure }
            if failure.hints.model_unavailable || failure.hints.tool_unavailable =>
        {
            FailureKind::Unsupported
        }
        RuntimeError::AuthenticationRequired | RuntimeError::PaidRouteRefused => {
            FailureKind::Authentication
        }
        RuntimeError::UnsafeToolConfiguration => FailureKind::Permission,
        RuntimeError::ImageGenerationUnavailable
        | RuntimeError::ReasoningModelUnavailable
        | RuntimeError::UnsupportedModel
        | RuntimeError::ActualModelUnconfirmed
        | RuntimeError::UnsupportedOption
        | RuntimeError::Unavailable => FailureKind::Unsupported,
        RuntimeError::InvalidInput => FailureKind::Input,
        RuntimeError::OutcomeUnknown { .. } => FailureKind::ExternalResultUnknown,
        _ => FailureKind::Worker,
    }
}

fn failure_message(error: &RuntimeError) -> String {
    if matches!(error, RuntimeError::ReasoningModelUnavailable) {
        return format!("선택된 추론 모델 {DEFAULT_REASONING_MODEL}이 현재 모델 목록에 없습니다. 계정 이용 권한은 별도로 확인해야 합니다. 다른 모델로 자동 변경하지 않았습니다.");
    }
    if let RuntimeError::GenerationFailed { failure } = error {
        let reason = if failure.hints.authentication_failure {
            "공식 Codex 인증이 거절되었습니다. Codex에서 다시 로그인한 뒤 연결을 확인해 주세요."
        } else if failure.hints.quota_exceeded {
            "공식 Codex 사용 한도에 도달했습니다. 연결 화면의 한도와 초기화 시각을 확인해 주세요."
        } else if failure.hints.model_unavailable {
            "공식 Codex가 추론 모델 요청을 거절했습니다. Codex 버전과 계정의 모델 이용 가능 여부를 확인해 주세요."
        } else if failure.hints.tool_unavailable {
            "현재 공식 Codex 연결에서 이미지 도구를 사용할 수 없습니다."
        } else {
            "공식 Codex 이미지 요청이 실패했습니다. 진단 기록을 확인한 후 다시 요청해 주세요."
        };
        return format!("{reason} 자동 재요청은 하지 않았습니다. ({})", error.code());
    }
    error.to_string()
}

fn open_official_login(value: &str) -> Result<()> {
    let url = url::Url::parse(value).context("공식 로그인 주소를 확인할 수 없습니다.")?;
    if url.scheme() != "https"
        || !matches!(
            url.host_str(),
            Some("auth.openai.com" | "auth0.openai.com" | "chatgpt.com" | "openai.com")
        )
        || !url.username().is_empty()
        || url.password().is_some()
    {
        bail!("공식 로그인 호스트가 아닌 주소는 열 수 없습니다.")
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let operation: Vec<u16> = "open\0".encode_utf16().collect();
        let target: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        if result as isize <= 32 {
            bail!("로그인 브라우저를 열지 못했습니다.")
        }
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg(value)
            .spawn()
            .context("로그인 브라우저를 열지 못했습니다.")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_selection_ranks_newer_alpha_above_older_stable() {
        let older = runtime_version_rank("codex-cli 0.147.0").unwrap();
        let alpha = runtime_version_rank("codex-cli 0.159.0-alpha.12.1").unwrap();
        let stable = runtime_version_rank("codex-cli 0.159.0").unwrap();
        assert!(alpha > older);
        assert!(stable > alpha);
        assert!(runtime_version_rank("codex-cli 0.159.0\nhttps://example.invalid").is_none());
    }

    #[test]
    fn runtime_selection_follows_semver_prerelease_precedence() {
        let alpha9 = runtime_version_rank("codex-cli 0.159.0-alpha.9").unwrap();
        let alpha12 = runtime_version_rank("codex-cli 0.159.0-alpha.12").unwrap();
        let beta = runtime_version_rank("codex-cli 0.159.0-beta.1").unwrap();
        let stable = runtime_version_rank("codex-cli 0.159.0").unwrap();
        assert!(alpha12.cmp_precedence(&alpha9).is_gt());
        assert!(beta.cmp_precedence(&alpha12).is_gt());
        assert!(stable.cmp_precedence(&beta).is_gt());
        let with_build = runtime_version_rank("codex-cli 0.159.0+build.2").unwrap();
        assert!(stable.cmp_precedence(&with_build).is_eq());
    }

    #[test]
    fn connection_preflight_does_not_promote_catalog_membership_to_account_access() {
        let status = RuntimeStatus {
            version: Some("codex-cli 0.159.0-alpha.12.1".into()),
            authentication: AuthStatus::Chatgpt,
            plan_type: Some("pro".into()),
            model_provider: "openai".into(),
            reasoning_model: Some(DEFAULT_REASONING_MODEL.into()),
            reasoning_catalog_commit: asset_providers::runtime::OFFICIAL_CATALOG_COMMIT.into(),
            official_provider_verified: true,
            native_image_generation: true,
            controls_verified: true,
            requested_image_model: REQUESTED_IMAGE_MODEL.into(),
            confirmed_image_model: None,
            live_generation_proven: false,
            rate_limits: vec![],
        };
        let result = connection(&status);
        assert_eq!(result["reasoningModel"], "gpt-6.1-sol");
        assert_eq!(result["catalogSource"], "application_pinned_catalog");
        assert_eq!(result["inferenceAccess"], "unknown");
        assert!(result["confirmedModel"].is_null());
        assert!(result["reason"]
            .as_str()
            .unwrap()
            .contains("계정 이용 권한을 증명하지"));
    }
}
