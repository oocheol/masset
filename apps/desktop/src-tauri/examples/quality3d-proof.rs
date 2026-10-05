//! Real Mac production-backend acceptance, isolated from user projects.
use anyhow::{bail, Context, Result};
use asset_core::Repository;
use asset_desktop::workbench::Backend;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

fn write(path: &Path, value: &Value) -> Result<()> {
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.sync_all()?;
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if !(4..=5).contains(&args.len()) {
        bail!("Usage: quality3d-proof <fresh-output> <prepared-runtime> <image> <GLB> [draft|standard|high]");
    }
    let quality = args.get(4).and_then(|v| v.to_str()).unwrap_or("standard");
    if !["draft", "standard", "high"].contains(&quality) {
        bail!("Invalid quality");
    }
    let output = PathBuf::from(&args[0]);
    fs::create_dir(&output)?;
    let runtime = PathBuf::from(&args[1]).canonicalize()?;
    let inputs = [
        PathBuf::from(&args[2]).canonicalize()?,
        PathBuf::from(&args[3]).canonicalize()?,
    ];
    let original: Vec<_> = inputs
        .iter()
        .map(|p| asset_core::sha256_file(p))
        .collect::<Result<_>>()?;
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()?;
    let data = output.join("app-data");
    fs::create_dir_all(data.join("image3d"))?;
    #[cfg(unix)]
    std::os::unix::fs::symlink(&runtime, data.join("image3d/triposr-cpu-v1"))?;
    #[cfg(not(unix))]
    bail!("This proof is currently Mac-only.");
    let backend = Backend::new(
        data,
        source.join("apps/desktop/public/examples"),
        source.join("workers/blender/worker.py"),
    );
    backend.start();
    let result = (|| -> Result<Value> {
        backend.request(json!({"action":"bootstrap"}))?;
        let before = backend.request(json!({"action":"import","paths":inputs}))?;
        let ids: Vec<_> = before["project"]["assets"]
            .as_array()
            .context("assets")?
            .iter()
            .filter(|a| a["versions"][0]["source"] == "import")
            .map(|a| a["id"].as_str().unwrap().to_owned())
            .collect();
        if ids.len() != 2 {
            bail!("Expected two copied source assets.");
        }
        let request = json!({"action":"quality3d","assetIds":ids,"name":"Native Quality Asset","quality":quality,"heightMeters":1.0,"maxTriangles":10000,"textureResolution":1024,"preserveMaterials":true});
        let mut invalid = request.clone();
        invalid["assetIds"] = json!([ids[0], ids[0]]);
        if backend.request(invalid).is_ok() {
            bail!("Duplicate input was admitted.");
        }
        let before_jobs = backend.snapshot()?["project"]["jobs"]
            .as_array()
            .unwrap()
            .len();
        let admitted = backend.request(request)?;
        if admitted["project"]["jobs"].as_array().unwrap().len() != before_jobs + 2 {
            bail!("Atomic two-item admission failed.");
        }
        let start = Instant::now();
        let mut previous = String::new();
        let final_state = loop {
            let state = backend.snapshot()?;
            let jobs = state["project"]["jobs"].as_array().unwrap();
            let progress = jobs
                .iter()
                .map(|j| format!("{}:{}:{}", j["kind"], j["status"], j["progress"]["stage"]))
                .collect::<Vec<_>>()
                .join(" | ");
            if previous != progress {
                println!("{progress}");
                previous = progress;
            }
            if jobs
                .iter()
                .any(|j| j["status"] == "failed" || j["status"] == "cancelled")
            {
                write(&output.join("failed-snapshot.json"), &state)?;
                bail!("Native quality worker failed; preserved proof snapshot.");
            }
            if jobs.iter().all(|j| j["status"] == "succeeded") {
                break state;
            }
            if start.elapsed() > Duration::from_secs(2400) {
                bail!("Native quality proof exceeded its bound.");
            }
            thread::sleep(Duration::from_millis(750));
        };
        let project = PathBuf::from(final_state["root"].as_str().context("project root")?);
        let repo = Repository::open(&project)?;
        for asset in repo.project()?.assets {
            for version in asset.versions {
                for artifact in version.artifacts {
                    repo.verify_artifact(&artifact)?;
                }
            }
        }
        let models: Vec<_> = final_state["project"]["assets"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|a| a["kind"] == "model")
            .cloned()
            .collect();
        if models.len() != 2 {
            bail!("Exactly two independent model assets were expected.");
        }
        if !models
            .iter()
            .any(|a| a["versions"].as_array().is_some_and(|v| v.len() == 2))
        {
            bail!("Existing GLB did not retain its original version.");
        }
        for model in &models {
            if model["mesh"]["triangles"].as_u64().unwrap_or(u64::MAX) > 10000 {
                bail!("Budget exceeded.");
            }
            let version = model["versions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["id"] == model["activeVersionId"])
                .unwrap();
            if version["validation"]["valid"] != true {
                bail!("Missing file validation.");
            }
        }
        for (index, path) in inputs.iter().enumerate() {
            if asset_core::sha256_file(path)? != original[index] {
                bail!("An original was modified.");
            }
        }
        let export=backend.request(json!({"action":"export","destination":output.join("export"),"assetIds":models.iter().map(|a|a["id"].clone()).collect::<Vec<_>>()}))?;
        write(&output.join("final-snapshot.json"), &final_state)?;
        Ok(
            json!({"nativeBackend":true,"nativeWindow":false,"platform":std::env::consts::OS,"passed":true,"providerRequests":0,"cloudInference":false,"runtime":runtime,
            "models":models,"inputs":inputs,"inputHashes":original,"originalsUnchanged":true,"project":project,"export":export["path"],"elapsedSeconds":start.elapsed().as_secs_f64(),
            "boundary":"Real CPU image reconstruction + trusted Blender finishing; separate native-window and independent artifact checks required."}),
        )
    })();
    backend.shutdown();
    let evidence = result?;
    write(&output.join("quality3d-proof.json"), &evidence)?;
    println!("Native local quality proof passed.");
    Ok(())
}
