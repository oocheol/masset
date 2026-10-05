//! Opt-in native TripoSR + Blender proof through the desktop's public Backend.
//! No provider command is called. Model preparation requires its own explicit
//! flag; ordinary runs consume an already prepared, coordinator-owned runtime.
use anyhow::{bail, ensure, Context, Result};
use asset_core::{
    models::{AssetKind, AssetSource, ExportManifest, JobResource, JobStatus, ProjectSnapshot},
    sha256_file, Repository,
};
use asset_desktop::workbench::Backend;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

const USAGE: &str = "image3d-proof --output <new-absolute-directory> [--data-root <reserved-absolute-app-data>] [--resources-root <absolute-packaged-resource-root>] [--prepare-confirmed] [--quality draft|standard] [--timeout-seconds 3300]";
const MODEL_ID: &str = "stabilityai/TripoSR";
const MODEL_REVISION: &str = "5b521936b01fbe1890f6f9baed0254ab6351c04a";
const CODE_REVISION: &str = "107cefdc244c39106fa830359024f6a2f1c78871";
const MODEL_SHA256: &str = "429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee";
const FIXTURE_SHA256: &str = "e6bd604de5a71c69cc2400bd5c88053a134fc962f17cde3a06801723cb7a7ff4";

struct Args {
    output: PathBuf,
    data: PathBuf,
    resources: Option<PathBuf>,
    prepare: bool,
    quality: String,
    timeout: u64,
}

fn args() -> Result<Args> {
    let mut arguments = std::env::args_os().skip(1);
    let (mut output, mut data, mut resources) = (None, None, None);
    let mut prepare = false;
    let mut quality = "draft".to_owned();
    let mut timeout = 3300;
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--output") if output.is_none() => {
                output = Some(PathBuf::from(arguments.next().context(USAGE)?));
            }
            Some("--data-root") if data.is_none() => {
                data = Some(PathBuf::from(arguments.next().context(USAGE)?));
            }
            Some("--resources-root") if resources.is_none() => {
                let path = PathBuf::from(arguments.next().context(USAGE)?);
                ensure!(
                    path.is_absolute(),
                    "Packaged resource root must be absolute"
                );
                no_links(&path)?;
                ensure!(
                    path.is_dir(),
                    "Packaged resource root must be a normal existing directory"
                );
                resources = Some(path.canonicalize()?);
            }
            Some("--prepare-confirmed") if !prepare => prepare = true,
            Some("--quality") => {
                quality = arguments
                    .next()
                    .context(USAGE)?
                    .into_string()
                    .map_err(|_| anyhow::anyhow!(USAGE))?;
                ensure!(["draft", "standard"].contains(&quality.as_str()), "{USAGE}");
            }
            Some("--timeout-seconds") => {
                timeout = arguments
                    .next()
                    .context(USAGE)?
                    .into_string()
                    .map_err(|_| anyhow::anyhow!(USAGE))?
                    .parse()?;
                ensure!(
                    (30..=4200).contains(&timeout),
                    "Timeout must be 30–4200 seconds"
                );
            }
            _ => bail!("{USAGE}"),
        }
    }
    let output = output.context(USAGE)?;
    let data = data.unwrap_or_else(|| output.join("app-data"));
    ensure!(
        output.is_absolute() && data.is_absolute(),
        "Output and app-data must be absolute paths"
    );
    no_links(&output)?;
    no_links(&data)?;
    ensure!(
        !output.exists(),
        "Output must be fresh; no existing file is overwritten"
    );
    ensure!(
        !data.join("recent.json").exists(),
        "Use reserved proof app-data; an existing user's recent project is preserved"
    );
    Ok(Args {
        output,
        data,
        resources,
        prepare,
        quality,
        timeout,
    })
}

