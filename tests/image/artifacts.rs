use asset_image_pipeline::{convert, derive_normal, inspect, pack_atlas, process, process_with_original, split_sheet, MAX_FILE_BYTES};
use image::{Rgba, RgbaImage};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

fn fixture(directory: &Path, name: &str, pixels: &RgbaImage) -> PathBuf {
    let path = directory.join(name);
    pixels.save(&path).expect("write a local test fixture");
    path
}

fn read(path: &Path) -> RgbaImage {
    image::open(path).expect("independently decode an output artifact").into_rgba8()
}

fn check_status(info: &asset_image_pipeline::ImageInfo, code: &str) -> String {
    info.checks.iter().find(|check| check.code == code).expect("named validation check").status.clone()
}

#[test]
fn inspect_uses_real_alpha_pixels_and_measured_seams() {
    let directory = TempDir::new().unwrap();
    let mut transparent = RgbaImage::from_pixel(3, 2, Rgba([200, 50, 20, 0]));
    transparent.put_pixel(2, 0, Rgba([0, 200, 255, 0]));
    let empty = inspect(&fixture(directory.path(), "empty.png", &transparent)).unwrap();
    assert!(!empty.non_empty);
    assert!(empty.has_alpha);
    assert_eq!(empty.edge_error, 0.0, "invisible RGB does not create a seam");
    assert_eq!(check_status(&empty, "NON_EMPTY"), "fail");

    let solid = RgbaImage::from_pixel(8, 8, Rgba([255, 255, 255, 255]));
    let info = inspect(&fixture(directory.path(), "solid.png", &solid)).unwrap();
    assert!(info.non_empty);
    assert_eq!(info.edge_error, 0.0);
    assert_eq!(check_status(&info, "CONTENT_AT_BORDER"), "warn");

    let mut seam = RgbaImage::from_pixel(8, 8, Rgba([0, 0, 0, 255]));
    for y in 0..8 { seam.put_pixel(7, y, Rgba([255, 255, 255, 255])); }
    let info = inspect(&fixture(directory.path(), "seam.png", &seam)).unwrap();
    assert!((info.edge_error - 0.375).abs() < 1e-9);
    assert_eq!(check_status(&info, "TILE_EDGE_DIFFERENCE"), "warn");
}

#[test]
fn nearest_neighbor_preserves_pixel_art_and_original_bytes() {
    let directory = TempDir::new().unwrap();
    let mut pixels = RgbaImage::new(2, 2);
    pixels.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
    pixels.put_pixel(1, 0, Rgba([0, 255, 0, 128]));
    pixels.put_pixel(0, 1, Rgba([0, 0, 255, 0]));
    pixels.put_pixel(1, 1, Rgba([255, 255, 255, 255]));
    let input = fixture(directory.path(), "입력 그림.png", &pixels);
    let before = fs::read(&input).unwrap();
    let output = directory.path().join("출력 그림 v2.PNG");
    let info = process(&input, &output, &json!({"type":"resize","width":4,"height":4,"pixelArt":true})).unwrap();
    assert_eq!((info.width, info.height), (4, 4));
    let actual = read(&output);
    for y in 0..4 { for x in 0..4 { assert_eq!(actual.get_pixel(x, y), pixels.get_pixel(x / 2, y / 2)); } }
    assert_eq!(before, fs::read(&input).unwrap());
    let existing = fs::read(&output).unwrap();
    assert!(process(&input, &output, &json!({"type":"trim","padding":0})).is_err());
    assert_eq!(existing, fs::read(&output).unwrap(), "output collision cannot replace a version");
    assert!(process(&input, &input, &json!({"type":"trim","padding":0})).is_err());
    assert_eq!(before, fs::read(&input).unwrap(), "source overwrite is forbidden");
}

#[test]
fn lanczos_interpolates_alpha_without_invisible_color_bleed() {
    let directory = TempDir::new().unwrap();
    let mut pixels = RgbaImage::new(2, 1);
    pixels.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
    pixels.put_pixel(1, 0, Rgba([0, 0, 255, 0]));
    let input = fixture(directory.path(), "hidden-blue.png", &pixels);
    let output = directory.path().join("filtered.png");
    process(&input, &output, &json!({"type":"resize","width":16,"height":2,"pixelArt":false})).unwrap();
    for pixel in read(&output).pixels() {
        if pixel[3] > 0 { assert_eq!(pixel[2], 0); assert_eq!(pixel[1], 0); }
    }
}

