//! Opt-in live provider proof using the same public Backend API as the desktop.
//! The default path probes only. No credentials, raw runtime events, login URLs,
//! provider logs, or automatic retry requests are written by this harness.
use anyhow::{anyhow, bail, ensure, Context, Result};
use asset_desktop::workbench::Backend;
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

const PROMPT: &str = "A single small forest potion icon, centered with generous empty margins, muted sage green and warm brass palette, clean readable silhouette, no text, no logo, no additional objects.";
const TERMINAL: &[&str] = &[
    "succeeded",
    "failed",
    "cancelled",
    "waiting_user",
    "external_unknown",
];

struct Args {
    output: PathBuf,
    generate: bool,
    codex: Option<PathBuf>,
}

fn args() -> Result<Args> {
    let mut arguments = std::env::args_os().skip(1);
    let mut output = None;
    let mut generate = false;
    let mut codex = None;
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--output") if output.is_none() => output = Some(PathBuf::from(arguments.next().context("--output requires a new directory")?)),
            Some("--generate") if !generate => generate = true,
            Some("--codex") if codex.is_none() => codex = Some(PathBuf::from(arguments.next().context("--codex requires an absolute executable path")?)),
            _ => bail!("Usage: provider-proof --output <new-directory> [--generate] [--codex <absolute-executable-path>]"),
        }
    }
    let output = output.context("Usage: provider-proof --output <new-directory> [--generate] [--codex <absolute-executable-path>]")?;
    if let Some(executable) = &codex {
        ensure!(
            executable.is_absolute() && executable.is_file(),
            "--codex must identify an existing absolute executable path"
        );
    }
    Ok(Args {
        output,
        generate,
        codex,
    })
}

fn main() -> Result<()> {
    let args = args()?;
    if let Some(executable) = &args.codex {
        // Set before Backend threads start. Official Codex owns authentication.
        std::env::set_var("CODEX_EXECUTABLE", executable);
    }
    ensure!(
        !args.output.exists(),
        "Proof output directory must be new; existing files are never overwritten"
    );
    if let Some(parent) = args
        .output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    fs::create_dir(&args.output)?;
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let data = args.output.join("app-data");
    let examples = base.join("../public/examples");
    let worker = base.join("../../../workers/blender/worker.py");
    let backend = Backend::new(data.clone(), examples.clone(), worker.clone());
    backend.start();
    let outcome = prove(&backend, &args, &data, &examples, &worker);
    backend.shutdown();
    outcome
}

fn request(backend: &Backend, value: Value, stage: &'static str) -> Result<Value> {
    // Provider/process error strings could contain uncontrolled text. This
    // proof retains a fixed stage error and the sanitized provider status only.
    backend.request(value).map_err(|_| {
        anyhow!("Native Backend request failed at {stage}; raw error output was not retained")
    })
}

