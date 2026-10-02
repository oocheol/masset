use asset_core::models::*;
use asset_core::{sha256_file, Repository};
use rusqlite::Connection;
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

fn fixture_png() -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for &byte in bytes {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }
    fn chunk(png: &mut Vec<u8>, kind: &[u8; 4], bytes: &[u8]) {
        png.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        let start = png.len();
        png.extend_from_slice(kind);
        png.extend_from_slice(bytes);
        let crc = crc32(&png[start..]);
        png.extend_from_slice(&crc.to_be_bytes());
    }
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    chunk(&mut png, b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    // A valid zlib stream containing an uncompressed red RGBA scanline.
    chunk(&mut png, b"IDAT", &[0x78, 0x01, 0x01, 5, 0, 0xfa, 0xff, 0, 255, 0, 0, 255, 5, 0, 1, 255]);
    chunk(&mut png, b"IEND", &[]);
    png
}

fn original(directory: &TempDir) -> PathBuf {
    let path = directory.path().join("서울 원본.PNG");
    fs::write(&path, fixture_png()).unwrap();
    path
}

fn version(id: &str, number: u32, artifact: Artifact) -> AssetVersion {
    AssetVersion {
        id: id.into(),
        number,
        created_at: now(),
        prompt: "차분한 한국어 에셋".into(),
        source: if number == 1 { AssetSource::Import } else { AssetSource::Procedural },
        requested_model: Some("Nano Banana 2".into()),
        // A requested model is never inferred to be the confirmed model.
        confirmed_model: None,
        provider_version: None,
        artifacts: vec![artifact],
        settings: BTreeMap::from([("pixelArt".into(), json!(true))]),
        validation: None,
    }
}

fn asset(id: &str, initial: AssetVersion) -> Asset {
    Asset {
        id: id.into(),
        name: "서울 상자 · 원본".into(),
        kind: AssetKind::Sprite,
        folder: "게임/배경".into(),
        tags: vec!["한글".into(), "pixel art".into()],
        active_version_id: initial.id.clone(),
        versions: vec![initial],
        width: Some(1),
        height: Some(1),
        mesh: None,
    }
}

fn job(project_id: &str) -> Job {
    Job {
        id: "job-1".into(),
        project_id: project_id.into(),
        asset_id: Some("asset-1".into()),
        kind: "image.import".into(),
        label: "원본 복사".into(),
        status: JobStatus::Pending,
        dependencies: Vec::new(),
        resource: JobResource::Cpu,
        attempts: 0,
        created_at: now(),
        started_at: None,
        finished_at: None,
        error: None,
        progress: JobProgress { stage: "pending".into(), completed: None, total: None },
        payload: BTreeMap::from([("artifact".into(), json!("서울 원본.PNG"))]),
        cache_key: Some("immutable-test-key".into()),
    }
}

#[test]
fn default_and_wire_models_match_shared_contract() {
    let project = Project::new("한글 프로젝트");
    let wire = serde_json::to_value(&project).unwrap();
    assert_eq!(wire["schemaVersion"], 1);
    assert_eq!(wire["spec"]["domain"], "game");
    assert_eq!(wire["spec"]["axis"], "Y-up");
    assert_eq!(wire["spec"]["colorSpace"], "sRGB");
    assert_eq!(wire["spec"]["normalConvention"], "OpenGL");
    assert_eq!(wire["spec"]["polygonBudget"], 10000);
    assert_eq!(wire["styleGuide"]["name"], "차분한 판타지");
    assert_eq!(wire["styleGuide"]["referenceAssetIds"], json!([]));
    let resize: ImageOperation = serde_json::from_value(json!({"type":"resize","width":32,"height":16,"pixelArt":true})).unwrap();
    assert_eq!(serde_json::to_value(resize).unwrap(), json!({"type":"resize","width":32,"height":16,"pixelArt":true}));
    assert_eq!(serde_json::to_value(JobStatus::ExternalUnknown).unwrap(), "external_unknown");
    assert_eq!(serde_json::to_value(AssetSource::CodexSubscription).unwrap(), "codex_subscription");
    assert_eq!(serde_json::to_value(JobResource::Cpu).unwrap(), "cpu");
}

