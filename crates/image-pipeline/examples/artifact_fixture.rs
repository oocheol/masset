//! Explicit local-fixture smoke run; this is not an external generation test.
use anyhow::{ensure, Context, Result};
use asset_image_pipeline::{convert, derive_normal, inspect, pack_atlas, process, split_sheet};
use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder, Rgba, RgbaImage};
use serde_json::json;
use std::fs::{self, File};
use std::path::{Path, PathBuf};

fn write_fixture(path: &Path, pixels: &RgbaImage) -> Result<()> {
    let mut file = File::options().write(true).create_new(true).open(path)?;
    PngEncoder::new(&mut file).write_image(pixels.as_raw(), pixels.width(), pixels.height(), ExtendedColorType::Rgba8)?;
    file.sync_all()?;
    Ok(())
}

fn main() -> Result<()> {
    let output = std::env::args_os().nth(1).map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("tests/image/artifact-example"));
    ensure!(!output.exists(), "fixture output folder already exists; use a new version folder");
    fs::create_dir_all(&output).context("create fixture folder")?;
    let palette = [[121, 153, 147], [212, 189, 138], [113, 146, 188], [199, 130, 114]];
    let mut inputs = Vec::new();
    for (index, color) in palette.iter().enumerate() {
        let pixels = RgbaImage::from_fn(48, 48, |x, y| {
            let dx = x as i32 - 24; let dy = y as i32 - 24;
            if dx * dx + dy * dy > 20 * 20 { return Rgba([0, 0, 0, 0]); }
            let edge = dx * dx + dy * dy > 17 * 17;
            if edge { Rgba([45, 51, 60, 255]) }
            else { Rgba([color[0], color[1], color[2], 255]) }
        });
        let path = output.join(format!("local-fixture-icon-{index}.png"));
        write_fixture(&path, &pixels)?;
        inputs.push(path);
    }
    let trim = output.join("trimmed-v2.png");
    let trim_info = process(&inputs[0], &trim, &json!({"type":"trim","padding":2}))?;
    let resized = output.join("pixel-art-v2.png");
    let resize_info = process(&inputs[0], &resized, &json!({"type":"resize","width":96,"height":96,"pixelArt":true}))?;
    let atlas = output.join("icons-atlas.png");
    let packed = pack_atlas(&inputs, &atlas, 104, 104, 2)?;
    let frames = split_sheet(&atlas, &output.join("split-frames"), 52, 52)?;
    let webp = output.join("icon.webp");
    let webp_info = convert(&inputs[0], &webp, "webp")?;
    let jpeg = output.join("white-background.jpg");
    let jpeg_info = convert(&inputs[0], &jpeg, "jpeg")?;
    let normal = output.join("heuristic-normal.png");
    let normal_info = derive_normal(&inputs[0], &normal, 2.0, false)?;
    let report = json!({
        "source": "local_fixture",
        "providerVerified": false,
        "originals": inputs.iter().map(|path| inspect(path)).collect::<Result<Vec<_>>>()?,
        "trim": trim_info,
        "nearestResize": resize_info,
        "atlas": packed,
        "splitFrames": frames,
        "webp": webp_info,
        "jpeg": jpeg_info,
        "normal": normal_info,
    });
    let mut file = File::options().write(true).create_new(true).open(output.join("artifact-report.json"))?;
    serde_json::to_writer_pretty(&mut file, &report)?;
    file.sync_all()?;
    println!("Local fixture artifacts: {}", output.display());
    Ok(())
}
