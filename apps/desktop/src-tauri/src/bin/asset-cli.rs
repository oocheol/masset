//! Native integration harness. Uses exactly the desktop's production backend.
use anyhow::{bail, Result};
use asset_desktop::workbench::Backend;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 || args[1] != "--smoke" {
        bail!("Usage: asset-cli --smoke <new-output-directory> [--with-blender]")
    }
    let output = PathBuf::from(&args[2]);
    if output.exists() {
        bail!("Smoke output directory must be new; existing files will not be overwritten.")
    }
    std::fs::create_dir_all(&output)?;
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let backend = Backend::new(
        output.join("app-data"),
        base.join("../public/examples"),
        base.join("../../../workers/blender/worker.py"),
    );
    backend.start();
    let snapshot = backend.request(json!({"action":"bootstrap"}))?;
    let root = snapshot["root"].clone();
    let assets = snapshot["project"]["assets"].as_array().unwrap();
    if assets.len() != 12 {
        bail!("Expected 12 real transparent fixture imports.")
    }
    let first = assets[0]["id"].clone();
    let second = assets[1]["id"].clone();
    backend.request(json!({"action":"process","assetId":first,"operation":{"type":"resize","width":256,"height":256,"pixelArt":false}}))?;
    backend.request(json!({"action":"process","assetId":second,"operation":{"type":"resize","width":256,"height":256,"pixelArt":true}}))?;
    wait_idle(&backend, 120)?;
    let processed = backend.request(json!({"action":"snapshot"}))?;
    let reuse_job = processed["project"]["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|job| job["kind"] == "image_process" && job["assetId"] == first)
        .unwrap();
    let first_asset = processed["project"]["assets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["id"] == first)
        .unwrap();
    backend.request(json!({"action":"update","assetId":first,"activeVersionId":first_asset["versions"][0]["id"]}))?;
    let reused = backend.request(json!({"action":"reuse","jobId":reuse_job["id"]}))?;
    if reused["project"]["assets"] != processed["project"]["assets"] {
        bail!("Explicit cache reuse did not restore the exact version without new files")
    }
    backend.request(json!({"action":"material","assetId":first,"strength":2.0,"directX":false}))?;
    backend.request(json!({"action":"atlas","assetIds":[first,second],"options":{"width":1024,"height":512,"padding":4}}))?;
    if args.iter().any(|arg| arg == "--with-blender") {
        backend.request(json!({"action":"model","models":[{"template":"crate","name":"검증 상자","width":1.2,"depth":0.8,"height":0.9,"color":"#799993","bevel":0.012},{"template":"table","name":"검증 테이블","width":1.4,"depth":0.7,"height":0.76,"color":"#bd9b76","bevel":0.008}]}))?;
    }
    wait_idle(&backend, 600)?;
    let before = backend.request(json!({"action":"snapshot"}))?;
    let competing = Backend::new(
        output.join("competing-app-data"),
        base.join("../public/examples"),
        base.join("../../../workers/blender/worker.py"),
    );
    if competing
        .request(json!({"action":"open","root":root}))
        .is_ok()
    {
        bail!("Another backend acquired an already-owned project")
    }
    drop(competing);
    backend.shutdown();
    thread::sleep(Duration::from_millis(200));
    let reopened = Backend::new(
        output.join("app-data"),
        base.join("../public/examples"),
        base.join("../../../workers/blender/worker.py"),
    );
    let after = reopened.request(json!({"action":"bootstrap"}))?;
    if before["project"]["assets"] != after["project"]["assets"] {
        bail!("Project reopen changed immutable asset versions")
    }
    let export = reopened
        .request(json!({"action":"export","destination":output.join("exports"),"assetIds":[]}))?;
    let evidence = json!({"nativeBackend":true,"nativeWindow":false,"providerLiveGeneration":false,"requestedModel":asset_providers::REQUESTED_IMAGE_MODEL,"confirmedModel":null,"images":12,"project":root,"reopened":true,"concurrentProjectOpenRejected":true,"ownershipCheckScope":"same-process independent handles","shutdownReleaseVerified":true,"explicitCacheReuse":true,"jobs":after["project"]["jobs"],"assets":after["project"]["assets"].as_array().unwrap().len(),"bundle":export["path"],"environment":reopened.request(json!({"action":"environment"}))?});
    std::fs::write(
        output.join("smoke.json"),
        serde_json::to_vec_pretty(&evidence)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&evidence)?);
    reopened.shutdown();
    Ok(())
}
fn wait_idle(backend: &Backend, timeout: u64) -> Result<()> {
    let started = Instant::now();
    loop {
        let state = backend.request(json!({"action":"snapshot"}))?;
        let jobs = state["project"]["jobs"].as_array().unwrap();
        if jobs.iter().all(|j| {
            [
                "succeeded",
                "failed",
                "cancelled",
                "waiting_user",
                "external_unknown",
            ]
            .contains(&j["status"].as_str().unwrap_or(""))
        }) {
            let failures: Vec<&Value> =
                jobs.iter().filter(|j| j["status"] != "succeeded").collect();
            if !failures.is_empty() {
                bail!("Native jobs failed: {}", serde_json::to_string(&failures)?)
            }
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(timeout) {
            bail!("Native smoke timed out")
        };
        thread::sleep(Duration::from_millis(250));
    }
}
