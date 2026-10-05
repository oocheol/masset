//! Reviewable per-item plans and all-or-nothing admission of mixed game assets.
use super::*;
use asset_providers::runtime::{CodexRuntime, RuntimeOptions};
use asset_providers::REQUESTED_IMAGE_MODEL;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const TEMPLATES: [&str; 9] = [
    "crate",
    "table",
    "shelf",
    "sword",
    "rifle",
    "spaceship",
    "barrel",
    "rock",
    "tree",
];
// An explicit text-only planning route, independent of the image agent model.
// The pinned official catalog and live model/list must both admit this model.
const PLANNING_MODEL: &str = "gpt-5.5";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Reference {
    asset_id: String,
    version_id: String,
    name: String,
    kind: AssetKind,
    width: Option<u32>,
    height: Option<u32>,
    mesh: Option<MeshInfo>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
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
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    schema_version: u32,
    id: String,
    project_id: String,
    planner_model: String,
    brief: String,
    output: String,
    mode: String,
    spec: AssetSpec,
    style_guide: StyleGuide,
    reference_asset_ids: Vec<String>,
    references: Vec<Reference>,
    summary: String,
    items: Vec<Item>,
    warnings: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProposedItem {
    name: String,
    kind: AssetKind,
    prompt: String,
    purpose: String,
    reference_asset_ids: Vec<String>,
    target_asset_id: Option<String>,
    model_parameters: Option<ModelParameters>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Proposal {
    summary: String,
    items: Vec<ProposedItem>,
    warnings: Vec<String>,
}

fn checked_text(text: &str, max: usize, label: &str) -> Result<()> {
    if text.trim().is_empty()
        || text.len() > max
        || text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        bail!("{label}의 길이와 내용을 확인해 주세요.")
    }
    Ok(())
}
pub(super) fn references(project: &Project, ids: &[String]) -> Result<Vec<Reference>> {
    if ids.len() > 5 || ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        bail!("참고 에셋은 중복 없이 최대 5개까지 선택해 주세요.")
    }
    ids.iter()
        .map(|id| {
            let a = project
                .assets
                .iter()
                .find(|a| &a.id == id)
                .context("현재 프로젝트의 참고 에셋을 선택해 주세요.")?;
            Ok(Reference {
                asset_id: a.id.clone(),
                version_id: a.active_version_id.clone(),
                name: a.name.clone(),
                kind: a.kind,
                width: a.width,
                height: a.height,
                mesh: a.mesh.clone(),
            })
        })
        .collect()
}
pub(super) fn reference_artifacts(project: &Project, refs: &[Reference]) -> Result<Value> {
    let mut files = Vec::new();
    for r in refs {
        let a = project
            .assets
            .iter()
            .find(|a| a.id == r.asset_id)
            .context("참고 에셋이 없습니다.")?;
        let v = a
            .versions
            .iter()
            .find(|v| v.id == r.version_id)
            .context("참고 버전을 찾을 수 없습니다.")?;
        let artifact = if a.kind == AssetKind::Model {
            v.artifacts
                .iter()
                .find(|a| a.role == ArtifactRole::Thumbnail && is_raster(&a.format))
        } else {
            v.artifacts
                .iter()
                .find(|a| a.role == ArtifactRole::Output && is_raster(&a.format))
                .or_else(|| v.artifacts.iter().find(|a| is_raster(&a.format)))
        };
        if let Some(f) = artifact {
            files.push(json!({"assetId":a.id,"versionId":v.id,"artifactId":f.id,"path":f.path,"sha256":f.sha256}));
        }
    }
    Ok(json!(files))
}
pub(super) fn verify_references(root: &Path, refs: &[Reference]) -> Result<()> {
    let repo = Repository::open(root)?;
    let project = repo.project()?;
    for reference in refs {
        let asset = project
            .assets
            .iter()
            .find(|a| a.id == reference.asset_id)
            .context("참고 에셋이 없습니다.")?;
        let version = asset
            .versions
            .iter()
            .find(|v| v.id == reference.version_id)
            .context("참고 버전을 찾을 수 없습니다.")?;
        for artifact in &version.artifacts {
            repo.verify_artifact(artifact)?;
        }
    }
    Ok(())
}
pub(super) fn copy_reference_images(
    root: &Path,
    files: &Value,
    work: &Path,
) -> Result<Vec<PathBuf>> {
    let files = files.as_array().context("참고 파일 기록이 없습니다.")?;
    if files.len() > 5 {
        bail!("참고 이미지는 최대 5개입니다.")
    }
    let repo = Repository::open(root)?;
    let project = repo.project()?;
    let directory = work.join("reference-images");
    fs::create_dir_all(&directory)?;
    let mut result = Vec::new();
    for (n, f) in files.iter().enumerate() {
        let asset = project
            .assets
            .iter()
            .find(|a| Some(a.id.as_str()) == f["assetId"].as_str())
            .context("참고 에셋 기록이 없습니다.")?;
        let version = asset
            .versions
            .iter()
            .find(|v| Some(v.id.as_str()) == f["versionId"].as_str())
            .context("참고 버전 기록이 없습니다.")?;
        let artifact = version
            .artifacts
            .iter()
            .find(|a| {
                Some(a.id.as_str()) == f["artifactId"].as_str()
                    && Some(a.path.as_str()) == f["path"].as_str()
                    && Some(a.sha256.as_str()) == f["sha256"].as_str()
            })
            .context("참고 파일 식별자·해시가 다릅니다.")?;
        repo.verify_artifact(artifact)?;
        let source = repo.artifact_path(&artifact.path)?;
        let copy = directory.join(format!("reference-{n}.png"));
        if copy.exists() {
            bail!("참고 이미지 작업 공간은 새 폴더여야 합니다.")
        }
        raster::convert(&source, &copy, "png")?;
        repo.verify_artifact(artifact)?;
        result.push(copy);
    }
    Ok(result)
}