#[test]
fn restart_preserves_versions_jobs_style_and_original_hash() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path().join("한글 프로젝트 폴더");
    let input = original(&temporary);
    let original_hash = sha256_file(&input).unwrap();
    let mut repository = Repository::create(&root, "서울 게임 에셋").unwrap();
    let source = repository.copy_in(&input, "sources", "서울 원본.PNG").unwrap();
    let output = repository.copy_in(&input, "outputs", "서울 원본.png").unwrap();
    assert_ne!(source.path.to_lowercase(), output.path.to_lowercase());
    assert_eq!(source.role, ArtifactRole::Source);
    assert_eq!(source.sha256, original_hash.0);
    repository.add_asset(asset("asset-1", version("version-1", 1, source.clone()))).unwrap();
    repository.add_version("asset-1", version("version-2", 2, output.clone())).unwrap();
    let mut project = repository.project().unwrap();
    project.spec.width = 1024;
    project.style_guide.palette.push("#ffffff".into());
    repository.save_project(&project).unwrap();
    let mut persistent_job = job(&project.id);
    repository.upsert_job(persistent_job.clone()).unwrap();
    persistent_job.status = JobStatus::ExternalUnknown;
    persistent_job.attempts = 1;
    persistent_job.error = Some("원격 결과 확인 필요".into());
    repository.upsert_job(persistent_job.clone()).unwrap();
    let saved = repository.project().unwrap();
    drop(repository);

    let reopened = Repository::open(&root).unwrap();
    let recovered = reopened.project().unwrap();
    assert_eq!(recovered, saved);
    assert_eq!(recovered.assets[0].versions.len(), 2);
    assert_eq!(recovered.assets[0].active_version_id, "version-2");
    assert_eq!(recovered.jobs, vec![persistent_job]);
    assert_eq!(recovered.spec.width, 1024);
    assert_eq!(recovered.assets[0].versions[0].confirmed_model, None);
    reopened.verify_artifact(&source).unwrap();
    reopened.verify_artifact(&output).unwrap();
    assert_eq!(sha256_file(&input).unwrap(), original_hash);
    let mirror: Project = serde_json::from_slice(&fs::read(root.join("project.json")).unwrap()).unwrap();
    assert_eq!(mirror, recovered);
    let database = Connection::open(root.join("project.sqlite")).unwrap();
    assert_eq!(database.query_row::<u32, _, _>("PRAGMA user_version", [], |row| row.get(0)).unwrap(), 1);
    assert_eq!(database.query_row::<String, _, _>("PRAGMA journal_mode", [], |row| row.get(0)).unwrap(), "wal");
    assert_eq!(database.query_row::<u32, _, _>("SELECT count(*) FROM schema_migrations", [], |row| row.get(0)).unwrap(), 1);
}

#[test]
fn snapshots_are_replaced_and_repaired_from_authoritative_database() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path().join("project");
    let mut repository = Repository::create(&root, "처음").unwrap();
    for name in ["두 번째", "세 번째"] {
        let mut project = repository.project().unwrap();
        project.name = name.into();
        repository.save_project(&project).unwrap();
        let mirror: Project = serde_json::from_slice(&fs::read(root.join("project.json")).unwrap()).unwrap();
        assert_eq!(mirror.name, name);
    }
    drop(repository);
    fs::write(root.join("project.json"), b"incomplete crash snapshot").unwrap();
    let repository = Repository::open(&root).unwrap();
    assert_eq!(repository.project().unwrap().name, "세 번째");
    let mirror: Project = serde_json::from_slice(&fs::read(root.join("project.json")).unwrap()).unwrap();
    assert_eq!(mirror, repository.project().unwrap());
    assert!(!fs::read_dir(&root).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
    drop(repository);
    fs::remove_file(root.join("project.json")).unwrap();
    assert!(Repository::open(&root).unwrap().root().join("project.json").is_file());
}

#[test]
fn failed_snapshot_replacement_rolls_back_database_update() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path().join("project");
    let mut repository = Repository::create(&root, "커밋 전 원본 상태").unwrap();
    let previous = repository.project().unwrap();
    let mut edited = previous.clone();
    edited.name = "실패한 수정".into();
    // A directory at the generated snapshot filename forces replacement to
    // fail without needing administrator-only permission fixture setup.
    fs::remove_file(root.join("project.json")).unwrap();
    fs::create_dir(root.join("project.json")).unwrap();
    assert!(repository.save_project(&edited).is_err());
    assert_eq!(repository.project().unwrap(), previous);
    fs::remove_dir(root.join("project.json")).unwrap();
    drop(repository);
    let reopened = Repository::open(&root).unwrap();
    assert_eq!(reopened.project().unwrap(), previous);
}

