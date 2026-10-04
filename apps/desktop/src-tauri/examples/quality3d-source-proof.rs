//! A real native regression: increasing a mesh budget must recover preserved detail.
use anyhow::{ensure, Context, Result};
use asset_core::Repository;
use asset_desktop::workbench::Backend;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

fn wait(backend: &Backend, output: &Path) -> Result<Value> {
    let started = Instant::now();
    loop {
        let state = backend.snapshot()?;
        let jobs = state["project"]["jobs"].as_array().context("jobs")?;
        if jobs
            .iter()
            .any(|job| job["status"] == "failed" || job["status"] == "cancelled")
        {
            fs::write(
                output.join("failed-snapshot.json"),
                serde_json::to_vec_pretty(&state)?,
            )?;
            anyhow::bail!("Native refinement failed; retained snapshot.");
        }
        if jobs.iter().all(|job| job["status"] == "succeeded") {
            return Ok(state);
        }
        ensure!(
            started.elapsed() < Duration::from_secs(1200),
            "Native refinement timed out"
        );
        thread::sleep(Duration::from_millis(500));
    }
}

fn model(state: &Value) -> Result<&Value> {
    state["project"]["assets"]
        .as_array()
        .context("assets")?
        .iter()
        .find(|asset| asset["kind"] == "model")
        .context("model")
}

fn active(asset: &Value) -> Result<&Value> {
    asset["versions"]
        .as_array()
        .context("versions")?
        .iter()
        .find(|version| version["id"] == asset["activeVersionId"])
        .context("active version")
}

fn main() -> Result<()> {
    ensure!(
        cfg!(all(target_os = "macos", target_arch = "aarch64")),
        "Mac arm64 proof only"
    );
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    ensure!(
        args.len() == 2,
        "Usage: quality3d-source-proof <fresh-output> <GLB>"
    );
    let output = PathBuf::from(&args[0]);
    fs::create_dir(&output)?;
    let input = PathBuf::from(&args[1]).canonicalize()?;
    let original = asset_core::sha256_file(&input)?;
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()?;
    let backend = Backend::new(
        output.join("app-data"),
        source.join("apps/desktop/public/examples"),
        source.join("workers/blender/worker.py"),
    );
    backend.start();
    let result = (|| -> Result<Value> {
        backend.request(json!({"action":"bootstrap"}))?;
        let imported = backend.request(json!({"action":"import","paths":[input]}))?;
        let id = model(&imported)?["id"]
            .as_str()
            .context("model id")?
            .to_owned();
        let submit = |budget| {
            backend.request(json!({"action":"quality3d","assetIds":[id],"name":"Preserved detail","quality":"high","heightMeters":1.0,"maxTriangles":budget,"textureResolution":512,"preserveMaterials":true}))
        };
        submit(1000)?;
        let low = wait(&backend, &output)?;
        let low_model = model(&low)?;
        let low_count = low_model["mesh"]["triangles"]
            .as_u64()
            .context("low count")?;
        let low_version = active(low_model)?;
        let high_id = low_version["settings"]["quality3dFiles"]["high"]
            .as_str()
            .context("high id")?;
        let preserved = low_version["artifacts"]
            .as_array()
            .context("artifacts")?
            .iter()
            .find(|artifact| artifact["id"] == high_id)
            .context("preserved high GLB")?
            .clone();
        ensure!(low_count <= 1000, "Initial budget was exceeded");
        let admitted = submit(2000)?;
        let payload = &admitted["project"]["jobs"]
            .as_array()
            .context("jobs")?
            .last()
            .context("job")?["payload"];
        ensure!(
            payload["source"] == preserved["path"]
                && payload["sourceSha256"] == preserved["sha256"],
            "Refinement chose the reduced game mesh"
        );
        let final_state = wait(&backend, &output)?;
        let final_model = model(&final_state)?;
        let final_count = final_model["mesh"]["triangles"]
            .as_u64()
            .context("final count")?;
        ensure!(
            final_count > low_count && final_count <= 2000,
            "Increasing the budget did not recover preserved detail"
        );
        ensure!(
            final_model["versions"]
                .as_array()
                .context("versions")?
                .len()
                == 3,
            "Versions were not retained"
        );
        ensure!(
            asset_core::sha256_file(&input)? == original,
            "Original changed"
        );
        let project = PathBuf::from(final_state["root"].as_str().context("root")?);
        let repo = Repository::open(&project)?;
        for asset in repo.project()?.assets {
            for version in asset.versions {
                for artifact in version.artifacts {
                    repo.verify_artifact(&artifact)?;
                }
            }
        }
        let export = backend.request(
            json!({"action":"export","destination":output.join("export"),"assetIds":[id]}),
        )?;
        fs::write(
            output.join("final-snapshot.json"),
            serde_json::to_vec_pretty(&final_state)?,
        )?;
        Ok(
            json!({"passed":true,"nativeBackend":true,"nativeWindow":false,"platform":"macos-arm64","lowTriangles":low_count,"restoredTriangles":final_count,"preservedHighUsed":true,"allOriginalAndVersionArtifactsVerified":true,"originalHash":original,"providerRequests":0,"project":project,"export":export["path"]}),
        )
    })();
    backend.shutdown();
    let evidence = result?;
    fs::write(
        output.join("quality3d-source-proof.json"),
        serde_json::to_vec_pretty(&evidence)?,
    )?;
    println!("{}", serde_json::to_string(&evidence)?);
    Ok(())
}
