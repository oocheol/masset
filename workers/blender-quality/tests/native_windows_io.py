# SPDX-License-Identifier: GPL-3.0-or-later
"""Focused real bpy I/O regression, not a full mesh-quality/release proof.

Run generate and reopen in separate Blender processes with --background,
--factory-startup, --disable-autoexec and --threads 2. The only source is a
hash-checked static GLB; the test creates new paths and never writes originals.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from audit import (GLB, artifact, blender_filename, filesystem_path,
                   prepare_output, read_parameters, verify_source)
import bpy
import numpy as np
import worker


def exclusive_json(path, data):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=True, indent=2, allow_nan=False)
        stream.write("\n")


def utf16_length(path):
    return len(str(path).encode("utf-16-le")) // 2


def generate(root, source):
    root = prepare_output(root)
    source = filesystem_path(source)
    original = source.read_bytes()
    source_sha = hashlib.sha256(original).hexdigest()
    original_inspection = GLB(original)
    result = {"scope": "focused native Windows I/O; not full quality pipeline or desktop integration",
              "blenderVersion": bpy.app.version_string, "sourcePath": str(source),
              "sourceSha256": source_sha, "scriptAutoexec": False, "threads": 2, "cases": []}
    parents = [root / "canonical-short"]
    long = root
    for index in range(6):
        long /= f"한글 긴 프로젝트 경로 {index} " + "모델 품질 " * 5 + "보존"
    parents.append(long)
    for index, parent in enumerate(parents):
        output = prepare_output(parent / "artifacts")
        inputs = parent / "inputs"
        inputs.mkdir()
        source_copy = inputs / "original-source.glb"
        with source_copy.open("xb") as stream:
            stream.write(original)
        job = {"sourcePath": str(source_copy), "sourceSha256": source_sha,
               "name": "Windows path regression", "heightMeters": 1,
               "maxTriangles": 1000, "textureResolution": 512,
               "sourceKind": "model", "preserveMaterials": True}
        input_path = inputs / "input.json"
        exclusive_json(input_path, job)
        actual_job = read_parameters(input_path)
        data, inspected = verify_source(actual_job)
        assert actual_job["sourcePath"] == str(source_copy)
        assert inspected.sha256 == source_sha
        scene = worker.cpu_scene()
        high, count = worker.import_snapshot(data, output, 1, job["name"])
        assert count == original_inspection.scene_triangles
        glb = worker.export_glb(high, output, "high-detail.glb")
        assert glb.scene_triangles == count
        image = bpy.data.images.new("Path regression pixels", width=64, height=64, alpha=True)
        yy, xx = np.mgrid[0:64, 0:64]
        rgba = np.stack((xx / 63, yy / 63, (xx % 8) / 7, np.ones_like(xx)), axis=-1).astype(np.float32)
        image.pixels.foreach_set(rgba.ravel())
        image.update()
        saved = worker.save_png(image, output, "basecolor.png")
        assert list(saved.size) == [64, 64] and saved.packed_file is not None
        bpy.ops.object.camera_add(location=(3, -4, 3))
        camera = bpy.context.object
        worker.aim(camera, (0, 0, 0.5))
        camera.data.type = "ORTHO"
        camera.data.ortho_scale = max(high.dimensions) * 1.8
        scene.camera = camera
        bpy.ops.object.light_add(type="AREA", location=(2, -3, 4))
        bpy.context.object.data.energy = 500
        bpy.context.object.data.size = 5
        scene.cycles.samples = 1
        scene.cycles.use_denoising = False
        scene.render.resolution_x = scene.render.resolution_y = 64
        temporary = output / "thumbnail.partial.png"
        scene.render.filepath = blender_filename(temporary)
        bpy.ops.render.render(write_still=True)
        worker.promote(temporary, output / "thumbnail.png")
        temporary = output / "source.partial.blend"
        bpy.ops.wm.save_as_mainfile(filepath=blender_filename(temporary), compress=True, check_existing=False)
        worker.promote(temporary, output / "source.blend")
        _, after = verify_source(actual_job)
        assert after.sha256 == source_sha and source.read_bytes() == original
        try:
            prepare_output(output)
        except ValueError:
            rejected_reuse = True
        else:
            raise AssertionError("Populated output directory was accepted")
        candidate = blender_filename(output / "game-ready.model.partial.glb")
        ordinary_output = str(output)[4:]
        assert os.path.samefile(Path(candidate).parent, output)
        assert not candidate.startswith("\\\\?\\") and utf16_length(candidate) < 260
        if index:
            assert utf16_length(ordinary_output) >= 260
        result["cases"].append({"input": str(input_path), "parameters": actual_job,
                                "output": str(output), "outputPathUTF16Length": utf16_length(ordinary_output),
                                "bpyExampleFilename": candidate,
                                "bpyExamplePathUTF16Length": utf16_length(candidate),
                                "aliasParentIdentityVerified": True, "populatedOutputRejected": rejected_reuse,
                                "triangleCount": count, "mesh": worker.mesh_inspection(high),
                                "artifacts": [artifact(output / filename, role) for filename, role in
                                              (("high-detail.glb", "output"), ("basecolor.png", "texture"),
                                               ("thumbnail.png", "thumbnail"), ("source.blend", "source"))]})
    result["originalSourcePreserved"] = source.read_bytes() == original
    result["valid"] = True
    exclusive_json(root / "native-io-generation.json", result)
    print(json.dumps({"type": "native-io-generation", "valid": True, "cases": len(result["cases"]),
                      "evidence": str(root / "native-io-generation.json")}), flush=True)


def reopen(root):
    root = filesystem_path(root)
    previous = json.loads((root / "native-io-generation.json").read_text(encoding="utf-8"))
    checks = []
    for case in previous["cases"]:
        output = filesystem_path(case["output"])
        _, source = verify_source(case["parameters"])
        assert source.sha256 == previous["sourceSha256"]
        for expected in case["artifacts"]:
            assert artifact(output / expected["path"], expected["role"]) == expected
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.context.preferences.filepaths.use_scripts_auto_execute = False
        bpy.ops.import_scene.gltf(filepath=blender_filename(output / "high-detail.glb"), import_pack_images=True)
        objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        assert sum(worker.triangles(obj) for obj in objects) == case["triangleCount"]
        measurements = [worker.mesh_inspection(obj) for obj in objects]
        assert all(info["finiteNormals"] and info["unitNormals"] and info["uvFinite"] for info in measurements)
        image_details = {}
        for basename in ("basecolor.png", "thumbnail.png"):
            image = bpy.data.images.load(blender_filename(output / basename), check_existing=False)
            assert list(image.size) == [64, 64]
            pixels = np.asarray(image.pixels[:], dtype=np.float32).reshape(-1, 4)
            assert np.isfinite(pixels).all() and float(pixels[:, :3].std()) > 0.001
            image_details[basename] = {"size": list(image.size), "finite": True,
                                       "rgbStddev": float(pixels[:, :3].std())}
        bpy.ops.wm.open_mainfile(filepath=blender_filename(output / "source.blend"), load_ui=False, use_scripts=False)
        scene = bpy.context.scene
        objects = [obj for obj in scene.objects if obj.type == "MESH"]
        assert sum(worker.triangles(obj) for obj in objects) == case["triangleCount"]
        assert scene.render.engine == "CYCLES" and scene.cycles.device == "CPU" and scene.render.threads == 2
        assert not bpy.context.preferences.filepaths.use_scripts_auto_execute and not bpy.data.texts
        assert all(image.packed_file is not None for image in bpy.data.images if image.type == "IMAGE" and image.has_data)
        checks.append({"output": case["output"], "sourcePath": case["parameters"]["sourcePath"],
                       "triangleCount": case["triangleCount"], "glbMeasurements": measurements,
                       "decodedPngs": image_details, "blendReopen": True,
                       "scriptAutoexec": False, "packedImages": True, "artifactHashesMatch": True})
    original = filesystem_path(previous["sourcePath"]).read_bytes()
    assert hashlib.sha256(original).hexdigest() == previous["sourceSha256"]
    result = {"scope": previous["scope"], "valid": True, "independentProcess": True,
              "blenderVersion": bpy.app.version_string, "checks": checks, "originalSourcePreserved": True}
    exclusive_json(root / "native-io-independent-reopen.json", result)
    print(json.dumps({"type": "native-io-independent-reopen", "valid": True,
                      "evidence": str(root / "native-io-independent-reopen.json")}), flush=True)


def main():
    if (os.name != "nt" or not bpy.app.background or "--factory-startup" not in sys.argv
            or "--disable-autoexec" not in sys.argv):
        raise ValueError("Requires native Windows Blender background/factory-startup/disable-autoexec")
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("generate", "reopen"), required=True)
    parser.add_argument("--output-root", required=True)
    parser.add_argument("--source")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    if args.mode == "generate":
        if not args.source:
            raise ValueError("Generation requires a bounded original GLB")
        generate(args.output_root, args.source)
    else:
        reopen(args.output_root)


if __name__ == "__main__":
    main()
