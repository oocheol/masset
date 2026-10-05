# SPDX-License-Identifier: MIT
"""Offline, single-image TripoSR CPU worker with versioned artifact receipts."""
from __future__ import annotations

import argparse
import contextlib
import gc
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).absolute().parent))
from runtime_common import (CODE_REVISION, DINO_REVISION, MODEL_ID, MODEL_REVISION,
                            MODEL_SHA256, MODULE_ROOT, QUALITY, SCHEMA_VERSION,
                            WorkerError, atomic_json, clean_env, emit, file_receipt,
                            prepare_output, runtime_python, utc_now, validate_job, verify_runtime)


def offline_guard():
    def denied(*args, **kwargs):
        raise WorkerError("offline_required", "Network access is disabled during TripoSR inference")
    socket.socket.connect = denied
    socket.socket.connect_ex = denied
    socket.create_connection = denied


def hardware(root):
    result = {"system": platform.system(), "machine": platform.machine(), "pythonVersion": platform.python_version()}
    if sys.platform == "darwin":
        for key, name in (("cpu", "machdep.cpu.brand_string"), ("ramBytes", "hw.memsize")):
            try:
                value = subprocess.check_output(["/usr/sbin/sysctl", "-n", name], env=clean_env(root), text=True, timeout=5).strip()
                result[key] = int(value) if key == "ramBytes" else value
            except Exception:
                pass
    return result


def peak_memory():
    try:
        import resource
        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(value if sys.platform == "darwin" else value * 1024)
    except ImportError:
        return None


def remove_numeric_degenerates(mesh):
    """Remove only bounded numerical slivers before sampling decoder colors.

    A 1e-12 square-metre cutoff is applied relative to the final one-metre
    height. No vertices are merged and no normals/faces are reoriented. Excess
    removal fails explicitly rather than concealing a bad reconstruction.
    """
    import numpy as np
    if len(mesh.vertices) < 4 or len(mesh.faces) < 4 or not np.isfinite(mesh.vertices).all():
        raise WorkerError("invalid_geometry", "Inference produced an empty or non-finite mesh")
    height = float(mesh.extents[2])  # Original model is +Z up.
    areas = mesh.area_faces.copy()
    if height <= 0 or not np.isfinite(areas).all() or float(areas.sum()) <= 0:
        raise WorkerError("invalid_geometry", "Inference produced invalid triangle areas")
    threshold = height ** 2 * 1e-12
    remove = areas <= threshold
    count = int(remove.sum())
    area_fraction = float(areas[remove].sum() / areas.sum())
    if count / len(mesh.faces) > .01 or area_fraction > 1e-8:
        raise WorkerError("invalid_geometry", "Too many numerical degenerates for bounded mesh cleanup")
    before_vertices, before_faces = len(mesh.vertices), len(mesh.faces)
    before_winding, before_watertight = bool(mesh.is_winding_consistent), bool(mesh.is_watertight)
    if count:
        mesh.update_faces(~remove)
        mesh.remove_unreferenced_vertices()
    if not mesh.is_winding_consistent:
        raise WorkerError("invalid_geometry", "Extracted mesh has inconsistent triangle winding")
    return {"method": "remove faces at or below scale-relative numeric area tolerance; remove unreferenced vertices",
            "normalizedAreaToleranceSquareMeters": 1e-12, "sourceAreaTolerance": threshold,
            "sourceHeight": height, "removedTriangleCount": count,
            "removedUnreferencedVertexCount": int(before_vertices - len(mesh.vertices)),
            "originalTriangleCount": int(before_faces), "originalVertexCount": int(before_vertices),
            "removedSurfaceAreaFraction": area_fraction, "maximumRemovedFaceFraction": .01,
            "maximumRemovedSurfaceAreaFraction": 1e-8, "windingConsistentBefore": before_winding,
            "windingConsistentAfter": bool(mesh.is_winding_consistent),
            "watertightBefore": before_watertight, "watertightAfter": bool(mesh.is_watertight),
            "facesReoriented": False, "verticesMerged": False, "holesFilled": False}