fn prove(
    backend: &Backend,
    args: &Args,
    data: &Path,
    examples: &Path,
    worker: &Path,
) -> Result<()> {
    let initial = request(backend, json!({"action":"bootstrap"}), "bootstrap")?;
    let root = PathBuf::from(
        initial["root"]
            .as_str()
            .context("Bootstrap did not return a project root")?,
    );
    let baseline_assets = ids(&initial, "assets");
    let baseline_jobs = ids(&initial, "jobs");
    let status = match backend.request(json!({"action":"provider_status"})) {
        Ok(value) => sanitized_status(&value),
        Err(_) => {
            json!({"available":false,"authenticated":null,"ready":false,"runtimeVersion":null,"requestedModel":null,"confirmedModel":null,"reason":"Provider status request failed; no raw runtime output was retained","usage":[],"checkedAt":chrono::Utc::now().to_rfc3339()})
        }
    };
    write_json_new(&args.output.join("provider-status.json"), &status)?;
    let mut proof = json!({
        "nativeBackend":true, "nativeWindow":false,
        "mode":if args.generate {"explicit_generation"} else {"probe_only"},
        "providerStatus":status, "fixtureBaselineAssets":baseline_assets.len(),
        "generationRequested":args.generate, "generationRequestAccepted":false,
        "providerLiveGeneration":false, "retryRequested":false,
        "remoteCancellationConfirmed":false, "jobs":[], "generatedAssets":[],
        "reopened":false, "independentManifestVerified":false, "status":"probe_complete",
    });
    if !args.generate {
        return finish(args, proof, true);
    }
    if proof["providerStatus"]["ready"] != true {
        proof["status"] = json!("blocked");
        proof["failureStage"] = json!("provider_not_ready");
        return finish(args, proof, false);
    }
    let request_id = Uuid::new_v4().to_string();
    proof["requestId"] = json!(request_id);
    proof["prompt"] = json!(PROMPT);
    if backend.request(json!({"action":"generate","requestId":request_id,"prompt":PROMPT,"count":1,"name":"구독 공급자 실증 아이콘"})).is_err() {
        proof["status"] = json!("failed");
        proof["failureStage"] = json!("generation_request_rejected");
        return finish(args, proof, false);
    }
    proof["generationRequestAccepted"] = json!(true);
    let started = Instant::now();
    let mut seen = BTreeMap::new();
    let mut last_heartbeat = Instant::now();
    let completed = loop {
        let snapshot = match backend.request(json!({"action":"snapshot"})) {
            Ok(value) => value,
            Err(_) => {
                proof["status"] = json!("external_unknown");
                proof["failureStage"] = json!("snapshot_failed_after_request");
                return finish(args, proof, false);
            }
        };
        let jobs = new_jobs(&snapshot, &baseline_jobs);
        proof["jobs"] = json!(jobs);
        for job in &jobs {
            let id = job["id"].as_str().unwrap_or("unknown");
            let status = job["status"].as_str().unwrap_or("unknown");
            if seen.insert(id.to_owned(), status.to_owned()).as_deref() != Some(status) {
                println!(
                    "{}",
                    json!({"event":"job_status","job":job,"elapsedSeconds":started.elapsed().as_secs()})
                );
            }
        }
        if !jobs.is_empty()
            && jobs
                .iter()
                .all(|job| TERMINAL.contains(&job["status"].as_str().unwrap_or("")))
        {
            break snapshot;
        }
        if started.elapsed() > Duration::from_secs(900) {
            proof["status"] = json!("external_unknown");
            proof["failureStage"] = json!("poll_timeout_no_retry");
            return finish(args, proof, false);
        }
        if last_heartbeat.elapsed() > Duration::from_secs(30) {
            println!(
                "{}",
                json!({"event":"waiting","elapsedSeconds":started.elapsed().as_secs(),"retryRequested":false})
            );
            last_heartbeat = Instant::now();
        }
        thread::sleep(Duration::from_millis(250));
    };
    if proof["jobs"]
        .as_array()
        .context("Missing job proof")?
        .iter()
        .any(|job| job["status"] != "succeeded")
    {
        proof["status"] = if proof["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|job| job["status"] == "external_unknown")
        {
            json!("external_unknown")
        } else {
            json!("failed")
        };
        proof["failureStage"] = json!("generation_job_not_successful");
        return finish(args, proof, false);
    }
    let selected = generated_assets(&completed, &baseline_assets);
    if selected.len() != 1 {
        proof["status"] = json!("failed");
        proof["failureStage"] = json!("expected_one_subscription_asset");
        return finish(args, proof, false);
    }
    let before = match verify_assets(&root, &selected) {
        Ok(value) => value,
        Err(_) => {
            proof["status"] = json!("failed");
            proof["failureStage"] = json!("generated_artifact_decode_or_hash");
            return finish(args, proof, false);
        }
    };
    proof["generatedAssets"] = json!(before);
    proof["providerLiveGeneration"] = json!(true);
    proof["requestedModelProven"] = json!(selected.iter().all(|asset| asset["versions"]
        .as_array()
        .is_some_and(|versions| versions
            .iter()
            .filter(|version| version["source"] == "codex_subscription")
            .all(|version| version["confirmedModel"].is_string()
                && version["confirmedModel"] == version["requestedModel"]))));
    backend.shutdown();
    thread::sleep(Duration::from_millis(300));
    let reopened = Backend::new(data.to_owned(), examples.to_owned(), worker.to_owned());
    let reopened_result = (|| -> Result<()> {
        let restored = request(&reopened, json!({"action":"bootstrap"}), "reopen")?;
        ensure!(
            fs::canonicalize(restored["root"].as_str().context("Missing reopened root")?)?
                == fs::canonicalize(&root)?,
            "Reopened a different project"
        );
        let after_assets = generated_assets(&restored, &baseline_assets);
        ensure!(
            selected == after_assets,
            "Reopen changed generated provenance or immutable versions"
        );
        let after = verify_assets(&root, &after_assets)?;
        ensure!(
            before == after,
            "Reopen changed generated file hashes or decoded pixels"
        );
        proof["reopened"] = json!(true);
        let asset_ids = selected
            .iter()
            .map(|asset| asset["id"].clone())
            .collect::<Vec<_>>();
        let bundle = request(
            &reopened,
            json!({"action":"export","destination":args.output.join("exports"),"assetIds":asset_ids}),
            "export",
        )?;
        let bundle_path = PathBuf::from(
            bundle["path"]
                .as_str()
                .context("Export did not return a bundle directory")?,
        );
        proof["bundle"] = json!(bundle_path);
        proof["manifest"] = verify_manifest(&bundle_path, &asset_ids)?;
        proof["independentManifestVerified"] = json!(true);
        Ok(())
    })();
    reopened.shutdown();
    if reopened_result.is_err() {
        proof["status"] = json!("failed");
        proof["failureStage"] = json!("reopen_or_independent_export_verification");
        return finish(args, proof, false);
    }
    proof["status"] = json!("completed");
    proof["elapsedSeconds"] = json!(started.elapsed().as_secs());
    finish(args, proof, true)
}

fn finish(args: &Args, proof: Value, succeeded: bool) -> Result<()> {
    write_json_new(&args.output.join("provider-proof.json"), &proof)?;
    println!("{}", serde_json::to_string_pretty(&proof)?);
    ensure!(succeeded, "Provider proof did not complete; see the sanitized provider-proof.json. No retry was requested");
    Ok(())
}

fn sanitized_status(raw: &Value) -> Value {
    let mut status = Map::new();
    for key in ["available", "authenticated", "ready"] {
        status.insert(
            key.to_owned(),
            raw[key].as_bool().map(Value::Bool).unwrap_or(Value::Null),
        );
    }
    for key in [
        "runtimeVersion",
        "reasoningModel",
        "catalogSource",
        "inferenceAccess",
        "requestedModel",
        "confirmedModel",
        "reason",
        "checkedAt",
    ] {
        let text = raw[key]
            .as_str()
            .filter(|text| {
                text.len() <= 2048
                    && ![
                        "http://",
                        "https://",
                        "Bearer ",
                        "sk-",
                        "authUrl",
                        "access_token",
                        "api_key",
                        "cookie",
                        "@",
                        "\\",
                    ]
                    .iter()
                    .any(|marker| text.contains(marker))
            })
            .filter(|text| match key {
                "runtimeVersion" => {
                    asset_providers::safe_codex_version(text.as_bytes()).as_deref() == Some(*text)
                }
                "reasoningModel" => *text == asset_providers::runtime::DEFAULT_REASONING_MODEL,
                "catalogSource" => matches!(*text, "application_pinned_catalog" | "unknown"),
                "inferenceAccess" => *text == "unknown",
                "requestedModel" | "confirmedModel" => {
                    text.starts_with("gpt-image-")
                        && text.len() <= 128
                        && text
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
                }
                "checkedAt" => {
                    chrono::DateTime::parse_from_rfc3339(text).is_ok()
                        || chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").is_ok()
                }
                _ => true,
            });
        status.insert(
            key.to_owned(),
            text.map(|text| json!(text)).unwrap_or(Value::Null),
        );
    }
    let usage = raw["usage"].as_array().into_iter().flatten().take(32).filter(|bucket| bucket.is_object()).map(|bucket| {
        let window = |value: &Value| {
            if !value.is_object() { return Value::Null; }
            json!({"usedPercent":value["usedPercent"].as_f64(),"windowDurationMins":value["windowDurationMins"].as_i64(),"resetsAt":value["resetsAt"].as_i64()})
        };
        let limit_id = bucket["limitId"].as_str().filter(|id| id.len() <= 128 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte)));
        json!({"limitId":limit_id,"primary":window(&bucket["primary"]),"secondary":window(&bucket["secondary"])})
    }).collect::<Vec<_>>();
    status.insert("usage".into(), json!(usage));
    Value::Object(status)
}

