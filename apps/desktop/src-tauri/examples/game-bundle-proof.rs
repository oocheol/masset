//! Opt-in actual game-bundle proof in a fresh private project. Images require
//! --generate; no login, retry, user-project changes or generated script runs.
use anyhow::{bail, ensure, Context, Result};
use asset_desktop::workbench::Backend;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

fn save(path: PathBuf, value: &Value) -> Result<()> {
    use std::io::Write;
    let mut f = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)?;
    f.write_all(&serde_json::to_vec_pretty(value)?)?;
    f.sync_all()?;
    Ok(())
}
fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let mut output = None;
    let mut generate = false;
    let mut model_reference = None;
    while let Some(arg) = args.next() {
        match arg.to_str() {
        Some("--output") if output.is_none()=>output=Some(PathBuf::from(args.next().context("Fresh output required")?)),
        Some("--generate") if !generate=>generate=true,
        Some("--model-reference") if model_reference.is_none()=>model_reference=Some(PathBuf::from(args.next().context("Existing verified GLB required")?)),
        _=>bail!("Usage: game-bundle-proof --output <fresh-absolute-directory> [--generate] [--model-reference <GLB>]")
    }
    }
    let output = output.context("Fresh output is required")?;
    ensure!(
        output.is_absolute() && !output.exists(),
        "Existing inputs and proof directories are preserved"
    );
    fs::create_dir_all(&output)?;
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let backend = Backend::new(
        output.join("app-data"),
        source.join("../public/examples"),
        source.join("../../../workers/blender/worker.py"),
    );
    let result = prove(&backend, &output, generate, model_reference);
    backend.shutdown();
    result
}

