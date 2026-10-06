use super::*;

pub(super) fn wait(
    backend: &Backend,
    root: &Path,
    timeout: u64,
    run_id: Option<&str>,
    job_ids: &[String],
) -> Result<Value> {
    let start = Instant::now();
    let mut previous = Value::Null;
    loop {
        let snapshot = backend.snapshot()?;
        let jobs: Vec<_> = snapshot["project"]["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|j| match run_id {
                Some(id) => j["payload"]["productionRunId"] == id,
                None => job_ids.iter().any(|id| j["id"] == id.as_str()),
            })
            .collect();
        let primary_ids: Vec<_> = jobs.iter().filter_map(|job| job["id"].as_str()).collect();
        let previews: Vec<_> = snapshot["project"]["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|job| {
                job["kind"] == "quality3d_preview"
                    && job["payload"]["parentJobId"]
                        .as_str()
                        .is_some_and(|id| primary_ids.contains(&id))
            })
            .collect();
        let mut counts = BTreeMap::<String, usize>::new();
        for j in &jobs {
            *counts
                .entry(j["status"].as_str().unwrap_or("unknown").into())
                .or_default() += 1;
        }
        let progress = json!({"type":"progress","workspace":root,"runId":run_id,"counts":counts,
            "coreComplete":!jobs.is_empty() && jobs.iter().all(|j|j["status"]=="succeeded"),
            "optionalPreviews":previews.iter().map(|j|json!({"id":j["id"],"status":j["status"],"progress":j["progress"]})).collect::<Vec<_>>(),
            "active":jobs.iter().filter(|j|j["status"]=="running").map(|j|json!({"id":j["id"],"kind":j["kind"],"progress":j["progress"]})).collect::<Vec<_>>()});
        if previous != progress {
            let temporary = root.join("cli-status.partial.json");
            fs::write(&temporary, serde_json::to_vec_pretty(&progress)?)?;
            fs::rename(temporary, root.join("cli-status.json"))?;
            emit(&progress)?;
            previous = progress;
        }
        let pending = jobs.iter().chain(previews.iter()).any(|j| {
            ["ready", "pending", "running", "retry_wait"]
                .contains(&j["status"].as_str().unwrap_or(""))
        });
        if pending
            && backend.workers_idle()
            && snapshot["project"]["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|j| {
                    j["status"] == "external_unknown"
                        && j["payload"].get("externalSlotReleasedAt").is_none()
                })
        {
            bail!("Queue capacity is held by an unconfirmed GPT request. Inspect it and explicitly continue; no automatic resubmission.");
        }
        if !pending && backend.workers_idle() {
            if jobs.iter().any(|j| j["status"] != "succeeded") {
                emit(
                    &json!({"type":"needs_attention","jobs":jobs.iter().filter(|j|j["status"]!="succeeded").map(|j|json!({"id":j["id"],"status":j["status"],"error":j["error"]})).collect::<Vec<_>>()}),
                )?;
                if run_id.is_none() {
                    bail!("Native work did not complete. Results and originals are preserved.");
                }
            }
            return Ok(snapshot);
        }
        if start.elapsed() > Duration::from_secs(timeout) {
            bail!("CLI wait timed out; originals and received results preserved. Reuse the same request UUID; inspect external_unknown before any remote retry.");
        }
        thread::sleep(Duration::from_millis(500));
    }
}
