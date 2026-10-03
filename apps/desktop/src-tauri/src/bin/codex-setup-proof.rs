//! Opt-in native onboarding proof. A fresh directory and explicit download flag
//! are required; this harness never logs in or requests image generation.
use anyhow::{bail, ensure, Context, Result};
use asset_desktop::workbench::Backend;
use asset_providers::{
    installer::CodexInstaller,
    runtime::{CodexRuntime, RuntimeOptions},
    AuthStatus,
};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let mut output = None;
    let mut download = false;
    while let Some(argument) = args.next() {
        match argument.to_str() {
            Some("--output") if output.is_none() => {
                output = Some(PathBuf::from(
                    args.next()
                        .context("A fresh --output directory is required")?,
                ))
            }
            Some("--download") if !download => download = true,
            _ => bail!("Usage: codex-setup-proof --output <new-absolute-directory> [--download]"),
        }
    }
    let output = output.context("A fresh --output directory is required")?;
    ensure!(
        output.is_absolute() && !output.exists(),
        "Output must be a new absolute directory; existing files are preserved"
    );
    ensure!(
        std::env::var_os("CODEX_EXECUTABLE").is_none(),
        "An explicit runtime selection is preserved; use an unconfigured QA process"
    );
    fs::create_dir_all(output.parent().context("Output has no parent")?)?;
    fs::create_dir(&output)?;
    let codex_home = output.join("empty-codex-home");
    fs::create_dir(&codex_home)?;
    // This is a fresh, process-only official Codex home. No user auth/config is
    // read, copied, replaced, or logged out by this proof.
    std::env::set_var("CODEX_HOME", &codex_home);
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let data = output.join("app-data");
    let backend = Backend::new(
        data.clone(),
        base.join("../public/examples"),
        base.join("../../../workers/blender/worker.py"),
    );
    let result = prove(&backend, &output, &data, download);
    backend.shutdown();
    result
}

fn prove(
    backend: &Backend,
    output: &std::path::Path,
    data: &std::path::Path,
    download: bool,
) -> Result<()> {
    let initial = backend.request(json!({"action":"provider_setup_status"}))?;
    let version = initial["manifest"]["version"]
        .as_str()
        .context("Version is missing")?;
    let sha256 = initial["manifest"]["sha256"]
        .as_str()
        .context("Checksum is missing")?;
    ensure!(backend.request(json!({"action":"provider_setup_install","consent":false,"expectedVersion":version,"expectedSha256":sha256})).is_err(), "Consent was not enforced");
    ensure!(backend.request(json!({"action":"provider_setup_install","consent":true,"expectedVersion":version,"expectedSha256":"0".repeat(64)})).is_err(), "Reviewed checksum was not enforced");
    ensure!(
        !data.join("codex-runtimes").exists(),
        "Rejected requests wrote installer files"
    );
    let mut report = json!({"checkedAt":chrono::Utc::now().to_rfc3339(),"nativeBackend":true,"nativeWindow":false,
        "downloadRequested":download,"generationRequested":false,"loginRequested":false,"userInstallationModified":false,
        "consentEnforced":true,"reviewedManifestEnforced":true,"manifest":initial["manifest"],
        "freshCodexHome":true,"managedRuntimeRegistered":false,"publicRpcConnected":false,
        "loggedOutDetected":false,"status":"probe_complete"});
    if download {
        backend.request(json!({"action":"provider_setup_install","consent":true,"expectedVersion":version,"expectedSha256":sha256}))?;
        let started = Instant::now();
        let mut heartbeat = Instant::now();
        loop {
            let status = backend.request(json!({"action":"provider_setup_status"}))?;
            if heartbeat.elapsed() >= Duration::from_secs(10) {
                println!(
                    "{} / {} bytes · {}",
                    status["downloadedBytes"], status["totalBytes"], status["state"]
                );
                heartbeat = Instant::now();
            }
            match status["state"].as_str() {
                Some("ready") => {
                    report["installerStatus"] = status;
                    break;
                }
                Some("error" | "cancelled") => {
                    report["installerStatus"] = status;
                    report["status"] = json!("installer_failed");
                    save(output, &report)?;
                    bail!("Managed preparation did not complete; sanitized status is retained");
                }
                _ if started.elapsed() > Duration::from_secs(900) => {
                    let _ = backend.request(json!({"action":"provider_setup_cancel"}));
                    report["status"] = json!("timeout_cancel_requested");
                    save(output, &report)?;
                    bail!("Preparation timed out; only this QA request was cancelled");
                }
                _ => thread::sleep(Duration::from_millis(500)),
            }
        }
        let installed = CodexInstaller::new(data.join("codex-runtimes")).installed_executables();
        ensure!(
            installed.len() == 1,
            "Expected exactly one verified managed runtime"
        );
        report["managedRuntimeRegistered"] = json!(true);
        let mut runtime = CodexRuntime::connect(RuntimeOptions::new(
            &installed[0],
            output.join("rpc-receipts"),
        ))
        .map_err(|_| {
            anyhow::anyhow!(
                "Managed runtime public RPC initialization failed; raw output was omitted"
            )
        })?;
        let status = runtime.refresh_status().map_err(|_| {
            anyhow::anyhow!("Managed runtime status read failed; raw output was omitted")
        })?;
        report["publicRpcConnected"] = json!(true);
        report["runtimeVersion"] = json!(status.version);
        report["loggedOutDetected"] = json!(status.authentication == AuthStatus::NotLoggedIn);
        report["controlsVerified"] = json!(status.controls_verified);
        report["nativeImageToolDetected"] = json!(status.native_image_generation);
        ensure!(
            report["loggedOutDetected"] == true && status.controls_verified,
            "Fresh-user public RPC controls/authentication were not established"
        );
        report["status"] = json!("completed");
    }
    save(output, &report)?;
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}

fn save(output: &std::path::Path, report: &Value) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output.join("codex-setup-proof.json"))?;
    file.write_all(&serde_json::to_vec_pretty(report)?)?;
    file.sync_all()?;
    Ok(())
}