fn ids(snapshot: &Value, field: &str) -> HashSet<String> {
    snapshot["project"][field]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| value["id"].as_str().map(str::to_owned))
        .collect()
}

fn new_jobs(snapshot: &Value, baseline: &HashSet<String>) -> Vec<Value> {
    snapshot["project"]["jobs"].as_array().into_iter().flatten().filter(|job| !baseline.contains(job["id"].as_str().unwrap_or(""))).map(|job| json!({
        "id":job["id"], "assetId":job["assetId"], "kind":job["kind"], "status":job["status"],
        "attempts":job["attempts"], "errorPresent":!job["error"].is_null(),
    })).collect()
}

fn generated_assets(snapshot: &Value, baseline: &HashSet<String>) -> Vec<Value> {
    snapshot["project"]["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|asset| {
            !baseline.contains(asset["id"].as_str().unwrap_or(""))
                && asset["versions"].as_array().is_some_and(|versions| {
                    versions
                        .iter()
                        .any(|version| version["source"] == "codex_subscription")
                })
        })
        .cloned()
        .collect()
}

fn relative_file(root: &Path, raw: &str) -> Result<PathBuf> {
    let relative = Path::new(raw);
    ensure!(
        !raw.is_empty()
            && relative
                .components()
                .all(|component| matches!(component, Component::Normal(_))),
        "Artifact reference is not a confined relative path"
    );
    let canonical_root = fs::canonicalize(root)?;
    let file = fs::canonicalize(root.join(relative))?;
    ensure!(
        file.starts_with(canonical_root) && file.is_file(),
        "Artifact escaped its root or is not a file"
    );
    Ok(file)
}

