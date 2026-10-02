# Local raster pipeline

This Rust crate processes actual PNG, WebP, and JPEG files. It has no network,
AI provider, script execution, or paid API dependency. Imported files are read
only; every output must use a new filename. Outputs are encoded in a temporary
file in the destination directory, flushed, synchronized, then persisted with
`persist_noclobber`. Existing outputs, including symlinks, are rejected.

The public API is `inspect`, `process`, `process_with_original`, `pack_atlas`,
`split_sheet`, `convert`, and `derive_normal`. Result structs serialize with
camelCase names. `process` accepts the shared `ImageOperation` JSON contract.
Hue uses degrees, saturation is a multiplier with `1` preserving saturation,
and color-key tolerance uses a per-channel 8-bit difference from `0` to `255`.

Pixel art uses nearest-neighbor interpolation. Ordinary resizing uses Lanczos3
with premultiplied RGB during filtering to avoid invisible-color halos; files
retain straight alpha. Background removal is a deterministic, border-connected
RGB color key, not semantic foreground segmentation. Brush strokes are joined
segments with a hard circular radius in image coordinates. Erase preserves RGB
and sets alpha to zero. Restore copies the exact preserved original RGBA pixels
using `process_with_original`; mismatched original dimensions are rejected.

Decoding applies supported EXIF display orientation in memory so imported
JPEG display dimensions and brush/crop coordinates agree; originals remain
byte-for-byte unchanged. New encoded versions store the oriented pixels.

The module checks input magic bytes, encoded file size (64 MiB), dimensions
(each edge at most 8192), pixel count (64 million), and decoder allocation.
Output dimensions and brush work are bounded before allocation or mutation.
Sheet frame dimensions must divide the whole sheet exactly. Frames are emitted
in row-major order. Atlas packing preserves caller input order and RGBA pixels,
rejects overflow and duplicate canonical input paths ignoring case, and records
unrotated pixel coordinates, center pivots, padding, and straight-alpha metadata.
Different version directories can contain the same basename. Standalone atlas
metadata identifies frames by full canonical input path; the desktop exporter
rewrites these references to project-relative artifact paths.

Validation decodes actual written files and measures nonempty alpha content,
visible boundary contact, and opposite-edge RGBA differences. Invisible RGB is
excluded from the edge measurement. A low edge difference is only a boundary
check; it does not prove natural repetition or visual quality. JPEG explicitly
composites over white. Heuristic normal maps treat luminance as an assumed
height field and declare that they do not recover physical material properties.

Artifact tests live in `tests/image/artifacts.rs` and compare redecoded pixels,
atlas JSON coordinates, alpha, Unicode paths, format content, no-overwrite
behavior, mask restoration, sheet order, and resource rejection. Run from the
workspace root with `cargo test -p asset-image-pipeline`. The inputs in these
tests are generated local fixtures, not proof of an image generation provider.

To retain example files for independent inspection, use a new output folder:
`cargo run -p asset-image-pipeline --example artifact_fixture -- tests/image/artifact-example`.
It writes four procedural fixture PNGs, new trimmed/resized versions, an atlas
and JSON, split frames, WebP, JPEG, a heuristic normal map, and a decoding report.
An existing destination is rejected. This fixture never claims provider success.
