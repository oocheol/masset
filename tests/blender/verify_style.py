# SPDX-License-Identifier: GPL-3.0-or-later
"""Independent fresh Blender inspection of applied style in source and exported GLB."""
import argparse
import json
import math
from pathlib import Path
import struct
import sys

import bpy
from mathutils import Vector


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def linear_color(color):
    srgb = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb] + [1.0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--style-file", type=Path, required=True)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    params = json.loads(args.input.read_text(encoding="utf-8-sig"))
    style = json.loads(args.style_file.read_text(encoding="utf-8-sig"))
    require(params["color"] != style["palette"][0], "Fixture must prove override with distinct primary palette color")
    report = json.loads((args.artifact_dir / "validation.json").read_text(encoding="utf-8"))
    metadata = report["styleGuide"]
    require(metadata["requested"] == style and metadata["identityGuarantee"] is False, "Requested style and honest identity limits")
    require(metadata["referenceAssetIds"] == style["referenceAssetIds"], "Reference id provenance")
    require({entry["field"] for entry in metadata["notApplied"]} == {"lineWeight", "detail", "margin"}, "Explicit unsupported style fields")
    bpy.ops.wm.open_mainfile(filepath=str(args.artifact_dir / "source.blend"), use_scripts=False)
    scene = bpy.context.scene
    model = next(obj for obj in scene.objects if obj.type == "MESH" and obj.get("assetStudioModel"))
    require(model["assetStudioStyleId"] == style["id"] and model["assetStudioStyleName"] == style["name"], "Style model provenance")
    require(json.loads(model["assetStudioReferenceAssetIds"]) == style["referenceAssetIds"], "No reference file path substitution")
    camera = scene.camera
    require(camera.data.type == "ORTHO", "Actual orthographic camera")
    require(style["camera"] == "orthographic front" and scene["assetStudioCameraPreset"] == "orthographic front", "Front test preset")
    size = max(params[k] for k in ("width", "depth", "height"))
    wanted_location = (0, -size * 3.4, params["height"] / 2)
    require(all(abs(a - b) < 0.0001 for a, b in zip(camera.location, wanted_location)), "Actual front camera location")
    wanted_direction = (Vector((0, 0, params["height"] / 2)) - camera.location).normalized()
    actual_direction = camera.matrix_world.to_quaternion() @ Vector((0, 0, -1))
    require(actual_direction.dot(wanted_direction) > 0.99999, "Actual camera orientation")
    lights = [obj for obj in scene.objects if obj.type == "LIGHT"]
    require(len(lights) == 3 and all(obj.data.type == "AREA" for obj in lights), "Actual soft-studio area lights")
    require(scene["assetStudioLightingPreset"] == "soft studio", "Actual lighting preset")
    energies = {obj.name: obj.data.energy for obj in lights}
    for name, watts in (("Key", 850), ("Fill", 500), ("Rim", 750)):
        require(abs(energies[name] - watts * size * size) < 0.001, "Actual scene-scale light energy")
    colors = [params["color"], style["palette"][1], style["palette"][2]]
    wanted_colors = [linear_color(color) for color in colors]
    source_colors = [list(mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value) for mat in model.data.materials]
    for color in wanted_colors:
        require(any(all(abs(a - b) < 0.00001 for a, b in zip(color, actual)) for actual in source_colors), "Actual source palette and explicit primary color")
    blob = (args.artifact_dir / "model.glb").read_bytes()
    chunk_length, chunk_type = struct.unpack_from("<II", blob, 12)
    require(chunk_type == 0x4E4F534A, "GLB JSON chunk")
    gltf = json.loads(blob[20:20 + chunk_length])
    exported_colors = [mat["pbrMetallicRoughness"]["baseColorFactor"] for mat in gltf["materials"]]
    for color in wanted_colors:
        require(any(all(abs(a - b) < 0.00001 for a, b in zip(color, actual)) for actual in exported_colors), "Actual exported palette and primary override")
    require(not len(bpy.data.texts), "No embedded scripts")
    require(report["mesh"]["triangles"] == 1620, "Unchanged crate geometry")
    result = {"valid": True, "styleId": style["id"], "camera": "orthographic front", "lighting": "soft studio",
              "paletteApplied": True, "primaryColorExplicitOverride": True, "referenceIdsProvenanceOnly": True,
              "sourceAndGlbMaterialsVerified": True, "triangles": report["mesh"]["triangles"], "blenderVersion": bpy.app.version_string}
    path = args.artifact_dir / "style-verification.json"
    require(not path.exists(), "Preserve existing verification")
    path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"type": "style-verification-failed", "error": str(exc)}), flush=True)
        raise SystemExit(1) from exc