fn verify_artifact(root: &Path, artifact: &Value) -> Result<Value> {
    let path = relative_file(
        root,
        artifact["path"].as_str().context("Missing artifact path")?,
    )?;
    let (sha256, bytes) = asset_core::sha256_file(&path)?;
    ensure!(
        artifact["sha256"].as_str() == Some(sha256.as_str())
            && artifact["bytes"].as_u64() == Some(bytes),
        "Artifact hash or size does not match metadata"
    );
    let format = artifact["format"].as_str().unwrap_or("");
    let decoded = if ["png", "jpeg", "jpg", "webp"].contains(&format) {
        let mut header = [0_u8; 32];
        let header_len = File::open(&path)?.read(&mut header)?;
        let actual_format = image::guess_format(&header[..header_len])?;
        let expected_format = match format {
            "png" => image::ImageFormat::Png,
            "webp" => image::ImageFormat::WebP,
            _ => image::ImageFormat::Jpeg,
        };
        ensure!(
            actual_format == expected_format,
            "Artifact metadata format differs from actual image bytes"
        );
        Some(asset_image_pipeline::inspect(&path)?)
    } else {
        None
    };
    Ok(
        json!({"id":artifact["id"],"path":artifact["path"],"format":format,"role":artifact["role"],"sha256":sha256,"bytes":bytes,"decoded":decoded}),
    )
}

fn verify_assets(root: &Path, assets: &[Value]) -> Result<Vec<Value>> {
    assets.iter().map(|asset| {
        let mut versions = Vec::new();
        let mut raster_count = 0;
        for version in asset["versions"].as_array().context("Missing versions")? {
            ensure!(version["source"] == "codex_subscription", "Fixture/import provenance cannot pass live generation proof");
            let mut artifacts = Vec::new();
            for artifact in version["artifacts"].as_array().context("Missing artifacts")? {
                let verified = verify_artifact(root, artifact)?;
                if verified["decoded"].is_object() {
                    ensure!(verified["decoded"]["nonEmpty"] == true, "Generated image is fully transparent");
                    raster_count += 1;
                }
                artifacts.push(verified);
            }
            versions.push(json!({"id":version["id"],"number":version["number"],"createdAt":version["createdAt"],"source":version["source"],"requestedModel":version["requestedModel"],"confirmedModel":version["confirmedModel"],"providerVersion":version["providerVersion"],"artifacts":artifacts}));
        }
        ensure!(raster_count > 0, "Generated version has no decodable raster artifact");
        Ok(json!({"id":asset["id"],"name":asset["name"],"activeVersionId":asset["activeVersionId"],"width":asset["width"],"height":asset["height"],"versions":versions}))
    }).collect()
}

