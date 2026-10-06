use super::*;

pub(super) fn produce(args: &Args, backend: &Backend, root: &Path) -> Result<()> {
    args.allow_gpt()?;
    let request_id = args.required("--request-id")?;
    Uuid::parse_str(request_id)?;
    let manifest_path = args.path("--manifest")?;
    let mut input = read_json(&manifest_path)?;
    let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&input)?));
    let reference_paths: Vec<String> = input
        .as_object_mut()
        .context("Manifest must be an object")?
        .remove("referencePaths")
        .map(serde_json::from_value)
        .transpose()?
        .unwrap_or_default();
    if reference_paths.len() > 5 {
        bail!("Select at most five reference files");
    }
    let references: Vec<PathBuf> = reference_paths
        .iter()
        .map(|p| absolute(p))
        .collect::<Result<_>>()?;
    let receipt = root.join(format!("cli-request-{request_id}.json"));
    let game = args.path("--game-root")?.canonicalize()?;
    if receipt.is_file() {
        let recorded = read_json(&receipt)?;
        if recorded["manifestSha256"] != hash || recorded["gameRoot"] != json!(game) {
            bail!("Request UUID belongs to a different manifest or game root. Existing run preserved.");
        }
    } else {
        // Reserve intent before provider admission, so a lost response cannot
        // turn a repeated invocation into a second remote image request.
        let bytes = serde_json::to_vec_pretty(
            &json!({"schemaVersion":1,"requestId":request_id,"manifestSha256":hash,"gameRoot":game}),
        )?;
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&receipt)?
            .write_all(&bytes)?;
    }
    let state = backend.request(json!({"action":"production_state"}))?;
    if let Some(run) = state["runs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == request_id)
    {
        // Reattach an existing DAG without creating a new plan or resubmitting
        // completed/unknown jobs. Maintenance-paused jobs require an explicit
        // continuation command rather than a hidden remote retry.
        emit(&json!({"type":"resumed","runId":run["id"],"workspace":root}))?;
        backend.request(json!({"action":"production_start","planId":run["planId"],"requestId":request_id,"uploadApproved":true}))?;
    } else {
        let status = backend.request(json!({"action":"provider_status"}))?;
        if status["ready"] != true {
            bail!("Official GPT subscription/image tool unavailable. Run asset-cli prepare --consent-downloads --login-if-needed, then check doctor --check-gpt. No paid API fallback.");
        }
        backend.request(json!({"action":"game_connect","root":game}))?;
        let before = backend.snapshot()?;
        let mut reference_ids = Vec::new();
        if !references.is_empty() {
            let imported = backend.request(json!({"action":"import","paths":references}))?;
            reference_ids = imported["project"]["assets"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|a| {
                    !before["project"]["assets"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|old| old["id"] == a["id"])
                })
                .map(|a| a["id"].clone())
                .collect();
        }
        let plan=backend.request(json!({"action":"production_manifest","manifest":input,"referenceAssetIds":reference_ids}))?;
        emit(&json!({"type":"plan","workspace":root,"runId":request_id,"plan":plan["plan"]}))?;
        backend.request(json!({"action":"production_start","planId":plan["plan"]["id"],"requestId":request_id,"uploadApproved":true}))?;
    }
    backend.start();
    wait(backend, root, args.timeout()?, Some(request_id), &[])?;
    let final_state = backend.request(json!({"action":"production_state"}))?;
    let run = final_state["runs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == request_id)
        .context("Production run not found")?;
    let verified = if run["status"] == "completed" {
        Some(backend.request(json!({"action":"production_verify","runId":request_id}))?)
    } else {
        None
    };
    emit(
        &json!({"type":"result","workspace":root,"run":run,"deliveryVerification":verified,"gameIntegrationVerified":false,"gameBuildVerified":false}),
    )?;
    if run["status"] != "completed" {
        bail!("Production needs attention. Read individual job errors; unknown GPT requests were not resent.");
    }
    Ok(())
}