#[test]
fn crop_clamps_bounds_and_trim_uses_visible_alpha_bounds() {
    let directory = TempDir::new().unwrap();
    let mut pixels = RgbaImage::new(10, 8);
    for y in 2..5 { for x in 3..7 { pixels.put_pixel(x, y, Rgba([10, 50, 80, 150])); } }
    let input = fixture(directory.path(), "trim-source.png", &pixels);
    let output = directory.path().join("trimmed.png");
    let info = process(&input, &output, &json!({"type":"trim","padding":2})).unwrap();
    assert_eq!((info.width, info.height), (8, 7));
    let actual = read(&output);
    assert_eq!(actual.get_pixel(2, 2), pixels.get_pixel(3, 2));
    assert_eq!(actual.get_pixel(0, 0)[3], 0);
    assert_eq!(check_status(&info, "CONTENT_AT_BORDER"), "pass");

    let crop = directory.path().join("cropped.png");
    let info = process(&input, &crop, &json!({"type":"crop","x":8,"y":6,"width":8,"height":8})).unwrap();
    assert_eq!((info.width, info.height), (2, 2));
    assert_eq!(check_status(&info, "CROP_CLAMPED"), "warn");
    assert!(!info.non_empty);
    assert!(process(&input, &directory.path().join("outside.png"), &json!({"type":"crop","x":10,"y":0,"width":2,"height":2})).is_err());

    let empty = fixture(directory.path(), "all-transparent.png", &RgbaImage::new(4, 4));
    let failed = directory.path().join("cannot-trim.png");
    assert!(process(&empty, &failed, &json!({"type":"trim","padding":0})).is_err());
    assert!(!failed.exists());
}

#[test]
fn color_shift_preserves_alpha_and_uses_hue_degrees() {
    let directory = TempDir::new().unwrap();
    let pixels = RgbaImage::from_pixel(2, 2, Rgba([255, 0, 0, 77]));
    let input = fixture(directory.path(), "red.png", &pixels);
    let output = directory.path().join("green.png");
    process(&input, &output, &json!({"type":"color","hue":120,"saturation":1})).unwrap();
    assert_eq!(*read(&output).get_pixel(0, 0), Rgba([0, 255, 0, 77]));
}

#[test]
fn background_removal_keeps_enclosed_same_color_pixels() {
    let directory = TempDir::new().unwrap();
    let mut pixels = RgbaImage::from_pixel(7, 7, Rgba([255, 255, 255, 255]));
    for x in 1..6 { pixels.put_pixel(x, 1, Rgba([10, 10, 10, 255])); pixels.put_pixel(x, 5, Rgba([10, 10, 10, 255])); }
    for y in 1..6 { pixels.put_pixel(1, y, Rgba([10, 10, 10, 255])); pixels.put_pixel(5, y, Rgba([10, 10, 10, 255])); }
    pixels.put_pixel(0, 3, Rgba([252, 254, 255, 255]));
    let input = fixture(directory.path(), "background.png", &pixels);
    let output = directory.path().join("removed.png");
    let info = process(&input, &output, &json!({"type":"background","color":"#ffffff","tolerance":3})).unwrap();
    let actual = read(&output);
    assert_eq!(actual.get_pixel(0, 0)[3], 0);
    assert_eq!(actual.get_pixel(0, 3)[3], 0);
    assert_eq!(actual.get_pixel(3, 3)[3], 255, "enclosed white interior is not a border-connected background");
    assert_eq!(actual.get_pixel(1, 1), pixels.get_pixel(1, 1));
    assert_eq!(check_status(&info, "BACKGROUND_COLOR_KEY"), "warn");
}