fn prove(
    backend: &Backend,
    output: &std::path::Path,
    generate: bool,
    model_reference: Option<PathBuf>,
) -> Result<()> {
    let mut snapshot=backend.request(json!({"action":"create","root":output.join("project"),"name":"Space war individual game assets"}))?;
    let mut spec = snapshot["project"]["spec"].clone();
    spec["width"] = json!(512);
    spec["height"] = json!(512);
    spec["polygonBudget"] = json!(10000);
    let mut style = snapshot["project"]["styleGuide"].clone();
    style["name"] = json!("Space war · readable individual assets");
    style["palette"] = json!(["#516378", "#4bd1e8", "#bd6571", "#d4bd8a"]);
    style["approved"] = json!(true);
    backend.request(json!({"action":"update","spec":spec,"styleGuide":style}))?;
    snapshot = backend.request(json!({"action":"fixture","count":1}))?;
    if let Some(path) = model_reference {
        ensure!(
            path.is_absolute() && path.is_file(),
            "Model reference must be an existing actual GLB"
        );
        snapshot = backend.request(json!({"action":"import","paths":[path]}))?;
    }
    let baseline = snapshot["project"]["assets"]
        .as_array()
        .context("Initial assets missing")?
        .clone();
    let refs: Vec<_> = baseline.iter().map(|a| a["id"].clone()).collect();
    let status = backend.request(json!({"action":"provider_status"}))?;
    ensure!(
        status["ready"] == true,
        "Official subscription readiness required; no login was attempted"
    );
    let brief="우주전쟁 게임에 필요한 서로 다른 무기 아이콘 5가지를 각각 독립 PNG로 만들고, 우주선 3D 모델 1개와 군수품 상자 3D 모델 1개도 함께 구성해 주세요. 무기는 플라스마 소총, 레이저 권총, 중력 대포, EMP 발사기, 광자 검입니다. 각 이미지에는 해당 무기 하나만 있어야 합니다. 무기 5개가 함께 있는 콜라주나 목록 이미지를 만들지 마세요. 참고 이미지는 공통 팔레트와 단순한 실루엣 기준이며, 참고 모델은 치수·메시 정보만 사용하세요. 3D는 제공된 고정 절차적 템플릿으로 만들고 원본 모델을 덮어쓰지 마세요.";
    let mut plan=backend.request(json!({"action":"plan_assets","brief":brief,"output":"mixed","mode":"new","count":5,"referenceAssetIds":refs,"referenceUploadApproved":true}))?;
    let items = plan["items"]
        .as_array()
        .context("Individual plan items missing")?;
    let images = items.iter().filter(|i| i["kind"] != "model").count();
    let models = items.len() - images;
    ensure!(
        images == 5 && models == 2,
        "Expected five individual weapon images and two procedural models"
    );
    let names: std::collections::HashSet<_> =
        items.iter().filter_map(|i| i["name"].as_str()).collect();
    ensure!(names.len() == 7, "Names must be distinct");
    save(output.join("reviewed-plan.json"), &plan)?;
    let mut report = json!({"nativeBackend":true,"nativeWindow":false,"generationRequested":generate,"loginRequested":false,"automaticRetry":false,"userInstallationModified":false,"baselineAssets":baseline.len(),"referenceCount":refs.len(),"plannedImages":images,"plannedModels":models,"plannedDistinctNames":names.len(),"textPlannerCompleted":true,"status":"plan_complete"});
    if !generate {
        save(output.join("game-bundle-proof.json"), &report)?;
        println!("{}", report);
        return Ok(());
    }
    // This harness explicitly reviews the actual typed plan, then reuses one
    // request identity to check admission before starting any worker.
    plan["styleGuide"]["approved"] = json!(true);
    backend
        .request(json!({"action":"update","spec":plan["spec"],"styleGuide":plan["styleGuide"]}))?;
    let request = json!({"action":"generate_bundle","requestId":uuid::Uuid::new_v4(),"plan":plan,"approved":true,"referenceUploadApproved":true});
    backend.request(request.clone())?;
    snapshot = backend.request(request)?;
    ensure!(
        snapshot["project"]["jobs"]
            .as_array()
            .context("Jobs missing")?
            .len()
            == 7,
        "Repeated submit duplicated or omitted work"
    );
    report["atomicBatchSubmitted"] = json!(true);
    report["duplicateSubmitRejected"] = json!(true);
    backend.start();
    let started = Instant::now();
    let mut last = String::new();
    loop {
        snapshot = backend.snapshot()?;
        let jobs = snapshot["project"]["jobs"]
            .as_array()
            .context("Jobs missing")?;
        let completed = jobs.iter().filter(|j| j["status"] == "succeeded").count();
        let stages = jobs
            .iter()
            .map(|j| {
                format!(
                    "{}:{}",
                    j["label"].as_str().unwrap_or("asset"),
                    j["status"].as_str().unwrap_or("unknown")
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        if stages != last {
            println!("{completed}/7 completed · {stages}");
            last = stages;
        }
        if jobs.iter().any(|j| {
            ["failed", "external_unknown", "cancelled"]
                .contains(&j["status"].as_str().unwrap_or(""))
        }) {
            report["status"] = json!("job_failed_no_automatic_retry");
            report["jobs"] = json!(jobs);
            save(output.join("game-bundle-proof.json"), &report)?;
            bail!("A job failed; receipts retained and no retry was made")
        }
        if completed == 7 {
            break;
        }
        if started.elapsed() > Duration::from_secs(1800) {
            report["status"] = json!("timeout_no_retry");
            save(output.join("game-bundle-proof.json"), &report)?;
            bail!("Proof timed out; existing output preserved")
        }
        thread::sleep(Duration::from_secs(1));
    }
    let assets = snapshot["project"]["assets"]
        .as_array()
        .context("Assets missing")?;
    ensure!(
        assets.len() == baseline.len() + 7,
        "Each planned item must become exactly one independent asset"
    );
    let generated: Vec<_> = assets
        .iter()
        .filter(|a| !baseline.iter().any(|b| a["id"] == b["id"]))
        .cloned()
        .collect();
    for a in &generated {
        ensure!(
            a["versions"][0]["validation"]["valid"] == true,
            "Output validation did not pass"
        );
        if a["kind"] != "model" {
            ensure!(
                a["width"] == 512 && a["height"] == 512,
                "Individual images were not normalized to approved dimensions"
            );
        }
    }
    for original in &baseline {
        ensure!(
            assets.iter().any(|a| a == original),
            "A reference original was changed"
        );
    }
    let export=backend.request(json!({"action":"export","destination":output.join("exports"),"preset":"game","format":"png"}))?;
    report["export"] = export.clone();
    report["generatedAssets"] = json!(generated);
    report["jobs"] = snapshot["project"]["jobs"].clone();
    report["referenceOriginalsPreserved"] = json!(true);
    report["status"] = json!("completed");
    let project = PathBuf::from(snapshot["root"].as_str().context("Project path missing")?);
    backend.shutdown();
    let reopened = backend.request(json!({"action":"open","root":project}));
    // Shutdown backends cannot reopen; use a new independent actor below.
    ensure!(
        reopened.is_err(),
        "Shutdown guard should reject new requests"
    );
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let new_backend = Backend::new(
        output.join("reopen-data"),
        source.join("../public/examples"),
        source.join("../../../workers/blender/worker.py"),
    );
    let reopened = new_backend.request(json!({"action":"open","root":project}))?;
    ensure!(
        reopened["project"]["assets"] == snapshot["project"]["assets"],
        "Assets/versions changed after reopening"
    );
    new_backend.shutdown();
    report["projectReopened"] = json!(true);
    save(output.join("game-bundle-proof.json"), &report)?;
    println!(
        "{}",
        json!({"status":"completed","images":5,"models":2,"independentAssets":7,"reopened":true,"report":output.join("game-bundle-proof.json")})
    );
    Ok(())
}