fn no_links(path: &Path) -> Result<()> {
    for component in path.components() {
        ensure!(
            !matches!(component, Component::ParentDir),
            "Parent-directory traversal is not allowed"
        );
    }
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                ensure!(
                    !metadata.file_type().is_symlink(),
                    "Proof paths must not pass through links"
                );
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    ensure!(
                        metadata.file_attributes() & 0x400 == 0,
                        "Proof paths must not pass through reparse points"
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn write_new(path: &Path, value: &Value) -> Result<()> {
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn trace(file: &mut File, kind: &str, value: Value) -> Result<()> {
    serde_json::to_writer(
        &mut *file,
        &json!({"at":chrono::Utc::now().to_rfc3339(),"kind":kind,"value":value}),
    )?;
    file.write_all(b"\n")?;
    file.flush()?;
    Ok(())
}

fn snapshot(backend: &Backend) -> Result<ProjectSnapshot> {
    Ok(serde_json::from_value(
        backend.request(json!({"action":"snapshot"}))?,
    )?)
}

fn runtime_lock() -> &'static str {
    if cfg!(windows) {
        "runtime-lock-windows.json"
    } else {
        "runtime-lock.json"
    }
}

fn pipeline_files() -> [(&'static str, &'static str); 8] {
    [
        ("blender-quality", "worker.py"),
        ("blender-quality", "audit.py"),
        ("image3d", "worker.py"),
        ("image3d", "image_input.py"),
        ("image3d", "runtime_common.py"),
        ("image3d", "image3d_adapter.py"),
        ("image3d", "glb_color.py"),
        ("image3d", runtime_lock()),
    ]
}

fn audit_resources(
    examples: &Path,
    worker: &Path,
    repository_workers: &Path,
    packaged_root: Option<&Path>,
) -> Result<Value> {
    let examples = examples
        .canonicalize()
        .context("Examples resource directory is missing")?;
    let worker = worker
        .canonicalize()
        .context("Backend Blender worker is missing")?;
    let workers = worker
        .parent()
        .and_then(Path::parent)
        .context("Backend worker has no workers root")?;
    no_links(&examples)?;
    no_links(&worker)?;
    ensure!(
        examples.is_dir() && worker.is_file(),
        "Backend resource paths are not ordinary files/directories"
    );
    if let Some(root) = packaged_root {
        no_links(root)?;
        ensure!(
            examples == root.join("examples") && workers == root.join("workers"),
            "All selected Backend resources must resolve inside the supplied packaged root"
        );
    }
    let mut required = vec![
        ("blender", "worker.py"),
        ("image3d", "setup.py"),
        ("image3d", "status.py"),
        ("image3d", "runtime_probe.py"),
        ("image3d", "upstream_patch.py"),
    ];
    required.extend(pipeline_files());
    let mut files = Vec::new();
    for (folder, name) in required {
        let requested = workers.join(folder).join(name);
        no_links(&requested)?;
        ensure!(
            requested.is_file(),
            "Required selected worker resource is missing: {}",
            requested.display()
        );
        let actual = requested.canonicalize()?;
        ensure!(
            actual.starts_with(workers),
            "Selected worker escaped its resource root"
        );
        if let Some(root) = packaged_root {
            ensure!(
                actual.starts_with(root),
                "Selected worker escaped the packaged root"
            );
        }
        let expected_path = repository_workers.join(folder).join(name).canonicalize()?;
        let (actual_sha, actual_bytes) = sha256_file(&actual)?;
        let (expected_sha, expected_bytes) = sha256_file(&expected_path)?;
        ensure!(
            actual_sha == expected_sha && actual_bytes == expected_bytes,
            "Selected resource differs from this proof build's repository source: {}",
            actual.display()
        );
        files.push(json!({"relativePath":format!("workers/{folder}/{name}"),
            "path":actual,"bytes":actual_bytes,"sha256":actual_sha,
            "repositorySource":expected_path,"matchesRepositorySource":true}));
    }
    let mut digest = Sha256::new();
    for (folder, name) in pipeline_files() {
        digest.update(folder.as_bytes());
        digest.update(name.as_bytes());
        digest.update(sha256_file(&workers.join(folder).join(name))?.0.as_bytes());
    }
    Ok(
        json!({"mode":if packaged_root.is_some() { "packaged-copy" } else { "repository" },
        "packagedRoot":packaged_root,"examplesDirectory":examples,"backendWorker":worker,
        "workersRoot":workers,"requiredFiles":files,"requiredFileCount":files.len(),
        "allWorkerPathsResolveWithinSelectedRoot":true,
        "pipelineSha256":format!("{:x}",digest.finalize()),
        "blenderQualityWorkerSha256":sha256_file(&workers.join("blender-quality/worker.py"))?.0,
        "image3dWorker":workers.join("image3d/worker.py"),
        "blenderQualityWorker":workers.join("blender-quality/worker.py"),
        "selectedRuntimeLock":workers.join("image3d").join(runtime_lock()),
        "wholeInstallerPackageVerified":false}),
    )
}

fn main() -> Result<()> {
    let args = args()?;
    fs::create_dir_all(args.output.parent().context("Output has no parent")?)?;
    fs::create_dir(&args.output)?;
    no_links(&args.output)?;
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repository_workers = base.join("../../../workers").canonicalize()?;
    let examples = args
        .resources
        .as_ref()
        .map(|root| root.join("examples"))
        .unwrap_or_else(|| base.join("../public/examples"))
        .canonicalize()?;
    let worker = args
        .resources
        .as_ref()
        .map(|root| root.join("workers/blender/worker.py"))
        .unwrap_or_else(|| repository_workers.join("blender/worker.py"))
        .canonicalize()?;
    let resources = audit_resources(
        &examples,
        &worker,
        &repository_workers,
        args.resources.as_deref(),
    )?;
    let source = base.join("../../../workers/image3d/fixtures/blue-sphere.png");
    let backend = Backend::new(args.data.clone(), examples.clone(), worker.clone());
    backend.start();
    let mut events = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(args.output.join("events.jsonl"))?;
    let started = Instant::now();
    let mut proof = json!({
        "schemaVersion":1,"appVersion":env!("CARGO_PKG_VERSION"),"checkedAt":chrono::Utc::now().to_rfc3339(),
        "nativeBackend":true,"nativeWindow":false,"packagedResourcesVerified":false,
        "providerLiveGeneration":false,"providerCommandsRequested":0,"externalProviderJobs":0,
        "productionModelBoundaryExecuted":false,"installerLifecycleTested":false,"cleanMachineRuntimeTested":false,
        "blenderSourceIndependentlyReopened":false,"passed":false,"stage":"initial checks",
        "output":args.output,"dataRoot":args.data,"prepareConfirmed":args.prepare,"quality":args.quality,
        "resources":resources,"wholeInstallerPackageVerified":false,
        "limits":{"jobTimeoutSeconds":args.timeout,"setupTimeoutSeconds":1900,"ramMb":8192,"cpuThreads":2},
    });
    let outcome = prove(
        &backend,
        &args,
        &source,
        &examples,
        &worker,
        &resources,
        &mut proof,
        &mut events,
    );
    backend.shutdown();
    proof["elapsedSeconds"] = json!(started.elapsed().as_secs_f64());
    if let Err(error) = &outcome {
        proof["error"] = json!(format!("{error:#}"));
    } else {
        let resources_after = audit_resources(
            &examples,
            &worker,
            &repository_workers,
            args.resources.as_deref(),
        );
        match resources_after {
            Ok(after) if after == resources => {
                proof["selectedResourcesUnchangedAfterNativeRun"] = json!(true);
                proof["packagedResourcesVerified"] = json!(args.resources.is_some());
            }
            Ok(_) => {
                proof["error"] =
                    json!("Selected resource paths or hashes changed during the native run");
                events.sync_all()?;
                write_new(&args.output.join("image3d-proof.json"), &proof)?;
                bail!("Selected resources changed during the native run");
            }
            Err(error) => {
                proof["error"] = json!(format!("Selected resource post-check failed: {error:#}"));
                events.sync_all()?;
                write_new(&args.output.join("image3d-proof.json"), &proof)?;
                return Err(error);
            }
        }
        proof["passed"] = json!(true);
        proof["stage"] = json!("completed");
    }
    events.sync_all()?;
    write_new(&args.output.join("image3d-proof.json"), &proof)?;
    println!("{}", serde_json::to_string_pretty(&proof)?);
    outcome
}

fn prove(
    backend: &Backend,
    args: &Args,
    source: &Path,
    examples: &Path,
    worker: &Path,
    resources: &Value,
    proof: &mut Value,
    events: &mut File,
) -> Result<()> {
    let environment = backend.request(json!({"action":"environment"}))?;
    ensure!(
        environment["native"] == true && environment["platform"] == std::env::consts::OS,
        "Actual native platform was not established"
    );
    ensure!(
        environment["blenderPath"]
            .as_str()
            .is_some_and(|value| !value.is_empty()),
        "Blender must be installed before this proof"
    );
    proof["environment"] = environment;
    let mut status = backend.request(json!({"action":"quality3d_status"}))?;
    write_new(&args.output.join("runtime-before.json"), &status)?;
    ensure!(
        status["supported"] == true && status["blenderReady"] == true,
        "Native reconstruction/Blender is unsupported or unavailable"
    );
    let memory = status["memoryMb"]
        .as_u64()
        .context("Native RAM measurement is missing")?;
    let minimum = status["minimumMemoryMb"]
        .as_u64()
        .context("Native minimum RAM is missing")?;
    ensure!(
        memory >= minimum && minimum > 0,
        "Native RAM is below the reconstruction minimum"
    );
    if status["installed"] != true {
        ensure!(args.prepare, "Runtime is not installed; download was not requested (use --prepare-confirmed only after consent)");
        proof["stage"] = json!("native model preparation");
        backend.request(json!({"action":"quality3d_prepare","confirmed":true}))?;
        let setup_start = Instant::now();
        let mut previous = Value::Null;
        loop {
            status = backend.request(json!({"action":"quality3d_status"}))?;
            let state = json!({"state":status["state"],"stage":status["stage"],"busy":status["busy"],"installed":status["installed"]});
            if state != previous {
                trace(events, "setup", state.clone())?;
                previous = state;
            }
            if status["installed"] == true && status["busy"] != true {
                break;
            }
            ensure!(
                status["busy"] == true,
                "Native model preparation stopped: {}",
                status["message"]
            );
            ensure!(
                setup_start.elapsed() < Duration::from_secs(1900),
                "Native setup exceeded the bounded proof wait"
            );
            thread::sleep(Duration::from_millis(500));
        }
        proof["setupElapsedSeconds"] = json!(setup_start.elapsed().as_secs_f64());
    }
    ensure!(
        status["installed"] == true && status["state"] == "ready",
        "Pinned runtime did not become ready"
    );
    proof["runtimeStatus"] = status;
    proof["stage"] = json!("isolated native project and import");
    let (source_hash, source_bytes) = sha256_file(source)?;
    ensure!(
        source_hash == FIXTURE_SHA256 && source_bytes == 18339,
        "The owned input fixture changed"
    );
    let pixels = image::open(source)?.to_rgba8();
    ensure!(
        pixels.dimensions() == (256, 256)
            && pixels.pixels().any(|pixel| pixel.0[3] == 0)
            && pixels.pixels().any(|pixel| pixel.0[3] > 0),
        "Fixture pixels/transparent foreground are invalid"
    );
    let project = args.output.join("project");
    let initial: ProjectSnapshot = serde_json::from_value(backend.request(
        json!({"action":"create","root":project,"name":"Native Windows image-to-3D proof"}),
    )?)?;
    ensure!(
        initial.project.assets.is_empty() && initial.project.jobs.is_empty(),
        "Proof project was not isolated"
    );
    let imported: ProjectSnapshot =
        serde_json::from_value(backend.request(json!({"action":"import","paths":[source]}))?)?;
    ensure!(
        imported.project.assets.len() == 1 && imported.project.jobs.is_empty(),
        "Exactly one original fixture import is required"
    );
    let original = imported.project.assets[0].clone();
    ensure!(
        original.kind == AssetKind::Image
            && original.versions.len() == 1
            && original.versions[0].source == AssetSource::Import,
        "Original image import provenance is missing"
    );
    let repo = Repository::open(Path::new(&imported.root))?;
    for artifact in &original.versions[0].artifacts {
        repo.verify_artifact(artifact)?;
        ensure!(
            artifact.sha256 == source_hash && artifact.bytes == source_bytes,
            "Native import did not preserve original bytes"
        );
    }
    proof["source"] = json!({"path":source,"sha256":source_hash,"bytes":source_bytes,"assetId":original.id,"originalVersionId":original.versions[0].id});
    proof["project"] = json!(imported.root);
    write_new(
        &args.output.join("imported-snapshot.json"),
        &serde_json::to_value(&imported)?,
    )?;
    proof["stage"] = json!("native TripoSR and Blender job");
    let submitted: ProjectSnapshot = serde_json::from_value(backend.request(json!({
        "action":"quality3d","assetIds":[original.id],"name":"Windows reconstructed sphere","quality":args.quality,
        "heightMeters":1.0,"maxTriangles":10000,"textureResolution":512,"preserveMaterials":true,
    }))?)?;
    ensure!(
        submitted.project.jobs.len() == 1,
        "Exactly one native model job must be submitted"
    );
    let job = &submitted.project.jobs[0];
    ensure!(
        job.kind == "quality3d" && job.resource == JobResource::Blender && job.asset_id.is_none(),
        "Image reconstruction must create a separate model"
    );
    ensure!(
        job.payload.get("sourceKind") == Some(&json!("image3d"))
            && job.payload["resources"]["ramMb"] == 8192
            && job.payload["resources"]["cpuThreads"] == 2,
        "Native CPU/RAM admission contract changed"
    );
    ensure!(
        job.payload.get("pipelineSha256") == Some(&resources["pipelineSha256"])
            && job.payload.get("workerSha256") == Some(&resources["blenderQualityWorkerSha256"]),
        "Submitted native job is not bound to the selected resource copy"
    );
    proof["jobId"] = json!(job.id);
    let generation_started = Instant::now();
    let completed = wait_job(backend, &job.id, args.timeout, events)?;
    proof["nativeJobElapsedSeconds"] = json!(generation_started.elapsed().as_secs_f64());
    proof["jobs"] = serde_json::to_value(&completed.project.jobs)?;
    ensure!(
        completed.project.assets.len() == 2,
        "One original image and one reconstructed model are required"
    );
    ensure!(
        completed
            .project
            .assets
            .iter()
            .find(|asset| asset.id == original.id)
            == Some(&original),
        "Original image or original version was changed"
    );
    let model = completed
        .project
        .assets
        .iter()
        .find(|asset| asset.id != original.id)
        .context("New model asset is missing")?;
    ensure!(
        model.kind == AssetKind::Model
            && model.versions.len() == 1
            && model
                .mesh
                .as_ref()
                .is_some_and(|mesh| mesh.triangles > 0 && mesh.triangles <= 10000),
        "Native model/mesh budget is invalid"
    );
    let version = &model.versions[0];
    ensure!(
        version.settings.get("pipelineSha256") == Some(&resources["pipelineSha256"])
            && version.settings.get("workerSha256")
                == Some(&resources["blenderQualityWorkerSha256"]),
        "Completed native provenance does not match selected resource hashes"
    );
    proof["selectedResourcePipelineExecutionVerified"] = json!(true);
    ensure!(
        version.source == AssetSource::LocalImage3d
            && version
                .validation
                .as_ref()
                .is_some_and(|validation| validation.valid),
        "Actual local reconstruction provenance/validation is missing"
    );
    let generation = version
        .settings
        .get("localReconstruction")
        .context("Actual reconstruction receipt is missing")?;
    ensure!(
        generation["modelId"] == MODEL_ID
            && generation["modelRevision"] == MODEL_REVISION
            && generation["codeRevision"] == CODE_REVISION
            && generation["modelSha256"] == MODEL_SHA256,
        "Inferred model/code differ from pinned TripoSR"
    );
    ensure!(
        generation["device"] == "cpu"
            && generation["cpuThreads"] == 2
            && generation["quality"] == args.quality,
        "Actual inference device/quality/thread count is incorrect"
    );
    ensure!(
        generation["source"]["sha256"] == source_hash
            && generation["source"]["bytes"] == source_bytes,
        "Inference did not use the original fixture bytes"
    );
    ensure!(
        generation["offline"]
            == json!({"networkBlocked":true,"localConfigOnly":true,"weightsOnly":true}),
        "Offline local-only inference proof is missing"
    );
    let rss = generation["peakRssBytes"]
        .as_u64()
        .context("Actual native peak RSS was not measured")?;
    ensure!(
        rss > 0 && rss < 8192 * 1024 * 1024u64,
        "Native inference exceeded the reserved 8GiB RAM budget"
    );
    let repo = Repository::open(Path::new(&completed.root))?;
    let mut files = Vec::new();
    for artifact in &version.artifacts {
        repo.verify_artifact(artifact)?;
        let path = repo.artifact_path(&artifact.path)?;
        let decoded = inspect(&path, &artifact.format)?;
        if path
            .file_name()
            .is_some_and(|name| name == "generation.json")
        {
            ensure!(
                serde_json::from_slice::<Value>(&fs::read(&path)?)? == *generation,
                "Saved generation receipt differs from recorded native provenance"
            );
        }
        files.push(json!({"artifact":artifact,"absolutePath":path,"decoded":decoded}));
    }
    for name in [
        "game-ready.model.glb",
        "high-detail.glb",
        "lod1.glb",
        "source.blend",
        "basecolor.png",
        "mesh.glb",
        "prepared-input.png",
        "generation.json",
        "validation.json",
    ] {
        ensure!(
            version
                .artifacts
                .iter()
                .any(|artifact| Path::new(&artifact.path)
                    .file_name()
                    .is_some_and(|value| value == name)),
            "Expected native output is missing: {name}"
        );
    }
    ensure!(
        sha256_file(source)? == (source_hash.clone(), source_bytes),
        "External original changed during generation"
    );
    proof["modelAssetId"] = json!(model.id);
    proof["localReconstruction"] = generation.clone();
    proof["qualityReport"] = version
        .settings
        .get("qualityReport")
        .cloned()
        .context("Blender quality receipt is missing")?;
    ensure!(
        proof["qualityReport"]["valid"] == true,
        "Blender did not validate its actual output"
    );
    proof["files"] = json!(files);
    proof["sourcePreserved"] = json!(true);
    proof["ramAdmissionVerified"] = json!(true);
    write_new(
        &args.output.join("completed-snapshot.json"),
        &serde_json::to_value(&completed)?,
    )?;
    proof["stage"] = json!("shutdown, reopen and export");
    backend.ensure_update_idle()?;
    backend.shutdown();
    let reopened = Backend::new(
        args.data.clone(),
        examples.to_path_buf(),
        worker.to_path_buf(),
    );
    let result = (|| -> Result<()> {
        let after: ProjectSnapshot = serde_json::from_value(
            reopened.request(json!({"action":"open","root":completed.root}))?,
        )?;
        ensure!(
            after.project.assets == completed.project.assets
                && after.project.jobs == completed.project.jobs,
            "Shutdown/reopen changed immutable assets, versions or jobs"
        );
        let exported = reopened.request(
            json!({"action":"export","destination":args.output.join("exports"),"assetIds":[]}),
        )?;
        let bundle = PathBuf::from(
            exported["path"]
                .as_str()
                .context("Native export path is missing")?,
        );
        no_links(&bundle)?;
        let manifest_path = bundle.join("manifest.json");
        let manifest: ExportManifest = serde_json::from_slice(&fs::read(&manifest_path)?)?;
        ensure!(
            manifest.format == "asset-studio-bundle"
                && manifest.schema_version == 1
                && manifest.project_id == after.project.id
                && manifest.assets == after.project.assets,
            "Export did not preserve exact native assets/versions"
        );
        let mut exported_files = Vec::new();
        for artifact in &manifest.files {
            let relative = Path::new(&artifact.path);
            ensure!(
                relative
                    .components()
                    .all(|component| matches!(component, Component::Normal(_))),
                "Export artifact escaped its bundle"
            );
            let path = bundle.join(relative);
            ensure!(
                sha256_file(&path)? == (artifact.sha256.clone(), artifact.bytes),
                "Exported artifact hash/size differs: {}",
                artifact.path
            );
            exported_files
                .push(json!({"artifact":artifact,"decoded":inspect(&path, &artifact.format)?}));
        }
        ensure!(
            !exported_files.is_empty(),
            "Export contains no native output files"
        );
        ensure!(
            sha256_file(source)? == (source_hash.clone(), source_bytes),
            "Original changed during reopen/export"
        );
        proof["reopened"] = json!(true);
        proof["export"] = json!({"path":bundle,"manifest":manifest_path,"manifestSha256":sha256_file(&manifest_path)?.0,"files":exported_files,"exactHashesVerified":true,"exactVersionsVerified":true});
        write_new(
            &args.output.join("reopened-snapshot.json"),
            &serde_json::to_value(&after)?,
        )?;
        Ok(())
    })();
    reopened.shutdown();
    result
}

fn wait_job(
    backend: &Backend,
    id: &str,
    timeout: u64,
    events: &mut File,
) -> Result<ProjectSnapshot> {
    let started = Instant::now();
    let mut previous = Value::Null;
    loop {
        let state = snapshot(backend)?;
        ensure!(
            state.project.jobs.len() == 1
                && state
                    .project
                    .jobs
                    .iter()
                    .all(|job| job.resource != JobResource::External),
            "Unexpected job/provider execution entered isolated proof"
        );
        let job = state
            .project
            .jobs
            .iter()
            .find(|job| job.id == id)
            .context("Native job disappeared")?;
        let current =
            json!({"id":job.id,"status":job.status,"progress":job.progress,"error":job.error});
        if current != previous {
            trace(events, "job", current.clone())?;
            previous = current;
        }
        match job.status {
            JobStatus::Succeeded if backend.ensure_update_idle().is_ok() => return Ok(state),
            JobStatus::Failed
            | JobStatus::Cancelled
            | JobStatus::WaitingUser
            | JobStatus::ExternalUnknown => bail!(
                "Native image-to-3D job did not succeed: {}",
                serde_json::to_string(job)?
            ),
            _ => {}
        }
        ensure!(started.elapsed() < Duration::from_secs(timeout), "Native image-to-3D proof timed out; owned workers will be cancelled and files retained");
        thread::sleep(Duration::from_millis(500));
    }
}

fn inspect(path: &Path, format: &str) -> Result<Value> {
    match format {
        "png" => {
            let image = image::open(path)?.to_rgba8();
            ensure!(
                image.width() > 0 && image.height() > 0,
                "Actual PNG has no decoded pixels"
            );
            Ok(
                json!({"format":"png","width":image.width(),"height":image.height(),"pixelsDecoded":true}),
            )
        }
        "json" => {
            let _: Value = serde_json::from_slice(&fs::read(path)?)?;
            Ok(json!({"format":"json","parsed":true}))
        }
        "glb" => {
            let data = fs::read(path)?;
            let gltf = gltf::Gltf::from_slice(&data)?;
            let blob = gltf
                .blob
                .as_deref()
                .context("GLB has no actual binary buffer")?;
            ensure!(
                gltf.buffers().all(
                    |buffer| matches!(buffer.source(), gltf::buffer::Source::Bin)
                        && buffer.length() <= blob.len()
                ),
                "GLB references an external or truncated buffer"
            );
            let (mut vertices, mut triangles) = (0u64, 0u64);
            for primitive in gltf.meshes().flat_map(|mesh| mesh.primitives()) {
                ensure!(
                    primitive.mode() == gltf::mesh::Mode::Triangles,
                    "GLB contains a non-triangle primitive"
                );
                let reader = primitive.reader(|buffer| (buffer.index() == 0).then_some(blob));
                let positions: Vec<_> = reader
                    .read_positions()
                    .context("GLB POSITION buffer is missing")?
                    .collect();
                ensure!(
                    !positions.is_empty()
                        && positions.iter().flatten().all(|value| value.is_finite()),
                    "GLB contains empty/nonfinite positions"
                );
                let count = if let Some(indices) = reader.read_indices() {
                    let indices: Vec<_> = indices.into_u32().collect();
                    ensure!(
                        indices
                            .iter()
                            .all(|index| (*index as usize) < positions.len()),
                        "GLB indices are out of bounds"
                    );
                    indices.len()
                } else {
                    positions.len()
                };
                ensure!(count > 0 && count % 3 == 0, "GLB triangles are incomplete");
                vertices += positions.len() as u64;
                triangles += count as u64 / 3;
            }
            ensure!(
                vertices > 0 && triangles > 0,
                "GLB has no actual decoded geometry"
            );
            Ok(
                json!({"format":"glb","positionsAndIndicesDecoded":true,"vertices":vertices,"triangles":triangles}),
            )
        }
        "blend" => {
            ensure!(
                fs::metadata(path)?.len() > 12,
                "Blender source file is empty"
            );
            Ok(json!({"format":"blend","hashVerified":true,"independentBlenderReopen":false}))
        }
        _ => bail!("Unexpected native proof output format: {format}"),
    }
}
