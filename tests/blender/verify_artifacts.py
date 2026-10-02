# SPDX-License-Identifier: GPL-3.0-or-later
"""Fresh-process round-trip oracle; deliberately independent of worker geometry code."""
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


def glb_binary_validation(path):
    blob = path.read_bytes()
    magic, version, length = struct.unpack_from("<4sII", blob)
    require(magic == b"glTF" and version == 2 and length == len(blob), "GLB header")
    cursor = 12
    binary = None
    document = None
    while cursor < len(blob):
        chunk_length, chunk_type = struct.unpack_from("<II", blob, cursor)
        require(cursor + 8 + chunk_length <= len(blob), "GLB chunk bounds")
        chunk = blob[cursor + 8:cursor + 8 + chunk_length]
        if chunk_type == 0x4E4F534A:
            document = json.loads(chunk)
        elif chunk_type == 0x004E4942:
            binary = chunk
        cursor += 8 + chunk_length
    require(document is not None and binary is not None, "GLB JSON and BIN chunks")
    require(not any(buffer.get("uri") for buffer in document["buffers"]), "No external buffers")
    require(not any(image.get("uri") for image in document.get("images", [])), "No external texture references")

    def values(index):
        accessor = document["accessors"][index]
        view = document["bufferViews"][accessor["bufferView"]]
        sizes = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
        codes = {5123: "H", 5125: "I", 5126: "f"}
        count = sizes[accessor["type"]]
        fmt = "<" + codes[accessor["componentType"]] * count
        item_bytes = struct.calcsize(fmt)
        stride = view.get("byteStride", item_bytes)
        start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        require(start + (accessor["count"] - 1) * stride + item_bytes <= len(binary), "Accessor bounds")
        return [struct.unpack_from(fmt, binary, start + i * stride) for i in range(accessor["count"])]

    positions = []
    triangles = 0
    for mesh in document["meshes"]:
        for primitive in mesh["primitives"]:
            attrs = primitive["attributes"]
            require({"POSITION", "NORMAL", "TEXCOORD_0"}.issubset(attrs), "Position, normal, UV attributes")
            require(0 <= primitive["material"] < len(document["materials"]), "Material reference")
            pos = values(attrs["POSITION"])
            normals = values(attrs["NORMAL"])
            uvs = values(attrs["TEXCOORD_0"])
            indices = values(primitive["indices"])
            require(len(pos) == len(normals) == len(uvs), "Equal vertex attribute counts")
            require(all(all(math.isfinite(v) for v in xyz) for xyz in pos + normals + uvs), "Finite attributes")
            require(all(abs(sum(c * c for c in n) - 1) < 0.002 for n in normals), "Unit normals")
            require(all(-0.002 <= c <= 1.002 for uv in uvs for c in uv), "Normalized UV range")
            require(len(indices) % 3 == 0 and all(0 <= i[0] < len(pos) for i in indices), "Triangle indices")
            triangles += len(indices) // 3
            positions.extend(pos)
    require(positions and triangles > 12, "Actual modeled geometry")
    mins = [min(v[i] for v in positions) for i in range(3)]
    maxs = [max(v[i] for v in positions) for i in range(3)]
    return {"vertices": len(positions), "triangles": triangles, "boundsMin": mins, "boundsMax": maxs,
            "dimensions": [maxs[i] - mins[i] for i in range(3)], "materials": len(document["materials"])}


def inspect_scene(parameters):
    models = [obj for obj in bpy.data.objects if obj.type == "MESH" and obj.get("assetStudioModel")]
    require(len(models) == 1, "Exactly one tagged asset mesh")
    model = models[0]
    points = [model.matrix_world @ vertex.co for vertex in model.data.vertices]
    require(points, "Nonempty mesh")
    mins = [min(v[i] for v in points) for i in range(3)]
    maxs = [max(v[i] for v in points) for i in range(3)]
    dimensions = [maxs[i] - mins[i] for i in range(3)]
    expected = [parameters[k] for k in ("width", "depth", "height")]
    tolerance = max(expected) * 0.00002
    require(all(abs(a - b) < tolerance for a, b in zip(dimensions, expected)), "Blender dimensions in meters")
    require(all(abs(v) < tolerance for v in model.location), "Bottom-center object origin")
    require(abs(mins[2]) < tolerance, "Bottom is zero")
    require(abs((mins[0] + maxs[0]) / 2) < tolerance and abs((mins[1] + maxs[1]) / 2) < tolerance,
            "Centered horizontal dimensions")
    model.data.calc_loop_triangles()
    require(12 < len(model.data.loop_triangles) <= 10_000, "Triangle ceiling")
    require(model.data.uv_layers and len(model.data.uv_layers.active.data) == len(model.data.loops), "UV loop count")
    require(model.data.materials and all(p.material_index < len(model.data.materials) for p in model.data.polygons),
            "Material assignments")
    require(all(all(math.isfinite(v) for v in n.vector) for n in model.data.corner_normals), "Finite corner normals")
    return {"vertices": len(model.data.vertices), "triangles": len(model.data.loop_triangles),
            "dimensions": dimensions, "uvLayers": len(model.data.uv_layers), "materials": len(model.data.materials),
            "origin": list(model.location), "minimumZ": mins[2]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--mode", choices=("glb", "blend"), required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    parameters = json.loads(args.input.read_text(encoding="utf-8-sig"))
    result = {"mode": args.mode, "blenderVersion": bpy.app.version_string}
    if args.mode == "glb":
        glb = glb_binary_validation(args.artifact_dir / "model.glb")
        expected = [parameters[k] for k in ("width", "height", "depth")]
        tolerance = max(expected) * 0.00002
        require(all(abs(a - b) < tolerance for a, b in zip(glb["dimensions"], expected)), "GLB Y-up meter dimensions")
        require(abs(glb["boundsMin"][1]) < tolerance, "GLB bottom is Y zero")
        bpy.ops.object.select_all(action="SELECT")
        bpy.ops.object.delete(use_global=False)
        bpy.ops.import_scene.gltf(filepath=str(args.artifact_dir / "model.glb"))
        result["binary"] = glb
    else:
        bpy.ops.wm.open_mainfile(filepath=str(args.artifact_dir / "source.blend"), use_scripts=False)
        require(bpy.context.scene.unit_settings.system == "METRIC" and bpy.context.scene.unit_settings.scale_length == 1,
                "Editable source metric unit settings")
        require(not len(bpy.data.texts), "No embedded scripts")
    result["scene"] = inspect_scene(parameters)
    result["valid"] = True
    path = args.artifact_dir / f"roundtrip-{args.mode}.json"
    require(not path.exists(), "Never overwrite existing verification")
    path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"type": "roundtrip", **result}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"type": "roundtrip-failed", "error": str(exc)}), flush=True)
        raise SystemExit(1) from exc
