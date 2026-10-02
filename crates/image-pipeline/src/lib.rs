//! Deterministic local raster operations. Every public writer creates a new file.
//!
//! Encoded inputs are limited to PNG, JPEG and WebP. Images are probed before
//! decoding, with size and decoder allocation limits. The module never runs
//! code contained in a file. It writes RGBA PNGs, lossless WebP, or JPEG images
//! composited over white. A normal map derived here is a luminance heuristic,
//! not a measured physical material property.

use anyhow::{anyhow, bail, ensure, Context, Result};
use image::codecs::{jpeg::JpegEncoder, png::PngEncoder, webp::WebPEncoder};
use image::imageops::{self, FilterType};
use image::metadata::Orientation;
use image::{ExtendedColorType, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

/// Maximum encoded input size (64 MiB).
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// Maximum width or height, checked before decoding or allocating output.
pub const MAX_EDGE: u32 = 8192;
/// Maximum decoded pixel count, checked before decoding or allocating output.
pub const MAX_PIXELS: u64 = 64_000_000;
const MAX_FRAMES: usize = 4096;
const MAX_BRUSH_POINTS: usize = 10_000;
const MAX_BRUSH_PIXEL_VISITS: u64 = MAX_PIXELS * 4;
const EDGE_WARNING_THRESHOLD: f64 = 0.04;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationCheck {
    pub code: String,
    pub status: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measured: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    /// The decoded source format contains an alpha channel. This is separate
    /// from whether any pixels are transparent.
    pub has_alpha: bool,
    pub non_empty: bool,
    /// Mean opposite-edge RGBA difference in [0, 1], with RGB premultiplied
    /// solely for measurement so invisible RGB cannot create false seams.
    pub edge_error: f64,
    pub checks: Vec<ValidationCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasFrame {
    pub file: String,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// Normalized pivot. The default is the frame center.
    pub pivot: [f32; 2],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasResult {
    pub image: ImageInfo,
    pub metadata_path: PathBuf,
    pub frames: Vec<AtlasFrame>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum Operation {
    Resize {
        width: u32,
        height: u32,
        #[serde(rename = "pixelArt")]
        pixel_art: bool,
    },
    Crop { x: u32, y: u32, width: u32, height: u32 },
    Trim { padding: u32 },
    /// Hue in degrees; saturation is a multiplier (1.0 preserves saturation).
    Color { hue: f64, saturation: f64 },
    /// A border-connected RGB color key; tolerance is in 8-bit channel units.
    Background { color: String, tolerance: f64 },
    Mask { points: Vec<[f64; 2]>, radius: f64, mode: MaskMode },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum MaskMode {
    Erase,
    Restore,
}

struct Decoded {
    pixels: RgbaImage,
    has_alpha: bool,
    orientation: Orientation,
}

/// Decode the actual file and measure resolution, alpha, nonempty content,
/// visible boundary contact, and opposite-edge differences.
pub fn inspect(path: &Path) -> Result<ImageInfo> {
    let decoded = decode(path)?;
    let mut info = measure(&decoded.pixels, decoded.has_alpha);
    if decoded.orientation != Orientation::NoTransforms {
        info.checks.push(check("EXIF_ORIENTATION", "pass", "저장된 EXIF 표시 방향을 픽셀 좌표에 적용했습니다. 입력 파일은 변경하지 않았습니다", Some(json!(format!("{:?}", decoded.orientation)))));
    }
    Ok(info)
}

/// Apply an operation to a new PNG version. Restore masks require
/// [`process_with_original`] so restoration uses preserved source pixels.
pub fn process(input: &Path, output: &Path, operation: &Value) -> Result<ImageInfo> {
    process_impl(input, None, output, operation)
}

/// Apply an operation with an immutable original available for mask restore.
/// A restoration source must have the same dimensions as the edited image.
/// Callers must explicitly provide a suitably aligned original after a crop or
/// resize; the module does not guess a coordinate transformation.
pub fn process_with_original(
    input: &Path,
    original: &Path,
    output: &Path,
    operation: &Value,
) -> Result<ImageInfo> {
    process_impl(input, Some(original), output, operation)
}

fn process_impl(
    input: &Path,
    original: Option<&Path>,
    output: &Path,
    operation: &Value,
) -> Result<ImageInfo> {
    require_extension(output, ImageFormat::Png)?;
    require_new_path(output)?;
    let op: Operation = serde_json::from_value(operation.clone())
        .context("이미지 작업 매개변수가 공통 계약과 일치하지 않습니다")?;
    let mut pixels = decode(input)?.pixels;
    let mut extra = Vec::new();
    match op {
        Operation::Resize { width, height, pixel_art } => {
            validate_dimensions(width, height)?;
            pixels = if pixel_art {
                imageops::resize(&pixels, width, height, FilterType::Nearest)
            } else {
                resize_with_alpha(&mut pixels, width, height)
            };
            extra.push(check(
                "RESIZE_FILTER",
                "pass",
                if pixel_art { "픽셀아트 최근접 보간을 적용했습니다" } else { "일반 이미지 Lanczos3 보간을 적용했습니다" },
                Some(json!(if pixel_art { "nearest" } else { "lanczos3" })),
            ));
        }
        Operation::Crop { x, y, width, height } => {
            validate_dimensions(width, height)?;
            ensure!(x < pixels.width() && y < pixels.height(), "자르기 영역이 이미지 밖에 있습니다");
            let cropped_width = width.min(pixels.width() - x);
            let cropped_height = height.min(pixels.height() - y);
            if cropped_width != width || cropped_height != height {
                extra.push(check("CROP_CLAMPED", "warn", "자르기 영역의 이미지 밖 부분을 제외했습니다", Some(json!(format!("{cropped_width}x{cropped_height}")))));
            }
            pixels = imageops::crop_imm(&pixels, x, y, cropped_width, cropped_height).to_image();
        }
        Operation::Trim { padding } => {
            ensure!(padding <= MAX_EDGE, "여백이 허용 범위를 초과합니다");
            let [left, top, right, bottom] = alpha_bounds(&pixels)
                .ok_or_else(|| anyhow!("완전히 투명한 이미지는 여백 정리할 수 없습니다"))?;
            let width = (right - left + 1).checked_add(padding.checked_mul(2).context("여백 계산 오류")?).context("너비 계산 오류")?;
            let height = (bottom - top + 1).checked_add(padding.checked_mul(2).context("여백 계산 오류")?).context("높이 계산 오류")?;
            validate_dimensions(width, height)?;
            let cropped = imageops::crop_imm(&pixels, left, top, right - left + 1, bottom - top + 1).to_image();
            let mut trimmed = RgbaImage::new(width, height);
            imageops::replace(&mut trimmed, &cropped, i64::from(padding), i64::from(padding));
            pixels = trimmed;
            extra.push(check("TRIM_BOUNDS", "pass", "보이는 알파 영역을 기준으로 여백을 정리했습니다", Some(json!(format!("{left},{top},{right},{bottom}")))));
        }
        Operation::Color { hue, saturation } => {
            ensure!(hue.is_finite() && saturation.is_finite(), "색상 매개변수는 유한한 수여야 합니다");
            ensure!((0.0..=4.0).contains(&saturation), "채도 배율은 0에서 4 사이여야 합니다");
            for pixel in pixels.pixels_mut() {
                let rgb = shift_hsv([pixel[0], pixel[1], pixel[2]], hue, saturation);
                pixel[0] = rgb[0]; pixel[1] = rgb[1]; pixel[2] = rgb[2];
            }
        }
        Operation::Background { color, tolerance } => {
            ensure!(tolerance.is_finite() && (0.0..=255.0).contains(&tolerance), "배경 허용 오차는 0에서 255 사이여야 합니다");
            let target = parse_rgb(&color)?;
            let count = remove_border_background(&mut pixels, target, tolerance);
            extra.push(check("BACKGROUND_COLOR_KEY", "warn", "가장자리와 연결된 단색 배경을 제거했습니다. 비슷한 전경색과 복잡한 배경은 수동 마스크 검토가 필요합니다", Some(json!(count))));
        }
        Operation::Mask { points, radius, mode } => {
            let preserved = match mode {
                MaskMode::Restore => {
                    let path = original.context("마스크 복원에는 보존된 원본 이미지가 필요합니다")?;
                    let image = decode(path)?.pixels;
                    ensure!(image.dimensions() == pixels.dimensions(), "원본과 편집본의 크기가 달라 복원 좌표를 적용할 수 없습니다");
                    Some(image)
                }
                MaskMode::Erase => None,
            };
            let changed = apply_brush(&mut pixels, preserved.as_ref(), &points, radius)?;
            let (status, message) = if changed > 0 {
                ("pass", "수동 브러시 마스크를 실제 픽셀에 적용했습니다")
            } else {
                ("warn", "브러시 영역에서 변경된 픽셀이 없습니다. 좌표와 반지름을 확인하세요")
            };
            extra.push(check("MANUAL_MASK", status, message, Some(json!(changed))));
        }
    }
    save_new_image(output, &pixels, ImageFormat::Png)?;
    drop(pixels);
    let mut info = inspect(output).context("작성한 PNG의 재디코딩에 실패했습니다")?;
    info.checks.extend(extra);
    Ok(info)
}

/// Pack sprites in input order using bounded shelf packing. Metadata stores
/// top-left pixel coordinates and unrotated frame dimensions; the PNG uses
/// straight alpha. Both output names must be unused.
pub fn pack_atlas(inputs: &[PathBuf], output: &Path, width: u32, height: u32, padding: u32) -> Result<AtlasResult> {
    ensure!(!inputs.is_empty() && inputs.len() <= MAX_FRAMES, "아틀라스 프레임 수는 1에서 {MAX_FRAMES} 사이여야 합니다");
    validate_dimensions(width, height)?;
    ensure!(padding < width && padding < height, "아틀라스 여백이 캔버스보다 큽니다");
    require_extension(output, ImageFormat::Png)?;
    require_new_path(output)?;
    let metadata_path = output.with_extension("json");
    require_new_path(&metadata_path)?;
    let mut atlas = RgbaImage::new(width, height);
    let mut frames = Vec::with_capacity(inputs.len());
    let mut names = HashSet::new();
    let mut x = padding;
    let mut y = padding;
    let mut row_height = 0_u32;
    for input in inputs {
        let decoded = decode(input)?;
        let image = decoded.pixels;
        ensure!(alpha_bounds(&image).is_some(), "완전히 투명한 프레임은 아틀라스에 넣을 수 없습니다");
        let canonical = fs::canonicalize(input).context("프레임 원본 경로를 확인할 수 없습니다")?;
        let file = canonical.to_str().context("프레임 파일 경로가 유효한 UTF-8이 아닙니다")?.to_owned();
        ensure!(names.insert(file.to_lowercase()), "동일한 원본 경로가 아틀라스에 중복되어 있습니다");
        let horizontal_extent = image.width().checked_add(padding.checked_mul(2).context("아틀라스 여백 계산 오류")?).context("아틀라스 너비 계산 오류")?;
        ensure!(horizontal_extent <= width, "프레임과 여백이 아틀라스 너비를 초과합니다");
        if u64::from(x) + u64::from(image.width()) + u64::from(padding) > u64::from(width) {
            x = padding;
            y = y.checked_add(row_height).and_then(|value| value.checked_add(padding.saturating_mul(2))).context("아틀라스 행 계산 오류")?;
            row_height = 0;
        }
        ensure!(u64::from(y) + u64::from(image.height()) + u64::from(padding) <= u64::from(height), "프레임을 배치할 아틀라스 공간이 부족합니다");
        imageops::replace(&mut atlas, &image, i64::from(x), i64::from(y));
        frames.push(AtlasFrame { file, x, y, width: image.width(), height: image.height(), pivot: [0.5, 0.5] });
        x = x.checked_add(image.width()).and_then(|value| value.checked_add(padding.saturating_mul(2))).context("아틀라스 열 계산 오류")?;
        row_height = row_height.max(image.height());
    }
    let metadata = json!({
        "schemaVersion": 1,
        "image": output.file_name().and_then(|name| name.to_str()).context("아틀라스 파일명이 유효한 UTF-8이 아닙니다")?,
        "width": width, "height": height, "padding": padding,
        "premultipliedAlpha": false,
        "frames": frames,
    });
    let metadata_bytes = serde_json::to_vec_pretty(&metadata)?;
    save_new_image(output, &atlas, ImageFormat::Png)?;
    if let Err(error) = write_new_bytes(&metadata_path, &metadata_bytes) {
        // Only the PNG newly created by this invocation is rolled back.
        let _ = fs::remove_file(output);
        return Err(error).context("아틀라스 메타데이터 작성 실패로 새 PNG를 롤백했습니다");
    }
    drop(atlas);
    let mut info = inspect(output)?;
    info.checks.push(check("ATLAS_LAYOUT", "pass", "프레임의 좌표·크기와 겹치지 않는 배치를 기록했습니다", Some(json!(frames.len()))));
    Ok(AtlasResult { image: info, metadata_path, frames })
}

/// Split a sheet in row-major order. Partial trailing frames are rejected;
/// frame sizes must exactly divide the sheet. Existing frame files are never
/// replaced. An existing output directory is permitted.
pub fn split_sheet(input: &Path, output_dir: &Path, frame_width: u32, frame_height: u32) -> Result<Vec<PathBuf>> {
    validate_dimensions(frame_width, frame_height)?;
    let pixels = decode(input)?.pixels;
    ensure!(pixels.width() % frame_width == 0 && pixels.height() % frame_height == 0, "시트 크기가 프레임 크기로 정확히 나누어지지 않습니다");
    let columns = pixels.width() / frame_width;
    let rows = pixels.height() / frame_height;
    let count = u64::from(columns) * u64::from(rows);
    ensure!(count > 0 && count <= MAX_FRAMES as u64, "시트 프레임 수가 허용 범위를 초과합니다");
    let paths: Vec<PathBuf> = (0..count).map(|index| output_dir.join(format!("frame_{index:04}.png"))).collect();
    for path in &paths { require_new_path(path)?; }
    fs::create_dir_all(output_dir).context("프레임 출력 디렉터리를 만들 수 없습니다")?;
    let mut created: Vec<PathBuf> = Vec::new();
    for row in 0..rows {
        for column in 0..columns {
            let index = (u64::from(row) * u64::from(columns) + u64::from(column)) as usize;
            let frame = imageops::crop_imm(&pixels, column * frame_width, row * frame_height, frame_width, frame_height).to_image();
            if let Err(error) = save_new_image(&paths[index], &frame, ImageFormat::Png) {
                for path in &created { let _ = fs::remove_file(path); }
                return Err(error).context("프레임 작성 실패로 이번 실행에서 만든 프레임만 롤백했습니다");
            }
            created.push(paths[index].clone());
        }
    }
    // Decode every produced artifact; file existence alone is not validation.
    for path in &paths {
        let frame = inspect(path)?;
        ensure!(frame.width == frame_width && frame.height == frame_height, "작성된 프레임 크기가 지정값과 다릅니다");
    }
    Ok(paths)
}

/// Encode a new PNG, lossless WebP, or quality-95 JPEG. JPEG has no alpha and is
/// explicitly composited over white; this choice is included in its checks.
pub fn convert(input: &Path, output: &Path, format: &str) -> Result<ImageInfo> {
    let format = parse_format(format)?;
    require_extension(output, format)?;
    require_new_path(output)?;
    let pixels = decode(input)?.pixels;
    save_new_image(output, &pixels, format)?;
    drop(pixels);
    let mut info = inspect(output)?;
    if format == ImageFormat::Jpeg {
        info.checks.push(check("JPEG_ALPHA_COMPOSITE", "warn", "JPEG는 알파를 지원하지 않아 흰 배경 위에 합성했습니다", Some(json!("#ffffff"))));
    }
    Ok(info)
}

/// Derive a tangent-space normal map from image luminance used as an assumed
/// height field. OpenGL uses green-up; DirectX flips the green channel.
/// Alpha is preserved. This is an experimental heuristic, not recovered PBR.
pub fn derive_normal(input: &Path, output: &Path, strength: f32, direct_x: bool) -> Result<ImageInfo> {
    ensure!(strength.is_finite() && strength > 0.0 && strength <= 100.0, "노멀 강도는 0보다 크고 100 이하여야 합니다");
    require_extension(output, ImageFormat::Png)?;
    require_new_path(output)?;
    let pixels = decode(input)?.pixels;
    let (width, height) = pixels.dimensions();
    let mut normal = RgbaImage::new(width, height);
    let height_at = |x: u32, y: u32| {
        let pixel = pixels.get_pixel(x, y);
        (0.2126 * f32::from(pixel[0]) + 0.7152 * f32::from(pixel[1]) + 0.0722 * f32::from(pixel[2])) / 255.0
    };
    for y in 0..height {
        for x in 0..width {
            let dx = (height_at((x + 1).min(width - 1), y) - height_at(x.saturating_sub(1), y)) * strength;
            let dy = (height_at(x, (y + 1).min(height - 1)) - height_at(x, y.saturating_sub(1))) * strength;
            let nx = -dx;
            let ny = if direct_x { -dy } else { dy };
            let length = (nx * nx + ny * ny + 1.0).sqrt();
            let encode = |value: f32| ((value * 0.5 + 0.5) * 255.0).round().clamp(0.0, 255.0) as u8;
            normal.put_pixel(x, y, Rgba([encode(nx / length), encode(ny / length), encode(1.0 / length), pixels.get_pixel(x, y)[3]]));
        }
    }
    save_new_image(output, &normal, ImageFormat::Png)?;
    drop(normal); drop(pixels);
    let mut info = inspect(output)?;
    info.checks.push(check("HEURISTIC_NORMAL", "warn", "밝기를 가정 높이로 사용한 실험적 노멀맵입니다. 물리적으로 측정한 재질이나 3D 형상 복원이 아닙니다", Some(json!(if direct_x { "DirectX" } else { "OpenGL" }))));
    Ok(info)
}

fn decode(path: &Path) -> Result<Decoded> {
    let file = File::open(path).context("이미지 입력 파일을 열 수 없습니다")?;
    let metadata = file.metadata()?;
    ensure!(metadata.is_file(), "이미지 입력은 일반 파일이어야 합니다");
    ensure!(metadata.len() <= MAX_FILE_BYTES, "이미지 입력 파일이 64 MiB 제한을 초과합니다");
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= MAX_FILE_BYTES, "읽는 중 입력 파일이 64 MiB 제한을 초과했습니다");
    let format = image::guess_format(&bytes).context("파일 내용을 지원되는 래스터 이미지로 식별할 수 없습니다")?;
    ensure!(matches!(format, ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP), "PNG, JPEG, WebP 래스터 파일만 지원합니다");
    let mut probe = ImageReader::with_format(Cursor::new(&bytes), format);
    probe.limits(decoder_limits());
    let mut probe_decoder = probe.into_decoder().context("이미지 헤더를 읽을 수 없습니다")?;
    let (width, height) = probe_decoder.dimensions();
    validate_dimensions(width, height)?;
    let orientation = probe_decoder.orientation().context("이미지 표시 방향 메타데이터를 읽을 수 없습니다")?;
    drop(probe_decoder);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(decoder_limits());
    let mut image = reader.decode().context("이미지 픽셀 디코딩에 실패했습니다")?;
    ensure!(image.width() == width && image.height() == height, "이미지 헤더와 디코딩 결과 크기가 다릅니다");
    let has_alpha = image.color().has_alpha();
    image.apply_orientation(orientation);
    Ok(Decoded { pixels: image.into_rgba8(), has_alpha, orientation })
}

fn decoder_limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_EDGE);
    limits.max_image_height = Some(MAX_EDGE);
    limits.max_alloc = Some(MAX_PIXELS * 8);
    limits
}

fn validate_dimensions(width: u32, height: u32) -> Result<()> {
    ensure!(width > 0 && height > 0, "이미지 너비와 높이는 0보다 커야 합니다");
    ensure!(width <= MAX_EDGE && height <= MAX_EDGE, "이미지 한 변이 {MAX_EDGE}픽셀 제한을 초과합니다");
    ensure!(u64::from(width) * u64::from(height) <= MAX_PIXELS, "이미지 픽셀 수가 {MAX_PIXELS} 제한을 초과합니다");
    Ok(())
}

fn alpha_bounds(pixels: &RgbaImage) -> Option<[u32; 4]> {
    let mut bounds = [pixels.width(), pixels.height(), 0, 0];
    let mut nonempty = false;
    for (x, y, pixel) in pixels.enumerate_pixels() {
        if pixel[3] > 0 {
            nonempty = true;
            bounds[0] = bounds[0].min(x); bounds[1] = bounds[1].min(y);
            bounds[2] = bounds[2].max(x); bounds[3] = bounds[3].max(y);
        }
    }
    nonempty.then_some(bounds)
}

fn measure(pixels: &RgbaImage, has_alpha: bool) -> ImageInfo {
    let (width, height) = pixels.dimensions();
    let non_empty = alpha_bounds(pixels).is_some();
    let boundary = (0..width).any(|x| pixels.get_pixel(x, 0)[3] > 0 || pixels.get_pixel(x, height - 1)[3] > 0)
        || (0..height).any(|y| pixels.get_pixel(0, y)[3] > 0 || pixels.get_pixel(width - 1, y)[3] > 0);
    let component_diff = |a: &Rgba<u8>, b: &Rgba<u8>| -> f64 {
        let aa = f64::from(a[3]) / 255.0;
        let ba = f64::from(b[3]) / 255.0;
        (0..3).map(|channel| (f64::from(a[channel]) * aa - f64::from(b[channel]) * ba).abs()).sum::<f64>()
            + (f64::from(a[3]) - f64::from(b[3])).abs()
    };
    let mut edge_sum = 0.0;
    for y in 0..height { edge_sum += component_diff(pixels.get_pixel(0, y), pixels.get_pixel(width - 1, y)); }
    for x in 0..width { edge_sum += component_diff(pixels.get_pixel(x, 0), pixels.get_pixel(x, height - 1)); }
    let edge_error = edge_sum / (f64::from(width + height) * 4.0 * 255.0);
    let checks = vec![
        check("IMAGE_DECODE", "pass", "실제 이미지 파일을 디코딩했습니다", None),
        check("IMAGE_RESOLUTION", "pass", "해상도와 디코딩 자원 제한을 확인했습니다", Some(json!(format!("{width}x{height}")))),
        check("ALPHA_CHANNEL", if has_alpha { "pass" } else { "warn" }, if has_alpha { "알파 채널이 있습니다" } else { "알파 채널이 없는 형식입니다" }, Some(json!(has_alpha.to_string()))),
        check("NON_EMPTY", if non_empty { "pass" } else { "fail" }, if non_empty { "보이는 픽셀이 있습니다" } else { "완전히 투명한 빈 이미지입니다" }, Some(json!(non_empty.to_string()))),
        check("CONTENT_AT_BORDER", if boundary { "warn" } else { "pass" }, if boundary { "보이는 픽셀이 이미지 경계에 닿습니다. 스프라이트 잘림과 여백을 검토하세요" } else { "보이는 픽셀이 이미지 경계에 닿지 않습니다" }, None),
        check("TILE_EDGE_DIFFERENCE", if edge_error > EDGE_WARNING_THRESHOLD { "warn" } else { "pass" }, "좌우·상하 경계의 실제 알파 가중 픽셀 차이를 측정했습니다. 경계 일치만으로 내부 반복 패턴까지 보장하지 않습니다", Some(json!(edge_error))),
    ];
    ImageInfo { width, height, has_alpha, non_empty, edge_error, checks }
}

fn check(code: &str, status: &str, message: &str, measured: Option<Value>) -> ValidationCheck {
    ValidationCheck { code: code.to_owned(), status: status.to_owned(), message: message.to_owned(), measured }
}

fn parse_rgb(color: &str) -> Result<[u8; 3]> {
    let hex = color.strip_prefix('#').context("배경색은 #RRGGBB 형식이어야 합니다")?;
    ensure!(hex.len() == 6 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()), "배경색은 #RRGGBB 형식이어야 합니다");
    Ok([u8::from_str_radix(&hex[0..2], 16)?, u8::from_str_radix(&hex[2..4], 16)?, u8::from_str_radix(&hex[4..6], 16)?])
}

fn remove_border_background(pixels: &mut RgbaImage, target: [u8; 3], tolerance: f64) -> u64 {
    let (width, height) = pixels.dimensions();
    let count = u64::from(width) * u64::from(height);
    let mut visited = vec![0_u8; count.div_ceil(8) as usize];
    let mut queue: VecDeque<u32> = VecDeque::new();
    let offer = |x: u32, y: u32, queue: &mut VecDeque<u32>, visited: &mut [u8], pixels: &RgbaImage| {
        let index = y * width + x;
        let byte = index as usize / 8;
        let bit = 1_u8 << (index % 8);
        if visited[byte] & bit != 0 { return; }
        visited[byte] |= bit;
        let pixel = pixels.get_pixel(x, y);
        if pixel[3] == 0 || (0..3).all(|channel| (f64::from(pixel[channel]) - f64::from(target[channel])).abs() <= tolerance) {
            queue.push_back(index);
        }
    };
    for x in 0..width { offer(x, 0, &mut queue, &mut visited, pixels); offer(x, height - 1, &mut queue, &mut visited, pixels); }
    for y in 0..height { offer(0, y, &mut queue, &mut visited, pixels); offer(width - 1, y, &mut queue, &mut visited, pixels); }
    let mut erased = 0_u64;
    while let Some(index) = queue.pop_front() {
        let x = index % width;
        let y = index / width;
        if pixels.get_pixel(x, y)[3] > 0 { erased += 1; }
        pixels.get_pixel_mut(x, y)[3] = 0;
        if x > 0 { offer(x - 1, y, &mut queue, &mut visited, pixels); }
        if x + 1 < width { offer(x + 1, y, &mut queue, &mut visited, pixels); }
        if y > 0 { offer(x, y - 1, &mut queue, &mut visited, pixels); }
        if y + 1 < height { offer(x, y + 1, &mut queue, &mut visited, pixels); }
    }
    erased
}

fn shift_hsv(rgb: [u8; 3], hue_degrees: f64, saturation_factor: f64) -> [u8; 3] {
    let [r, g, b] = rgb.map(|channel| f64::from(channel) / 255.0);
    let maximum = r.max(g).max(b);
    let minimum = r.min(g).min(b);
    let delta = maximum - minimum;
    let hue = if delta == 0.0 { 0.0 } else if maximum == r { ((g - b) / delta).rem_euclid(6.0) } else if maximum == g { (b - r) / delta + 2.0 } else { (r - g) / delta + 4.0 };
    let hue = (hue + hue_degrees / 60.0).rem_euclid(6.0);
    let saturation = if maximum == 0.0 { 0.0 } else { (delta / maximum * saturation_factor).clamp(0.0, 1.0) };
    let chroma = maximum * saturation;
    let second = chroma * (1.0 - ((hue % 2.0) - 1.0).abs());
    let [r, g, b] = match hue.floor() as u8 {
        0 => [chroma, second, 0.0], 1 => [second, chroma, 0.0],
        2 => [0.0, chroma, second], 3 => [0.0, second, chroma],
        4 => [second, 0.0, chroma], _ => [chroma, 0.0, second],
    };
    [r, g, b].map(|value| ((value + maximum - chroma) * 255.0).round().clamp(0.0, 255.0) as u8)
}

fn resize_with_alpha(pixels: &mut RgbaImage, width: u32, height: u32) -> RgbaImage {
    // Interpolate premultiplied RGB to stop hidden colors in transparent pixels
    // bleeding into visible edges. Stored output remains straight alpha.
    for pixel in pixels.pixels_mut() {
        let alpha = u32::from(pixel[3]);
        for channel in 0..3 { pixel[channel] = ((u32::from(pixel[channel]) * alpha + 127) / 255) as u8; }
    }
    let mut resized = imageops::resize(pixels, width, height, FilterType::Lanczos3);
    for pixel in resized.pixels_mut() {
        let alpha = u32::from(pixel[3]);
        for channel in 0..3 {
            pixel[channel] = if alpha == 0 { 0 } else { ((u32::from(pixel[channel]) * 255 + alpha / 2) / alpha).min(255) as u8 };
        }
    }
    resized
}

fn apply_brush(pixels: &mut RgbaImage, original: Option<&RgbaImage>, points: &[[f64; 2]], radius: f64) -> Result<u64> {
    ensure!(!points.is_empty() && points.len() <= MAX_BRUSH_POINTS, "브러시 점 수는 1에서 {MAX_BRUSH_POINTS} 사이여야 합니다");
    ensure!(radius.is_finite() && radius > 0.0 && radius <= f64::from(MAX_EDGE), "브러시 반지름이 허용 범위를 벗어났습니다");
    for point in points {
        ensure!(point.iter().all(|value| value.is_finite() && *value >= -f64::from(MAX_EDGE) && *value <= f64::from(MAX_EDGE) * 2.0), "브러시 좌표가 유효하지 않습니다");
    }
    let segments: Vec<([f64; 2], [f64; 2])> = if points.len() == 1 {
        vec![(points[0], points[0])]
    } else { points.windows(2).map(|pair| (pair[0], pair[1])).collect() };
    let mut total_visits = 0_u64;
    let mut changed = 0_u64;
    let radius_squared = radius * radius;
    // Preflight all bounding boxes before modifying any pixels.
    let mut boxes = Vec::with_capacity(segments.len());
    for (start, end) in &segments {
        let left = (start[0].min(end[0]) - radius).floor().clamp(0.0, f64::from(pixels.width())) as u32;
        let top = (start[1].min(end[1]) - radius).floor().clamp(0.0, f64::from(pixels.height())) as u32;
        let right = (start[0].max(end[0]) + radius).ceil().clamp(0.0, f64::from(pixels.width())) as u32;
        let bottom = (start[1].max(end[1]) + radius).ceil().clamp(0.0, f64::from(pixels.height())) as u32;
        total_visits = total_visits.checked_add(u64::from(right - left) * u64::from(bottom - top)).context("브러시 처리량 계산 오류")?;
        ensure!(total_visits <= MAX_BRUSH_PIXEL_VISITS, "브러시 처리량이 제한을 초과합니다. 짧은 획으로 나누세요");
        boxes.push([left, top, right, bottom]);
    }
    for ((start, end), [left, top, right, bottom]) in segments.iter().zip(boxes) {
        let vx = end[0] - start[0]; let vy = end[1] - start[1];
        let length_squared = vx * vx + vy * vy;
        for y in top..bottom {
            for x in left..right {
                let px = f64::from(x) + 0.5; let py = f64::from(y) + 0.5;
                let projection = if length_squared == 0.0 { 0.0 } else { (((px - start[0]) * vx + (py - start[1]) * vy) / length_squared).clamp(0.0, 1.0) };
                let dx = px - (start[0] + projection * vx);
                let dy = py - (start[1] + projection * vy);
                if dx * dx + dy * dy <= radius_squared {
                    let pixel = pixels.get_pixel_mut(x, y);
                    let next = if let Some(original) = original { *original.get_pixel(x, y) } else { Rgba([pixel[0], pixel[1], pixel[2], 0]) };
                    if *pixel != next { changed += 1; *pixel = next; }
                }
            }
        }
    }
    Ok(changed)
}

fn parse_format(format: &str) -> Result<ImageFormat> {
    match format.to_ascii_lowercase().as_str() {
        "png" => Ok(ImageFormat::Png), "webp" => Ok(ImageFormat::WebP),
        "jpeg" | "jpg" => Ok(ImageFormat::Jpeg),
        _ => bail!("내보내기는 PNG, WebP, JPEG만 지원합니다"),
    }
}

fn require_extension(path: &Path, format: ImageFormat) -> Result<()> {
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let matches = match format {
        ImageFormat::Png => extension == "png", ImageFormat::WebP => extension == "webp",
        ImageFormat::Jpeg => extension == "jpeg" || extension == "jpg", _ => false,
    };
    ensure!(matches, "출력 파일 확장자가 실제 이미지 형식과 일치하지 않습니다");
    Ok(())
}

fn require_new_path(path: &Path) -> Result<()> {
    ensure!(path.file_name().is_some(), "출력 파일명이 필요합니다");
    match fs::symlink_metadata(path) {
        Ok(_) => bail!("출력 경로가 이미 존재합니다. 새 버전 파일명을 사용하세요"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("출력 경로를 검사할 수 없습니다"),
    }
}

fn temporary_output(path: &Path) -> Result<NamedTempFile> {
    require_new_path(path)?;
    let parent = path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).context("이미지 출력 디렉터리를 만들 수 없습니다")?;
    NamedTempFile::new_in(parent).context("이미지 임시 파일을 만들 수 없습니다")
}

fn persist_new(mut temporary: NamedTempFile, path: &Path) -> Result<()> {
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    // persist_noclobber prevents races as well as accidental source overwrite.
    temporary.persist_noclobber(path).map_err(|error| error.error).context("새 출력 파일을 확정할 수 없습니다. 기존 파일은 덮어쓰지 않았습니다")?;
    Ok(())
}

fn save_new_image(path: &Path, pixels: &RgbaImage, format: ImageFormat) -> Result<()> {
    validate_dimensions(pixels.width(), pixels.height())?;
    let mut temporary = temporary_output(path)?;
    match format {
        ImageFormat::Png => PngEncoder::new(temporary.as_file_mut()).write_image(pixels.as_raw(), pixels.width(), pixels.height(), ExtendedColorType::Rgba8)?,
        ImageFormat::WebP => WebPEncoder::new_lossless(temporary.as_file_mut()).write_image(pixels.as_raw(), pixels.width(), pixels.height(), ExtendedColorType::Rgba8)?,
        ImageFormat::Jpeg => {
            let mut rgb = Vec::with_capacity(pixels.as_raw().len() / 4 * 3);
            for pixel in pixels.pixels() {
                let alpha = u32::from(pixel[3]);
                for channel in 0..3 { rgb.push(((u32::from(pixel[channel]) * alpha + 255 * (255 - alpha) + 127) / 255) as u8); }
            }
            JpegEncoder::new_with_quality(temporary.as_file_mut(), 95).encode(&rgb, pixels.width(), pixels.height(), ExtendedColorType::Rgb8)?;
        }
        _ => bail!("지원하지 않는 이미지 출력 형식입니다"),
    }
    ensure!(temporary.as_file().metadata()?.len() <= MAX_FILE_BYTES, "인코딩한 출력이 64 MiB 파일 제한을 초과합니다. 해상도를 낮추세요");
    persist_new(temporary, path)
}

fn write_new_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut temporary = temporary_output(path)?;
    temporary.write_all(bytes)?;
    persist_new(temporary, path)
}
