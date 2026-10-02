//! Native production-Backend import acceptance, without the Tauri window,
//! browser, provider connection, external generation, or Blender worker jobs.
//! Inputs and a JSON evidence report are retained in a new UUID directory.
#![cfg(any(target_os = "windows", target_os = "macos"))]

use anyhow::{Context, Result};
use asset_core::{models::Artifact, sha256_file};
use asset_desktop::workbench::Backend;
use image::codecs::{jpeg::JpegEncoder, png::PngEncoder};
use image::{ExtendedColorType, ImageEncoder, ImageFormat, Rgba, RgbaImage};
use serde_json::{json, Value};
use std::{fs, fs::File, io::Write, path::{Path, PathBuf}};
use uuid::Uuid;

struct NativeProject {
    output: PathBuf,
    sources: PathBuf,
    data: PathBuf,
    root: PathBuf,
    examples: PathBuf,
    worker: PathBuf,
    backend: Backend,
}

impl NativeProject {
    fn new() -> Result<Self> {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let parent = base.join("../../../artifacts/native-import-acceptance");
        fs::create_dir_all(&parent)?;
        let output = parent.join(Uuid::new_v4().to_string());
        fs::create_dir(&output)?;
        let sources = output.join("읽기 전용 원본 입력");
        fs::create_dir(&sources)?;
        let data = output.join("app-data");
        let examples = base.join("../public/examples");
        let worker = base.join("../../../workers/blender/worker.py");
        let backend = Backend::new(data.clone(), examples.clone(), worker.clone());
        let root = output.join("한글 프로젝트");
        let created = backend.request(json!({"action":"create","root":root,"name":"네이티브 가져오기 수용 검사"}))?;
        assert!(created["project"]["assets"].as_array().unwrap().is_empty());
        assert!(created["project"]["jobs"].as_array().unwrap().is_empty());
        println!("Native Backend import evidence directory: {}", output.display());
        Ok(Self { output, sources, data, root, examples, worker, backend })
    }

    fn source(&self, name: &str, bytes: &[u8]) -> Result<PathBuf> {
        let path = self.sources.join(name);
        let mut file = File::options().write(true).create_new(true).open(&path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        let mut permissions = fs::metadata(&path)?.permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions)?;
        assert!(fs::metadata(&path)?.permissions().readonly());
        Ok(path)
    }
}

impl Drop for NativeProject {
    fn drop(&mut self) {
        self.backend.shutdown();
        // Deliberately retain immutable source fixtures and evidence. There is
        // no recursive deletion and no mutation of a user's existing files.
    }
}

fn png_bytes(pixels: &RgbaImage) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes).write_image(pixels.as_raw(), pixels.width(), pixels.height(), ExtendedColorType::Rgba8)?;
    Ok(bytes)
}

fn jpeg_bytes(pixels: &RgbaImage) -> Result<Vec<u8>> {
    let rgb = pixels.pixels().flat_map(|pixel| [pixel[0], pixel[1], pixel[2]]).collect::<Vec<_>>();
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 95).encode(&rgb, pixels.width(), pixels.height(), ExtendedColorType::Rgb8)?;
    Ok(bytes)
}

fn rejected_import(project: &NativeProject, source: &Path, expected_bytes: &[u8], category: &str) -> Result<Value> {
    let before = project.backend.request(json!({"action":"snapshot"}))?;
    let original_hash = sha256_file(source)?;
    let result = project.backend.request(json!({"action":"import","paths":[source]}));
    let error = result.expect_err("native Backend must reject this invalid import");
    if category == "extension_content_mismatch" {
        assert!(error.to_string().contains("확장자"), "A valid differently named raster must be rejected for extension mismatch, not a fabricated decoder failure");
    }
    let after = project.backend.request(json!({"action":"snapshot"}))?;
    assert_eq!(before["project"]["assets"], after["project"]["assets"], "rejected input must not publish an asset/version");
    assert_eq!(before["project"]["jobs"], after["project"]["jobs"], "rejected import must not queue generation or processing jobs");
    assert_eq!(fs::read(source)?, expected_bytes, "rejected original must be byte-for-byte unchanged");
    assert_eq!(sha256_file(source)?, original_hash);
    assert!(fs::metadata(source)?.permissions().readonly(), "native import must leave source permissions unchanged");
    let evidence = json!({
        "case":category,"source":source.file_name().unwrap().to_string_lossy(),
        "rejected":true,"publishedAssetsUnchanged":true,"jobsUnchanged":true,
        "originalBytesPreserved":true,"originalReadonlyPreserved":true,
        "originalSha256":original_hash.0,"originalBytes":original_hash.1,
    });
    println!("{}", serde_json::to_string(&evidence)?);
    Ok(evidence)
}

fn write_evidence(path: &Path, evidence: &Value) -> Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut file = File::options().write(true).create_new(true).open(&temporary)?;
    file.write_all(&serde_json::to_vec_pretty(evidence)?)?;
    file.sync_all()?;
    drop(file);
    // Publishing a same-directory hard link never replaces an existing file.
    let result = fs::hard_link(&temporary, path);
    let _ = fs::remove_file(&temporary);
    result?;
    Ok(())
}