impl Backend {
    pub(super) fn plan_game_assets(&self, request: &Value) -> Result<Value> {
        let brief = text_field(request, "brief")?.trim();
        checked_text(brief, 16000, "게임 설명")?;
        let output = request["output"].as_str().unwrap_or("images");
        let mode = request["mode"].as_str().unwrap_or("new");
        if !["images", "models", "mixed"].contains(&output) || !["new", "improve"].contains(&mode) {
            bail!("제작 종류를 확인해 주세요.")
        }
        let count = request
            .get("count")
            .filter(|v| !v.is_null())
            .map(|v| v.as_u64().context("제작 수는 정수여야 합니다."))
            .transpose()?;
        if count.is_some_and(|n| n == 0 || n > if output == "models" { 24 } else { 20 }) {
            bail!("이미지 20개·모델 24개 이내로 구성해 주세요.")
        }
        let root = self.root()?;
        let project = Repository::open(&root)?.project()?;
        let ids: Vec<String> = serde_json::from_value(request["referenceAssetIds"].clone())?;
        let refs = references(&project, &ids)?;
        if !refs.is_empty() && request["referenceUploadApproved"] != true {
            bail!("참고 이미지·모델 정보를 구독 연결에 전달하는 데 동의해 주세요.")
        }
        verify_references(&root, &refs)?;
        let executable = self
            .provider_executable()
            .context("게임 에셋 구성안에 사용할 GPT 구독 연결을 확인해 주세요.")?;
        let work = root
            .join("cache")
            .join(format!("game-plan-{}", Uuid::new_v4()));
        fs::create_dir_all(&work)?;
        let images = copy_reference_images(&root, &reference_artifacts(&project, &refs)?, &work)?;
        let cancel = Arc::new(AtomicBool::new(false));
        *self.inner.planning_cancel.lock().unwrap() = Some(cancel.clone());
        let result = (|| -> Result<Value> {
            let mut context = json!({"brief":brief,"output":output,"mode":mode,"styleGuide":project.style_guide,"spec":project.spec,"references":refs,"supportedModelTemplates":if self.inner.blender.is_some(){TEMPLATES.to_vec()}else{vec![]}});
            if let Some(count) = count {
                context["count"] = json!(count)
            }
            let mut options = RuntimeOptions::new(executable, work.join("rpc"));
            options.reasoning_model = Some(PLANNING_MODEL.into());
            let mut runtime = CodexRuntime::connect_for_planning(options)?;
            let proposal: Proposal =
                serde_json::from_value(runtime.plan_assets(&context, &images, &cancel)?)?;
            if cancel.load(Ordering::SeqCst) {
                bail!("구성안 작성을 취소했습니다. 에셋 제작 요청은 제출하지 않았습니다.")
            }
            checked_text(&proposal.summary, 8000, "구성안 설명")?;
            if proposal.items.is_empty()
                || proposal.items.len() > 44
                || proposal.warnings.len() > 16
                || proposal.warnings.iter().any(|w| w.len() > 2048)
                || count.is_some_and(|n| {
                    n as usize
                        != proposal
                            .items
                            .iter()
                            .filter(|i| {
                                if output == "models" {
                                    i.kind == AssetKind::Model
                                } else {
                                    i.kind != AssetKind::Model
                                }
                            })
                            .count()
                })
            {
                bail!("구성안의 개수가 요청과 다릅니다. 에셋 제작은 시작하지 않았습니다.")
            }
            let items = proposal
                .items
                .into_iter()
                .map(|i| Item {
                    id: Uuid::new_v4().to_string(),
                    name: i.name,
                    kind: i.kind,
                    prompt: i.prompt,
                    purpose: i.purpose,
                    reference_asset_ids: i.reference_asset_ids,
                    target_asset_id: i.target_asset_id,
                    model_parameters: i.model_parameters,
                    enabled: true,
                })
                .collect();
            let plan = Plan {
                schema_version: 1,
                id: Uuid::new_v4().to_string(),
                project_id: project.id.clone(),
                planner_model: PLANNING_MODEL.into(),
                brief: brief.into(),
                output: output.into(),
                mode: mode.into(),
                spec: project.spec.clone(),
                style_guide: project.style_guide.clone(),
                reference_asset_ids: ids,
                references: refs,
                summary: proposal.summary,
                items,
                warnings: proposal.warnings,
            };
            validate_plan(&plan, &project)?;
            fs::write(work.join("plan.json"), serde_json::to_vec_pretty(&plan)?)?;
            Ok(serde_json::to_value(plan)?)
        })();
        *self.inner.planning_cancel.lock().unwrap() = None;
        result
    }