def orient_and_verify(mesh):
    import numpy as np
    # TripoSR's right-handed model space uses +Z up, +X back, +Y right.
    # Map (x,y,z) -> (x,z,-y): proper rotation into glTF +Y up.
    rotation = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=np.float64)
    mesh.apply_transform(rotation)
    if len(mesh.vertices) < 4 or len(mesh.faces) < 4 or not np.isfinite(mesh.vertices).all():
        raise WorkerError("invalid_geometry", "Inference produced an empty or non-finite mesh")
    singular = np.linalg.svd(mesh.vertices - mesh.vertices.mean(axis=0), compute_uv=False)
    if singular[-1] <= max(1e-5, singular[0] * 1e-4) or float(mesh.extents.min()) <= 1e-4:
        raise WorkerError("invalid_geometry", "Inference produced planar or degenerate geometry")
    # A normalized asset unit is exported as one metre of height, floor centered.
    # The image provides no physical-scale calibration; Blender may rescale it.
    scale = 1.0 / float(mesh.extents[1])
    mesh.apply_scale(scale)
    bounds = mesh.bounds.copy()
    translation = [-(bounds[0, 0] + bounds[1, 0]) / 2, -bounds[0, 1], -(bounds[0, 2] + bounds[1, 2]) / 2]
    mesh.apply_translation(translation)
    colors = np.asarray(mesh.visual.vertex_colors)
    if colors.shape != (len(mesh.vertices), 4) or not np.isfinite(colors).all():
        raise WorkerError("invalid_geometry", "Inference did not produce actual vertex colors")
    areas = mesh.area_faces
    if not np.isfinite(areas).all() or float(areas.min()) <= 1e-12:
        raise WorkerError("invalid_geometry", "Inference produced degenerate triangles")
    return {"vertexCount": int(len(mesh.vertices)), "triangleCount": int(len(mesh.faces)),
            "bounds": mesh.bounds.tolist(), "extents": mesh.extents.tolist(), "nonplanar": True,
            "vertexColors": True, "uniqueVertexColors": int(len(np.unique(colors[:, :3], axis=0))),
            "watertight": bool(mesh.is_watertight), "coordinateSystem": "right-handed-glTF-Y-up",
            "upAxis": "Y", "units": "meters", "normalizedHeightMeters": 1.0, "floorCentered": True,
            "physicalScaleEstimated": False, "sourceCoordinateSystem": "TripoSR-Z-up",
            "sourceToGlbRotation": rotation.tolist(), "sourceToGlbScale": scale,
            "sourceToGlbTranslation": [float(v) for v in translation],
            "minimumTriangleAreaSquareMeters": float(areas.min()),
            "trianglesBelow1eMinus12SquareMeters": int((areas < 1e-12).sum())}