#[test]
fn manual_brush_connects_points_and_restores_preserved_original_pixels() {
    let directory = TempDir::new().unwrap();
    let pixels = RgbaImage::from_fn(12, 8, |x, y| Rgba([(x * 10) as u8, (y * 10) as u8, 25, 153]));
    let original = fixture(directory.path(), "original.png", &pixels);
    let erased = directory.path().join("erased.png");
    let erase = json!({"type":"mask","points":[[2.5,3.5],[9.5,3.5]],"radius":1,"mode":"erase"});
    process(&original, &erased, &erase).unwrap();
    let actual = read(&erased);
    for x in 2..10 { assert_eq!(actual.get_pixel(x, 3)[3], 0, "continuous stroke must fill between samples"); }
    assert_eq!(actual.get_pixel(0, 0), pixels.get_pixel(0, 0));
    let restored = directory.path().join("restored.png");
    let restore = json!({"type":"mask","points":[[2.5,3.5],[9.5,3.5]],"radius":1,"mode":"restore"});
    assert!(process(&erased, &restored, &restore).is_err(), "restore cannot invent an original");
    process_with_original(&erased, &original, &restored, &restore).unwrap();
    assert_eq!(read(&restored), pixels);

    let smaller = fixture(directory.path(), "smaller.png", &RgbaImage::new(2, 2));
    assert!(process_with_original(&erased, &smaller, &directory.path().join("bad-restore.png"), &restore).is_err());
    assert_eq!(read(&original), pixels);
}

#[test]
fn atlas_json_coordinates_match_exact_source_pixels_without_overlap() {
    let directory = TempDir::new().unwrap();
    let sources = [
        RgbaImage::from_fn(3, 2, |x, y| Rgba([200, x as u8, y as u8, 123])),
        RgbaImage::from_pixel(4, 3, Rgba([0, 200, 0, 255])),
        RgbaImage::from_pixel(3, 4, Rgba([0, 0, 200, 200])),
    ];
    let paths = sources.iter().enumerate().map(|(index, source)| fixture(directory.path(), &format!("sprite-{index}.png"), source)).collect::<Vec<_>>();
    let output = directory.path().join("아틀라스.png");
    let packed = pack_atlas(&paths, &output, 12, 12, 1).unwrap();
    let actual = read(&output);
    assert_eq!(actual.dimensions(), (12, 12));
    let metadata: Value = serde_json::from_slice(&fs::read(&packed.metadata_path).unwrap()).unwrap();
    assert_eq!(metadata["image"], "아틀라스.png");
    assert_eq!(metadata["premultipliedAlpha"], false);
    assert_eq!(metadata["frames"].as_array().unwrap().len(), sources.len());
    let mut occupied = vec![false; 144];
    for (index, frame) in packed.frames.iter().enumerate() {
        assert_eq!(frame.width, sources[index].width());
        assert_eq!(frame.height, sources[index].height());
        assert_eq!(frame.pivot, [0.5, 0.5]);
        assert_eq!(metadata["frames"][index]["x"], frame.x);
        assert_eq!(metadata["frames"][index]["y"], frame.y);
        for y in 0..frame.height {
            for x in 0..frame.width {
                let offset = ((frame.y + y) * 12 + frame.x + x) as usize;
                assert!(!occupied[offset]); occupied[offset] = true;
                assert_eq!(actual.get_pixel(frame.x + x, frame.y + y), sources[index].get_pixel(x, y));
            }
        }
    }
    for (index, pixel) in actual.pixels().enumerate() { if !occupied[index] { assert_eq!(pixel[3], 0); } }
    assert!(pack_atlas(&paths, &directory.path().join("overflow.png"), 4, 4, 1).is_err());
    assert!(!directory.path().join("overflow.png").exists());
}

#[test]
fn atlas_collisions_preserve_files_and_same_basename_versions_are_distinct() {
    let directory = TempDir::new().unwrap();
    let pixel = RgbaImage::from_pixel(2, 2, Rgba([5, 10, 20, 255]));
    let source = fixture(directory.path(), "source.png", &pixel);
    let output = directory.path().join("collision.png");
    let metadata = directory.path().join("collision.json");
    fs::write(&metadata, b"user metadata").unwrap();
    assert!(pack_atlas(&[source.clone()], &output, 8, 8, 1).is_err());
    assert_eq!(fs::read(metadata).unwrap(), b"user metadata");
    assert!(!output.exists());
    let second_directory = directory.path().join("other"); fs::create_dir(&second_directory).unwrap();
    let same_basename = fixture(&second_directory, "source.png", &pixel);
    let packed = pack_atlas(&[source.clone(), same_basename], &directory.path().join("same-names.png"), 12, 12, 1).unwrap();
    assert_eq!(packed.frames.len(), 2);
    assert_ne!(packed.frames[0].file, packed.frames[1].file);
    assert!(Path::new(&packed.frames[0].file).is_absolute());
    assert!(pack_atlas(&[source.clone(), source], &directory.path().join("duplicates.png"), 12, 12, 1).is_err());
}