    pub(super) fn enqueue_game_bundle(&self, request: &Value) -> Result<()> {
        if request["approved"] != true {
            bail!("개별 제작 항목과 공통 규격·스타일을 승인해 주세요.")
        }
        let request_id = text_field(request, "requestId")?;
        Uuid::parse_str(request_id)?;
        let plan: Plan = serde_json::from_value(request["plan"].clone())?;
        let root = self.root()?;
        let project = Repository::open(&root)?.project()?;
        validate_plan(&plan, &project)?;
        if !plan.references.is_empty() && request["referenceUploadApproved"] != true {
            bail!("참고 자료 전달 동의를 확인해 주세요.")
        }
        verify_references(&root, &plan.references)?;
        if plan.spec != project.spec
            || plan.style_guide != project.style_guide
            || !project.style_guide.approved
        {
            bail!("구성안 작성 뒤 공통 규격·스타일이 바뀌었습니다. 새 구성안을 확인해 주세요.")
        }
        let status = self.inner.provider_connection.lock().unwrap().clone();
        let enabled: Vec<_> = plan.items.iter().filter(|i| i.enabled).collect();
        if enabled.iter().any(|i| i.kind != AssetKind::Model) && status["ready"] != true {
            bail!("이미지 제작에 사용할 GPT 구독 연결을 먼저 확인해 주세요.")
        }
        if enabled.iter().any(|i| i.kind == AssetKind::Model) && self.inner.blender.is_none() {
            bail!("3D 제작에 필요한 Blender를 확인해 주세요. 다른 항목도 제출하지 않았습니다.")
        }
        let mut tasks = Vec::new();
        for item in enabled {
            let refs: Vec<_> = plan
                .references
                .iter()
                .filter(|r| item.reference_asset_ids.contains(&r.asset_id))
                .cloned()
                .collect();
            let inputs = reference_artifacts(&project, &refs)?;
            for f in inputs.as_array().unwrap() {
                resolve_artifact(&root, text_field(f, "path")?)?;
            }
            let common = json!({"name":item.name,"prompt":item.prompt,"bundleId":plan.id,"bundleItemId":item.id,"assetKind":item.kind,"purpose":item.purpose,"references":inputs,"referenceMetadata":refs,"styleGuide":project.style_guide,"spec":project.spec});
            if item.kind == AssetKind::Model {
                let mut payload = common;
                let mut params = item
                    .model_parameters
                    .clone()
                    .context("3D 치수를 확인해 주세요.")?;
                params.name = item.name.clone();
                payload["parameters"] = serde_json::to_value(params)?;
                payload["toolVersion"] = json!(self.inner.blender_version);
                payload["workerSha256"] = json!(self.inner.worker_sha256);
                payload["resources"] = json!({"ramMb":1024,"cpuThreads":2,"diskWeight":1});
                tasks.push(job(
                    &project,
                    "blender_model",
                    &format!("3D 제작 · {}", item.name),
                    None,
                    JobResource::Blender,
                    payload,
                )?);
            } else {
                let mut payload = common;
                payload["requestedModel"] = json!(REQUESTED_IMAGE_MODEL);
                payload["reasoningModel"] = status["reasoningModel"].clone();
                payload["toolVersion"] = status["runtimeVersion"].clone();
                payload["singleAsset"] = json!(true);
                payload["normalizeToSpec"] = json!(true);
                payload["resources"] = json!({"ramMb":image_ram_mb(raster::MAX_PIXELS,16,384),"cpuThreads":1,"diskWeight":1});
                tasks.push(job(
                    &project,
                    "image_generate",
                    &format!("2D 제작 · {}", item.name),
                    item.target_asset_id.clone(),
                    JobResource::External,
                    payload,
                )?);
            }
        }
        // One transaction: a bad item, unavailable dependency or repeated
        // submit never leaves a partial image/model batch or charges twice.
        SchedulerStore::open(&root.join("scheduler.sqlite"))?
            .enqueue_many_once(request_id, tasks)?;
        Ok(())
    }
}

