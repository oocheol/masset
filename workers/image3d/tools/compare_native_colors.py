# SPDX-License-Identifier: MIT
"""Measured source/raw/native-render comparison for the preserved weapon proof."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).absolute().parents[1]
sys.path.insert(0, str(ROOT))
sys.dont_write_bytecode = True
import numpy as np
from PIL import Image
import trimesh
from glb_color import linear_to_srgb, read_color0

OUTPUT = ROOT / "output"
STANDARD = OUTPUT / "native-game-standard-linear-final"
HIGH = OUTPUT / "native-game-high-linear-final"
receipt = json.loads((STANDARD / "generation.json").read_text())
source = Path(receipt["source"]["path"])
assert hashlib.sha256(source.read_bytes()).hexdigest() == receipt["source"]["sha256"]


def image_stats(path):
    with Image.open(path) as image:
        pixels = np.asarray(image.convert("RGBA"))
    visible = pixels[pixels[:, :, 3] >= 128, :3].astype(np.float64) / 255
    return {"path": str(path), "opaquePixelCount": int(len(visible)),
            "sampling": "pixels with alpha >= 128; displayed sRGB, no geometry correspondence implied",
            "meanDisplayedSrgb": visible.mean(0).tolist(), "medianDisplayedSrgb": np.median(visible, axis=0).tolist()}


old_data = (OUTPUT / "native-game-standard/mesh.glb").read_bytes()
new_data = (STANDARD / "mesh.glb").read_bytes()
old_rgb = read_color0(old_data)[0][:, :3]
new_linear = read_color0(new_data)[0][:, :3]
decoded_rgb = linear_to_srgb(new_linear)
old_mesh = trimesh.load(OUTPUT / "native-game-standard/mesh.glb", force="mesh", process=False)
standard_mesh = trimesh.load(STANDARD / "mesh.glb", force="mesh", process=False)
high_mesh = trimesh.load(HIGH / "mesh.glb", force="mesh", process=False)
assert np.array_equal(old_mesh.vertices, standard_mesh.vertices)
assert np.array_equal(old_mesh.faces, standard_mesh.faces)
assert float(np.abs(decoded_rgb-old_rgb).max()) <= .5/255 + 2e-6

report = {"sourcePreserved": True, "sourceSha256": receipt["source"]["sha256"], "source": image_stats(source),
          "standardGeometryIdenticalBeforeAfterColorFix": True,
          "standardQuantizedUpstreamRgbMaxDifference": float(np.abs(decoded_rgb-old_rgb).max()),
          "oldStoredRgbMean": old_rgb.mean(0).tolist(),
          "oldDisplayedSrgbMean": linear_to_srgb(old_rgb).mean(0).tolist(),
          "correctedStoredLinearMean": new_linear.mean(0).tolist(), "correctedDisplayedSrgbMean": decoded_rgb.mean(0).tolist(),
          "standard": {"vertices": len(standard_mesh.vertices), "triangles": len(standard_mesh.faces),
                       "surfaceArea": standard_mesh.area, "signedVolume": standard_mesh.volume},
          "high": {"vertices": len(high_mesh.vertices), "triangles": len(high_mesh.faces),
                   "surfaceArea": high_mesh.area, "signedVolume": high_mesh.volume},
          "triangleCountRatio": len(high_mesh.faces)/len(standard_mesh.faces),
          "nativePreviews": {name: image_stats(OUTPUT / "color-comparison-wide" / (name + ".png"))
                             for name in ("old-standard", "linear-standard", "linear-high")},
          "visualAssessment": "Linear conversion removes the washed-out display. High samples the same soft neural shape more densely; hard edges, holes and fine weapon details remain imperfect. No modern Tripo Studio parity claim.",
          "cameraBasis": receipt["cameraConvention"]}
with (OUTPUT / "native-color-comparison.json").open("x") as handle:
    json.dump(report, handle, indent=2, allow_nan=False)
    handle.write("\n")
print(json.dumps(report, indent=2, allow_nan=False))