#[test]
fn portable_export_contains_all_selected_versions_and_reads_without_source_project() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path().join("원 프로젝트");
    let input = original(&temporary);
    let mut repository = Repository::create(&root, "오프라인 묶음").unwrap();
    let first = repository.copy_in(&input, "sources", "서울 원본.PNG").unwrap();
    let second = repository.copy_in(&input, "outputs", "서울 출력.png").unwrap();
    let third = repository.copy_in(&input, "sources", "another.png").unwrap();
    repository.add_asset(asset("asset-1", version("version-1", 1, first))).unwrap();
    repository.add_version("asset-1", version("version-2", 2, second)).unwrap();
    repository.add_asset(asset("asset-2", version("version-3", 1, third))).unwrap();
    let destination = temporary.path().join("배포 파일");
    let bundle = repository.export_bundle(&destination, &["asset-1".into(), "asset-1".into()]).unwrap();
    let manifest: ExportManifest = serde_json::from_slice(&fs::read(bundle.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest.format, "asset-studio-bundle");
    assert_eq!(manifest.schema_version, 1);
    assert_eq!(manifest.project_name, "오프라인 묶음");
    assert_eq!(manifest.assets.len(), 1);
    assert_eq!(manifest.assets[0].versions.len(), 2);
    assert_eq!(manifest.files.len(), 2);
    assert_eq!(manifest.assets[0].versions[0].requested_model.as_deref(), Some("Nano Banana 2"));
    assert_eq!(manifest.assets[0].versions[0].confirmed_model, None);
    assert!(!bundle.join("project.sqlite").exists());
    let all = repository.export_bundle(&destination, &[]).unwrap();
    let all_manifest: ExportManifest = serde_json::from_slice(&fs::read(all.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(all_manifest.assets.len(), 2);
    assert_eq!(all_manifest.files.len(), 3);
    drop(repository);
    fs::rename(&root, temporary.path().join("원 프로젝트 이동")).unwrap();
    assert!(!root.exists());
    for artifact in &manifest.files {
        assert!(!Path::new(&artifact.path).is_absolute());
        assert!(!artifact.path.contains('\\'));
        let (hash, bytes) = sha256_file(&bundle.join(&artifact.path)).unwrap();
        assert_eq!((hash, bytes), (artifact.sha256.clone(), artifact.bytes));
        assert_eq!(fs::read(bundle.join(&artifact.path)).unwrap(), fixture_png());
    }
}

#[test]
fn export_rejects_missing_ids_tampering_and_source_project_destinations() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path().join("project");
    let input = original(&temporary);
    let original_hash = sha256_file(&input).unwrap();
    let mut repository = Repository::create(&root, "검증").unwrap();
    let copied = repository.copy_in(&input, "sources", "original.png").unwrap();
    repository.add_asset(asset("asset-1", version("version-1", 1, copied.clone()))).unwrap();
    let destination = temporary.path().join("must-not-be-created");
    assert!(repository.export_bundle(&destination, &["missing".into()]).is_err());
    assert!(!destination.exists());
    assert!(repository.export_bundle(&root, &[]).is_err());
    assert!(repository.export_bundle(&root.join("new/exports"), &[]).is_err());
    assert!(!root.join("new").exists());
    fs::write(repository.artifact_path(&copied.path).unwrap(), b"tampered bytes").unwrap();
    assert!(repository.verify_artifact(&copied).is_err());
    assert!(repository.export_bundle(&destination, &[]).is_err());
    assert!(!destination.exists());
    assert_eq!(sha256_file(&input).unwrap(), original_hash);
}

#[test]
fn copies_use_unique_paths_and_reject_traversal_and_case_collisions() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path().join("project");
    let input = original(&temporary);
    let repository = Repository::create(&root, "안전한 경로").unwrap();
    let upper = repository.copy_in(&input, "sources", "NAME.PNG").unwrap();
    let lower = repository.copy_in(&input, "sources", "name.png").unwrap();
    assert_ne!(upper.path.to_lowercase(), lower.path.to_lowercase());
    assert_eq!(fs::read(repository.artifact_path(&upper.path).unwrap()).unwrap(), fixture_png());
    for category in ["../sources", "nested/folder", "C:\\assets", "CON", "sources "] {
        assert!(repository.copy_in(&input, category, "valid.png").is_err(), "{category}");
    }
    for filename in ["../file.png", "..\\file.png", "/file.png", "C:file.png", "NUL.png", "COM¹.png", "CON .png", "file.png.", "file.png "] {
        assert!(repository.copy_in(&input, "sources", filename).is_err(), "{filename}");
    }
    assert!(repository.copy_in(&input, "Sources", "valid.png").is_err());
    for relative in ["../outside.png", "sources/../../outside.png", "C:/outside.png", "sources\\file.png", "/outside.png", "project.sqlite"] {
        assert!(repository.artifact_path(relative).is_err(), "{relative}");
    }
}