fn validate_plan(plan: &Plan, project: &Project) -> Result<()> {
    if plan.schema_version != 1
        || plan.project_id != project.id
        || plan.planner_model != PLANNING_MODEL
        || !["images", "models", "mixed"].contains(&plan.output.as_str())
        || !["new", "improve"].contains(&plan.mode.as_str())
    {
        bail!("현재 프로젝트의 구성안이 아닙니다.")
    }
    Uuid::parse_str(&plan.id)?;
    checked_text(&plan.brief, 16000, "게임 설명")?;
    if plan.items.is_empty() || plan.items.len() > 44 || plan.references.len() > 5 {
        bail!("구성안의 항목 제한을 확인해 주세요.")
    }
    let current = references(project, &plan.reference_asset_ids)?;
    if current != plan.references {
        bail!("참고 에셋 버전이나 정보가 바뀌었습니다. 새 구성안을 확인해 주세요.")
    }
    let mut names = HashSet::new();
    let mut ids = HashSet::new();
    let mut images = 0;
    let mut models = 0;
    let mut targets = HashSet::new();
    for i in plan.items.iter().filter(|i| i.enabled) {
        Uuid::parse_str(&i.id)?;
        if !ids.insert(&i.id) || !names.insert(i.name.trim().to_lowercase()) {
            bail!("개별 항목의 이름과 식별자는 서로 달라야 합니다.")
        }
        checked_text(&i.name, 240, "에셋 이름")?;
        checked_text(&i.prompt, 16000, "개별 에셋 설명")?;
        if i.name.chars().count() > 80
            || i.name
                .chars()
                .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
            || i.purpose.len() > 2048
        {
            bail!("에셋 이름과 용도를 확인해 주세요.")
        }
        if i.reference_asset_ids.len() > 5
            || i.reference_asset_ids.iter().collect::<HashSet<_>>().len()
                != i.reference_asset_ids.len()
            || i.reference_asset_ids
                .iter()
                .any(|id| !plan.reference_asset_ids.contains(id))
        {
            bail!("승인한 참고 에셋만 사용할 수 있습니다.")
        }
        if i.kind == AssetKind::Model {
            if plan.output == "images" || plan.mode == "improve" {
                bail!("기존 에셋 개선은 2D 새 버전으로 제작합니다. 모델은 새 모델 구성안으로 제작해 주세요.")
            }
            models += 1;
            let mut p = i
                .model_parameters
                .clone()
                .context("3D 항목에 템플릿과 치수가 필요합니다.")?;
            p.name = i.name.clone();
            validate_model(&p)?;
            if i.target_asset_id.is_some() {
                bail!("3D 참고 모델은 새 절차적 에셋을 제작하는 기준입니다. 원본 메시를 덮어쓰지 않습니다.")
            }
        } else {
            if plan.output == "models" {
                bail!("모델 구성안에는 3D 항목을 선택해 주세요.")
            }
            images += 1;
            if i.model_parameters.is_some() {
                bail!("2D 항목에 3D 매개변수가 있습니다.")
            }
            if plan.mode == "improve" && i.target_asset_id.is_none() {
                bail!("개선 결과를 새 버전으로 저장할 원본 이미지를 선택해 주세요.")
            }
            if let Some(target) = &i.target_asset_id {
                if plan.mode != "improve" || !i.reference_asset_ids.contains(target) {
                    bail!("개선할 참고 이미지를 선택해 주세요.")
                }
                if project
                    .assets
                    .iter()
                    .find(|a| &a.id == target)
                    .is_none_or(|a| a.kind == AssetKind::Model)
                {
                    bail!("이미지 개선 대상이 올바르지 않습니다.")
                }
                if !targets.insert(target) {
                    bail!("원본 이미지마다 개선 항목 하나를 지정해 주세요.")
                }
            }
        }
    }
    if images > 20 || models > 24 || images + models == 0 {
        bail!("제작할 항목은 이미지 20개·모델 24개 이내로 선택해 주세요.")
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        backend: Backend,
        root: PathBuf,
        directory: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("asset-bundle-admission-{}", Uuid::new_v4()));
            let root = directory.join("project");
            fs::create_dir_all(&directory).unwrap();
            // Admission only: no provider, Blender, login or network process.
            let backend = Backend {
                inner: Arc::new(Inner {
                    data: directory.join("data"),
                    runtime_data: directory.join("data"),
                    examples: directory.join("unused-examples"),
                    worker: directory.join("unused-worker"),
                    blender: Some(directory.join("unused-blender")),
                    blender_version: Some("test-admission-only".into()),
                    worker_sha256: Some("0".repeat(64)),
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
                    provider_connection: Mutex::new(
                        json!({"ready":true,"reasoningModel":"test-admission-only","runtimeVersion":"test-admission-only"}),
                    ),
                    codex_installer: asset_providers::installer::CodexInstaller::new(
                        directory.join("unused-installer"),
                    ),
                    planning_cancel: Mutex::new(None),
                    quality3d_setup: quality3d::SetupState::default(),
                }),
            };
            backend
                .request(json!({"action":"create","root":root,"name":"독립 게임 에셋"}))
                .unwrap();
            Self {
                backend,
                root,
                directory,
            }
        }
        fn plan(&self) -> Plan {
            let p = Repository::open(&self.root).unwrap().project().unwrap();
            let names = [
                "플라스마 소총",
                "레이저 권총",
                "중력 대포",
                "EMP 발사기",
                "광자 검",
            ];
            Plan {
                schema_version: 1,
                id: Uuid::new_v4().to_string(),
                project_id: p.id,
                planner_model: PLANNING_MODEL.into(),
                brief: "우주전쟁 게임에 필요한 서로 다른 무기 5가지를 개별 이미지로 제작".into(),
                output: "images".into(),
                mode: "new".into(),
                spec: p.spec,
                style_guide: p.style_guide,
                reference_asset_ids: vec![],
                references: vec![],
                summary: "개별 무기 다섯 가지".into(),
                items: names
                    .iter()
                    .map(|name| Item {
                        id: Uuid::new_v4().to_string(),
                        name: (*name).into(),
                        kind: AssetKind::Image,
                        prompt: format!(
                            "One individual {name}, isolated full silhouette for a space-war game."
                        ),
                        purpose: "개별 인벤토리 아이콘".into(),
                        reference_asset_ids: vec![],
                        target_asset_id: None,
                        model_parameters: None,
                        enabled: true,
                    })
                    .collect(),
                warnings: vec![],
            }
        }
        fn request(&self, plan: &Plan, id: &str) -> Value {
            json!({"action":"generate_bundle","requestId":id,"plan":plan,"approved":true,"referenceUploadApproved":false})
        }
        fn jobs(&self) -> Vec<Job> {
            SchedulerStore::open(&self.root.join("scheduler.sqlite"))
                .unwrap()
                .jobs()
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.backend.shutdown();
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn five_weapons_are_five_distinct_jobs_and_double_submit_does_not_duplicate() {
        let f = Fixture::new();
        let plan = f.plan();
        let id = Uuid::new_v4().to_string();
        let request = f.request(&plan, &id);
        f.backend.request(request.clone()).unwrap();
        f.backend.request(request).unwrap();
        let jobs = f.jobs();
        assert_eq!(jobs.len(), 5);
        assert_eq!(
            jobs.iter()
                .map(|j| j.payload["prompt"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            5
        );
        assert_eq!(
            jobs.iter()
                .map(|j| j.payload["name"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            5
        );
        assert!(jobs.iter().all(|j| j.payload["singleAsset"] == true
            && j.payload["normalizeToSpec"] == true
            && !j.payload["prompt"].as_str().unwrap().contains("5가지를")));
    }
    #[test]
    fn mixed_invalid_model_never_admits_partial_images() {
        let f = Fixture::new();
        let mut plan = f.plan();
        let mut model = plan.items[0].clone();
        model.id = Uuid::new_v4().to_string();
        model.name = "우주선".into();
        model.kind = AssetKind::Model;
        model.model_parameters = Some(ModelParameters {
            template: ModelTemplate::Spaceship,
            name: "우주선".into(),
            width: 1.,
            depth: 1.,
            height: 1.,
            color: "#799993".into(),
            bevel: 5.,
        });
        plan.items.push(model);
        plan.output = "mixed".into();
        assert!(f
            .backend
            .request(f.request(&plan, &Uuid::new_v4().to_string()))
            .is_err());
        assert!(f.jobs().is_empty());
    }
    #[test]
    fn repeated_names_unapproved_batches_and_ambiguous_legacy_counts_are_rejected() {
        let f = Fixture::new();
        let mut plan = f.plan();
        plan.items[1].name = plan.items[0].name.clone();
        assert!(f
            .backend
            .request(f.request(&plan, &Uuid::new_v4().to_string()))
            .is_err());
        let mut r = f.request(&f.plan(), &Uuid::new_v4().to_string());
        r["approved"] = json!(false);
        assert!(f.backend.request(r).is_err());
        assert!(f.backend.request(json!({"action":"generate","requestId":Uuid::new_v4(),"prompt":"무기 5가지","count":5})).is_err());
        assert!(f.jobs().is_empty());
    }
    #[test]
    fn stale_reference_version_or_unapproved_upload_never_creates_jobs() {
        let f = Fixture::new();
        let input = f.directory.join("original.png");
        image::RgbaImage::from_pixel(4, 4, image::Rgba([81, 99, 120, 255]))
            .save(&input)
            .unwrap();
        f.backend
            .import_raster(&input, AssetSource::Import)
            .unwrap();
        let mut repo = Repository::open(&f.root).unwrap();
        let project = repo.project().unwrap();
        let original = project.assets[0].clone();
        let mut plan = f.plan();
        plan.reference_asset_ids = vec![original.id.clone()];
        plan.references = references(&project, &plan.reference_asset_ids).unwrap();
        plan.items[0].reference_asset_ids = plan.reference_asset_ids.clone();
        assert!(f
            .backend
            .request(f.request(&plan, &Uuid::new_v4().to_string()))
            .is_err());
        assert!(f.jobs().is_empty()); // The real current reference lacks upload consent.
        let mut approved = f.request(&plan, &Uuid::new_v4().to_string());
        approved["referenceUploadApproved"] = json!(true);
        let mut newer = original.versions[0].clone();
        newer.id = Uuid::new_v4().to_string();
        newer.number = 2;
        repo.add_version(&original.id, newer).unwrap();
        assert!(f.backend.request(approved).is_err());
        assert!(f.jobs().is_empty());
        // A refreshed plan still refuses tampered source bytes before admitting any jobs.
        let current = repo.project().unwrap();
        plan.references = references(&current, &plan.reference_asset_ids).unwrap();
        let copied = repo
            .artifact_path(&original.versions[0].artifacts[0].path)
            .unwrap();
        fs::write(copied, b"tampered private test fixture").unwrap();
        let mut approved = f.request(&plan, &Uuid::new_v4().to_string());
        approved["referenceUploadApproved"] = json!(true);
        assert!(f.backend.request(approved).is_err());
        assert!(f.jobs().is_empty());
    }
    #[test]
    fn improving_an_image_adds_a_version_and_preserves_original_asset() {
        let f = Fixture::new();
        let mut repo = Repository::open(&f.root).unwrap();
        let original = new_asset(
            "기존 무기".into(),
            AssetKind::Image,
            AssetSource::Import,
            vec![],
            Some((512, 512)),
            None,
            None,
            BTreeMap::new(),
        );
        let id = original.id.clone();
        let version = original.versions[0].id.clone();
        repo.add_asset(original).unwrap();
        let p = repo.project().unwrap();
        let task=job(&p,"image_generate","개선",Some(id.clone()),JobResource::External,json!({"prompt":"개선된 무기 하나","toolVersion":"test-only","singleAsset":true,"requestedModel":REQUESTED_IMAGE_MODEL,"executionId":Uuid::new_v4()})).unwrap();
        let generated = new_asset(
            "개선된 무기".into(),
            AssetKind::Image,
            AssetSource::CodexSubscription,
            vec![],
            Some((512, 512)),
            None,
            None,
            BTreeMap::new(),
        );
        record_generated(&mut repo, generated, &task).unwrap();
        let assets = repo.project().unwrap().assets;
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].id, id);
        assert_eq!(assets[0].versions.len(), 2);
        assert_eq!(assets[0].versions[0].id, version);
        assert_eq!(assets[0].versions[1].number, 2);
    }
}
