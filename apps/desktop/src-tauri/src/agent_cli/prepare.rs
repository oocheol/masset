//! Headless preparation. Existing official authentication is reused through
//! public RPC; local preparation is independent of account availability.
use super::*;
use asset_providers::local_prerequisites::{self, Kind};

fn public_connection(value: &Value) -> Value {
    json!({"available":value["available"] == true,
        "authenticated":value["authenticated"] == true,"ready":value["ready"] == true,
        "runtimeVersion":value["runtimeVersion"],"reasoningModel":value["reasoningModel"],
        "requestedModel":value["requestedModel"],"confirmedModel":value["confirmedModel"],
        "inferenceAccess":value["inferenceAccess"],"liveGenerationChecked":false})
}

fn attention(code: &str, message: &str) -> Value {
    json!({"code":code,"message":message})
}

fn remaining(started: Instant, timeout: Duration) -> Result<Duration> {
    timeout
        .checked_sub(started.elapsed())
        .filter(|value| !value.is_zero())
        .context("CLI preparation deadline exceeded; incomplete files are preserved")
}

#[cfg(windows)]
fn windows_vc_ready() -> bool {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .is_some_and(|directory| {
            directory.is_absolute() && directory.join("System32/msvcp140.dll").is_file()
        })
}
#[cfg(not(windows))]
fn windows_vc_ready() -> bool {
    true
}

fn prepare_prerequisite(
    args: &Args,
    data: &Path,
    kind: Kind,
    started: Instant,
    timeout: Duration,
) -> Result<PathBuf> {
    let mut output_error = None;
    let result = local_prerequisites::ensure(
        data,
        kind,
        args.get("--consent-downloads") == Some("true"),
        remaining(started, timeout)?,
        |progress| {
            if let Err(error) = emit(
                &json!({"type":"preparation_progress","prerequisite":progress.prerequisite,
                "stage":progress.stage,"downloadedBytes":progress.downloaded_bytes,"totalBytes":progress.total_bytes}),
            ) {
                output_error = Some(error);
            }
        },
    )?;
    if let Some(error) = output_error {
        return Err(error);
    }
    Ok(result)
}

fn poll_codex(backend: &Backend, started: Instant, timeout: Duration) -> Result<()> {
    let mut last = Value::Null;
    loop {
        if remaining(started, timeout).is_err() {
            let _ = backend.request(json!({"action":"provider_setup_cancel"}));
            bail!("Official Codex setup exceeded the CLI deadline; partial files preserved");
        }
        let status = backend.request(json!({"action":"provider_setup_status"}))?;
        let public = json!({"type":"preparation_progress","prerequisite":"codex",
            "stage":status["state"],"downloadedBytes":status["downloadedBytes"],"totalBytes":status["totalBytes"]});
        if public != last {
            emit(&public)?;
            last = public;
        }
        match status["state"].as_str() {
            Some("ready") => return Ok(()),
            Some("error" | "cancelled" | "idle") => bail!(
                "Official Codex setup did not complete; originals and partial files preserved"
            ),
            _ => thread::sleep(Duration::from_millis(500)),
        }
    }
}

fn poll_3d(backend: &Backend, started: Instant, timeout: Duration) -> Result<Value> {
    let mut last = Value::Null;
    loop {
        if remaining(started, timeout).is_err() {
            let _ = backend.request(json!({"action":"quality3d_cancel_setup"}));
            bail!(
                "Local model preparation exceeded the CLI deadline; verified downloads preserved"
            );
        }
        let status = backend.request(json!({"action":"quality3d_status"}))?;
        let public = json!({"type":"preparation_progress","prerequisite":"local3d",
            "stage":status["stage"],"state":status["state"]});
        if public != last {
            emit(&public)?;
            last = public;
        }
        if status["busy"] != true {
            if status["installed"] == true {
                return Ok(status);
            }
            emit(&json!({"type":"preparation_detail","prerequisite":"local3d","status":status}))?;
            bail!("Local image-to-3D runtime did not reach verified ready state");
        }
        thread::sleep(Duration::from_millis(500));
    }
}