#[test]
fn stale_snapshot_cannot_overwrite_another_connection() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path().join("project");
    let mut first = Repository::create(&root, "처음").unwrap();
    let mut second = Repository::open(&root).unwrap();
    let mut stale = second.project().unwrap();
    let mut current = first.project().unwrap();
    current.name = "첫 연결 저장".into();
    first.save_project(&current).unwrap();
    stale.name = "오래된 연결 덮어쓰기".into();
    assert!(second.save_project(&stale).is_err());
    assert_eq!(second.project().unwrap().name, "첫 연결 저장");
    let mut refreshed = second.project().unwrap();
    refreshed.name = "새로 읽고 저장".into();
    second.save_project(&refreshed).unwrap();
    assert_eq!(first.project().unwrap().name, "새로 읽고 저장");
}

#[test]
fn long_korean_space_paths_preserve_copies_restart_and_export_hashes() {
    let temporary = TempDir::new().unwrap();
    let mut nested = temporary.path().join("긴 경로 한글 공백");
    for index in 0..10 {
        nested = nested.join(format!("한국어 공백 구간 {index:02} abcdefghijklmnopqrst"));
    }
    #[cfg(windows)]
    let path_units = {
        use std::os::windows::ffi::OsStrExt;
        nested.as_os_str().encode_wide().count()
    };
    #[cfg(not(windows))]
    let path_units = nested.to_string_lossy().chars().count();
    assert!(path_units > 260, "fixture must exceed Windows MAX_PATH in actual character units");
    let outcome = (|| -> anyhow::Result<()> {
        fs::create_dir_all(&nested)?;
        let input = nested.join("서울 원본.PNG");
        fs::write(&input, fixture_png())?;
        let before = sha256_file(&input)?;
        let root = nested.join("프로젝트 한글 공백");
        let mut repository = Repository::create(&root, "긴 경로 프로젝트")?;
        let copied = repository.copy_in(&input, "sources", "서울 원본.PNG")?;
        repository.add_asset(asset("long-asset", version("long-version", 1, copied.clone())))?;
        drop(repository);
        let reopened = Repository::open(&root)?;
        reopened.verify_artifact(&copied)?;
        let bundle = reopened.export_bundle(&temporary.path().join("portable"), &[])?;
        assert_eq!(sha256_file(&bundle.join(&copied.path))?, before);
        assert_eq!(sha256_file(&input)?, before);
        assert_eq!(reopened.project()?.assets[0].versions[0].id, "long-version");
        Ok(())
    })();
    if let Err(error) = outcome {
        #[cfg(windows)]
        if error.chain().any(|cause| cause.downcast_ref::<std::io::Error>().is_some_and(|io| io.raw_os_error() == Some(206))) {
            eprintln!("SKIPPED long-path verification: Windows environment rejected a {path_units}-unit path with ERROR_FILENAME_EXCED_RANGE (206): {error:#}");
            return;
        }
        panic!("long-path operation failed: {error:#}");
    }
    eprintln!("LONG_PATH_VERIFIED: {path_units} character units; Korean names, spaces, restart and exported SHA-256 matched");
}

