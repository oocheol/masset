# SPDX-License-Identifier: GPL-3.0-or-later
"""Independent fixed GLB data and fresh-native AO/opacity regression checks.

The fixture GLBs are written directly, without the finishing worker or glTF
exporter. Source materials deliberately have duplicate names. Sampling checks
use actual reopened mesh UVs and independently decoded source/output images.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bpy
import numpy as np
from mathutils import Vector
from audit import GLB, blender_filename


def write_json(path, value):
    encoded = json.dumps(value, indent=2, allow_nan=False)
    with path.open("x", encoding="utf-8") as stream:
        stream.write(encoded + "\n")


def png(path, opacity=False, low_opacity=False):
    image = bpy.data.images.new(path.stem, width=32, height=32, alpha=True, float_buffer=True)
    image.colorspace_settings.name = "Non-Color"
    values = np.ones((32, 32, 4), dtype=np.float32)
    for x in range(32):
        u = x / 31
        if opacity:
            values[:, x, :3] = (0.3, 0.7, 0.9)
            values[:, x, 3] = 0.12 + (0.25 if low_opacity else 0.75) * u
        else:
            values[:, x, :3] = 0.2 + 0.6 * u
    image.pixels.foreach_set(values.ravel())
    image.filepath_raw = blender_filename(path)
    image.file_format = "PNG"
    image.save()
    bpy.data.images.remove(image)
    return path.read_bytes()


def build_glb(directory, name, modes):
    low_opacity = name == "low-opacity-blend"
    base = png(directory / (name + "-rgba.png"), opacity=True, low_opacity=low_opacity)
    ao = png(directory / (name + "-source-ao.png"))
    any_ao = any(mode != "OPAQUE" for mode in modes)
    document = {"asset": {"version": "2.0"}, "buffers": [{"byteLength": 0}],
                "bufferViews": [], "accessors": [], "materials": [], "images": [],
                "textures": [{"source": 0}] + ([{"source": 1}] if any_ao else []), "meshes": [{"primitives": []}],
                "nodes": [{"mesh": 0}], "scenes": [{"nodes": [0]}], "scene": 0}
    binary = bytearray()

    def view(blob, target=None):
        binary.extend(b"\0" * (-len(binary) % 4))
        index = len(document["bufferViews"])
        value = {"buffer": 0, "byteOffset": len(binary), "byteLength": len(blob)}
        if target is not None:
            value["target"] = target
        document["bufferViews"].append(value)
        binary.extend(blob)
        return index

    def accessor(values, kind, dtype="<f4", component=5126, target=34962):
        array = np.asarray(values, dtype=dtype)
        index = len(document["accessors"])
        value = {"bufferView": view(array.tobytes(), target), "componentType": component,
                 "count": len(array), "type": kind}
        if kind == "VEC3":
            value.update(min=array.min(axis=0).tolist(), max=array.max(axis=0).tolist())
        document["accessors"].append(value)
        return index

    for blob in ((base, ao) if any_ao else (base,)):
        document["images"].append({"bufferView": view(blob), "mimeType": "image/png"})
    cases = []
    for slot, mode in enumerate(modes):
        touching = name == "touching-render-parts"
        center = (slot - (len(modes) - 1) / 2) * (0.8 if touching else 1.2)
        divisions = 20 if touching else 1
        positions, uv_values, faces = [], [], []
        for row in range(divisions + 1):
            for column in range(divisions + 1):
                u, v = column / divisions, row / divisions
                positions.append((center + (u - 0.5) * 0.8, v, 0))
                uv_values.append((u, v))
        for row in range(divisions):
            for column in range(divisions):
                a = row * (divisions + 1) + column
                b, c, d = a + 1, a + divisions + 2, a + divisions + 1
                faces.extend((a, b, c, a, c, d))
        attrs = {"POSITION": accessor(positions, "VEC3"),
                 "NORMAL": accessor([(0, 0, 1)] * len(positions), "VEC3"),
                 "TEXCOORD_0": accessor(uv_values, "VEC2")}
        indices = accessor(faces, "SCALAR", "<u2", 5123, 34963)
        material = {"name": "Deliberately duplicated source name", "alphaMode": mode,
                    "extras": {"assetStudioSourceMaterialIndex": 99},
                    "doubleSided": mode == "MASK", "pbrMetallicRoughness": {
                        "baseColorTexture": {"index": 0}, "baseColorFactor": [1, 1, 1, 1],
                        "roughnessFactor": 0.23, "metallicFactor": 0.65}}
        strength = 0.4 if mode == "MASK" else 0.7
        has_ao = mode not in {"OPAQUE", "DEFAULT"}
        if mode == "MASK":
            material["alphaCutoff"] = 0.37
        if has_ao:
            material["occlusionTexture"] = {"index": 1, "strength": strength}
        primitive = {"attributes": attrs, "indices": indices}
        if mode != "DEFAULT":
            primitive["material"] = len(document["materials"])
            document["materials"].append(material)
        document["meshes"][0]["primitives"].append(primitive)
        cases.append({"centerX": center, "alphaMode": "OPAQUE" if mode == "DEFAULT" else mode, "alphaCutoff": 0.37 if mode == "MASK" else None,
                      "doubleSided": mode == "MASK", "hasAO": has_ao, "strength": strength,
                      "base": str(directory / (name + "-rgba.png")),
                      "ao": str(directory / (name + "-source-ao.png"))})
    document["buffers"][0]["byteLength"] = len(binary)
    binary.extend(b"\0" * (-len(binary) % 4))
    encoded = json.dumps(document, separators=(",", ":")).encode("utf-8")
    encoded += b" " * (-len(encoded) % 4)
    raw = (struct.pack("<4sII", b"glTF", 2, 28 + len(encoded) + len(binary))
           + struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
           + struct.pack("<II", len(binary), 0x004E4942) + binary)
    GLB(raw)
    source = directory / (name + ".glb")
    with source.open("xb") as stream:
        stream.write(raw)
    job = {"sourcePath": str(source), "sourceSha256": hashlib.sha256(raw).hexdigest(),
           "name": name, "heightMeters": 1.0, "maxTriangles": 1000,
           "textureResolution": 512, "sourceKind": "model", "preserveMaterials": True,
           "previewMode": "deferred"}
    job_path = directory / (name + "-input.json")
    write_json(job_path, job)
    return {"name": name, "job": str(job_path), "source": str(source), "sourceSha256": job["sourceSha256"], "parts": cases}


def create(directory):
    directory = directory.absolute()
    directory.mkdir(parents=True, exist_ok=False)
    values = [build_glb(directory, "mixed-render-ao", ["OPAQUE", "MASK", "BLEND"]),
              build_glb(directory, "low-opacity-blend", ["BLEND"]),
              build_glb(directory, "opaque-low-alpha", ["OPAQUE"]),
              build_glb(directory, "touching-render-parts", ["OPAQUE", "MASK", "BLEND"]),
              build_glb(directory, "mixed-default-material", ["OPAQUE", "MASK", "DEFAULT"])]
    write_json(directory / "fixture-manifest.json", {"cases": values, "synthetic": True,
               "sourceBytesWrittenDirectly": True, "userInputsModified": False})
    print(json.dumps({"fixtures": len(values), "root": str(directory)}), flush=True)


def decoded(path, noncolor=True):
    image = bpy.data.images.load(blender_filename(path), check_existing=False)
    if noncolor:
        image.colorspace_settings.name = "Non-Color"
    values = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(values)
    return values.reshape(image.size[1], image.size[0], 4)


def sample(image, uv, repeat=False):
    h, w = image.shape[:2]
    x, y = uv[0] * w - 0.5, uv[1] * h - 0.5
    ix, iy = math.floor(x), math.floor(y)
    fx, fy = x - ix, y - iy
    def at(dx, dy):
        if repeat:
            return image[(iy + dy) % h, (ix + dx) % w]
        return image[min(h - 1, max(0, iy + dy)), min(w - 1, max(0, ix + dx))]
    return ((1 - fy) * ((1 - fx) * at(0, 0) + fx * at(1, 0))
            + fy * ((1 - fx) * at(0, 1) + fx * at(1, 1)))


def verify(directory, evidence_path=None):
    manifest = json.loads((directory / "fixture-manifest.json").read_text())
    evidence = {"nativePlatform": sys.platform, "blenderVersion": bpy.app.version_string,
                "newDownloads": False, "sourceOriginalsPreserved": True, "cases": []}
    for case in manifest["cases"]:
        assert hashlib.sha256(Path(case["source"]).read_bytes()).hexdigest() == case["sourceSha256"]
        result = directory / (case["name"] + "-result")
        base = decoded(result / "basecolor.png")
        orm = decoded(result / "orm.png")
        source_base = decoded(Path(case["parts"][0]["base"]))
        source_ao = decoded(Path(case["parts"][0]["ao"]))
        checks = []
        for basename in ("game-ready.model.glb", "lod1.glb"):
            bpy.ops.wm.read_factory_settings(use_empty=True)
            inspected = GLB((result / basename).read_bytes())
            document = inspected.doc
            bpy.ops.import_scene.gltf(filepath=blender_filename(result / basename), import_pack_images=True,
                                      import_shading="NORMALS", merge_vertices=False)
            seen, ao_errors, alpha_errors, ao_details = set(), [], [], []
            for obj in bpy.context.scene.objects:
                if obj.type != "MESH":
                    continue
                obj.data.calc_loop_triangles()
                for tri in obj.data.loop_triangles:
                    center = sum((obj.matrix_world @ obj.data.vertices[v].co for v in tri.vertices), Vector()) / 3
                    slot = min(range(len(case["parts"])), key=lambda index: abs(center.x - case["parts"][index]["centerX"]))
                    part = case["parts"][slot]
                    material = obj.data.materials[tri.material_index]
                    actual = next(value for value in document["materials"] if value["name"] == material.name)
                    assert actual.get("alphaMode", "OPAQUE") == part["alphaMode"]
                    assert actual.get("doubleSided", False) == part["doubleSided"]
                    assert material.use_backface_culling == (not part["doubleSided"])
                    if part["alphaMode"] == "MASK":
                        assert abs(actual.get("alphaCutoff", 0.5) - part["alphaCutoff"]) < 1e-6
                        assert any(node.type == "MATH" and node.operation == "LESS_THAN" and
                                   abs(node.inputs[1].default_value - 0.37) < 1e-6 for node in material.node_tree.nodes)
                    if part["alphaMode"] == "BLEND":
                        assert material.surface_render_method == "BLENDED"
                    assert ("occlusionTexture" in actual) == part["hasAO"]
                    if part["hasAO"]:
                        assert actual["occlusionTexture"].get("strength", 1) == 1
                        texture = document["textures"][actual["occlusionTexture"]["index"]]
                        image = inspected.images[texture["source"]]
                        assert image["sha256"] == hashlib.sha256((result / "orm.png").read_bytes()).hexdigest()
                    seen.add(slot)
                    positions = [obj.matrix_world @ obj.data.vertices[v].co for v in tri.vertices]
                    uvs = [np.asarray(obj.data.uv_layers.active.data[loop].uv) for loop in tri.loops]
                    for weights in ((0.2, 0.3, 0.5), (0.6, 0.2, 0.2), (0.2, 0.6, 0.2)):
                        point = sum((p * weight for p, weight in zip(positions, weights)), Vector())
                        uv = sum((p * weight for p, weight in zip(uvs, weights)))
                        original_uv = ((point.x - part["centerX"]) / 0.8 + 0.5, 1 - point.z)
                        expected_ao = 1 + part["strength"] * (sample(source_ao, original_uv, repeat=True)[0] - 1) if part["hasAO"] else 1
                        ao_errors.append(abs(float(sample(orm, uv)[0]) - float(expected_ao)))
                        ao_details.append({"slot": slot, "point": list(point), "uv": uv.tolist(),
                                           "expected": float(expected_ao), "actual": float(sample(orm, uv)[0])})
                        if part["alphaMode"] != "OPAQUE":
                            alpha_errors.append(abs(float(sample(base, uv)[3]) - float(sample(source_base, original_uv, repeat=True)[3])))
            assert seen == set(range(len(case["parts"])))
            assert max(ao_errors) < 0.035, (basename, "AO error", max(ao_errors), ao_details[int(np.argmax(ao_errors))])
            assert max(alpha_errors, default=0) < 0.035, (basename, "alpha error", max(alpha_errors, default=0))
            checks.append({"artifact": basename, "partsReopened": len(seen),
                           "maximumAOError": max(ao_errors), "maximumAlphaError": max(alpha_errors, default=0),
                           "flagsAndAssignmentsPreserved": True,
                           "AOImageBytesMatchStandalone": True if any(part["hasAO"] for part in case["parts"]) else None})
        evidence["cases"].append({"name": case["name"], "passed": True, "checks": checks})
    evidence_path = evidence_path or directory / "material-regression-evidence.json"
    write_json(evidence_path, evidence)
    print(json.dumps({"passed": True, "nativeCases": len(evidence["cases"]), "evidence": str(evidence_path)}), flush=True)


if __name__ == "__main__":
    assert bpy.app.background and "--factory-startup" in sys.argv and "--disable-autoexec" in sys.argv
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("create", "verify"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    create(args.output) if args.mode == "create" else verify(args.output, args.evidence)
