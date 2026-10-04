# SPDX-License-Identifier: GPL-3.0-or-later
"""Independent native recipe/style oracle; never imports production geometry."""
import argparse
import json
import math
from pathlib import Path
import struct
import sys

import bmesh
import bpy


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def linear_color(color):
    channels = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in channels] + [1.0]


def matching_colors(actual, expected):
    return all(any(all(abs(a - b) < 1e-5 for a, b in zip(color, candidate)) for candidate in actual) for color in expected)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--style-file", type=Path, required=True)
    parser.add_argument("--mode", choices=("glb", "blend"), required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    parameters = json.loads(args.input.read_text(encoding="utf-8"))
    style = json.loads(args.style_file.read_text(encoding="utf-8"))
    require(style["approved"] is True and parameters["color"] != style["palette"][0], "Approved palette and distinct primary override")
    expected_colors = [linear_color(color) for color in
                       (parameters["color"], style["palette"][min(1, len(style["palette"]) - 1)],
                        style["palette"][min(2, len(style["palette"]) - 1)])]
    blob = (args.artifact_dir / "model.glb").read_bytes()
    chunk_length, chunk_type = struct.unpack_from("<II", blob, 12)
    require(chunk_type == 0x4E4F534A, "GLB JSON chunk")
    document = json.loads(blob[20:20 + chunk_length])
    require(len(document["meshes"]) == 1 and len(document["materials"]) == 3, "Exactly one exported asset mesh and three materials")
    exported_colors = [entry["pbrMetallicRoughness"]["baseColorFactor"] for entry in document["materials"]]
    require(matching_colors(exported_colors, expected_colors), "Actual GLB palette and primary override")
    if args.mode == "blend":
        bpy.ops.wm.open_mainfile(filepath=str(args.artifact_dir / "source.blend"), use_scripts=False)
        require(bpy.context.scene.unit_settings.system == "METRIC", "Native source metric units")
        require(bpy.context.scene.unit_settings.scale_length == 1, "Native source meter scale")
        scene = bpy.context.scene
        require(scene.camera.data.type == "ORTHO" and scene["assetStudioCameraPreset"] == style["camera"], "Actual approved camera")
        lights = [obj for obj in scene.objects if obj.type == "LIGHT"]
        require(len(lights) == 3 and all(obj.data.type == "AREA" for obj in lights), "Actual soft studio lights")
    else:
        bpy.ops.object.select_all(action="SELECT")
        bpy.ops.object.delete(use_global=False)
        bpy.ops.import_scene.gltf(filepath=str(args.artifact_dir / "model.glb"))
        require(all(obj.type == "MESH" for obj in bpy.context.scene.objects), "GLB excludes studio camera/lights/floor")
    require(not bpy.context.preferences.filepaths.use_scripts_auto_execute, "Script auto-execution disabled")
    require(not bpy.data.texts, "No embedded scripts")
    models = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.get("assetStudioModel")]
    require(len(models) == 1, "Exactly one tagged asset mesh")
    model = models[0]
    require(model.name == parameters["name"] and model["assetStudioTemplate"] == parameters["template"], "Preserved asset name and template")
    require(model["assetStudioRecipe"] == "fixed-game-geometry-v1", "Fixed recipe provenance survives round-trip")
    features = json.loads(model["assetStudioFeatures"])
    require(features and all(parameters["template"].lower() in name.lower() for name in features), "Semantic feature names")
    points = [model.matrix_world @ vertex.co for vertex in model.data.vertices]
    require(points and all(math.isfinite(c) for point in points for c in point), "Finite actual 3D vertices")
    mins = [min(point[i] for point in points) for i in range(3)]
    maxs = [max(point[i] for point in points) for i in range(3)]
    dimensions = [maxs[i] - mins[i] for i in range(3)]
    expected = [parameters[key] for key in ("width", "depth", "height")]
    tolerance = max(expected) * 2e-5
    require(all(abs(a - b) <= tolerance for a, b in zip(dimensions, expected)), "Actual reopened canonical meter box")
    require(abs(mins[2]) <= tolerance and all(abs(mins[i] + maxs[i]) <= tolerance for i in (0, 1)), "Bottom-center pivot")
    require(not model.modifiers, "Baked editable mesh")
    model.data.calc_loop_triangles()
    triangles = len(model.data.loop_triangles)
    require(12 < triangles <= 10000, "Actual triangle ceiling")
    source_colors = [list(mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value) for mat in model.data.materials]
    require(matching_colors(source_colors, expected_colors), "Actual reopened palette and primary override")
    require(model.data.uv_layers and len(model.data.uv_layers.active.data) == len(model.data.loops), "Actual UVs")
    require(all(math.isfinite(c) for normal in model.data.corner_normals for c in normal.vector), "Actual finite normals")
    bm = bmesh.new()
    bm.from_mesh(model.data)
    # glTF duplicates positions at UV/normal/material seams. Weld only the QA
    # in-memory copy; source and exported originals are never rewritten.
    if args.mode == "glb":
        bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=min(expected) * 1e-6)
    open_edges = sum(not edge.is_manifold for edge in bm.edges)
    zero_area_faces = sum(face.calc_area() <= 0 for face in bm.faces)
    vertices_after_seam_weld = len(bm.verts)
    require(open_edges == 0 and zero_area_faces == 0,
            f"Closed components after round-trip: openEdges={open_edges}, zeroAreaFaces={zero_area_faces}, "
            f"verticesAfterSeamWeld={vertices_after_seam_weld}")
    bm.free()
    result = {"valid": True, "mode": args.mode, "blenderVersion": bpy.app.version_string,
              "template": parameters["template"], "name": model.name, "features": features,
              "vertices": len(model.data.vertices), "verticesAfterSeamWeld": vertices_after_seam_weld,
              "triangles": triangles, "materials": len(model.data.materials), "dimensionsMetersZUp": dimensions,
              "boundsMin": mins, "boundsMax": maxs, "openEdges": open_edges, "zeroAreaFaces": zero_area_faces,
              "sourceColorsLinear": source_colors, "exportedColorsLinear": exported_colors,
              "paletteVerified": True, "scriptAutoExecution": False, "embeddedScripts": 0}
    target = args.artifact_dir / f"game-verification-{args.mode}.json"
    with target.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"type": "game-roundtrip", **result}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"type": "game-roundtrip-failed", "error": str(exc)}), flush=True)
        raise SystemExit(1) from exc
