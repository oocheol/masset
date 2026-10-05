//! Describe a game, inspect a read-only project, then produce independent assets.
//! Plans are data; generated code and game source files never execute or upload.
use super::*;
use asset_providers::runtime::{CodexRuntime, NativeFailureClass, RuntimeError, RuntimeOptions};
use asset_providers::REQUESTED_IMAGE_MODEL;
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::io::{Read, Write};

const MAX_ITEMS: usize = 120;
const OUTPUT_FOLDER: &str = "AssetStudioGenerated";

struct PlanningCancellation<'a>(&'a Mutex<Option<Arc<AtomicBool>>>);

impl Drop for PlanningCancellation<'_> {
    fn drop(&mut self) {
        *self.0.lock().unwrap() = None;
    }
}

fn planning_error(error: RuntimeError) -> anyhow::Error {
    // Fixed user-facing messages only: never forward RPC errors, process output,
    // assistant text, URLs or authentication details through the desktop bridge.
    let message = match &error {
        RuntimeError::OutcomeUnknown { stage: "planning_timeout", .. } =>
            "GPT 에셋 분석이 10분 안에 완료되지 않았습니다. 설명과 참고 자료는 유지했습니다. 미션이나 구역 단위로 범위를 나눠 다시 분석해 주세요.",
        RuntimeError::Timeout => "GPT 분석 연결의 응답 시간이 초과됐습니다. 연결 상태를 확인한 뒤 다시 분석해 주세요.",
        RuntimeError::AuthenticationRequired => "GPT 구독 로그인이 만료됐습니다. GPT 구독 연결에서 다시 로그인한 뒤 분석해 주세요.",
        RuntimeError::Unavailable => "공식 Codex 실행 파일을 찾지 못했습니다. GPT 구독 연결에서 준비 상태를 확인해 주세요.",
        RuntimeError::ReasoningModelUnavailable => "GPT-5.5 분석 모델의 사용 가능 여부를 확인하지 못했습니다. GPT 구독 연결과 계정의 모델 이용 권한을 확인해 주세요.",
        RuntimeError::InvalidInput => "게임 설명 또는 참고 자료를 분석 요청으로 전달하지 못했습니다. 입력 크기와 참고 파일을 확인해 주세요.",
        RuntimeError::PlanningStreamLimit { .. } => "GPT 제작 목록 응답이 처리 가능한 크기를 초과했습니다. 미션이나 구역 단위로 나눠 분석해 주세요.",
        RuntimeError::InvalidPlan | RuntimeError::InvalidPlanRule { .. } => "GPT가 반환한 제작 목록의 형식을 확인하지 못했습니다. 설명과 참고 자료는 유지했습니다. 다시 분석해 주세요.",
        RuntimeError::Interrupted => "에셋 분석을 취소했습니다. 설명과 참고 자료는 유지했습니다.",
        RuntimeError::GenerationFailed { failure } => match failure.codex_error_info {
            NativeFailureClass::UsageLimitExceeded | NativeFailureClass::SessionBudgetExceeded => "GPT 구독 사용 한도에 도달했습니다. GPT 구독 연결에서 한도와 초기화 시간을 확인해 주세요.",
            NativeFailureClass::Unauthorized => "GPT 구독 인증을 확인하지 못했습니다. GPT 구독 연결에서 다시 로그인해 주세요.",
            NativeFailureClass::ContextWindowExceeded => "GPT 분석에 전달할 자료가 너무 큽니다. 참고 자료나 게임 설명의 범위를 줄여 주세요.",
            NativeFailureClass::ServerOverloaded => "GPT 서버가 혼잡해 분석을 완료하지 못했습니다. 잠시 후 다시 분석해 주세요.",
            _ => "GPT 요청이 실패해 에셋 분석을 완료하지 못했습니다. 연결 상태를 확인한 뒤 다시 분석해 주세요.",
        },
        RuntimeError::OutcomeUnknown { .. } => "GPT 분석 중 연결이 끊겨 결과를 확인하지 못했습니다. 자동 재요청은 하지 않았습니다. 연결 상태를 확인한 뒤 다시 분석해 주세요.",
        _ => "GPT 분석 연결의 실행 상태를 확인하지 못했습니다. GPT 구독 연결을 확인한 뒤 다시 분석해 주세요.",
    };
    anyhow!("{message} ({})", error.code())
}