def generate(root, job, output_arg, started):
    offline_guard()
    emit("stage", stage="runtime", message="Checking exact model/code hashes and isolated CPU runtime")
    ready = verify_runtime(root, probe=False)
    # Verify dependency versions without launching another torch process.
    import importlib.metadata
    if any(importlib.metadata.version(name) != version for name, version in ready["dependencies"].items()):
        raise WorkerError("runtime_integrity", "Installed dependency versions differ from the pinned runtime")
    from image_input import prepare_image
    emit("stage", stage="prepare", message="Validating source hash and transparent single-object input")
    prepared, preprocessing = prepare_image(job)
    output = prepare_output(output_arg)
    prepared_path = output / "prepared-input.png"
    prepared.save(prepared_path, format="PNG")
    emit("artifact", **file_receipt(prepared_path))
    stages = {}
    import torch
    from omegaconf import OmegaConf
    sys.path.insert(0, str(root / "code"))
    from tsr.system import TSR
    torch.set_num_threads(job["cpuThreads"])
    torch.set_num_interop_threads(1)
    torch.manual_seed(0)
    emit("stage", stage="load", message="Loading the pinned official checkpoint on CPU", device="cpu", cpuThreads=job["cpuThreads"])
    mark = time.monotonic()
    with contextlib.redirect_stdout(sys.stderr):
        config = OmegaConf.load(root / "model" / "config.yaml")
        OmegaConf.resolve(config)
        config.image_tokenizer.pretrained_model_name_or_path = str(root / "dino")
        model = TSR(config).to("cpu").eval()
        checkpoint = torch.load(root / "model" / "model.ckpt", map_location="cpu", weights_only=True)
        model.load_state_dict(checkpoint, strict=True)
        del checkpoint
        gc.collect()
    stages["loadSeconds"] = time.monotonic() - mark
    model.renderer.set_chunk_size(8192)
    emit("stage", stage="inference", message="Reconstructing one image with TripoSR on native CPU", quality=job["quality"], device="cpu")
    mark = time.monotonic()
    with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
        scene = model([prepared], device="cpu")
    stages["inferenceSeconds"] = time.monotonic() - mark
    emit("stage", stage="mesh", message="Extracting actual colored mesh with CPU scikit-image marching cubes",
         resolution=QUALITY[job["quality"]], inferenceSeconds=round(stages["inferenceSeconds"], 3))
    mark = time.monotonic()
    with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
        mesh = model.extract_mesh(scene, has_vertex_color=True, resolution=QUALITY[job["quality"]], threshold=25.0)[0]
        cleanup = remove_numeric_degenerates(mesh)
        emit("stage", stage="mesh-cleanup", message="Checked bounded scale-relative numeric triangle cleanup",
             removedTriangleCount=cleanup["removedTriangleCount"],
             removedUnreferencedVertexCount=cleanup["removedUnreferencedVertexCount"])
        # Re-query at the processed mesh's original positions so trimesh's
        # uint8 ColorVisuals cannot quantize the actual decoder RGB samples.
        predicted_srgb = model.renderer.query_triplane(
            model.decoder, torch.as_tensor(mesh.vertices.copy(), dtype=torch.float32, device="cpu"), scene[0]
        )["color"].cpu().numpy()
        geometry = orient_and_verify(mesh)
        mesh_path = output / "mesh.glb"
        from glb_color import export_linear_color0, read_color0
        encoded, color_encoding = export_linear_color0(mesh.export(file_type="glb"), predicted_srgb)
        with mesh_path.open("xb") as handle:
            handle.write(encoded)
        # Reopen the actual GLB; an in-memory mesh is insufficient artifact proof.
        import trimesh
        reopened = trimesh.load(mesh_path, file_type="glb", force="mesh", process=False)
        if len(reopened.faces) != geometry["triangleCount"] or len(reopened.vertices) != geometry["vertexCount"]:
            raise WorkerError("artifact_verification", "Exported GLB geometry differs from the inferred mesh")
        import numpy as np
        colors, color_accessor = read_color0(mesh_path.read_bytes())
        if not np.allclose(reopened.bounds, mesh.bounds, atol=1e-6) or colors.shape != (len(mesh.vertices), 4):
            raise WorkerError("artifact_verification", "Exported GLB bounds or colors did not round-trip")
        if not np.isfinite(reopened.area_faces).all() or float(reopened.area_faces.min()) <= 1e-12:
            raise WorkerError("artifact_verification", "Exported GLB contains degenerate triangles")
        geometry.update(vertexColorSpace="linear RGB", vertexColorComponentType="FLOAT32",
                        uniqueVertexColors=int(len(np.unique(colors[:, :3], axis=0))),
                        minimumExportedTriangleAreaSquareMeters=float(reopened.area_faces.min()))
    stages["meshSeconds"] = time.monotonic() - mark
    primary = [file_receipt(mesh_path), file_receipt(prepared_path)]
    emit("artifact", **primary[0])
    elapsed = time.monotonic() - started
    receipt = {"schemaVersion": SCHEMA_VERSION, "name": job["name"], "generatedAt": utc_now(),
               "modelId": MODEL_ID, "model": MODEL_ID, "modelRevision": MODEL_REVISION, "codeRevision": CODE_REVISION,
               "modelSha256": MODEL_SHA256, "dinoRevision": DINO_REVISION, "device": "cpu", "quality": job["quality"],
               "cpuThreads": job["cpuThreads"], "elapsedSeconds": round(elapsed, 3),
               "stageDurations": {k: round(v, 3) for k, v in stages.items()},
               "peakRssBytes": peak_memory(), "hardware": hardware(root),
               "source": {"path": job["sourcePath"], "sha256": job["sourceSha256"], "bytes": preprocessing["sourceBytes"]},
               "preprocessing": preprocessing, "geometry": geometry, "artifacts": primary, "meshCleanup": cleanup,
               "colorEncoding": color_encoding,
               "cameraConvention": {"sourceUp": "+Z", "sourceCanonicalViewDirection": "from +X toward origin",
                                    "sourceImageRight": "+Y", "glbUp": "+Y", "glbCanonicalViewDirection": "from +X toward transformed source origin",
                                    "glbImageRight": "-Z", "upstreamPreviewCameraDistance": 1.9, "upstreamPreviewVerticalFovDegrees": 40.0,
                                    "basis": "upstream get_spherical_cameras/TSR.render defaults; actual source perspective not calibrated"},
               "runtime": {"interpreterPath": sys.executable, "pythonVersion": ready["pythonVersion"], "dependencies": ready["dependencies"]},
               "offline": {"networkBlocked": True, "localConfigOnly": True, "weightsOnly": True},
               "limitations": ["Older single-image TripoSR model; modern Tripo Studio parity is not claimed",
                               "No UV texture baking, rigging or physical-scale estimation", "Requires one object with existing transparent alpha"]}
    generation_path = output / "generation.json"
    atomic_json(generation_path, receipt)
    artifacts = primary + [file_receipt(generation_path)]
    emit("artifact", **artifacts[2])
    # An artifact-backed receipt distinguishes inference from the install probe.
    ready["inferenceVerified"] = True
    ready["inferenceProof"] = {"verifiedAt": utc_now(), "outputDir": str(output), "artifacts": artifacts,
                               "quality": job["quality"], "device": "cpu", "geometry": geometry,
                               "elapsedSeconds": receipt["elapsedSeconds"], "peakRssBytes": receipt["peakRssBytes"],
                               "hardware": receipt["hardware"]}
    atomic_json(root / "ready.json", ready)
    (output / ".image3d-running").unlink()
    emit("completed", artifacts=artifacts, elapsedSeconds=round(time.monotonic() - started, 3),
         model=MODEL_ID, modelId=MODEL_ID, modelRevision=MODEL_REVISION, codeRevision=CODE_REVISION,
         device="cpu", quality=job["quality"], cpuThreads=job["cpuThreads"], geometry=geometry,
         peakRssBytes=receipt["peakRssBytes"])
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--_runtime-child", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    started = time.monotonic()
    try:
        job = validate_job(args.input)
        root = args.runtime_root.resolve()
        output = args.output_dir.absolute()
        if output.is_symlink() or (output.exists() and (not output.is_dir() or any(output.iterdir()))):
            raise WorkerError("output_not_empty", "output-dir must be a new directory or an existing empty directory")
        if not args._runtime_child:
            if not runtime_python(root).is_file():
                raise WorkerError("runtime_missing", "Prepare the pinned CPU runtime before generating a model")
            command = [str(runtime_python(root)), "-I", "-B", str(MODULE_ROOT / "worker.py"),
                       "--runtime-root", str(root), "--input", str(args.input.absolute()),
                       "--output-dir", str(output), "--_runtime-child"]
            # Replace the launcher process on this Mac release. The coordinator
            # retains the same PID/process group for cancellation and RSS limits.
            os.chdir(root)
            os.execve(command[0], command, clean_env(root, job["cpuThreads"]))
        if Path(sys.prefix).resolve() != (root / "venv").resolve():
            raise WorkerError("runtime_integrity", "Worker must run inside the isolated runtime interpreter")
        return generate(root, job, output, started)
    except KeyboardInterrupt:
        emit("failed", code="cancelled", message="Image-to-3D generation was cancelled", elapsedSeconds=round(time.monotonic()-started, 3))
        return 130
    except Exception as exc:
        code = exc.code if isinstance(exc, WorkerError) else "inference_failed"
        message = str(exc) if isinstance(exc, WorkerError) else "Native CPU inference failed (" + type(exc).__name__ + ")"
        emit("failed", code=code, message=message, elapsedSeconds=round(time.monotonic()-started, 3))
        # Local diagnostics contain no environment dumps or network URLs.
        if not isinstance(exc, WorkerError):
            import traceback
            traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
