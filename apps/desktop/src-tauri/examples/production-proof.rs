//! Real Mac game-root -> GPT plan -> individual PNG + neural GLB -> delivery.
//! Uses a fresh synthetic project; never modifies a user's game or authentication.
use anyhow::{bail, Context, Result};
use asset_core::Repository;
use asset_desktop::workbench::Backend;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

fn write(path: &Path, value: &Value) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.sync_all()?;
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if !(2..=3).contains(&args.len()) {
        bail!("Usage: production-proof <fresh-output> <prepared-runtime> [--resume]");
    }
    let resume = args.get(2).is_some_and(|s| s == "--resume");
    if args.len() == 3 && !resume {
        bail!("Unknown proof option");
    }
    let output = PathBuf::from(&args[0]);
    if !resume {
        fs::create_dir(&output)?;
    } else if !output.join("failure-state.json").is_file() {
        bail!("Only an existing isolated failed proof can be resumed.");
    }
    let output = output.canonicalize()?;
    let runtime = PathBuf::from(&args[1]).canonicalize()?;
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()?;
    let data = output.join("app-data");
    fs::create_dir_all(data.join("image3d"))?;
    #[cfg(unix)]
    if !resume {
        std::os::unix::fs::symlink(runtime, data.join("image3d/triposr-cpu-v1"))?;
    }
    let game = output.join("game-project");
    if !resume {
        fs::create_dir(&game)?;
    }
    let originals=[("project.godot","[application]\nconfig/name=\"Space Survival Proof\"\n"),
        ("main.tscn","[gd_scene load_steps=3 format=3]\n[ext_resource type=\"Texture2D\" path=\"res://assets/fuel_cell.png\" id=\"1\"]\n[ext_resource type=\"PackedScene\" path=\"res://assets/basalt_asteroid.glb\" id=\"2\"]\n[node name=\"Main\" type=\"Node3D\"]\n")];
    for (name, text) in originals {
        if !resume {
            fs::write(game.join(name), text)?;
        } else if fs::read_to_string(game.join(name))? != text {
            bail!("Proof source fixture changed.");
        }
    }
    // A secret fixture verifies that source content and secret filenames stay local.
    if !resume {
        fs::write(game.join(".env"), "PRIVATE_PROOF_SENTINEL=never_upload\n")?;
    }
    let before: Vec<_> = ["project.godot", "main.tscn", ".env"]
        .iter()
        .map(|s| asset_core::sha256_file(&game.join(s)))
        .collect::<Result<_>>()?;
    let backend = Backend::new(
        data,
        source.join("apps/desktop/public/examples"),
        source.join("workers/blender/worker.py"),
    );
    backend.start();
    let result = (|| -> Result<Value> {
        backend.request(json!({"action":"bootstrap"}))?;
        let connected = if resume {
            backend.request(json!({"action":"production_state"}))?
        } else {
            backend.request(json!({"action":"game_connect","root":game}))?
        };
        if connected["connection"]["engine"] != "godot"
            || connected["connection"]["missingReferences"]
                .as_array()
                .context("missing")?
                .len()
                != 2
        {
            bail!("Engine/missing-reference discovery failed.");
        }
        if !resume {
            write(&output.join("connection.json"), &connected)?;
            let provider = backend.request(json!({"action":"provider_status"}))?;
            if provider["ready"] != true {
                bail!("Official GPT subscription is not ready.");
            }
        }
        let planned = if resume {
            connected.clone()
        } else {
            backend.request(json!({"action":"production_plan","brief":"Space Survival is a small game prototype. Its complete visual scope for this proof is EXACTLY TWO assets: one 2D SPRITE inventory icon named Fuel Cell, and one standalone rigid 3D MODEL named Basalt Asteroid. These are the two missing project references. Plan exactly these two items and nothing else. Use a coherent realistic science-fiction style. Fuel Cell: one upright orange power capsule with a dark metal shell. Basalt Asteroid: one connected dark gray irregular volcanic rock, clear solid silhouette, rough basalt surfaces, no rings, no ground or stand. No animation, rigging, sound, code or UI screens are needed in this prototype.","output":"mixed","referenceAssetIds":[],"uploadApproved":true}))?
        };
        let plan = planned["plan"].clone();
        let items = plan["items"].as_array().context("items")?;
        if items.len() != 2
            || items.iter().filter(|i| i["kind"] == "model").count() != 1
            || items.iter().any(|i| !i["modelParameters"].is_null())
        {
            bail!("Expected exactly one individual sprite and one neural model.");
        }
        if !resume {
            write(&output.join("plan.json"), &plan)?;
        }
        let request = json!({"action":"production_start","planId":plan["id"],"requestId":uuid::Uuid::new_v4().to_string(),"uploadApproved":true});
        let admitted = if resume {
            let run = &connected["runs"][0];
            let item = run["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|i| i["status"] == "needs_attention")
                .context("Failed stage")?;
            backend.request(
                json!({"action":"production_retry","runId":run["id"],"itemId":item["id"]}),
            )?
        } else {
            backend.request(request.clone())?
        };
        let count = admitted["snapshot"]["project"]["jobs"]
            .as_array()
            .context("jobs")?
            .len();
        if count != 3 {
            bail!("Expected atomic DAG with three stages.");
        }
        let replay = if resume {
            admitted.clone()
        } else {
            backend.request(request)?
        };
        if replay["snapshot"]["project"]["jobs"]
            .as_array()
            .unwrap()
            .len()
            != count
        {
            bail!("Repeat start duplicated jobs.");
        }
        let start = Instant::now();
        let mut previous = String::new();
        let state = loop {
            let snapshot = backend.snapshot()?;
            let progress = snapshot["project"]["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|j| format!("{}:{}:{}", j["kind"], j["status"], j["progress"]["stage"]))
                .collect::<Vec<_>>()
                .join(" | ");
            if progress != previous {
                println!("{progress}");
                previous = progress;
            }
            let state = backend.request(json!({"action":"production_state"}))?;
            if state["runs"][0]["status"] == "completed" {
                break state;
            }
            if state["runs"][0]["status"] == "needs_attention"
                || start.elapsed() > Duration::from_secs(2400)
            {
                write(
                    &output.join(if resume {
                        "failure-state-resumed-2.json"
                    } else {
                        "failure-state.json"
                    }),
                    &state,
                )?;
                bail!("Native production failed or timed out; isolated evidence preserved.");
            }
            thread::sleep(Duration::from_millis(800));
        };
        let snapshot = backend.snapshot()?;
        let repo = Repository::open(Path::new(snapshot["root"].as_str().context("workspace")?))?;
        for asset in repo.project()?.assets {
            for version in asset.versions {
                for artifact in version.artifacts {
                    repo.verify_artifact(&artifact)?;
                }
            }
        }
        let run = &state["runs"][0];
        for item in run["items"].as_array().unwrap() {
            let path = PathBuf::from(item["outputPath"].as_str().context("delivery")?);
            let manifest: Value = serde_json::from_slice(&fs::read(path.join("manifest.json"))?)?;
            for file in manifest["files"].as_array().unwrap() {
                let (hash, bytes) =
                    asset_core::sha256_file(&path.join(file["path"].as_str().unwrap()))?;
                if hash != file["sha256"].as_str().unwrap() || Some(bytes) != file["bytes"].as_u64()
                {
                    bail!("Delivered file integrity failed.");
                }
            }
            backend.request(json!({"action":"production_review","runId":run["id"],"itemId":item["id"],"approved":true}))?;
        }
        let after: Vec<_> = ["project.godot", "main.tscn", ".env"]
            .iter()
            .map(|s| asset_core::sha256_file(&game.join(s)))
            .collect::<Result<_>>()?;
        if before != after {
            bail!("Original game files changed.");
        }
        let state = backend.request(json!({"action":"production_state"}))?;
        if state["runs"][0]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["review"] != "approved")
        {
            bail!("Review persistence failed.");
        }
        write(&output.join("final-state.json"), &state)?;
        write(&output.join("final-snapshot.json"), &snapshot)?;
        if snapshot["project"]["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|j| j["kind"] == "image_generate")
            .any(|j| j["attempts"] != 1)
        {
            bail!("Local retry resubmitted a GPT image.");
        }
        Ok(
            json!({"nativeBackend":true,"platform":std::env::consts::OS,"plannerLive":true,"gptImagesLive":true,"localReconstructionLive":true,"gameRoot":game,"workspace":snapshot["root"],"stages":count,"results":2,"elapsedSeconds":start.elapsed().as_secs(),"duplicateStartPrevented":true,"resumedLocalOnly":resume,"gptImageAttempts":1,"originalHashesPreserved":true,"deliveryHashesVerified":true,"reviewsPersisted":true,"state":state}),
        )
    })();
    backend.shutdown();
    write(
        &output.join(if resume {
            "verification-resumed-2.json"
        } else {
            "verification.json"
        }),
        &match &result {
            Ok(v) => v.clone(),
            Err(e) => json!({"passed":false,"error":e.to_string()}),
        },
    )?;
    result.map(|_| ())
}
