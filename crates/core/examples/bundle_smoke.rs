//! Native persistence/export smoke proof. This is a local fixture, not an AI
//! provider call or a claim that the desktop UI works on another platform.

use anyhow::{ensure, Context, Result};
use asset_core::models::*;
use asset_core::{sha256_file, Repository};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use uuid::Uuid;

const PNG: &[u8] = include_bytes!("../../../tests/core/fixtures/reference.png");

fn write_new(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn main() -> Result<()> {
    let destination = std::env::args_os().nth(1)
        .map(PathBuf::from)
        .context("usage: cargo run -p asset-core --example bundle_smoke -- <proof directory>")?;
    fs::create_dir_all(&destination)?;
    let destination = destination.canonicalize()?;
    let proof = destination.join(format!("core-native-smoke-{}", Uuid::new_v4()));
    fs::create_dir(&proof)?;
    let inputs = proof.join("original inputs");
    fs::create_dir(&inputs)?;
    let original = inputs.join("서울 원본.PNG");
    write_new(&original, PNG)?;
    let before = sha256_file(&original)?;
    let root = proof.join("한글 프로젝트");
    let mut repository = Repository::create(&root, "네이티브 저장 · 내보내기 검증")?;
    let first = repository.copy_in(&original, "sources", "서울 원본.PNG")?;
    let case_variant = repository.copy_in(&original, "sources", "서울 원본.png")?;
    let output = repository.copy_in(&original, "outputs", "서울 출력.png")?;
    let asset_id = Uuid::new_v4().to_string();
    let first_version_id = Uuid::new_v4().to_string();
    repository.add_asset(Asset {
        id: asset_id.clone(),
        name: "서울 · 검증 이미지".into(),
        kind: AssetKind::Image,
        folder: "검증".into(),
        tags: vec!["native-smoke".into(), "fixture".into()],
        active_version_id: first_version_id.clone(),
        versions: vec![AssetVersion {
            id: first_version_id,
            number: 1,
            created_at: now(),
            prompt: "원본 fixture 가져오기".into(),
            source: AssetSource::Import,
            requested_model: None,
            confirmed_model: None,
            provider_version: None,
            artifacts: vec![first, case_variant],
            settings: BTreeMap::new(),
            validation: None,
        }],
        width: Some(1),
        height: Some(1),
        mesh: None,
    })?;
    repository.add_version(&asset_id, AssetVersion {
        id: Uuid::new_v4().to_string(),
        number: 2,
        created_at: now(),
        prompt: "로컬 fixture 복사; 외부 제공자 요청 없음".into(),
        source: AssetSource::Fixture,
        requested_model: Some("Nano Banana 2".into()),
        confirmed_model: None,
        provider_version: None,
        artifacts: vec![output],
        settings: BTreeMap::from([("fixture".into(), json!(true))]),
        validation: None,
    })?;
    let project = repository.project()?;
    repository.upsert_job(Job {
        id: Uuid::new_v4().to_string(),
        project_id: project.id,
        asset_id: Some(asset_id),
        kind: "core.smoke".into(),
        label: "저장 및 복사 무결성 검증".into(),
        status: JobStatus::Succeeded,
        dependencies: Vec::new(),
        resource: JobResource::Cpu,
        attempts: 1,
        created_at: now(),
        started_at: Some(now()),
        finished_at: Some(now()),
        error: None,
        progress: JobProgress { stage: "verified".into(), completed: Some(3), total: Some(3) },
        payload: BTreeMap::from([("fixture".into(), json!(true))]),
        cache_key: None,
    })?;
    let expected = repository.project()?;
    drop(repository);
    let reopened = Repository::open(&root)?;
    let persisted = reopened.project()?;
    ensure!(persisted == expected, "SQLite reopen lost project state");
    let bundle = reopened.export_bundle(&proof.join("portable exports"), &[])?;
    let manifest: ExportManifest = serde_json::from_slice(&fs::read(bundle.join("manifest.json"))?)?;
    let mut checked_files = Vec::new();
    for artifact in &manifest.files {
        let actual = sha256_file(&bundle.join(&artifact.path))?;
        ensure!(actual == (artifact.sha256.clone(), artifact.bytes), "exported bytes did not match manifest");
        checked_files.push(json!({"path": artifact.path, "sha256": actual.0, "bytes": actual.1, "verified": true}));
    }
    let after = sha256_file(&original)?;
    ensure!(before == after, "original input changed");
    ensure!(persisted.assets[0].versions.len() == 2 && persisted.jobs.len() == 1, "versions or job missing after restart");
    let report = json!({
        "proofScope": "Native Rust repository execution; fixture data; no external provider call or desktop/macOS UI claim",
        "platform": std::env::consts::OS,
        "schemaVersion": SCHEMA_VERSION,
        "projectRoot": reopened.root(),
        "bundle": bundle,
        "reopenedFromSqlite": true,
        "assetCount": persisted.assets.len(),
        "versionCount": persisted.assets[0].versions.len(),
        "jobCount": persisted.jobs.len(),
        "original": {"path": original, "sha256": before.0, "bytes": before.1, "unchanged": true},
        "checkedFiles": checked_files,
        "requestedModel": "Nano Banana 2",
        "confirmedModel": null
    });
    let report_path = proof.join("smoke-report.json");
    write_new(&report_path, &serde_json::to_vec_pretty(&report)?)?;
    println!("{}", serde_json::to_string_pretty(&json!({"report": report_path, "result": report}))?);
    Ok(())
}