#[test]
fn sheet_split_is_row_major_and_rejects_partial_frames_without_writes() {
    let directory = TempDir::new().unwrap();
    let sheet = RgbaImage::from_fn(6, 4, |x, y| Rgba([x as u8, y as u8, 90, (x * 30 + y * 10) as u8]));
    let source = fixture(directory.path(), "sheet.png", &sheet);
    let output = directory.path().join("한글 분할 폴더");
    let frames = split_sheet(&source, &output, 3, 2).unwrap();
    assert_eq!(frames.len(), 4);
    for (index, path) in frames.iter().enumerate() {
        let frame = read(path);
        assert_eq!(frame.dimensions(), (3, 2));
        for y in 0..2 { for x in 0..3 { assert_eq!(frame.get_pixel(x, y), sheet.get_pixel((index as u32 % 2) * 3 + x, (index as u32 / 2) * 2 + y)); } }
    }
    let invalid = directory.path().join("partial");
    assert!(split_sheet(&source, &invalid, 4, 3).is_err());
    assert!(!invalid.exists());
    let before = fs::read(&frames[0]).unwrap();
    assert!(split_sheet(&source, &output, 3, 2).is_err());
    assert_eq!(before, fs::read(&frames[0]).unwrap());
}

#[test]
fn png_webp_and_jpeg_are_actual_decodable_formats() {
    let directory = TempDir::new().unwrap();
    let pixels = RgbaImage::from_pixel(16, 16, Rgba([250, 20, 40, 0]));
    let source = fixture(directory.path(), "transparent.png", &pixels);
    for format in ["png", "webp"] {
        let path = directory.path().join(format!("converted.{format}"));
        let info = convert(&source, &path, format).unwrap();
        assert!(info.has_alpha); assert!(!info.non_empty);
        assert_eq!(read(&path), pixels, "lossless output retains actual RGBA");
    }
    let jpeg = directory.path().join("white.jpg");
    let info = convert(&source, &jpeg, "jpeg").unwrap();
    assert!(!info.has_alpha); assert!(info.non_empty);
    assert_eq!(check_status(&info, "JPEG_ALPHA_COMPOSITE"), "warn");
    for pixel in read(&jpeg).pixels() {
        assert!(pixel[0] >= 253 && pixel[1] >= 253 && pixel[2] >= 253);
        assert_eq!(pixel[3], 255);
    }
    assert!(convert(&source, &directory.path().join("pretend.svg"), "svg").is_err());
    assert!(convert(&source, &directory.path().join("wrong.jpg"), "png").is_err());
}

#[test]
fn jpeg_exif_orientation_aligns_dimensions_and_processing_pixels() {
    let directory = TempDir::new().unwrap();
    let png = fixture(directory.path(), "raw-source.png", &RgbaImage::from_fn(12, 8, |x, y| Rgba([(x * 16) as u8, (y * 24) as u8, 40, 255])));
    let raw_jpeg = directory.path().join("raw.jpg");
    convert(&png, &raw_jpeg, "jpeg").unwrap();
    let raw_pixels = read(&raw_jpeg);
    let mut payload = b"Exif\0\0II\x2a\0\x08\0\0\0".to_vec();
    payload.extend_from_slice(&[1, 0]); // one TIFF IFD entry
    payload.extend_from_slice(&[0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0]); // orientation 6
    payload.extend_from_slice(&[0, 0, 0, 0]);
    let original_bytes = fs::read(&raw_jpeg).unwrap();
    let mut oriented_bytes = original_bytes[..2].to_vec();
    oriented_bytes.extend_from_slice(&[0xff, 0xe1]);
    oriented_bytes.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    oriented_bytes.extend_from_slice(&payload);
    oriented_bytes.extend_from_slice(&original_bytes[2..]);
    let source = directory.path().join("orientation-6.jpg");
    fs::write(&source, &oriented_bytes).unwrap();
    let info = inspect(&source).unwrap();
    assert_eq!((info.width, info.height), (8, 12));
    assert_eq!(check_status(&info, "EXIF_ORIENTATION"), "pass");
    let normalized = directory.path().join("normalized.png");
    convert(&source, &normalized, "png").unwrap();
    assert_eq!(read(&normalized), image::imageops::rotate90(&raw_pixels));
    assert_eq!(fs::read(source).unwrap(), oriented_bytes);
}

