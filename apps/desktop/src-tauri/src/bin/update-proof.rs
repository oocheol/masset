//! Developer-only check of an already built update artifact. No installer runs,
//! no HTTP or provider requests occur, and the output directory must be new.
use anyhow::{ensure, Context, Result};
use asset_desktop::updater::validate_metadata;
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::PathBuf};
use tauri_plugin_updater::UpdaterExt;

// Optional read-only proof against the fixed public release endpoint. No
// production Backend is created, no project/auth files are read, no window is
// opened and the installer is never executed. The comparator override allows
// verification of the current release without pretending it is an upgrade.
fn verify_native_download(
    version: &str,
    expected_length: u64,
    expected_digest: &str,
) -> Result<Value> {
    ensure!(
        cfg!(all(windows, target_arch = "x86_64")),
        "Windows x64 proof only"
    );
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .map_err(|_| anyhow::anyhow!("Could not initialize native update verifier"))?;
    tauri::async_runtime::block_on(async {
        let updater = app
            .handle()
            .updater_builder()
            .target("windows-x86_64")
            .version_comparator(|_, _| true)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|_| anyhow::anyhow!("Could not create native updater"))?;
        let mut update = updater
            .check()
            .await
            .map_err(|_| anyhow::anyhow!("Public release metadata check failed"))?
            .context("Public release missing")?;
        ensure!(
            update.version == version,
            "Public version differs from expected release"
        );
        let (length, digest) = validate_metadata(
            &update.version,
            "0.1.0",
            update.download_url.as_str(),
            &update.raw_json["platforms"]["windows-x86_64"],
        )?;
        ensure!(
            length == expected_length && digest == expected_digest,
            "Public metadata differs from local artifact"
        );
        update.timeout = Some(std::time::Duration::from_secs(180));
        let bytes = update.download(|_, _| {}, || {}).await.map_err(|_| {
            anyhow::anyhow!("Official Tauri update download/signature check failed")
        })?;
        ensure!(
            bytes.len() as u64 == length && format!("{:x}", Sha256::digest(&bytes)) == digest,
            "Public bytes differ from local artifact"
        );
        Ok(
            json!({"plugin":"tauri-plugin-updater 2.13.1","publicMetadataChecked":true,
            "payloadSignatureAndVersionVerified":true,"sha256":digest,"bytes":length,
            "sameVersionComparatorOverride":true,"installerExecuted":false,
            "scope":"Actual official Tauri check/download of current public release; download verification only, no cross-version install"}),
        )
    })
}

// The plugin's verifier is private. This independent artifact check uses the
// same minisign library to verify payload and global signature, then compares
// the authenticated version exactly as the pinned Tauri plugin does.
fn verify_artifact(data: &[u8], signature: &str, public_key: &str, version: &str) -> Result<()> {
    let key_text = String::from_utf8(STANDARD.decode(public_key)?)?;
    let signature_text = String::from_utf8(STANDARD.decode(signature)?)?;
    let key = PublicKey::decode(&key_text)?;
    let signature = Signature::decode(&signature_text)?;
    key.verify(data, &signature, true)?;
    let signed_version = signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
        .context("Authenticated version missing")?;
    ensure!(
        semver::Version::parse(signed_version.trim_start_matches('v'))?
            == semver::Version::parse(version.trim_start_matches('v'))?,
        "Authenticated version differs from announced version"
    );
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    ensure!(
        args.len() == 3 || (args.len() == 4 && args[3] == "--verify-download"),
        "Usage: update-proof <installer.exe> <latest.json> <new-output-directory> [--verify-download]"
    );
    let installer = PathBuf::from(&args[0]);
    let manifest_path = PathBuf::from(&args[1]);
    let output = PathBuf::from(&args[2]);
    ensure!(!output.exists(), "Output directory must be new");
    let bytes = fs::read(&installer)?;
    let manifest: Value = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    let config: Value = serde_json::from_str(include_str!("../../tauri.conf.json"))?;
    let version = manifest["version"].as_str().context("version missing")?;
    let platform = &manifest["platforms"]["windows-x86_64"];
    let url = platform["url"].as_str().context("URL missing")?;
    let signature = platform["signature"]
        .as_str()
        .context("signature missing")?;
    let pubkey = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .context("key missing")?;
    let (length, digest) = validate_metadata(version, "0.1.0", url, platform)?;
    ensure!(
        bytes.len() as u64 == length && format!("{:x}", Sha256::digest(&bytes)) == digest,
        "Installer bytes/digest mismatch"
    );
    verify_artifact(&bytes, signature, pubkey, version)?;
    let mut tampered = bytes.clone();
    let index = tampered.len() / 2;
    tampered[index] ^= 1;
    let tampered_rejected = verify_artifact(&tampered, signature, pubkey, version).is_err();
    let version_replay_rejected = verify_artifact(&bytes, signature, pubkey, "999.0.0").is_err();
    ensure!(
        tampered_rejected && version_replay_rejected,
        "Update authenticity checks did not reject tampering/replay"
    );
    let mut result = json!({"checkedAt":chrono::Utc::now().to_rfc3339(),"nativeLibrary":true,
        "networkRequests":0,"installerExecuted":false,"providerGenerationRequested":false,
        "version":version,"installerBytes":length,"installerSha256":digest,
        "payloadSignatureVerified":true,"signedVersionVerified":true,
        "tamperedPayloadRejected":tampered_rejected,"versionReplayRejected":version_replay_rejected,
        "scope":"Independent minisign-verify 0.2.5 check of actual local release bytes and authenticated version; excludes the plugin download path, cross-version installer execution and clean-machine behavior"});
    if args.len() == 4 {
        result["nativePublicDownload"] = verify_native_download(version, length, &digest)?;
        result["networkRequests"] = Value::Null; // Redirect request count is not measured.
        result["publicNetworkOperations"] = json!(["releaseMetadata", "installerDownload"]);
    }
    fs::create_dir_all(&output)?;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(output.join("update-proof.json"))?;
    file.write_all(&serde_json::to_vec_pretty(&result)?)?;
    file.sync_all()?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