fn record_planning_error(work: &Path, phase: &str, error: &RuntimeError) {
    // Allowlisted diagnostics only, in this request's new app-owned directory.
    let rule = match error {
        RuntimeError::InvalidPlanRule { rule }
            if [
                "response_size",
                "json_shape",
                "summary_or_count",
                "item_identity_or_text",
                "name_prefix",
                "single_asset_description",
                "reference_identity",
                "target_or_kind",
                "target_reference",
                "improvement_target",
                "model_parameters",
                "prompt_size",
                "requested_counts",
                "serialization",
            ]
            .contains(rule) =>
        {
            Some(*rule)
        }
        _ => None,
    };
    if let Ok(file) = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(work.join("planning-error.json"))
    {
        let stream = match error {
            RuntimeError::PlanningStreamLimit {
                notifications,
                received_bytes,
            } => Some(json!({"notifications":notifications,"receivedBytes":received_bytes})),
            _ => None,
        };
        let _ = serde_json::to_writer(
            file,
            &json!({"phase":phase,"code":error.code(),"rule":rule,"stream":stream}),
        );
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Item {
    id: String,
    name: String,
    kind: AssetKind,
    prompt: String,
    purpose: String,
    reference_asset_ids: Vec<String>,
    target_asset_id: Option<String>,
    model_parameters: Option<ModelParameters>,
    enabled: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    schema_version: u32,
    id: String,
    project_id: String,
    planner_model: String,
    game_root: String,
    fingerprint: String,
    brief: String,
    output: String,
    mode: String,
    spec: AssetSpec,
    style_guide: StyleGuide,
    reference_asset_ids: Vec<String>,
    references: Value,
    summary: String,
    items: Vec<Item>,
    warnings: Vec<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    connection: Option<Value>,
    plan: Option<Plan>,
    #[serde(default)]
    run_ids: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Run {
    id: String,
    request_id: String,
    plan: Plan,
    created_at: String,
    output_root: String,
    jobs: Vec<Job>,
    #[serde(default)]
    reviews: BTreeMap<String, bool>,
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    no_links(path)?;
    let file = fs::File::open(path)?;
    if file.metadata()?.len() > 8 * 1024 * 1024 {
        bail!("제작 기록의 크기 제한을 초과했습니다. 원본 기록은 보존했습니다.");
    }
    let mut bytes = Vec::new();
    file.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn save_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    no_links(path)?;
    let bytes = serde_json::to_vec_pretty(value)?;
    if bytes.len() > 8 * 1024 * 1024 {
        bail!("제작 기록이 너무 큽니다.");
    }
    atomic_new_replace(path, &bytes)
}

fn no_links(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        bail!("절대 프로젝트 경로가 필요합니다.");
    }
    let mut parent = PathBuf::new();
    for component in path.components() {
        if matches!(
            component,
            std::path::Component::ParentDir | std::path::Component::CurDir
        ) {
            bail!("프로젝트 경로에 상대 경로가 있습니다.");
        }
        parent.push(component);
        // A bare verbatim Windows prefix (\\?\C:) is not an inspectable
        // filesystem path. Wait until RootDir appends its separator, matching
        // project_scan's original-path checks without discarding ancestors.
        if matches!(component, std::path::Component::Prefix(_)) {
            continue;
        }
        match fs::symlink_metadata(&parent) {
            Ok(metadata) if linked_metadata(&metadata) => {
                bail!("연결된 경로 대신 실제 프로젝트 폴더를 선택하세요.")
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn linked_metadata(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x0000_0400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn state_path(root: &Path) -> PathBuf {
    root.join("production.json")
}
fn run_path(root: &Path, id: &str) -> Result<PathBuf> {
    Uuid::parse_str(id)?;
    Ok(root.join("production-runs").join(format!("{id}.json")))
}
fn load_state(root: &Path) -> Result<State> {
    let path = state_path(root);
    if path.try_exists()? {
        read_json(&path)
    } else {
        Ok(State::default())
    }
}

fn include_delivered_inventory(scan: &Value, project: &Project) -> Result<Value> {
    let mut scan = scan.clone();
    let game = Path::new(text_field(&scan, "root")?);
    let mut assets = scan["assets"]
        .as_array()
        .context("에셋 목록이 없습니다.")?
        .clone();
    let mut count = scan["assetCount"].as_u64().unwrap_or(0);
    let mut incomplete = false;
    for asset in &project.assets {
        let Some(delivery) = asset
            .versions
            .iter()
            .rev()
            .find_map(|v| v.settings.get("productionDelivery"))
        else {
            continue;
        };
        let Some(directory) = delivery["path"].as_str().map(PathBuf::from) else {
            continue;
        };
        if ![
            OUTPUT_FOLDER,
            "Assets/AssetStudioGenerated",
            "Content/AssetStudioGenerated",
        ]
        .iter()
        .any(|folder| directory.starts_with(game.join(folder)))
        {
            continue;
        }
        if no_links(&directory).is_err() {
            incomplete = true;
            continue;
        }
        for file in delivery["files"].as_array().into_iter().flatten().take(32) {
            let Some(name) = file["path"].as_str() else {
                continue;
            };
            if Path::new(name).components().count() != 1
                || name == ".."
                || name == "."
                || name.contains(['/', '\\'])
            {
                continue;
            }
            let Some(format) = file["format"].as_str() else {
                continue;
            };
            let kind = if format == "glb" {
                "model"
            } else if ["png", "jpg", "jpeg", "webp"].contains(&format) {
                "image"
            } else {
                continue;
            };
            let path = directory.join(name);
            let Ok((hash, bytes)) = asset_core::sha256_file(&path) else {
                incomplete = true;
                continue;
            };
            if file["sha256"].as_str() != Some(hash.as_str())
                || file["bytes"].as_u64() != Some(bytes)
            {
                incomplete = true;
                continue;
            }
            let relative = path
                .strip_prefix(game)?
                .to_string_lossy()
                .replace('\\', "/");
            if !assets.iter().any(|a| a["path"] == relative) {
                assets.push(json!({"path":relative,"kind":kind}));
                count += 1;
            }
        }
    }
    scan["assets"] = json!(assets);
    scan["assetCount"] = json!(count);
    if incomplete {
        scan["warnings"].as_array_mut().context("분석 경고가 없습니다.")?.push(json!("Some previously delivered files changed or disappeared; they are not included as usable inventory."));
    }
    Ok(scan)
}

fn planning_project_context(scan: &Value) -> Result<Value> {
    let mut budget = 128 * 1024usize;
    let mut warnings = scan["warnings"]
        .as_array()
        .context("프로젝트 분석 경고가 없습니다.")?
        .clone();
    let mut take = |name: &str| -> Result<Vec<Value>> {
        let source = scan[name].as_array().context("프로젝트 목록이 없습니다.")?;
        let mut result = Vec::new();
        for item in source.iter().take(2000) {
            let size = serde_json::to_vec(item)?.len() + 1;
            if size > budget {
                break;
            }
            budget -= size;
            result.push(item.clone());
        }
        if result.len() < source.len() {
            warnings.push(json!(format!("{name} list was limited for planning; omitted entries are not verified or fulfilled.")));
        }
        Ok(result)
    };
    // Concrete missing references take precedence over existing inventory.
    let missing = take("missingReferences")?;
    let assets = take("assets")?;
    Ok(
        json!({"engine":scan["engine"],"assetCount":scan["assetCount"],"assets":assets,"missingReferences":missing,"warnings":warnings}),
    )
}

fn validate_plan(plan: &Plan, project: &Project) -> Result<()> {
    if plan.schema_version != 1
        || plan.project_id != project.id
        || plan.planner_model != "gpt-5.5"
        || plan.mode != "new"
        || !["images", "models", "mixed"].contains(&plan.output.as_str())
        || plan.items.is_empty()
        || plan.items.len() > MAX_ITEMS
        || plan.warnings.len() > 32
        || plan.warnings.iter().any(|s| s.len() > 2048)
        || plan.reference_asset_ids.len() > 5
        || plan.spec != project.spec
        || !plan.style_guide.approved
    {
        bail!("게임 구성안 또는 공통 제작 기준이 바뀌었습니다. 다시 분석해 주세요.");
    }
    Uuid::parse_str(&plan.id)?;
    let mut names = HashSet::new();
    let mut ids = HashSet::new();
    for item in &plan.items {
        Uuid::parse_str(&item.id)?;
        let name = item.name.trim();
        if name.is_empty()
            || name.chars().count() > 72
            || name
                .chars()
                .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
            || name == "."
            || name == ".."
            || name.ends_with('.')
            || !names.insert(name.to_lowercase())
            || !ids.insert(&item.id)
            || item.target_asset_id.is_some()
            || item.model_parameters.is_some()
            || item.prompt.len() > 8192
            || item.purpose.is_empty()
            || item.purpose.len() > 2048
            || !item
                .prompt
                .starts_with(&format!("SINGLE ASSET \"{}\":", item.name))
            || item.prompt.chars().any(|c| c.is_control())
            || item.reference_asset_ids.len() > 5
            || item
                .reference_asset_ids
                .iter()
                .any(|id| !plan.reference_asset_ids.contains(id))
            || (plan.output == "images" && item.kind == AssetKind::Model)
            || (plan.output == "models" && item.kind != AssetKind::Model)
        {
            bail!(
                "개별 에셋의 이름·설명·참고 자료를 확인할 수 없습니다. 제작은 제출하지 않았습니다."
            );
        }
    }
    if plan.items.iter().all(|i| !i.enabled) {
        bail!("제작할 에셋이 없습니다.");
    }
    Ok(())
}

fn asset_for_job<'a>(project: &'a Project, job_id: &str) -> Option<(&'a Asset, &'a AssetVersion)> {
    project.assets.iter().find_map(|asset| {
        asset
            .versions
            .iter()
            .filter(|version| version.settings.get("jobId") == Some(&json!(job_id)))
            .max_by_key(|version| version.number)
            .map(|version| (asset, version))
    })
}

pub(super) fn verify_delivery(task: &Job, version: &AssetVersion) -> Result<()> {
    if task.payload.get("productionDeliver") != Some(&json!(true)) {
        return Ok(());
    }
    let delivery = version
        .settings
        .get("productionDelivery")
        .context("게임 프로젝트 전달 기록이 없습니다.")?;
    let game = Path::new(
        task.payload
            .get("gameRoot")
            .and_then(Value::as_str)
            .context("게임 루트가 없습니다.")?,
    );
    let run = task
        .payload
        .get("productionRunId")
        .and_then(Value::as_str)
        .context("제작 식별자가 없습니다.")?;
    Uuid::parse_str(run)?;
    let folder = task
        .payload
        .get("gameOutputFolder")
        .and_then(Value::as_str)
        .unwrap_or(OUTPUT_FOLDER);
    if ![
        OUTPUT_FOLDER,
        "Assets/AssetStudioGenerated",
        "Content/AssetStudioGenerated",
    ]
    .contains(&folder)
    {
        bail!("게임 출력 폴더가 잘못됐습니다.");
    }
    let expected = game.join(folder).join(run);
    let path = Path::new(text_field(delivery, "path")?);
    no_links(path)?;
    if path.parent() != Some(expected.as_path()) || delivery["runId"] != run {
        bail!("게임 출력 경로가 제작 폴더와 다릅니다.");
    }
    let files = delivery["files"]
        .as_array()
        .context("전달 파일 기록이 없습니다.")?;
    if files.is_empty() || files.len() > 32 {
        bail!("전달 파일 수가 잘못됐습니다.");
    }
    for file in files {
        let relative = text_field(file, "path")?;
        if Path::new(relative).components().count() != 1
            || relative == "."
            || relative == ".."
            || relative.contains(['/', '\\'])
        {
            bail!("전달 파일 경로가 잘못됐습니다.");
        }
        let target = path.join(relative);
        no_links(&target)?;
        let (hash, bytes) = asset_core::sha256_file(&target)?;
        if Some(hash.as_str()) != file["sha256"].as_str() || Some(bytes) != file["bytes"].as_u64() {
            bail!("게임 프로젝트의 제작 파일이 바뀌었습니다. 원본 기록은 보존했습니다.");
        }
    }
    Ok(())
}

fn item_status(jobs: &[&Job]) -> &'static str {
    if jobs.is_empty() {
        return "needs_attention";
    }
    if jobs.iter().any(|j| {
        matches!(
            j.status,
            JobStatus::Failed | JobStatus::WaitingUser | JobStatus::ExternalUnknown
        )
    }) {
        "needs_attention"
    } else if jobs.iter().all(|j| j.status == JobStatus::Succeeded) {
        "completed"
    } else if jobs.iter().any(|j| j.status == JobStatus::Cancelled) {
        "cancelled"
    } else if jobs
        .iter()
        .any(|j| matches!(j.status, JobStatus::Running | JobStatus::Succeeded))
    {
        "running"
    } else {
        "pending"
    }
}

impl Backend {
    // A successful provider receipt survives an export failure. Reusing its
    // verified file prevents a local retry from submitting GPT a second time.
    pub(super) fn reuse_production_image(&self, root: &Path, task: &Job) -> Result<bool> {
        if !task.payload.contains_key("productionRunId") {
            return Ok(false);
        }
        let _io = self.inner.io.lock().unwrap();
        let mut repo = Repository::open(root)?;
        let mut project = repo.project()?;
        let Some((asset, version)) = asset_for_job(&project, &task.id) else {
            return Ok(false);
        };
        if version.source != AssetSource::CodexSubscription
            || version.requested_model.as_deref() != Some(REQUESTED_IMAGE_MODEL)
            || !version.validation.as_ref().is_some_and(|v| v.valid)
        {
            bail!("수신 이미지의 검증 기록을 확인할 수 없습니다. 자동 재요청하지 않았습니다.");
        }
        for artifact in &version.artifacts {
            repo.verify_artifact(artifact)?;
        }
        let aid = asset.id.clone();
        let vid = version.id.clone();
        let version = project
            .assets
            .iter_mut()
            .find(|a| a.id == aid)
            .unwrap()
            .versions
            .iter_mut()
            .find(|v| v.id == vid)
            .unwrap();
        version.settings.insert(
            "executionId".into(),
            task.payload
                .get("executionId")
                .cloned()
                .context("실행 식별자가 없습니다.")?,
        );
        version
            .settings
            .insert("cacheKey".into(), json!(task.cache_key));
        version
            .settings
            .insert("providerResultReused".into(), json!(true));
        repo.save_project(&project)?;
        Ok(true)
    }
    pub(super) fn production_request(&self, request: &Value) -> Result<Value> {
        let root = self.root()?;
        match text_field(request, "action")? {
            "production_state" => self.production_state(&root),
            "game_connect" => {
                let game = PathBuf::from(text_field(request, "root")?);
                no_links(&game)?;
                let scan = project_scan::scan(&game)?;
                let game = PathBuf::from(text_field(&scan, "root")?);
                if root.starts_with(&game) || game.starts_with(&root) {
                    bail!("게임 프로젝트와 Asset Studio 작업 공간은 별도 폴더를 사용해 주세요.");
                }
                let _io = self.inner.io.lock().unwrap();
                let mut state = load_state(&root)?;
                state.connection = Some(scan);
                state.plan = None;
                save_json(&state_path(&root), &state)?;
                drop(_io);
                self.production_state(&root)
            }
            "production_plan" => self.plan_production(&root, request),
            "production_start" => self.start_production(&root, request),
            "production_review" => {
                let _io = self.inner.io.lock().unwrap();
                let id = text_field(request, "runId")?;
                let state = load_state(&root)?;
                if !state.run_ids.contains(&id.to_owned()) {
                    bail!("제작 기록을 찾을 수 없습니다.");
                }
                let path = run_path(&root, id)?;
                let mut run: Run = read_json(&path)?;
                let item = text_field(request, "itemId")?;
                if !run.plan.items.iter().any(|i| i.id == item) {
                    bail!("에셋 항목을 찾을 수 없습니다.");
                }
                let jobs = SchedulerStore::open(&root.join("scheduler.sqlite"))?.jobs()?;
                let actual: Vec<_> = jobs
                    .iter()
                    .filter(|j| {
                        j.payload.get("productionRunId") == Some(&json!(id))
                            && j.payload.get("productionItemId") == Some(&json!(item))
                    })
                    .collect();
                if item_status(&actual) != "completed" {
                    bail!("완성된 에셋을 확인한 뒤 승인할 수 있습니다.");
                }
                let final_job = actual
                    .iter()
                    .find(|j| j.payload.get("productionDeliver") == Some(&json!(true)))
                    .context("전달 작업이 없습니다.")?;
                let project = Repository::open(&root)?.project()?;
                verify_delivery(
                    final_job,
                    asset_for_job(&project, &final_job.id)
                        .context("확인할 결과가 없습니다.")?
                        .1,
                )?;
                run.reviews.insert(
                    item.into(),
                    request["approved"]
                        .as_bool()
                        .context("확인 여부가 필요합니다.")?,
                );
                save_json(&path, &run)?;
                drop(_io);
                self.production_state(&root)
            }
            "production_retry" | "production_cancel" => self.control_production(&root, request),
            _ => bail!("지원하지 않는 제작 작업입니다."),
        }
    }

    fn production_state(&self, root: &Path) -> Result<Value> {
        let _io = self.inner.io.lock().unwrap();
        let state = load_state(root)?;
        let project = Repository::open(root)?.project()?;
        let jobs = SchedulerStore::open(&root.join("scheduler.sqlite"))?.jobs()?;
        let mut runs = Vec::new();
        for id in state.run_ids.iter().rev().take(20) {
            let run: Run = read_json(&run_path(root, id)?)?;
            let mut items = Vec::new();
            for item in run.plan.items.iter().filter(|i| i.enabled) {
                let actual: Vec<_> = jobs
                    .iter()
                    .filter(|j| {
                        j.payload.get("productionRunId") == Some(&json!(id))
                            && j.payload.get("productionItemId") == Some(&json!(item.id))
                    })
                    .collect();
                let final_job = actual
                    .iter()
                    .find(|j| j.payload.get("productionDeliver") == Some(&json!(true)));
                let asset = final_job.and_then(|j| asset_for_job(&project, &j.id));
                let delivery = asset.and_then(|(_, v)| v.settings.get("productionDelivery"));
                let status = item_status(&actual);
                items.push(json!({"id":item.id,"name":item.name,"kind":item.kind,"jobIds":actual.iter().map(|j|&j.id).collect::<Vec<_>>(),
                    "assetId":asset.map(|(a,_)|&a.id),"status":status,"review":if run.reviews.get(&item.id)==Some(&true){"approved"}else{"pending"},
                    "outputPath":delivery.and_then(|d|d.get("path")),"error":actual.iter().find_map(|j|j.error.as_ref())}));
            }
            let status = if items.iter().all(|i| i["status"] == "completed") {
                "completed"
            } else if items.iter().any(|i| i["status"] == "needs_attention") {
                "needs_attention"
            } else if items.iter().any(|i| i["status"] == "running") {
                "running"
            } else if items.iter().any(|i| i["status"] == "cancelled") {
                "cancelled"
            } else {
                "pending"
            };
            runs.push(json!({"id":run.id,"planId":run.plan.id,"brief":run.plan.brief,"createdAt":run.created_at,"outputRoot":run.output_root,"status":status,"items":items}));
        }
        Ok(json!({"connection":state.connection,"plan":state.plan,"runs":runs}))
    }

    fn plan_production(&self, root: &Path, request: &Value) -> Result<Value> {
        if request["uploadApproved"] != true {
            bail!("게임 설명·에셋 목록·선택한 참고 자료를 GPT 연결로 전달하는 데 동의해 주세요.");
        }
        let brief = text_field(request, "brief")?.trim();
        if brief.is_empty()
            || brief.len() > 16000
            || brief
                .chars()
                .any(|c| c.is_control() && !['\n', '\t'].contains(&c))
        {
            bail!("게임 설명은 16,000바이트 이내로 입력해 주세요.");
        }
        let output = text_field(request, "output")?;
        if !["images", "models", "mixed"].contains(&output) {
            bail!("2D·3D 제작 종류를 선택하세요.");
        }
        // Planning must not offer a batch whose reconstruction path cannot run
        // on this native platform. Reject it before reading project references,
        // creating a planning cache, or discovering/calling an official provider.
        if output != "images" && !quality3d::reconstruction_supported() {
            bail!("이 기기에서는 이미지 제작만 지원합니다. '이미지'를 선택하고 다시 분석하세요. 이미지에서 3D 제작은 Windows x64·Apple Silicon Mac에서 지원합니다.");
        }
        let cancel = Arc::new(AtomicBool::new(false));
        *self.inner.planning_cancel.lock().unwrap() = Some(cancel.clone());
        let _planning = PlanningCancellation(&self.inner.planning_cancel);
        let mut state = load_state(root)?;
        let previous = state
            .connection
            .as_ref()
            .context("게임 프로젝트 루트 폴더를 먼저 연결하세요.")?;
        let scan = project_scan::scan(Path::new(text_field(previous, "root")?))?;
        let project = Repository::open(root)?.project()?;
        let ids: Vec<String> = serde_json::from_value(request["referenceAssetIds"].clone())?;
        let refs = bundle::references(&project, &ids)?;
        bundle::verify_references(root, &refs)?;
        let work = root
            .join("cache")
            .join(format!("production-plan-{}", Uuid::new_v4()));
        fs::create_dir_all(&work)?;
        let images = bundle::copy_reference_images(
            root,
            &bundle::reference_artifacts(&project, &refs)?,
            &work,
        )?;
        // Never transmit absolute paths, game source code, credentials or hidden files.
        let project_context =
            planning_project_context(&include_delivered_inventory(&scan, &project)?)?;
        let mut style = project.style_guide.clone();
        style.name = "게임 설명과 참고 자료 기준".into();
        style.palette.clear();
        style.detail="Follow the game's described visual style and selected references; use one coherent art direction across all items.".into();
        style.reference_asset_ids = ids.clone();
        style.approved = true;
        let context = json!({"production":true,"projectContext":project_context,"brief":brief,"output":output,"mode":"new","styleGuide":style,"spec":project.spec,"references":refs,"supportedModelTemplates":[]});
        let executable = self
            .provider_executable()
            .context("GPT 구독 연결을 먼저 확인해 주세요.")?;
        let result = (|| -> Result<Plan> {
            if cancel.load(Ordering::SeqCst) {
                return Err(planning_error(RuntimeError::Interrupted));
            }
            let mut options = RuntimeOptions::new(executable, work.join("rpc"));
            options.reasoning_model = Some("gpt-5.5".into());
            let mut runtime = CodexRuntime::connect_for_planning(options).map_err(|error| {
                record_planning_error(&work, "connect", &error);
                planning_error(error)
            })?;
            let proposal = runtime
                .plan_assets(&context, &images, &cancel)
                .map_err(|error| {
                    record_planning_error(&work, "plan", &error);
                    planning_error(error)
                })?;
            if cancel.load(Ordering::SeqCst) {
                bail!("게임 분석을 취소했습니다.");
            }
            let mut items = proposal["items"]
                .as_array()
                .context("에셋 구성안이 없습니다.")?
                .clone();
            for item in &mut items {
                item["id"] = json!(Uuid::new_v4().to_string());
                item["enabled"] = json!(true);
            }
            let plan = Plan {
                schema_version: 1,
                id: Uuid::new_v4().to_string(),
                project_id: project.id.clone(),
                planner_model: "gpt-5.5".into(),
                game_root: text_field(&scan, "root")?.into(),
                fingerprint: text_field(&scan, "fingerprint")?.into(),
                brief: brief.into(),
                output: output.into(),
                mode: "new".into(),
                spec: project.spec.clone(),
                style_guide: style,
                reference_asset_ids: ids,
                references: serde_json::to_value(refs)?,
                summary: text_field(&proposal, "summary")?.into(),
                items: serde_json::from_value(json!(items))?,
                warnings: serde_json::from_value(proposal["warnings"].clone())?,
            };
            validate_plan(&plan, &project)?;
            Ok(plan)
        })();
        let plan = result?;
        let _io = self.inner.io.lock().unwrap();
        state.connection = Some(scan);
        state.plan = Some(plan);
        save_json(&state_path(root), &state)?;
        drop(_io);
        self.production_state(root)
    }

    fn start_production(&self, root: &Path, request: &Value) -> Result<Value> {
        if request["uploadApproved"] != true {
            bail!("선택한 참고 자료 전달에 동의해 주세요.");
        }
        let request_id = text_field(request, "requestId")?;
        Uuid::parse_str(request_id)?;
        let mut state = load_state(root)?;
        // A repeated click or lost IPC response reuses the original complete DAG.
        if state.run_ids.contains(&request_id.to_owned()) {
            let run: Run = read_json(&run_path(root, request_id)?)?;
            if run.plan.id != text_field(request, "planId")? {
                bail!("같은 요청 식별자로 다른 구성안을 시작할 수 없습니다.");
            }
            SchedulerStore::open(&root.join("scheduler.sqlite"))?
                .enqueue_many_once(request_id, run.jobs)?;
            return Ok(json!({"snapshot":self.snapshot()?,"state":self.production_state(root)?}));
        }
        let plan = state
            .plan
            .clone()
            .context("게임 설명과 프로젝트 폴더를 분석해 주세요.")?;
        if plan.id != text_field(request, "planId")? {
            bail!("구성안이 바뀌었습니다. 새 구성안을 확인해 주세요.");
        }
        let project = Repository::open(root)?.project()?;
        validate_plan(&plan, &project)?;
        let scan = project_scan::scan(Path::new(&plan.game_root))?;
        if scan["fingerprint"] != plan.fingerprint {
            bail!("게임 프로젝트가 분석 후 변경됐습니다. 다시 분석해 주세요.");
        }
        let refs = bundle::references(&project, &plan.reference_asset_ids)?;
        if serde_json::to_value(&refs)? != plan.references {
            bail!("참고 자료가 바뀌었습니다. 다시 분석해 주세요.");
        }
        bundle::verify_references(root, &refs)?;
        let status = self.inner.provider_connection.lock().unwrap().clone();
        if status["ready"] != true {
            bail!("GPT 구독 연결을 먼저 확인해 주세요.");
        }
        let models = plan
            .items
            .iter()
            .any(|i| i.enabled && i.kind == AssetKind::Model);
        if models
            && (self.quality3d_status()["installed"] != true
                || self.inner.blender.is_none()
                || self.inner.limits.ram_mb < 8192)
        {
            bail!("3D 제작용 로컬 모델과 Blender를 먼저 준비해 주세요. 다른 항목도 제출하지 않았습니다.");
        }
        let game_folder = Path::new(&plan.game_root);
        let output_folder = match scan["engine"].as_str() {
            Some("unity") if game_folder.join("Assets").is_dir() => "Assets/AssetStudioGenerated",
            Some("unreal") if game_folder.join("Content").is_dir() => {
                "Content/AssetStudioGenerated"
            }
            _ => OUTPUT_FOLDER,
        };
        let output_root = PathBuf::from(&plan.game_root)
            .join(output_folder)
            .join(request_id);
        no_links(&output_root)?;
        let pipeline = if models {
            self.quality3d_pipeline_hash()?
        } else {
            String::new()
        };
        let mut tasks = Vec::new();
        for item in plan.items.iter().filter(|i| i.enabled) {
            let refs = bundle::references(&project, &item.reference_asset_ids)?;
            let mut common = json!({"name":item.name,"prompt":item.prompt,"purpose":item.purpose,"bundleId":plan.id,"bundleItemId":item.id,
                "productionRunId":request_id,"productionItemId":item.id,"gameRoot":plan.game_root,"gameOutputFolder":output_folder,"outputRoot":output_root,
                "styleGuide":plan.style_guide,"spec":project.spec,"references":bundle::reference_artifacts(&project,&refs)?,"referenceMetadata":refs});
            let model = item.kind == AssetKind::Model;
            common["assetKind"] = if model {
                json!("image")
            } else {
                json!(item.kind)
            };
            common["productionConcept"] = json!(model);
            common["transparentBackground"] = json!(model || item.kind == AssetKind::Sprite);
            common["productionDeliver"] = json!(!model);
            common["requestedModel"] = json!(REQUESTED_IMAGE_MODEL);
            common["reasoningModel"] = status["reasoningModel"].clone();
            common["toolVersion"] = status["runtimeVersion"].clone();
            common["singleAsset"] = json!(true);
            common["normalizeToSpec"] = json!(!model);
            common["resources"] = json!({"ramMb":image_ram_mb(raster::MAX_PIXELS,16,384),"cpuThreads":1,"diskWeight":1});
            let image = job(
                &project,
                "image_generate",
                &format!(
                    "{} · {}",
                    if model {
                        "3D 참고 이미지"
                    } else {
                        "2D 생성"
                    },
                    item.name
                ),
                None,
                JobResource::External,
                common.clone(),
            )?;
            if model {
                let mut payload = common;
                payload["imageJobId"] = json!(image.id);
                payload["productionDeliver"] = json!(true);
                payload["name"] = json!(item.name);
                payload["quality"] = json!("high");
                payload["heightMeters"] = json!(1.0);
                payload["maxTriangles"] = json!(project.spec.polygon_budget.min(10000));
                payload["textureResolution"] = json!(1024);
                payload["preserveMaterials"] = json!(true);
                payload["sourceKind"] = json!("image3d");
                payload["pipelineSha256"] = json!(pipeline);
                payload["toolVersion"] = json!(self.inner.blender_version);
                payload["resources"] = json!({"ramMb":8192,"cpuThreads":2,"diskWeight":2});
                let mut reconstruction = job(
                    &project,
                    "production_model",
                    &format!("3D 변환 · {}", item.name),
                    None,
                    JobResource::Blender,
                    payload,
                )?;
                reconstruction.dependencies = vec![image.id.clone()];
                tasks.push(image);
                tasks.push(reconstruction);
            } else {
                tasks.push(image);
            }
        }
        let run = Run {
            id: request_id.into(),
            request_id: request_id.into(),
            plan,
            created_at: now(),
            output_root: output_root.to_string_lossy().into(),
            jobs: tasks.clone(),
            reviews: BTreeMap::new(),
        };
        let directory = root.join("production-runs");
        no_links(&directory)?;
        fs::create_dir_all(&directory)?;
        // Persist the entire intended DAG before admission. A retry repairs a
        // crash between this write and the SQLite enqueue transaction.
        let _io = self.inner.io.lock().unwrap();
        save_json(&run_path(root, request_id)?, &run)?;
        state.run_ids.push(request_id.into());
        save_json(&state_path(root), &state)?;
        SchedulerStore::open(&root.join("scheduler.sqlite"))?
            .enqueue_many_once(request_id, tasks)?;
        drop(_io);
        Ok(json!({"snapshot":self.snapshot()?,"state":self.production_state(root)?}))
    }

    fn control_production(&self, root: &Path, request: &Value) -> Result<Value> {
        let id = text_field(request, "runId")?;
        let state = load_state(root)?;
        if !state.run_ids.contains(&id.to_owned()) {
            bail!("제작 기록을 찾을 수 없습니다.");
        }
        let run: Run = read_json(&run_path(root, id)?)?;
        let _dispatch = self.inner.dispatch.lock().unwrap();
        let queue = SchedulerStore::open(&root.join("scheduler.sqlite"))?;
        let jobs = queue.jobs()?;
        if request["action"] == "production_cancel" {
            for job in jobs.iter().filter(|j| {
                j.payload.get("productionRunId") == Some(&json!(id))
                    && matches!(
                        j.status,
                        JobStatus::Pending
                            | JobStatus::Ready
                            | JobStatus::Running
                            | JobStatus::RetryWait
                            | JobStatus::WaitingUser
                    )
            }) {
                let cancelled = queue.cancel(&job.id)?;
                let runners = self.inner.runners.lock().unwrap();
                for jid in cancelled {
                    if let Some(r) = runners.get(&jid) {
                        r.cancel.store(true, Ordering::SeqCst);
                    }
                }
            }
        } else {
            let item = text_field(request, "itemId")?;
            if !run.plan.items.iter().any(|i| i.id == item) {
                bail!("에셋 항목을 찾을 수 없습니다.");
            }
            let actual: Vec<_> = jobs
                .iter()
                .filter(|j| {
                    j.payload.get("productionRunId") == Some(&json!(id))
                        && j.payload.get("productionItemId") == Some(&json!(item))
                })
                .collect();
            if actual.is_empty() {
                // Startup can recover a persisted intent whose enqueue never
                // committed. Restore its original IDs, never a new GPT batch.
                SchedulerStore::open(&root.join("scheduler.sqlite"))?
                    .enqueue_many_once(&run.request_id, run.jobs)?;
                drop(_dispatch);
                return Ok(
                    json!({"snapshot":self.snapshot()?,"state":self.production_state(root)?}),
                );
            }
            let runners = self.inner.runners.lock().unwrap();
            if actual.iter().any(|j| runners.contains_key(&j.id)) {
                bail!("이 에셋의 실행이 종료되면 다시 시도할 수 있습니다.");
            }
            drop(runners);
            // Keep succeeded concept images. Retry only the first failed stage;
            // rerun() restores its blocked descendants under scheduler rules.
            let failed = actual
                .iter()
                .find(|j| {
                    matches!(
                        j.status,
                        JobStatus::Failed
                            | JobStatus::Cancelled
                            | JobStatus::WaitingUser
                            | JobStatus::ExternalUnknown
                    )
                })
                .context("다시 실행할 실패 단계가 없습니다.")?;
            if failed.status == JobStatus::ExternalUnknown {
                bail!("GPT 결과가 불명확합니다. 작업 상세에서 수신 기록을 확인한 뒤 다시 요청해 주세요. 자동 재전송하지 않았습니다.");
            }
            queue.rerun(&failed.id)?;
        }
        drop(_dispatch);
        Ok(json!({"snapshot":self.snapshot()?,"state":self.production_state(root)?}))
    }

    pub(super) fn run_production_model(
        &self,
        root: &Path,
        task: &Job,
        work: &Path,
        cancel: &AtomicBool,
    ) -> Result<()> {
        let project = Repository::open(root)?.project()?;
        let image_job = task
            .payload
            .get("imageJobId")
            .and_then(Value::as_str)
            .context("선행 이미지 작업이 없습니다.")?;
        let (concept, version) =
            asset_for_job(&project, image_job).context("선행 이미지 결과를 찾을 수 없습니다.")?;
        let source = version
            .artifacts
            .iter()
            .find(|a| {
                a.role == ArtifactRole::Output
                    && ["png", "webp", "jpg", "jpeg"].contains(&a.format.as_str())
            })
            .context("3D 참고 이미지가 없습니다.")?;
        let repo = Repository::open(root)?;
        repo.verify_artifact(source)?;
        let prepared = work.join("production-foreground.png");
        let preparation = prepare_foreground(&repo.artifact_path(&source.path)?, &prepared)?;
        if cancel.load(Ordering::SeqCst) {
            bail!("3D 제작을 취소했습니다.");
        }
        let _io = self.inner.io.lock().unwrap();
        let mut repo = Repository::open(root)?;
        let mut input = repo.copy_in(&prepared, "outputs", "production-foreground.png")?;
        input.role = ArtifactRole::Output;
        // Register the prepared copy as a new local version. The reconstruction
        // boundary accepts only project-recorded, hash-verified artifacts.
        let mut original = source.clone();
        original.role = ArtifactRole::Source;
        let info = raster::inspect(&prepared)?;
        repo.add_version(
            &concept.id,
            AssetVersion {
                id: Uuid::new_v4().to_string(),
                number: concept.versions.iter().map(|v| v.number).max().unwrap_or(0) + 1,
                created_at: now(),
                prompt: version.prompt.clone(),
                source: AssetSource::Procedural,
                requested_model: None,
                confirmed_model: None,
                provider_version: Some("local-production-foreground-v1".into()),
                artifacts: vec![original, input.clone()],
                settings: BTreeMap::from([
                    ("inputPreparationFor".into(), json!(task.id)),
                    ("foregroundPreparation".into(), preparation.clone()),
                    ("conceptVersionId".into(), json!(version.id)),
                ]),
                validation: Some(image_report(&input.id, &info)?),
            },
        )?;
        drop(_io);
        let mut bound = task.clone();
        bound.payload.insert(
            "pipelineSha256".into(),
            json!(self.quality3d_pipeline_hash()?),
        );
        bound.payload.insert("source".into(), json!(input.path));
        bound
            .payload
            .insert("sourceSha256".into(), json!(input.sha256));
        bound
            .payload
            .insert("foregroundPreparation".into(), preparation);
        bound
            .payload
            .insert("conceptArtifact".into(), serde_json::to_value(source)?);
        self.run_quality3d(root, &bound, work, cancel)?;
        self.deliver_production_asset(root, task, cancel)
    }

    pub(super) fn deliver_production_asset(
        &self,
        root: &Path,
        task: &Job,
        cancel: &AtomicBool,
    ) -> Result<()> {
        let _io = self.inner.io.lock().unwrap();
        let mut repo = Repository::open(root)?;
        let mut project = repo.project()?;
        let (asset, version) =
            asset_for_job(&project, &task.id).context("내보낼 제작 결과를 찾을 수 없습니다.")?;
        if !version.validation.as_ref().is_some_and(|v| v.valid) {
            bail!("검증에 통과한 에셋만 프로젝트로 저장할 수 있습니다.");
        }
        let game = PathBuf::from(
            task.payload
                .get("gameRoot")
                .and_then(Value::as_str)
                .context("게임 루트가 없습니다.")?,
        );
        let run_id = task
            .payload
            .get("productionRunId")
            .and_then(Value::as_str)
            .context("제작 식별자가 없습니다.")?;
        let item_id = task
            .payload
            .get("productionItemId")
            .and_then(Value::as_str)
            .context("에셋 식별자가 없습니다.")?;
        Uuid::parse_str(run_id)?;
        Uuid::parse_str(item_id)?;
        let folder = task
            .payload
            .get("gameOutputFolder")
            .and_then(Value::as_str)
            .unwrap_or(OUTPUT_FOLDER);
        let run_root = managed_output_at(&game, run_id, folder)?;
        let name = task
            .payload
            .get("name")
            .and_then(Value::as_str)
            .context("에셋 이름이 없습니다.")?;
        let directory = run_root.join(format!("{}-{}-{}", name, item_id, Uuid::new_v4()));
        no_links(&directory)?;
        fs::create_dir(&directory)?;
        let outputs: Vec<_> = version
            .artifacts
            .iter()
            .filter(|a| a.role == ArtifactRole::Output)
            .collect();
        if outputs.is_empty() {
            bail!("게임에 전달할 출력 파일이 없습니다.");
        }
        let mut files = Vec::new();
        let mut used = HashSet::new();
        for artifact in outputs {
            if cancel.load(Ordering::SeqCst) {
                bail!("제작 파일 전달을 취소했습니다. 작성한 새 폴더는 보존했습니다.");
            }
            repo.verify_artifact(artifact)?;
            let original_name = Path::new(&artifact.path)
                .file_name()
                .and_then(|s| s.to_str())
                .context("출력 파일 이름이 없습니다.")?;
            let filename = if artifact.format == "png" && asset.kind != AssetKind::Model {
                format!("{name}.png")
            } else if original_name == "game-ready.model.glb" {
                format!("{name}.glb")
            } else {
                original_name.into()
            };
            if !used.insert(filename.to_lowercase()) {
                bail!("출력 파일 이름이 중복됐습니다.");
            }
            let target = directory.join(&filename);
            no_links(&target)?;
            let mut input = fs::File::open(repo.artifact_path(&artifact.path)?)?;
            let mut output = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&target)?;
            std::io::copy(&mut input, &mut output)?;
            output.sync_all()?;
            let (hash, bytes) = asset_core::sha256_file(&target)?;
            if hash != artifact.sha256 || bytes != artifact.bytes {
                bail!("게임 프로젝트에 저장한 파일의 검증이 실패했습니다.");
            }
            repo.verify_artifact(artifact)?;
            files.push(
                json!({"path":filename,"sha256":hash,"bytes":bytes,"format":artifact.format}),
            );
        }
        let delivery = json!({"schemaVersion":1,"path":directory,"runId":run_id,"itemId":item_id,"assetId":asset.id,"versionId":version.id,"files":files,"review":"pending","sourcePreserved":true});
        let receipt_path = directory.join("manifest.json");
        let mut receipt_file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&receipt_path)?;
        receipt_file.write_all(&serde_json::to_vec_pretty(&delivery)?)?;
        receipt_file.sync_all()?;
        let mut receipt = repo.copy_in(&receipt_path, "outputs", "production-delivery.json")?;
        receipt.role = ArtifactRole::Metadata;
        let aid = asset.id.clone();
        let vid = version.id.clone();
        let version = project
            .assets
            .iter_mut()
            .find(|a| a.id == aid)
            .unwrap()
            .versions
            .iter_mut()
            .find(|v| v.id == vid)
            .unwrap();
        version
            .settings
            .insert("productionDelivery".into(), delivery);
        version.artifacts.push(receipt);
        repo.save_project(&project)?;
        Ok(())
    }
}

#[cfg(test)]
fn managed_output(game: &Path, run_id: &str) -> Result<PathBuf> {
    managed_output_at(game, run_id, OUTPUT_FOLDER)
}

fn managed_output_at(game: &Path, run_id: &str, folder: &str) -> Result<PathBuf> {
    no_links(game)?;
    if !game.is_dir() {
        bail!("게임 프로젝트 폴더가 없습니다.");
    }
    Uuid::parse_str(run_id)?;
    if ![
        OUTPUT_FOLDER,
        "Assets/AssetStudioGenerated",
        "Content/AssetStudioGenerated",
    ]
    .contains(&folder)
    {
        bail!("게임 출력 폴더가 잘못됐습니다.");
    }
    let managed = game.join(folder);
    no_links(&managed)?;
    let marker = managed.join(".asset-studio-output.json");
    if managed.try_exists()? {
        let value:Value=read_json(&marker).context("같은 이름의 사용자 폴더는 보존했습니다. AssetStudioGenerated 폴더 이름을 확인해 주세요.")?;
        if value["format"] != "asset-studio/generated"
            || value["gameRoot"] != game.to_string_lossy().as_ref()
        {
            bail!("제작 폴더 표식이 다릅니다. 기존 파일은 보존했습니다.");
        }
    } else {
        fs::create_dir(&managed)?;
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&marker)?;
        file.write_all(&serde_json::to_vec(
            &json!({"format":"asset-studio/generated","gameRoot":game}),
        )?)?;
        file.sync_all()?;
    }
    let run = managed.join(run_id);
    no_links(&run)?;
    if !run.try_exists()? {
        fs::create_dir(&run)?;
    } else if !run.is_dir() {
        bail!("새 제작 폴더 경로를 사용할 수 없습니다.");
    }
    Ok(run)
}

/// Keep true transparency; otherwise remove only a uniform exterior matte.
/// Flood fill cannot erase enclosed white material. Original files are immutable.
fn prepare_foreground(source: &Path, target: &Path) -> Result<Value> {
    raster::inspect(source)?;
    let mut image = image::open(source)?.into_rgba8();
    let (w, h) = image.dimensions();
    if image.pixels().any(|p| p[3] < 250) {
        image.save(target)?;
        return Ok(json!({"method":"preserved_alpha"}));
    }
    let corners = [
        image.get_pixel(0, 0).0,
        image.get_pixel(w - 1, 0).0,
        image.get_pixel(0, h - 1).0,
        image.get_pixel(w - 1, h - 1).0,
    ];
    let bg = corners[0];
    let close = |p: &image::Rgba<u8>| (0..3).all(|i| p[i].abs_diff(bg[i]) <= 24);
    if !corners
        .iter()
        .all(|p| (0..3).all(|i| p[i].abs_diff(bg[i]) <= 12))
    {
        bail!("3D 참고 이미지의 배경을 자동 분리할 수 없습니다. 투명 배경의 단일 물체로 이미지를 다시 생성해 주세요.");
    }
    let border = (0..w)
        .flat_map(|x| [(x, 0), (x, h - 1)])
        .chain((0..h).flat_map(|y| [(0, y), (w - 1, y)]))
        .collect::<Vec<_>>();
    if border
        .iter()
        .filter(|&&(x, y)| close(image.get_pixel(x, y)))
        .count()
        * 100
        < border.len() * 98
    {
        bail!("3D 물체가 이미지 가장자리에 닿습니다. 전체 물체가 보이도록 이미지를 다시 생성해 주세요.");
    }
    let mut visited = vec![false; (w as usize) * (h as usize)];
    let mut queue = VecDeque::from(border);
    let mut removed = 0;
    while let Some((x, y)) = queue.pop_front() {
        let index = y as usize * w as usize + x as usize;
        if visited[index] {
            continue;
        }
        visited[index] = true;
        if !close(image.get_pixel(x, y)) {
            continue;
        }
        image.get_pixel_mut(x, y)[3] = 0;
        removed += 1;
        if x > 0 {
            queue.push_back((x - 1, y));
        }
        if x + 1 < w {
            queue.push_back((x + 1, y));
        }
        if y > 0 {
            queue.push_back((x, y - 1));
        }
        if y + 1 < h {
            queue.push_back((x, y + 1));
        }
    }
    if removed * 100 < u64::from(w) * u64::from(h) * 5
        || removed * 100 > u64::from(w) * u64::from(h) * 95
    {
        bail!("3D 참고 이미지에서 단일 물체를 구분할 수 없습니다. 이미지를 다시 생성해 주세요.");
    }
    image.save(target)?;
    Ok(json!({"method":"exterior_uniform_matte","backgroundRgb":&bg[..3],"removedPixels":removed}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(all(windows, target_arch = "x86_64"))]
    #[test]
    #[ignore = "requires a prepared local TripoSR CPU runtime and Blender; no provider requests"]
    fn windows_native_production_reconstruction_and_delivery() {
        let data = PathBuf::from(std::env::var_os("ASSET_WINDOWS_IMAGE3D_DATA_ROOT").expect("reserved native proof data"));
        let output = PathBuf::from(std::env::var_os("ASSET_WINDOWS_IMAGE3D_PRODUCTION_OUTPUT").expect("fresh native proof output"));
        assert!(data.is_absolute() && output.is_absolute() && !output.exists());
        fs::create_dir_all(&output).unwrap();
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let backend = Backend::new(data, base.join("../public/examples"), base.join("../../../workers/blender/worker.py"));
        let status = backend.quality3d_status();
        assert_eq!(status["supported"], true);
        assert_eq!(status["installed"], true);
        assert_eq!(status["blenderReady"], true);
        assert!(backend.inner.limits.ram_mb >= 8192);
        let root = output.join("workbench");
        let game = output.join("한글 게임 프로젝트");
        fs::create_dir(&game).unwrap();
        let original_game = game.join("project.godot");
        fs::write(&original_game, b"[application]\nconfig/name=\"Windows production proof\"\n").unwrap();
        let original_game_hash = asset_core::sha256_file(&original_game).unwrap();
        let source = base.join("../../../workers/image3d/fixtures/blue-sphere.png");
        let source_hash = asset_core::sha256_file(&source).unwrap();
        backend.request(json!({"action":"create","root":root,"name":"Windows production reconstruction proof"})).unwrap();
        backend.request(json!({"action":"import","paths":[source]})).unwrap();
        backend.request(json!({"action":"game_connect","root":game})).unwrap();
        let image_job_id = Uuid::new_v4().to_string();
        let mut repo = Repository::open(&root).unwrap();
        let mut project = repo.project().unwrap();
        // This is a recorded local fixture, not a newly generated GPT image.
        // Bind only its QA metadata to the same image-job boundary as production.
        let concept = &mut project.assets[0].versions[0];
        concept.artifacts[0].role = ArtifactRole::Output;
        concept.settings.insert("jobId".into(), json!(image_job_id));
        concept.settings.insert("localFixtureOnly".into(), json!(true));
        repo.save_project(&project).unwrap();
        let mut task = job(&project, "production_model", "Windows production reconstruction", None, JobResource::Blender,
            json!({"name":"Windows reconstructed sphere","imageJobId":image_job_id,
            "productionRunId":Uuid::new_v4().to_string(),"productionItemId":Uuid::new_v4().to_string(),
            "gameRoot":game,"gameOutputFolder":OUTPUT_FOLDER,"quality":"high","heightMeters":1.,
            "maxTriangles":10000,"textureResolution":1024,"preserveMaterials":true,"sourceKind":"image3d",
            "spec":project.spec,"resources":{"ramMb":8192,"cpuThreads":2,"diskWeight":2}})).unwrap();
        task.payload.insert("toolVersion".into(), json!(backend.inner.blender_version));
        let queue = SchedulerStore::open(&root.join("scheduler.sqlite")).unwrap();
        queue.enqueue(task.clone()).unwrap();
        let admitted = queue.claim_ready(&backend.inner.limits).unwrap();
        assert_eq!(admitted.len(), 1);
        assert_eq!(admitted[0].id, task.id);
        let task = admitted[0].clone();
        let work = output.join("native-work");
        fs::create_dir(&work).unwrap();
        let started = Instant::now();
        backend.run_production_model(&root, &task, &work, &AtomicBool::new(false)).unwrap();
        queue.complete(&task.id).unwrap();
        let completed = Repository::open(&root).unwrap().project().unwrap();
        let (model, version) = asset_for_job(&completed, &task.id).unwrap();
        assert_eq!(model.kind, AssetKind::Model);
        assert_eq!(version.source, AssetSource::LocalImage3d);
        assert_eq!(version.settings["localReconstruction"]["device"], "cpu");
        let delivery = &version.settings["productionDelivery"];
        let delivered = PathBuf::from(delivery["path"].as_str().unwrap());
        assert!(delivered.starts_with(&game));
        for file in delivery["files"].as_array().unwrap() {
            let (hash, bytes) = asset_core::sha256_file(&delivered.join(file["path"].as_str().unwrap())).unwrap();
            assert_eq!(file["sha256"], hash);
            assert_eq!(file["bytes"], bytes);
        }
        assert_eq!(asset_core::sha256_file(&source).unwrap(), source_hash);
        assert_eq!(asset_core::sha256_file(&original_game).unwrap(), original_game_hash);
        let report = json!({"passed":true,"platform":"windows","fixtureImage":true,"providerCommands":0,
            "realGptGeneration":false,"nativeProductionModel":true,"sourceOriginalPreserved":true,
            "gameOriginalPreserved":true,"modelId":model.id,"jobId":task.id,"elapsedSeconds":started.elapsed().as_secs_f64(),
            "delivery":delivery,"reconstruction":version.settings["localReconstruction"],"project":root,"work":work});
        fs::write(output.join("production-image3d-proof.json"), serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        backend.shutdown();
    }

    #[test]
    fn planning_errors_keep_actionable_causes_without_private_runtime_details() {
        let cases = [
            (RuntimeError::AuthenticationRequired, "로그인"),
            (RuntimeError::Timeout, "응답 시간"),
            (
                RuntimeError::OutcomeUnknown {
                    stage: "planning_timeout",
                    thread_id: Some("PRIVATE_CREDENTIAL".into()),
                    turn_id: Some("PRIVATE_CREDENTIAL".into()),
                },
                "10분",
            ),
            (
                RuntimeError::OutcomeUnknown {
                    stage: "PRIVATE_CREDENTIAL",
                    thread_id: None,
                    turn_id: None,
                },
                "연결이 끊겨",
            ),
            (
                RuntimeError::InvalidPlanRule {
                    rule: "PRIVATE_CREDENTIAL",
                },
                "제작 목록의 형식",
            ),
        ];
        for (error, message) in cases {
            let code = error.code();
            let displayed = planning_error(error).to_string();
            assert!(displayed.contains(message));
            assert!(displayed.contains(code));
            assert!(!displayed.contains("PRIVATE_CREDENTIAL"));
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_verbatim_paths_preserve_state_and_managed_delivery() {
        // This storage-path regression neither discovers installed tools nor
        // constructs a provider runtime. Every file belongs to this fixture.
        struct OwnedRoot {
            directory: PathBuf,
            parent: PathBuf,
        }
        impl Drop for OwnedRoot {
            fn drop(&mut self) {
                assert_eq!(self.directory.parent(), Some(self.parent.as_path()));
                assert!(self
                    .directory
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("asset-production-windows-paths-"));
                let _ = fs::remove_dir_all(&self.directory);
            }
        }
        let parent = std::env::temp_dir().canonicalize().unwrap();
        let directory = parent.join(format!("asset-production-windows-paths-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let owned = OwnedRoot {
            directory: directory.canonicalize().unwrap(),
            parent,
        };
        assert!(matches!(
            owned.directory.components().next(),
            Some(std::path::Component::Prefix(prefix))
                if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_) | std::path::Prefix::VerbatimUNC(_, _))
        ));
        let workspace = owned.directory.join("제작 작업 공간");
        let game = owned.directory.join("한글 게임 프로젝트");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(&game).unwrap();
        let original = game.join("project.godot");
        let original_bytes = b"[application]\nconfig/name=\"Original test game\"\n";
        fs::write(&original, original_bytes).unwrap();
        let original_hash = asset_core::sha256_file(&original).unwrap();
        let scan = project_scan::scan(&game).unwrap();
        assert_eq!(scan["engine"], "godot");

        let mut state = State {
            connection: Some(scan),
            ..State::default()
        };
        save_json(&state_path(&workspace), &state).unwrap();
        let run_id = Uuid::new_v4().to_string();
        state.run_ids.push(run_id.clone());
        // Replacing an app-owned state snapshot must still work on Windows.
        save_json(&state_path(&workspace), &state).unwrap();
        assert_eq!(
            serde_json::to_value(load_state(&workspace).unwrap()).unwrap(),
            serde_json::to_value(&state).unwrap()
        );

        let run = managed_output(&game, &run_id).unwrap();
        let target = run.join("새 결과 파일.txt");
        no_links(&target).unwrap();
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .unwrap();
        output.write_all(b"independent delivery fixture").unwrap();
        output.sync_all().unwrap();
        drop(output);
        assert_eq!(managed_output(&game, &run_id).unwrap(), run);
        assert!(fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .is_err());
        assert_eq!(fs::read(&target).unwrap(), b"independent delivery fixture");
        assert_eq!(asset_core::sha256_file(&original).unwrap(), original_hash);
        assert_eq!(fs::read(&original).unwrap(), original_bytes);

        let linked = owned.directory.join("linked-game");
        match std::os::windows::fs::symlink_dir(&game, &linked) {
            Ok(()) => {
                assert!(linked_metadata(&fs::symlink_metadata(&linked).unwrap()));
                assert!(no_links(&linked.join("future-output.json")).is_err());
                fs::remove_dir(&linked).unwrap();
            }
            Err(error) if matches!(error.raw_os_error(), Some(5 | 1314)) => {
                eprintln!("SKIPPED Windows symlink fixture: creation privilege unavailable ({error}); canonical storage/delivery checks still executed");
            }
            Err(error) => panic!("cannot create owned Windows link fixture: {error}"),
        }
    }

    struct Fixture {
        directory: PathBuf,
        root: PathBuf,
        game: PathBuf,
        backend: Backend,
    }
    impl Fixture {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("asset-production-backend-{}", Uuid::new_v4()));
            fs::create_dir(&directory).unwrap();
            let directory = directory.canonicalize().unwrap();
            let root = directory.join("workspace");
            let game = directory.join("game");
            fs::create_dir(&game).unwrap();
            fs::write(
                game.join("project.godot"),
                "[application]\nconfig/name=\"Test Game\"\n",
            )
            .unwrap();
            // Admission/storage fixtures must never discover installed tools,
            // invoke a provider, authenticate, or download a local runtime.
            let backend = Backend {
                inner: Arc::new(Inner {
                    data: directory.join("app-data"),
                    examples: directory.join("unused-examples"),
                    worker: directory.join("unused-worker.py"),
                    blender: None,
                    blender_version: None,
                    worker_sha256: None,
                    current: Mutex::new(None),
                    project_lease: Mutex::new(None),
                    requests: Mutex::new(()),
                    io: Mutex::new(()),
                    dispatch: Mutex::new(()),
                    initialize: Mutex::new(()),
                    runners: Mutex::new(BTreeMap::new()),
                    stop: AtomicBool::new(false),
                    limits: ResourceLimits::default(),
                    provider_runtime: Mutex::new(None),
                    provider_connection: Mutex::new(provider::unavailable_connection(
                        "단위 테스트는 외부 생성을 요청하지 않습니다.",
                    )),
                    codex_installer: asset_providers::installer::CodexInstaller::new(
                        directory.join("unused-installer"),
                    ),
                    planning_cancel: Mutex::new(None),
                    quality3d_setup: quality3d::SetupState::default(),
                }),
            };
            backend
                .request(json!({"action":"create","root":root,"name":"Private test workspace"}))
                .unwrap();
            let connected = backend
                .request(json!({"action":"game_connect","root":game}))
                .unwrap();
            let project = Repository::open(&root).unwrap().project().unwrap();
            let scan = connected["connection"].clone();
            let plan = Plan {
                schema_version: 1,
                id: Uuid::new_v4().to_string(),
                project_id: project.id.clone(),
                planner_model: "gpt-5.5".into(),
                game_root: game.to_string_lossy().into(),
                fingerprint: scan["fingerprint"].as_str().unwrap().into(),
                brief: "Two distinct game icons".into(),
                output: "images".into(),
                mode: "new".into(),
                spec: project.spec.clone(),
                style_guide: project.style_guide.clone(),
                reference_asset_ids: vec![],
                references: json!([]),
                summary: "Two icons".into(),
                warnings: vec![],
                items: ["Sword", "Shield"]
                    .into_iter()
                    .map(|name| Item {
                        id: Uuid::new_v4().to_string(),
                        name: name.into(),
                        kind: AssetKind::Sprite,
                        prompt: format!("SINGLE ASSET \"{name}\": A single {name} icon."),
                        purpose: "Game inventory".into(),
                        reference_asset_ids: vec![],
                        target_asset_id: None,
                        model_parameters: None,
                        enabled: true,
                    })
                    .collect(),
            };
            save_json(
                &state_path(&root),
                &State {
                    connection: Some(scan),
                    plan: Some(plan),
                    run_ids: vec![],
                },
            )
            .unwrap();
            *backend.inner.provider_connection.lock().unwrap() = json!({"ready":true,"runtimeVersion":"unit-fixture-no-provider","reasoningModel":"gpt-6.1-sol"});
            Self {
                directory,
                root,
                game,
                backend,
            }
        }
        fn start_request(&self) -> Value {
            json!({"action":"production_start","planId":load_state(&self.root).unwrap().plan.unwrap().id,"requestId":Uuid::new_v4().to_string(),"uploadApproved":true})
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.backend.shutdown();
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    #[cfg(not(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "windows", target_arch = "x86_64"))))]
    #[test]
    fn unsupported_production_plan_preserves_project_before_provider_or_cache_creation() {
        let f = Fixture::new();
        let before_state = fs::read(state_path(&f.root)).unwrap();
        let before_project =
            serde_json::to_value(Repository::open(&f.root).unwrap().project().unwrap()).unwrap();
        let before_original = asset_core::sha256_file(&f.game.join("project.godot")).unwrap();
        let queue = SchedulerStore::open(&f.root.join("scheduler.sqlite")).unwrap();
        fs::create_dir(f.root.join("cache")).unwrap();
        let cache_file = f.root.join("cache/preexisting-cache.txt");
        fs::write(&cache_file, b"preserve existing cached data").unwrap();
        let before_cache_file = asset_core::sha256_file(&cache_file).unwrap();
        let cache_entries = || {
            let mut entries: Vec<_> = fs::read_dir(f.root.join("cache"))
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            entries.sort();
            entries
        };
        let before_cache = cache_entries();
        for output in ["models", "mixed"] {
            let error = f
                .backend
                .request(json!({"action":"production_plan","brief":"A game with images and model concepts",
                    "output":output,"referenceAssetIds":[],"uploadApproved":true}))
                .unwrap_err()
                .to_string();
            assert!(error.contains("'이미지'를 선택하고 다시 분석"), "{error}");
            assert!(f.backend.inner.provider_runtime.lock().unwrap().is_none());
            assert!(f.backend.inner.planning_cancel.lock().unwrap().is_none());
            assert!(!f.backend.inner.codex_installer.busy());
            assert!(queue.jobs().unwrap().is_empty());
            assert_eq!(fs::read(state_path(&f.root)).unwrap(), before_state);
            assert_eq!(
                serde_json::to_value(Repository::open(&f.root).unwrap().project().unwrap())
                    .unwrap(),
                before_project
            );
            assert_eq!(
                asset_core::sha256_file(&f.game.join("project.godot")).unwrap(),
                before_original
            );
            assert_eq!(cache_entries(), before_cache);
            assert_eq!(
                asset_core::sha256_file(&cache_file).unwrap(),
                before_cache_file
            );
            assert!(!f.game.join(OUTPUT_FOLDER).exists());
        }
    }

    #[test]
    fn production_admission_is_atomic_replayable_and_durable_without_provider_calls() {
        let f = Fixture::new();
        let request = f.start_request();
        let first = f.backend.request(request.clone()).unwrap();
        let repeat = f.backend.request(request).unwrap();
        assert_eq!(
            first["snapshot"]["project"]["jobs"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            first["state"]["runs"][0]["id"],
            repeat["state"]["runs"][0]["id"]
        );
        let jobs = SchedulerStore::open(&f.root.join("scheduler.sqlite"))
            .unwrap()
            .jobs()
            .unwrap();
        assert_eq!(jobs.len(), 2);
        assert!(jobs.iter().all(
            |j| matches!(j.status, JobStatus::Pending | JobStatus::Ready)
                && j.payload["singleAsset"] == true
        ));
        assert_ne!(jobs[0].payload["name"], jobs[1].payload["name"]);
        assert!(!f.game.join(OUTPUT_FOLDER).exists());
        f.backend.shutdown();
        let reopened = Backend::new(
            f.directory.join("app-data"),
            f.directory.join("examples"),
            f.directory.join("worker.py"),
        );
        reopened.request(json!({"action":"bootstrap"})).unwrap();
        assert_eq!(
            reopened
                .request(json!({"action":"production_state"}))
                .unwrap()["runs"],
            repeat["state"]["runs"]
        );
        reopened.shutdown();
    }

    #[test]
    fn changed_project_and_unprepared_3d_never_partially_admit_images() {
        let f = Fixture::new();
        fs::write(f.game.join("main.tscn"), "[gd_scene format=3]\n").unwrap();
        assert!(f.backend.request(f.start_request()).is_err());
        assert!(SchedulerStore::open(&f.root.join("scheduler.sqlite"))
            .unwrap()
            .jobs()
            .unwrap()
            .is_empty());
        let mut state = load_state(&f.root).unwrap();
        let scan = project_scan::scan(&f.game).unwrap();
        let plan = state.plan.as_mut().unwrap();
        plan.fingerprint = scan["fingerprint"].as_str().unwrap().into();
        plan.output = "mixed".into();
        plan.items[1].kind = AssetKind::Model;
        save_json(&state_path(&f.root), &state).unwrap();
        assert!(f.backend.request(f.start_request()).is_err());
        assert!(SchedulerStore::open(&f.root.join("scheduler.sqlite"))
            .unwrap()
            .jobs()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn received_image_reuse_and_delivery_tamper_are_checked_without_resubmission() {
        let f = Fixture::new();
        f.backend.request(f.start_request()).unwrap();
        let queue = SchedulerStore::open(&f.root.join("scheduler.sqlite")).unwrap();
        let mut task = queue
            .claim_ready(&ResourceLimits::default())
            .unwrap()
            .remove(0);
        let source = f.directory.join("image.png");
        image::RgbaImage::from_pixel(32, 32, image::Rgba([80, 120, 180, 255]))
            .save(&source)
            .unwrap();
        let mut repo = Repository::open(&f.root).unwrap();
        let mut artifact = repo.copy_in(&source, "outputs", "image.png").unwrap();
        artifact.role = ArtifactRole::Output;
        let mut generated = new_asset(
            "Sword".into(),
            AssetKind::Sprite,
            AssetSource::CodexSubscription,
            vec![artifact.clone()],
            Some((32, 32)),
            None,
            Some(image_report(&artifact.id, &raster::inspect(&source).unwrap()).unwrap()),
            BTreeMap::new(),
        );
        generated.versions[0].requested_model = Some(REQUESTED_IMAGE_MODEL.into());
        record_generated(&mut repo, generated, &task).unwrap();
        let preserved =
            asset_core::sha256_file(&repo.artifact_path(&artifact.path).unwrap()).unwrap();
        task.payload
            .insert("executionId".into(), json!(Uuid::new_v4().to_string()));
        assert!(f.backend.reuse_production_image(&f.root, &task).unwrap());
        assert_eq!(
            asset_core::sha256_file(&repo.artifact_path(&artifact.path).unwrap()).unwrap(),
            preserved
        );
        f.backend
            .deliver_production_asset(&f.root, &task, &AtomicBool::new(false))
            .unwrap();
        let project = repo.project().unwrap();
        let (_, version) = asset_for_job(&project, &task.id).unwrap();
        verify_delivery(&task, version).unwrap();
        let delivery = &version.settings["productionDelivery"];
        let filename = delivery["files"][0]["path"].as_str().unwrap();
        fs::write(
            Path::new(delivery["path"].as_str().unwrap()).join(filename),
            "changed output",
        )
        .unwrap();
        assert!(verify_delivery(&task, version).is_err());
        let scan = project_scan::scan(&f.game).unwrap();
        assert_eq!(
            include_delivered_inventory(&scan, &project).unwrap()["assetCount"],
            scan["assetCount"]
        );
    }

    #[test]
    fn planning_inventory_is_bounded_and_records_omitted_entries() {
        let entries: Vec<_> = (0..2100)
            .map(|i| json!({"path":format!("assets/{i}-{}.png","x".repeat(180)),"kind":"image"}))
            .collect();
        let context=planning_project_context(&json!({"engine":"unknown","assetCount":2100,"assets":entries,"missingReferences":[],"warnings":[]})).unwrap();
        assert!(context["assets"].as_array().unwrap().len() < 2000);
        assert!(!context["warnings"].as_array().unwrap().is_empty());
        assert!(serde_json::to_vec(&context).unwrap().len() < 160 * 1024);
    }
    #[test]
    fn foreground_removes_exterior_only_and_preserves_original() {
        let root = std::env::temp_dir().join(format!("asset-production-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let source = root.join("original.png");
        let target = root.join("new.png");
        let mut image = image::RgbaImage::from_pixel(64, 64, image::Rgba([255, 255, 255, 255]));
        for y in 12..52 {
            for x in 12..52 {
                image.put_pixel(x, y, image::Rgba([40, 60, 80, 255]));
            }
        }
        image.put_pixel(32, 32, image::Rgba([255, 255, 255, 255]));
        image.save(&source).unwrap();
        let before = asset_core::sha256_file(&source).unwrap();
        assert_eq!(
            prepare_foreground(&source, &target).unwrap()["method"],
            "exterior_uniform_matte"
        );
        let result = image::open(target).unwrap().into_rgba8();
        assert_eq!(result.get_pixel(0, 0)[3], 0);
        assert_eq!(result.get_pixel(32, 32)[3], 255);
        assert_eq!(asset_core::sha256_file(&source).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn user_output_folder_is_never_adopted_or_overwritten() {
        let root = std::env::temp_dir().join(format!("asset-production-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        fs::create_dir(root.join(OUTPUT_FOLDER)).unwrap();
        fs::write(root.join(OUTPUT_FOLDER).join("original.txt"), "preserve").unwrap();
        assert!(managed_output(&root, &Uuid::new_v4().to_string()).is_err());
        assert_eq!(
            fs::read_to_string(root.join(OUTPUT_FOLDER).join("original.txt")).unwrap(),
            "preserve"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn output_links_are_rejected() {
        let root = std::env::temp_dir().join(format!("asset-production-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        std::os::unix::fs::symlink(&root, root.join(OUTPUT_FOLDER)).unwrap();
        assert!(managed_output(&root, &Uuid::new_v4().to_string()).is_err());
        fs::remove_file(root.join(OUTPUT_FOLDER)).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