#[test]
fn normal_maps_declare_heuristic_and_convention_and_preserve_alpha() {
    let directory = TempDir::new().unwrap();
    let pixels = RgbaImage::from_fn(4, 4, |_, y| Rgba([(y * 50) as u8, (y * 50) as u8, (y * 50) as u8, 100]));
    let source = fixture(directory.path(), "height.png", &pixels);
    let gl = directory.path().join("normal-gl.png"); let dx = directory.path().join("normal-dx.png");
    let info = derive_normal(&source, &gl, 2.0, false).unwrap();
    derive_normal(&source, &dx, 2.0, true).unwrap();
    assert_eq!(check_status(&info, "HEURISTIC_NORMAL"), "warn");
    let gl_pixels = read(&gl); let dx_pixels = read(&dx);
    for (opengl, directx) in gl_pixels.pixels().zip(dx_pixels.pixels()) {
        assert_eq!(opengl[0], directx[0]); assert_eq!(opengl[2], directx[2]);
        assert!((i16::from(opengl[1]) + i16::from(directx[1]) - 255).abs() <= 1);
        assert_eq!(opengl[3], 100); assert_eq!(directx[3], 100);
    }
    let flat_source = fixture(directory.path(), "flat.png", &RgbaImage::from_pixel(2, 2, Rgba([80, 80, 80, 255])));
    let flat = directory.path().join("normal-flat.png");
    derive_normal(&flat_source, &flat, 2.0, false).unwrap();
    assert_eq!(*read(&flat).get_pixel(0, 0), Rgba([128, 128, 255, 255]));
}

#[test]
fn invalid_untrusted_inputs_and_excessive_allocations_are_rejected() {
    let directory = TempDir::new().unwrap();
    let bad = directory.path().join("not-a-real.png"); fs::write(&bad, b"<svg><script>alert(1)</script></svg>").unwrap();
    assert!(inspect(&bad).is_err());
    let oversized = directory.path().join("oversized.png");
    let file = fs::File::create(&oversized).unwrap(); file.set_len(MAX_FILE_BYTES + 1).unwrap();
    assert!(inspect(&oversized).is_err());
    let source = fixture(directory.path(), "small.png", &RgbaImage::from_pixel(1, 1, Rgba([1, 2, 3, 255])));
    for (index, operation) in [
        json!({"type":"resize","width":8193,"height":1,"pixelArt":true}),
        json!({"type":"resize","width":8192,"height":8192,"pixelArt":true}),
        json!({"type":"resize","width":0,"height":1,"pixelArt":true}),
        json!({"type":"background","color":"#GGGGGG","tolerance":2}),
        json!({"type":"background","color":"#ffffff","tolerance":-1}),
        json!({"type":"color","hue":0,"saturation":5}),
        json!({"type":"mask","points":[],"radius":5,"mode":"erase"}),
        json!({"type":"mask","points":[[0,0]],"radius":-1,"mode":"erase"}),
        json!({"type":"resize","width":2,"height":2,"pixelArt":true,"execute":"evil"}),
    ].iter().enumerate() {
        let output = directory.path().join(format!("rejected-{index}.png"));
        assert!(process(&source, &output, operation).is_err()); assert!(!output.exists());
    }
}

#[test]
fn serialization_matches_shared_camel_case_contract() {
    let directory = TempDir::new().unwrap();
    let source = fixture(directory.path(), "contract.png", &RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 255])));
    let serialized = serde_json::to_value(inspect(&source).unwrap()).unwrap();
    assert!(serialized.get("hasAlpha").is_some());
    assert!(serialized.get("nonEmpty").is_some());
    assert!(serialized.get("edgeError").is_some());
    assert!(serialized.get("has_alpha").is_none());
    for check in serialized["checks"].as_array().unwrap() {
        if let Some(measured) = check.get("measured") { assert!(measured.is_string() || measured.is_number()); }
    }
}
