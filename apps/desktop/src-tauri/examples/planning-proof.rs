//! Live subscription planning with a supplied brief and read-only game root.
//! Uses an isolated workspace, never generates assets or executes game inputs.
use anyhow::{bail, Context, Result};
use asset_desktop::workbench::Backend;
use serde_json::json;
use std::{fs, path::PathBuf, time::Instant};

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 3 {
        bail!("Usage: planning-proof <new-output> <brief-file> <game-root>");
    }
    let output = PathBuf::from(&args[0]);
    fs::create_dir(&output)?;
    let output = output.canonicalize()?;
    let brief = fs::read_to_string(PathBuf::from(&args[1]))?;
    let game = PathBuf::from(&args[2]).canonicalize()?;
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let backend = Backend::new(
        output.join("app-data"),
        source.join("apps/desktop/public/examples"),
        source.join("workers/blender/worker.py"),
    );
    backend.request(json!({"action":"bootstrap"}))?;
    let before = backend.request(json!({"action":"game_connect","root":game}))?;
    let started = Instant::now();
    let result = backend.request(json!({"action":"production_plan","brief":brief,
        "output":"mixed","referenceAssetIds":[],"uploadApproved":true}));
    let elapsed = started.elapsed().as_secs_f64();
    match result {
        Ok(state) => {
            let items = state["plan"]["items"].as_array().context("No items")?;
            let after = backend.request(json!({"action":"game_connect","root":game}))?;
            let originals_preserved =
                before["connection"]["fingerprint"] == after["connection"]["fingerprint"];
            let jobs = backend.request(json!({"action":"snapshot"}))?["project"]["jobs"]
                .as_array()
                .context("No jobs")?
                .len();
            fs::write(
                output.join("plan.json"),
                serde_json::to_vec_pretty(&state["plan"])?,
            )?;
            let report = json!({"verified":originals_preserved && jobs == 0 && !items.is_empty(),
                "nativeBackend":true,"liveGptPlanner":true,"plannerModel":state["plan"]["plannerModel"],
                "elapsedSeconds":elapsed,"inventory":before["connection"]["assetCount"],
                "scanWarnings":before["connection"]["warnings"],"items":items.len(),
                "images":items.iter().filter(|i| i["kind"] != "model").count(),
                "models":items.iter().filter(|i| i["kind"] == "model").count(),
                "warningCount":state["plan"]["warnings"].as_array().map(Vec::len),
                "originalGameFingerprintUnchanged":originals_preserved,"generationJobs":jobs,
                "planningLimitSeconds":600,"automaticResubmissions":0});
            fs::write(
                output.join("verification.json"),
                serde_json::to_vec_pretty(&report)?,
            )?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if report["verified"] != true {
                bail!("Planning proof invariant failed");
            }
        }
        Err(error) => {
            // Backend planning errors are fixed public messages; never dump an
            // app-server stream, credentials, user prompt or reference contents.
            fs::write(
                output.join("failure.json"),
                serde_json::to_vec_pretty(&json!({
                "verified":false,"elapsedSeconds":elapsed,"error":error.to_string(),
                "inventory":before["connection"]["assetCount"]}))?,
            )?;
            bail!("Native planning failed; see isolated failure.json");
        }
    }
    Ok(())
}