pub(super) fn run(args: &Args) -> Result<()> {
    let local_only = args.get("--local-only") == Some("true");
    let needs_3d = args.get("--needs-3d") == Some("true");
    let consent = args.get("--consent-downloads") == Some("true");
    if local_only && args.get("--login-if-needed") == Some("true") {
        bail!("--local-only cannot be combined with --login-if-needed");
    }
    let data = match args.get("--data-dir") {
        Some(value) => absolute(value)?,
        None => default_data()?,
    };
    let started = Instant::now();
    // The managed workers have their own finite setup deadlines. The CLI also
    // places a single bounded deadline over downloads, local setup and login.
    let timeout = Duration::from_secs(args.timeout()?.min(3600));
    let owner = Owner(backend(args, None)?);
    let mut local = owner.0.request(json!({"action":"quality3d_status"}))?;
    let environment = owner.0.request(json!({"action":"environment"}))?;
    let mut gpt = if local_only {
        Value::Null
    } else {
        owner.0.request(json!({"action":"provider_status"}))?
    };
    let mut manifests = Vec::new();
    let mut problems = Vec::new();
    let mut runtime_integrity_failed = false;
    if needs_3d && local["installed"] == true {
        local = owner
            .0
            .request(json!({"action":"quality3d_verify_runtime"}))?;
        if local["runtimeIntegrityVerified"] != true {
            runtime_integrity_failed = true;
            problems.push(attention("local3d_runtime_integrity", "An existing local model runtime did not pass its pinned file and interpreter checks. Original files are preserved; preparation did not repair or replace them."));
        }
    }
    let blender_usable = environment["blenderPath"].is_string()
        && environment["blenderVersion"]
            .as_str()
            .is_some_and(|value| !value.trim().is_empty());
    let explicit_blender_invalid =
        needs_3d && !blender_usable && std::env::var_os("BLENDER_EXECUTABLE").is_some();
    let needs_blender = needs_3d && !blender_usable && !explicit_blender_invalid;
    if explicit_blender_invalid {
        problems.push(attention("explicit_blender_unavailable", "The explicitly selected BLENDER_EXECUTABLE did not pass its native version probe. Its path is preserved; fix the selection before preparing 3D."));
    }
    let needs_python = cfg!(all(target_os = "macos", target_arch = "aarch64"))
        && needs_3d
        && local["installed"] != true
        && !runtime_integrity_failed
        && local_prerequisites::discover(&data, Kind::MacPython)?.is_none()
        && local_prerequisites::system_mac_python().is_none();
    for (missing, kind) in [
        (needs_blender, Kind::Blender),
        (needs_python, Kind::MacPython),
    ] {
        if missing {
            if let Some(manifest) = local_prerequisites::manifest(kind) {
                manifests.push(serde_json::to_value(manifest)?);
            }
        }
    }
    let codex_setup = if local_only {
        Value::Null
    } else {
        owner.0.request(json!({"action":"provider_setup_status"}))?
    };
    let needs_codex = !local_only && codex_setup["runtimeDetected"] != true;
    if needs_codex {
        manifests.push(codex_setup["manifest"].clone());
    }
    let model_manifest = if needs_3d && local["installed"] != true && !runtime_integrity_failed {
        let lock_name = if cfg!(windows) {
            "runtime-lock-windows.json"
        } else {
            "runtime-lock.json"
        };
        let lock = resources(args)?.join("workers/image3d").join(lock_name);
        Some(json!({"id":"image3d-cpu","runtimeLock":lock,
            "runtimeLockSha256":asset_core::sha256_file(&lock)?.0,
            "modelId":local["modelId"],"modelRevision":local["modelRevision"],
            "weightBytes":local["weightBytes"],"download":local["download"],
            "sourceUrl":format!("https://github.com/oocheol/masset/blob/master/workers/image3d/{lock_name}"),
            "license":"MIT; pinned dependency licenses are listed in the runtime lock"}))
    } else {
        None
    };
    emit(
        &json!({"type":"preparation_manifest","version":env!("CARGO_PKG_VERSION"),
        "downloadsConsented":consent,"needs3D":needs_3d,"localOnly":local_only,
        "prerequisites":manifests,"localModel":model_manifest,
        "systemInstallations":false,"credentialsCopied":false,"paidApiFallback":false}),
    )?;

    if needs_codex {
        if codex_setup["supported"] != true {
            problems.push(attention("codex_unavailable", "Verify the explicitly selected official Codex executable; its path is never silently changed."));
        } else if !consent {
            problems.push(attention(
                "download_consent_required",
                "Official Codex setup requires --consent-downloads.",
            ));
        } else {
            let prepared = owner
                .0
                .request(json!({"action":"provider_setup_install","consent":true,
                "expectedVersion":codex_setup["manifest"]["version"],
                "expectedSha256":codex_setup["manifest"]["sha256"]}))
                .and_then(|_| poll_codex(&owner.0, started, timeout));
            if prepared.is_err() {
                problems.push(attention("codex_setup_failed", "Official Codex preparation did not complete. Verified files and partial downloads are preserved."));
            }
        }
    }
    // Account status cannot block offline Blender/Python/model preparation.
    drop(owner);

    let hardware_admitted = !needs_3d
        || (local["supported"] == true
            && local["memoryMb"].as_u64().unwrap_or(0)
                >= local["minimumMemoryMb"].as_u64().unwrap_or(u64::MAX)
            && windows_vc_ready());
    let local_admitted = hardware_admitted && !runtime_integrity_failed;
    if needs_3d && !hardware_admitted {
        let (code, message) = if local["supported"] != true {
            (
                "local3d_unsupported",
                "Local image-to-3D supports Windows x64 and Apple Silicon Mac.",
            )
        } else if !windows_vc_ready() {
            ("windows_vc_runtime_required", "Microsoft Visual C++ x64 runtime is missing. Its system installation may need administrator approval; no system installer was run. Use https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist .")
        } else {
            (
                "local3d_memory_required",
                "Local image-to-3D requires at least 16GB physical RAM.",
            )
        };
        problems.push(attention(code, message));
    }
    if needs_3d && local_admitted {
        for (missing, kind) in [
            (needs_blender, Kind::Blender),
            (needs_python, Kind::MacPython),
        ] {
            if missing {
                if let Err(error) = prepare_prerequisite(args, &data, kind, started, timeout) {
                    problems.push(attention(
                        if !consent {
                            "download_consent_required"
                        } else {
                            "local_prerequisite_failed"
                        },
                        &error.to_string(),
                    ));
                }
            }
        }
    }
    // A fresh backend sees newly committed, hash-verified managed prerequisites.
    let owner = Owner(backend(args, None)?);
    let final_environment = owner.0.request(json!({"action":"environment"}))?;
    local = owner.0.request(json!({"action":"quality3d_status"}))?;
    let final_blender_usable = final_environment["blenderPath"].is_string()
        && final_environment["blenderVersion"]
            .as_str()
            .is_some_and(|value| !value.trim().is_empty());
    if needs_3d && local_admitted && final_blender_usable && local["installed"] != true {
        if !consent {
            problems.push(attention(
                "download_consent_required",
                "Local CPU model preparation requires --consent-downloads.",
            ));
        } else {
            let prepared = owner
                .0
                .request(json!({"action":"quality3d_prepare","confirmed":true}))
                .and_then(|_| poll_3d(&owner.0, started, timeout));
            match prepared {
                Ok(status) => local = status,
                Err(_) => problems.push(attention("local3d_setup_failed", "Local model preparation did not complete. Inspect the emitted setup status; verified downloads are preserved.")),
            }
        }
    }
    if needs_3d && !runtime_integrity_failed && local["installed"] == true {
        local = owner
            .0
            .request(json!({"action":"quality3d_verify_runtime"}))?;
        if local["runtimeIntegrityVerified"] != true {
            runtime_integrity_failed = true;
            problems.push(attention("local3d_runtime_integrity", "The local model runtime did not pass the final pinned file and interpreter verification. Received files are preserved."));
        }
    }
    if runtime_integrity_failed {
        local["installed"] = json!(false);
        local["state"] = json!("error");
        local["runtimeIntegrityVerified"] = json!(false);
    }
    let mut login_started = false;
    if !local_only {
        gpt = owner.0.request(json!({"action":"provider_status"}))?;
        if gpt["available"] == true
            && gpt["authenticated"] != true
            && args.get("--login-if-needed") == Some("true")
        {
            match owner.0.request(json!({"action":"provider_login"})) {
                Ok(_) => {
                    login_started = true;
                    emit(
                        &json!({"type":"login_needed","message":"Complete the official Codex login in the browser. No token or login URL is copied to CLI output."}),
                    )?;
                    let login_start = Instant::now();
                    while login_start.elapsed() < Duration::from_secs(600)
                        && remaining(started, timeout).is_ok()
                    {
                        gpt = owner.0.request(json!({"action":"provider_status"}))?;
                        if gpt["authenticated"] == true {
                            break;
                        }
                        thread::sleep(Duration::from_secs(2));
                    }
                }
                Err(_) => problems.push(attention(
                    "official_login_failed",
                    "The official Codex browser login could not start.",
                )),
            }
        }
        if gpt["available"] != true {
            problems.push(attention(
                "codex_runtime_not_ready",
                "The official Codex runtime or its required controls could not be verified.",
            ));
        } else if gpt["authenticated"] != true {
            problems.push(attention("needs_login", "Existing ChatGPT authentication was not available. Run prepare --login-if-needed to open the official login when needed."));
        } else if gpt["ready"] != true {
            problems.push(attention("image_tool_not_ready", "ChatGPT authentication is present, but the official image tool or execution controls could not be verified."));
        }
    }
    let ready_local = !needs_3d
        || (local["installed"] == true
            && local["runtimeIntegrityVerified"] == true
            && final_blender_usable);
    let ready_gpt = if local_only {
        None
    } else {
        Some(gpt["ready"] == true)
    };
    let ready = ready_local && ready_gpt.unwrap_or(true);
    emit(
        &json!({"type":if ready {"prepared"} else {"needs_attention"},
        "version":env!("CARGO_PKG_VERSION"),"readyLocal":ready_local,"readyGpt":ready_gpt,
        "needs3D":needs_3d,"localOnly":local_only,"gptChecked":!local_only,
        "existingAuthReused":!local_only && !login_started && gpt["authenticated"] == true,
        "loginStarted":login_started,"environment":final_environment,"local3D":local,
        "gpt":if local_only {Value::Null} else {public_connection(&gpt)},
        "attention":problems,"freshGptRequests":0,"paidApiFallback":false,
        "systemInstallations":false,"credentialsCopied":false}),
    )?;
    if !ready {
        bail!("Preparation needs attention; available offline preparation results are preserved");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn auth_output_never_contains_runtime_urls_or_credentials() {
        let input = json!({"available":true,"authenticated":true,"ready":true,
            "runtimeVersion":"codex-cli 0.160.0","reasoningModel":"gpt-6.1-sol",
            "requestedModel":"gpt-image-2","confirmedModel":null,
            "authUrl":"https://auth.example.test/?secret=never-output","token":"never-output",
            "reason":"private data never-output"});
        let public = public_connection(&input);
        assert_eq!(public["authenticated"], true);
        assert_eq!(public["liveGenerationChecked"], false);
        assert!(!public.to_string().contains("never-output"));
    }
    #[test]
    fn preparation_deadline_is_finite() {
        assert!(remaining(Instant::now(), Duration::ZERO).is_err());
        assert!(remaining(Instant::now(), Duration::from_secs(1)).is_ok());
    }
}