#[test]
fn project_identity_duplicate_versions_and_future_schema_are_rejected() {
    let temporary = TempDir::new().unwrap();
    let root = temporary.path().join("project");
    let input = original(&temporary);
    let mut repository = Repository::create(&root, "보존").unwrap();
    assert!(Repository::create(&root, "overwrite").is_err());
    let copied = repository.copy_in(&input, "sources", "original.png").unwrap();
    let initial = version("version-1", 1, copied.clone());
    let original_asset = asset("asset-1", initial.clone());
    repository.add_asset(original_asset.clone()).unwrap();
    assert!(repository.add_asset(original_asset).is_err());
    assert!(repository.add_version("asset-1", initial).is_err());
    assert!(repository.add_version("missing", version("version-2", 2, copied)).is_err());
    let mut project = repository.project().unwrap();
    project.id = "other-project".into();
    assert!(repository.save_project(&project).is_err());
    let mut wrong_job = job("other-project");
    assert!(repository.upsert_job(wrong_job.clone()).is_err());
    wrong_job.project_id = repository.project().unwrap().id;
    wrong_job.id.clear();
    assert!(repository.upsert_job(wrong_job).is_err());
    drop(repository);
    let database = Connection::open(root.join("project.sqlite")).unwrap();
    database.pragma_update(None, "user_version", 99u32).unwrap();
    drop(database);
    assert!(Repository::open(&root).is_err());
    let database = Connection::open(root.join("project.sqlite")).unwrap();
    assert_eq!(database.query_row::<u32, _, _>("PRAGMA user_version", [], |row| row.get(0)).unwrap(), 99);
}

#[cfg(unix)]
#[test]
fn symlink_sources_artifacts_and_destinations_are_rejected() {
    use std::os::unix::fs::{symlink, symlink as symlink_dir};
    let temporary = TempDir::new().unwrap();
    let root = temporary.path().join("project");
    let input = original(&temporary);
    let mut repository = Repository::create(&root, "링크 제한").unwrap();
    let source_link = temporary.path().join("source-link.png");
    symlink(&input, &source_link).unwrap();
    assert!(repository.copy_in(&source_link, "sources", "original.png").is_err());
    let copied = repository.copy_in(&input, "sources", "original.png").unwrap();
    repository.add_asset(asset("asset-1", version("version-1", 1, copied.clone()))).unwrap();
    let copied_path = repository.artifact_path(&copied.path).unwrap();
    fs::remove_file(&copied_path).unwrap();
    symlink(&input, &copied_path).unwrap();
    assert!(repository.verify_artifact(&copied).is_err());
    let destination = temporary.path().join("destination-link");
    symlink_dir(&root, &destination).unwrap();
    assert!(repository.export_bundle(&destination, &[]).is_err());
}

#[cfg(target_os = "macos")]
#[test]
fn standard_macos_tmp_alias_does_not_allow_user_file_symlinks() {
    use std::os::unix::fs::symlink;
    let temporary = TempDir::new_in("/tmp").unwrap();
    let root = temporary.path().join("project");
    let input = original(&temporary);
    let mut repository = Repository::create(&root, "macOS 시스템 경로").unwrap();
    let copied = repository.copy_in(&input, "sources", "original.png").unwrap();
    repository.add_asset(asset("asset-1", version("version-1", 1, copied))).unwrap();
    let linked_input = temporary.path().join("user-link.png");
    symlink(&input, &linked_input).unwrap();
    assert!(repository.copy_in(&linked_input, "sources", "linked.png").is_err());
    let reopened = Repository::open(&root).unwrap();
    assert!(reopened.export_bundle(&temporary.path().join("exports"), &[]).unwrap().join("manifest.json").is_file());
}

#[cfg(windows)]
#[test]
fn windows_junction_categories_and_export_destinations_are_rejected() {
    fn junction(link: &Path, target: &Path) {
        // Directory junctions need no administrator privileges. All paths are
        // private temporary test paths and passed as distinct process args.
        let result = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(result.status.success(), "junction fixture failed: {}", String::from_utf8_lossy(&result.stderr));
    }
    let temporary = TempDir::new().unwrap();
    let root = temporary.path().join("project");
    let input = original(&temporary);
    let repository = Repository::create(&root, "링크 제한").unwrap();
    let outside = temporary.path().join("outside");
    fs::create_dir(&outside).unwrap();
    junction(&root.join("sources"), &outside);
    assert!(repository.copy_in(&input, "sources", "original.png").is_err());
    let destination = temporary.path().join("destination-link");
    junction(&destination, &root);
    assert!(repository.export_bundle(&destination, &[]).is_err());
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
}
