# SPDX-License-Identifier: MIT
"""Independent verification of actual output files and the completed JSONL event."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys

ROOT = Path(__file__).absolute().parents[1]
sys.path.insert(0, str(ROOT))
sys.dont_write_bytecode = True
from runtime_common import MODEL_ID, MODEL_SHA256, MODEL_REVISION, CODE_REVISION


def verify(folder, events):
    import numpy as np
    import trimesh
    from PIL import Image
    folder = folder.absolute()
    assert {p.name for p in folder.iterdir()} == {"mesh.glb", "prepared-input.png", "generation.json"}
    receipt = json.loads((folder / "generation.json").read_text())
    lines = [json.loads(line) for line in events.read_text().splitlines()]
    assert all(line["type"] in {"stage", "artifact", "completed", "failed"} for line in lines)
    assert lines[-1]["type"] == "completed"
    completed = lines[-1]
    assert len(completed["artifacts"]) == 3
    for artifact in completed["artifacts"]:
        data = (folder / artifact["basename"]).read_bytes()
        assert len(data) == artifact["bytes"]
        assert hashlib.sha256(data).hexdigest() == artifact["sha256"]
    assert receipt["modelId"] == MODEL_ID and receipt["modelSha256"] == MODEL_SHA256
    assert receipt["modelRevision"] == MODEL_REVISION and receipt["codeRevision"] == CODE_REVISION
    assert receipt["device"] == "cpu" and receipt["offline"] == {"networkBlocked": True, "localConfigOnly": True, "weightsOnly": True}
    source = Path(receipt["source"]["path"])
    assert hashlib.sha256(source.read_bytes()).hexdigest() == receipt["source"]["sha256"]
    mesh_bytes = (folder / "mesh.glb").read_bytes()
    magic, version, total = struct.unpack_from("<4sII", mesh_bytes, 0)
    assert magic == b"glTF" and version == 2 and total == len(mesh_bytes)
    json_length, json_kind = struct.unpack_from("<II", mesh_bytes, 12)
    assert json_kind == 0x4e4f534a
    gltf = json.loads(mesh_bytes[20:20+json_length])
    primitives = [p for m in gltf["meshes"] for p in m["primitives"]]
    assert len(primitives) == 1
    assert {"POSITION", "COLOR_0"}.issubset(primitives[0]["attributes"])
    assert primitives[0].get("mode", 4) == 4
    mesh = trimesh.load(folder / "mesh.glb", file_type="glb", force="mesh", process=False)
    assert np.isfinite(mesh.vertices).all() and np.isfinite(mesh.area_faces).all()
    assert float(mesh.area_faces.min()) > 1e-12
    assert len(mesh.vertices) == receipt["geometry"]["vertexCount"]
    assert len(mesh.faces) == receipt["geometry"]["triangleCount"]
    assert np.linalg.svd(mesh.vertices - mesh.vertices.mean(0), compute_uv=False)[-1] > 1e-5
    np.testing.assert_allclose(mesh.bounds, receipt["geometry"]["bounds"], atol=1e-6)
    assert abs(mesh.bounds[0, 1]) < 1e-6 and abs(mesh.extents[1]-1) < 1e-6
    assert abs(mesh.bounds[:, 0].sum()) < 1e-6 and abs(mesh.bounds[:, 2].sum()) < 1e-6
    assert receipt["geometry"]["upAxis"] == "Y" and receipt["geometry"]["units"] == "meters"
    # trimesh 4.0.5 only reads normalized integer COLOR_0 into ColorVisuals.
    # Verify FLOAT32 directly from the actual GLB buffer instead of silently
    # depending on that reader's lossy/unsupported color conversion.
    if "colorEncoding" not in receipt:
        assert mesh.visual.kind == "vertex" and len(np.unique(mesh.visual.vertex_colors[:, :3], axis=0)) > 1
    if "colorEncoding" in receipt:
        from glb_color import read_color0, linear_to_srgb
        colors, accessor = read_color0(mesh_bytes)
        assert accessor["componentType"] == 5126 and accessor["type"] == "VEC4"
        assert not accessor.get("normalized", False)
        assert colors.shape == (len(mesh.vertices), 4) and np.isfinite(colors).all()
        assert (colors >= 0).all() and (colors <= 1).all() and (colors[:, 3] == 1).all()
        encoding = receipt["colorEncoding"]
        assert encoding["componentType"] == "FLOAT32" and encoding["exportColorSpace"] == "linear RGB"
        assert not encoding["uint8QuantizationBeforeExport"] and encoding["roundTripMaxAbsoluteError"] < 2e-6
        np.testing.assert_allclose(colors[:, :3].mean(0), encoding["meanExportedLinear"], atol=2e-6)
        np.testing.assert_allclose(linear_to_srgb(colors[:, :3]).mean(0), encoding["meanPredictedSrgb"], atol=2e-6)
        assert len(np.unique(colors[:, :3], axis=0)) == receipt["geometry"]["uniqueVertexColors"] > 1
    if "meshCleanup" in receipt:
        cleanup = receipt["meshCleanup"]
        assert cleanup["windingConsistentAfter"]
        assert not cleanup["facesReoriented"] and not cleanup["verticesMerged"] and not cleanup["holesFilled"]
        assert cleanup["removedTriangleCount"] / cleanup["originalTriangleCount"] <= .01
        assert cleanup["removedSurfaceAreaFraction"] <= 1e-8
        assert cleanup["originalTriangleCount"] - cleanup["removedTriangleCount"] == len(mesh.faces)
        assert cleanup["originalVertexCount"] - cleanup["removedUnreferencedVertexCount"] == len(mesh.vertices)
    assert mesh.is_winding_consistent and mesh.volume > 0
    with Image.open(folder / "prepared-input.png") as image:
        assert image.size == (512, 512) and image.mode == "RGB"
    assert 0 < receipt["peakRssBytes"] < 8192 * 1024 ** 2
    return {"verified": True, "outputDir": str(folder), "artifacts": completed["artifacts"],
            "modelId": receipt["modelId"], "modelRevision": receipt["modelRevision"],
            "codeRevision": receipt["codeRevision"], "device": "cpu", "quality": receipt["quality"],
            "cpuThreads": receipt["cpuThreads"], "elapsedSeconds": receipt["elapsedSeconds"],
            "peakRssBytes": receipt["peakRssBytes"], "hardware": receipt["hardware"], "geometry": receipt["geometry"],
            "colorEncoding": receipt.get("colorEncoding"), "meshCleanup": receipt.get("meshCleanup"),
            "sourceSha256": receipt["source"]["sha256"], "sourcePreserved": True,
            "checks": ["exact artifact SHA-256 and sizes", "GLB 2.0 structure with actual COLOR_0",
                       "nonplanar, finite, nondegenerate triangles", "outward consistent winding",
                       "Y-up floor-centered one-metre height", "original image hash preserved",
                       "offline CPU provenance", "measured peak RSS below 8 GiB"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--events", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.output_dir, args.events), indent=2, allow_nan=False))