#[test]
fn native_import_rejects_invalid_content_and_preserves_read_only_originals() -> Result<()> {
    let project = NativeProject::new()?;
    let pixels = RgbaImage::from_fn(17, 13, |x, y| {
        if (2..15).contains(&x) && (2..11).contains(&y) {
            Rgba([(x * 11) as u8, (y * 17) as u8, 80, if (x + y) % 2 == 0 {128} else {255}])
        } else { Rgba([10, 20, 30, 0]) }
    });
    let png = png_bytes(&pixels)?;
    let jpeg = jpeg_bytes(&pixels)?;
    assert_eq!(image::guess_format(&png)?, ImageFormat::Png);
    assert_eq!(image::guess_format(&jpeg)?, ImageFormat::Jpeg);
    assert_eq!(image::load_from_memory(&png)?.into_rgba8(), pixels);
    assert_eq!((image::load_from_memory(&jpeg)?.width(), image::load_from_memory(&jpeg)?.height()), (17, 13));

    let png_named_jpeg = project.source("PNG 내용 JPEG 확장자.jpg", &png)?;
    let jpeg_named_png = project.source("JPEG 내용 PNG 확장자.png", &jpeg)?;
    let mut cases = vec![
        rejected_import(&project, &png_named_jpeg, &png, "extension_content_mismatch")?,
        rejected_import(&project, &jpeg_named_png, &jpeg, "extension_content_mismatch")?,
    ];

    let corrupt_png = &png[..png.len() / 2];
    let corrupt_jpeg = &jpeg[..jpeg.len().min(12)];
    assert_eq!(image::guess_format(corrupt_png)?, ImageFormat::Png);
    assert_eq!(image::guess_format(corrupt_jpeg)?, ImageFormat::Jpeg);
    assert!(image::load_from_memory(corrupt_png).is_err(), "corrupt PNG fixture must genuinely fail pixel decoding");
    assert!(image::load_from_memory(corrupt_jpeg).is_err(), "corrupt JPEG fixture must genuinely fail pixel decoding");
    let truncated_png = project.source("손상된 PNG 원본.png", corrupt_png)?;
    let truncated_jpeg = project.source("손상된 JPEG 원본.jpeg", corrupt_jpeg)?;
    cases.push(rejected_import(&project, &truncated_png, corrupt_png, "corrupt_raster")?);
    cases.push(rejected_import(&project, &truncated_jpeg, corrupt_jpeg, "corrupt_raster")?);

    let valid = project.source("한글과 공백 정상 원본.PNG", &png)?;
    let original_hash = sha256_file(&valid)?;
    let imported = project.backend.request(json!({"action":"import","paths":[valid]}))?;
    let assets = imported["project"]["assets"].as_array().context("native import did not return assets")?;
    assert_eq!(assets.len(), 1, "only the valid source may be published");
    let asset = &assets[0];
    assert_eq!(asset["width"], 17); assert_eq!(asset["height"], 13);
    assert_eq!(asset["versions"][0]["source"], "import");
    assert_eq!(asset["versions"][0]["validation"]["valid"], true);
    let artifact: Artifact = serde_json::from_value(asset["versions"][0]["artifacts"][0].clone())?;
    assert_eq!(artifact.format, "png");
    let copied = project.root.join(&artifact.path);
    assert_ne!(fs::canonicalize(&copied)?, fs::canonicalize(&valid)?, "project storage must preserve a separate immutable copy");
    assert_eq!(fs::read(&copied)?, png);
    assert_eq!(sha256_file(&copied)?, original_hash);
    assert_eq!((artifact.sha256.clone(), artifact.bytes), original_hash);
    assert_eq!(image::guess_format(&fs::read(&copied)?)?, ImageFormat::Png);
    let independent_decode = image::open(&copied)?.into_rgba8();
    assert_eq!(independent_decode, pixels, "stored copy must contain the real RGBA pixels, not merely exist");
    assert_eq!(independent_decode.get_pixel(0, 0)[3], 0);
    assert!(independent_decode.pixels().any(|pixel| pixel[3] == 128));
    assert_eq!(fs::read(&valid)?, png); assert_eq!(sha256_file(&valid)?, original_hash);
    assert!(fs::metadata(&valid)?.permissions().readonly());
    assert!(imported["project"]["jobs"].as_array().unwrap().is_empty());

    project.backend.shutdown();
    let reopened = Backend::new(project.data.clone(), project.examples.clone(), project.worker.clone());
    let restore_result = reopened.request(json!({"action":"open","root":project.root}));
    reopened.shutdown();
    let restored = restore_result?;
    assert_eq!(restored["project"]["assets"], imported["project"]["assets"], "reopen must preserve the accepted version and rejected-input exclusion");
    assert_eq!(sha256_file(&copied)?, original_hash);
    assert_eq!(fs::read(&valid)?, png);
    assert!(fs::metadata(&valid)?.permissions().readonly());
    let evidence = json!({
        "nativeBackend":true,"nativeWindow":false,"platform":std::env::consts::OS,
        "fixtureProvenance":"local_test_fixture","externalGenerationRequested":false,
        "providerStatusRequested":false,"blenderWorkerRequested":false,
        "rejectedCases":cases,"acceptedAssets":1,"readOnlyOriginalPreserved":true,
        "separateStoredCopy":true,"independentDecode":{"width":17,"height":13,"hasAlpha":true,"partialAlphaPreserved":true,"allPixelsEqual":true},
        "originalSha256":original_hash.0,"storedSha256":artifact.sha256,"bytes":artifact.bytes,
        "reopenedProjectVerified":true,"scope":"Production native Backend import and SQLite persistence; excludes window, file dialog, installer, and external provider generation",
    });
    write_evidence(&project.output.join("native-import-acceptance.json"), &evidence)?;
    println!("{}", serde_json::to_string_pretty(&evidence)?);
    Ok(())
}
