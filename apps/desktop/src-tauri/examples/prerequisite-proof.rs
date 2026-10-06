//! Explicit native installer proof; never part of a shipping CLI/GUI package.
use anyhow::{bail, Context, Result};
use asset_providers::local_prerequisites::{discover, ensure, Kind};
use serde_json::json;
use std::{path::PathBuf, time::Duration};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 || args[1] != "--consent-downloads" {
        bail!("Usage: prerequisite-proof --consent-downloads NEW_ABSOLUTE_DATA_DIRECTORY");
    }
    let data = PathBuf::from(&args[2]);
    if !data.is_absolute() || data.exists() { bail!("Proof data directory must be new and absolute"); }
    let blender = ensure(&data, Kind::Blender, true, Duration::from_secs(1800), |progress| {
        println!("{}", json!({"type":"preparation_progress","proof":true,"progress":progress}));
    })?;
    if discover(&data, Kind::Blender)?.context("Verified Blender disappeared")? != blender {
        bail!("Installed Blender discovery differed from the verified executable");
    }
    #[cfg(target_os = "macos")]
    let python = {
        let installed = ensure(&data, Kind::MacPython, true, Duration::from_secs(600), |progress| {
            println!("{}", json!({"type":"preparation_progress","proof":true,"progress":progress}));
        })?;
        if discover(&data, Kind::MacPython)?.context("Verified Python disappeared")? != installed {
            bail!("Installed Python discovery differed from the verified executable");
        }
        Some(installed)
    };
    #[cfg(not(target_os = "macos"))]
    let python: Option<PathBuf> = None;
    println!("{}", json!({"type":"prerequisite_proof","platform":std::env::consts::OS,
        "architecture":std::env::consts::ARCH,"blender":blender,"python":python,
        "sourceDerivedFilesVerified":true,"nativeProbesVerified":true,"modelDownloaded":false,
        "providerGenerationRequested":false,"systemInstallations":false}));
    Ok(())
}