fn verify_manifest(bundle: &Path, expected_assets: &[Value]) -> Result<Value> {
    let path = bundle.join("manifest.json");
    ensure!(
        fs::metadata(&path)?.len() < 16 * 1024 * 1024,
        "Manifest exceeds proof reader budget"
    );
    let manifest: Value = serde_json::from_slice(&fs::read(&path)?)?;
    let assets = manifest["assets"]
        .as_array()
        .context("Independent manifest has no assets")?;
    let actual_ids = assets
        .iter()
        .filter_map(|asset| asset["id"].as_str())
        .collect::<HashSet<_>>();
    let expected_ids = expected_assets
        .iter()
        .filter_map(Value::as_str)
        .collect::<HashSet<_>>();
    ensure!(
        actual_ids == expected_ids && assets.len() == expected_assets.len(),
        "Export manifest includes a different asset selection"
    );
    ensure!(
        assets.iter().all(|asset| asset["versions"]
            .as_array()
            .is_some_and(|versions| !versions.is_empty()
                && versions
                    .iter()
                    .all(|version| version["source"] == "codex_subscription"))),
        "Export manifest lost subscription provenance"
    );
    let files = manifest["files"]
        .as_array()
        .context("Independent manifest has no files")?;
    ensure!(
        !files.is_empty() && files.len() <= 1024,
        "Manifest file count is invalid"
    );
    let verified = files
        .iter()
        .map(|artifact| verify_artifact(bundle, artifact))
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        verified
            .iter()
            .any(|artifact| artifact["decoded"].is_object()),
        "Export contains no decodable image"
    );
    let (sha256, bytes) = asset_core::sha256_file(&path)?;
    Ok(
        json!({"path":"manifest.json","sha256":sha256,"bytes":bytes,"schemaVersion":manifest["schemaVersion"],"assetCount":assets.len(),"fileCount":verified.len(),"files":verified}),
    )
}

fn write_json_new(path: &Path, value: &Value) -> Result<()> {
    ensure!(!path.exists(), "Proof file already exists");
    let parent = path.parent().context("Proof file has no parent")?;
    let temporary = parent.join(format!(".proof-{}.tmp", Uuid::new_v4()));
    let mut file = File::options()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let written = (|| -> Result<()> {
        file.write_all(&serde_json::to_vec_pretty(value)?)?;
        file.sync_all()?;
        Ok(())
    })();
    drop(file);
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    // Same-directory hard-link creation publishes the complete file and fails
    // if a destination appeared concurrently. It cannot replace an original.
    let persisted = fs::hard_link(&temporary, path);
    let _ = fs::remove_file(&temporary);
    persisted.context("Could not atomically publish the new proof file")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_proof_excludes_account_and_nested_usage_fields() {
        let status = sanitized_status(&json!({
            "available":true,"authenticated":true,"ready":true,
            "runtimeVersion":"codex-cli 0.147.0","requestedModel":"gpt-image-2","confirmedModel":null,
            "reason":"Native image controls verified","checkedAt":"2026-10-02T00:00:00Z",
            "account":{"email":"fixture@example.invalid"},"authUrl":"https://example.invalid/fixture",
            "usage":[{"limitId":"codex","account":"fixture-only","primary":{"usedPercent":12,"windowDurationMins":300,"resetsAt":123,"extra":"fixture-only"},"secondary":null}],
        }));
        assert_eq!(status.as_object().unwrap().len(), 12);
        assert!(status.get("account").is_none());
        assert!(status.get("authUrl").is_none());
        assert!(status["usage"][0].get("account").is_none());
        assert!(status["usage"][0]["primary"].get("extra").is_none());
        assert_eq!(status["usage"][0]["primary"]["usedPercent"], 12.0);
        assert!(status["confirmedModel"].is_null());
    }

    #[test]
    fn readiness_requires_boolean_and_status_cannot_retain_login_links() {
        let status = sanitized_status(
            &json!({"available":true,"authenticated":true,"ready":"true","reason":"https://example.invalid/fixture-login","usage":{"account":"fixture"}}),
        );
        assert!(status["ready"].is_null());
        assert!(status["reason"].is_null());
        assert_eq!(status["usage"], json!([]));
    }

    #[test]
    fn planner_probe_retains_alpha_version_and_does_not_assert_account_access() {
        let status = sanitized_status(&json!({
            "runtimeVersion":"codex-cli 0.159.0-alpha.12.1",
            "reasoningModel":asset_providers::runtime::DEFAULT_REASONING_MODEL,
            "catalogSource":"application_pinned_catalog","inferenceAccess":"unknown",
            "requestedModel":"gpt-image-2","confirmedModel":null
        }));
        assert_eq!(status["runtimeVersion"], "codex-cli 0.159.0-alpha.12.1");
        assert_eq!(status["reasoningModel"], "gpt-6.1-sol");
        assert_eq!(status["inferenceAccess"], "unknown");
        assert!(status["confirmedModel"].is_null());
        let unsafe_status = sanitized_status(&json!({
            "reasoningModel":"https://example.invalid/credential",
            "catalogSource":"server_account_entitlement","inferenceAccess":"verified"
        }));
        assert!(unsafe_status["reasoningModel"].is_null());
        assert!(unsafe_status["catalogSource"].is_null());
        assert!(unsafe_status["inferenceAccess"].is_null());
    }
}
