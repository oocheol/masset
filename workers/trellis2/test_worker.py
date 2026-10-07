"""Deterministic local boundary tests. No model download, upload, CUDA or inference."""
from __future__ import annotations

import hashlib
import contextlib
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock

MODULE = Path(__file__).parent / "worker.py"
SPEC = importlib.util.spec_from_file_location("trellis2_worker", MODULE)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


def rgba_source(path, format="PNG"):
    from PIL import Image
    import numpy as np
    array = np.zeros((64, 64, 4), dtype=np.uint8)
    array[:, :, :3] = [17, 231, 89]  # Hidden transparent RGB must not condition the model.
    array[8:56, 12:52] = [183, 37, 71, 255]
    array[20:35, 12:16, 3] = 90
    image = Image.fromarray(array)
    image.save(path, format=format, lossless=True)
    return image


def job(path):
    return {"name": "Test prop", "sourcePath": str(path), "sourceSha256": worker.sha256(path),
            "quality": "standard", "seed": 42, "textureResolution": 2048, "maxTriangles": 300000}


def glb_fixture(external=False):
    from PIL import Image
    import io
    texture = io.BytesIO()
    Image.new("RGBA", (1, 1), (173, 45, 75, 255)).save(texture, format="PNG")
    png = texture.getvalue()
    positions = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
    uvs = struct.pack("<6f", 0, 0, 1, 0, 0, 1)
    indices = struct.pack("<3H", 0, 1, 2) + b"\0\0"
    bin_data = positions + uvs + indices
    view3 = len(bin_data)
    bin_data += png
    while len(bin_data) % 4:
        bin_data += b"\0"
    view4 = len(bin_data)
    bin_data += png
    used = len(bin_data)
    while len(bin_data) % 4:
        bin_data += b"\0"
    doc = {
        "asset": {"version": "2.0"}, "buffers": [{"byteLength": used}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(positions)},
                        {"buffer": 0, "byteOffset": len(positions), "byteLength": len(uvs)},
                        {"buffer": 0, "byteOffset": len(positions) + len(uvs), "byteLength": 6},
                        {"buffer": 0, "byteOffset": view3, "byteLength": len(png)},
                        {"buffer": 0, "byteOffset": view4, "byteLength": len(png)}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0, 0, 0], "max": [1, 1, 0]},
                      {"bufferView": 1, "componentType": 5126, "count": 3, "type": "VEC2"},
                      {"bufferView": 2, "componentType": 5123, "count": 3, "type": "SCALAR"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 1}, "indices": 2, "material": 0}]}],
        "images": [{"bufferView": 3, "mimeType": "image/png"}, {"bufferView": 4, "mimeType": "image/png"}],
        "textures": [{"source": 0}, {"source": 1}],
        "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicRoughnessTexture": {"index": 1}}}],
        "nodes": [{"mesh": 0}], "scenes": [{"nodes": [0]}], "scene": 0,
    }
    if external:
        doc["images"][0]["uri"] = "https://untrusted.invalid/texture.png"
    encoded = json.dumps(doc).encode()
    while len(encoded) % 4:
        encoded += b" "
    content = struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(encoded) + 8 + len(bin_data))
    return content + struct.pack("<I4s", len(encoded), b"JSON") + encoded + struct.pack("<I4s", len(bin_data), b"BIN\0") + bin_data


class Trellis2BoundaryTests(unittest.TestCase):
    def test_lock_contains_only_pinned_safe_local_models(self):
        lock = worker.read_json(MODULE.parent / "runtime-lock.json")
        self.assertEqual(lock["pins"], worker.PINS)
        self.assertFalse(lock["downloadAllowed"])
        weights = [entry for entry in lock["modelFiles"] if entry["algorithm"] == "sha256"]
        self.assertEqual(len(weights), 9)
        self.assertEqual(sum(entry["bytes"] for entry in weights), 16180022310)
        self.assertTrue(all(entry["path"].endswith(".safetensors") for entry in weights))
        self.assertFalse(any("bria" in entry["path"].lower() or entry["path"].endswith(".bin") for entry in lock["modelFiles"]))
        self.assertEqual(len({entry["path"] for entry in lock["codeFiles"]}), len(lock["codeFiles"]))

    def test_duplicate_json_and_file_overwrite_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "receipt.json"
            path.write_text('{"pins":1,"pins":2}')
            with self.assertRaises(worker.WorkerError):
                worker.read_json(path)
            original = path.read_bytes()
            with self.assertRaises(FileExistsError):
                worker.write_new_json(path, {"changed": True})
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(Path(folder).glob("*.tmp")), [])
            new_path = Path(folder) / "complete.json"
            worker.write_new_json(new_path, {"complete": True})
            self.assertEqual(worker.read_json(new_path), {"complete": True})

    def test_local_runtime_path_hash_and_size_are_enforced(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "model.safetensors"
            path.write_bytes(b"known safe fixture bytes")
            entry = {"path": path.name, "algorithm": "sha256", "digest": worker.sha256(path), "bytes": path.stat().st_size}
            checked = worker.verify_entry(root, entry)
            self.assertEqual(checked, entry)
            path.write_bytes(b"different same length!!!")
            with self.assertRaises(worker.WorkerError):
                worker.verify_entry(root, entry)
            for invalid in ("../model.safetensors", "/outside/model", "part/../../outside", "a\\b"):
                with self.assertRaises(worker.WorkerError):
                    worker.local_file(root, invalid)

    def test_model_source_is_compiled_from_checked_bytes_not_cached_pyc(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)
            path = source / "checked.py"
            content = b"value = 71\n"
            path.write_bytes(content)
            digest = hashlib.sha1(b"blob " + str(len(content)).encode() + b"\0" + content).hexdigest()
            entries = [{"path": path.name, "algorithm": "gitBlobSha1", "digest": digest, "bytes": len(content)}]
            original = importlib.machinery.SourceFileLoader.get_code
            original_bytecode = importlib.machinery.SourcelessFileLoader.get_code
            try:
                worker.install_source_guard(source, entries)
                loader = importlib.machinery.SourceFileLoader("checked", str(path))
                namespace = {}
                exec(loader.get_code("checked"), namespace)
                self.assertEqual(namespace["value"], 71)
                path.write_bytes(b"value = 99\n")
                with self.assertRaises(worker.WorkerError):
                    loader.get_code("checked")
                pyc = source / "untrusted.pyc"
                pyc.write_bytes(b"not trusted bytecode")
                with self.assertRaises(worker.WorkerError):
                    importlib.machinery.SourcelessFileLoader("untrusted", str(pyc)).get_code("untrusted")
            finally:
                importlib.machinery.SourceFileLoader.get_code = original
                importlib.machinery.SourcelessFileLoader.get_code = original_bytecode

    def test_fixed_job_schema_never_accepts_asset_code_or_boolean_seed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "image.png"
            rgba_source(source)
            path = root / "job.json"
            good = job(source)
            path.write_text(json.dumps(good))
            self.assertEqual(worker.validate_job(path), good)
            for mutation in ({"script": "arbitrary.py"}, {"seed": True}, {"quality": "cpu"}, {"sourcePath": "relative.png"}, {"maxTriangles": 0}):
                path.write_text(json.dumps({**good, **mutation}))
                with self.assertRaises(worker.WorkerError):
                    worker.validate_job(path)

    def test_rgba_png_and_webp_match_official_crop_and_remove_hidden_rgb(self):
        from PIL import Image
        import numpy as np
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            results = []
            for format in ("PNG", "WEBP"):
                source = root / ("image." + format.lower())
                rgba_source(source, format)
                original = source.read_bytes()
                output = root / format
                output.mkdir()
                image, provenance = worker.prepare_image(job(source), output)
                with Image.open(source) as opened:
                    array = np.asarray(opened)
                foreground = np.argwhere(array[:, :, 3] > 204)
                left, top, right, bottom = np.min(foreground[:, 1]), np.min(foreground[:, 0]), np.max(foreground[:, 1]), np.max(foreground[:, 0])
                center = (left + right) / 2, (top + bottom) / 2
                side = int(max(right - left, bottom - top))
                crop = (center[0] - side // 2, center[1] - side // 2, center[0] + side // 2, center[1] + side // 2)
                reference = np.asarray(Image.fromarray(array).crop(crop)).astype(np.float32) / 255
                reference = (reference[:, :, :3] * reference[:, :, 3:4] * 255).astype(np.uint8)
                self.assertTrue(np.array_equal(np.asarray(image), reference))
                self.assertEqual(source.read_bytes(), original)
                self.assertEqual(provenance["preparedSha256"], worker.sha256(output / "prepared-input.png"))
                self.assertEqual(image.mode, "RGB")
                self.assertTrue(np.any(np.all(np.asarray(image) == 0, axis=2)))
                results.append(np.asarray(image))
            self.assertTrue(np.array_equal(results[0], results[1]))

    def test_opaque_empty_animated_and_changed_inputs_are_rejected(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = root / "new"
            output.mkdir()
            for alpha in (0, 255):
                source = root / f"alpha{alpha}.png"
                Image.new("RGBA", (64, 64), (53, 92, 121, alpha)).save(source)
                with self.assertRaises(worker.WorkerError):
                    worker.prepare_image(job(source), output)
            source = root / "animated.webp"
            first = Image.new("RGBA", (64, 64), (53, 92, 121, 128))
            second = Image.new("RGBA", (64, 64), (210, 92, 51, 128))
            first.save(source, save_all=True, append_images=[second], duration=100, loop=0, format="WEBP", lossless=True)
            with self.assertRaises(worker.WorkerError):
                worker.prepare_image(job(source), output)
            source = root / "changed.png"
            rgba_source(source)
            selected = job(source)
            selected["sourceSha256"] = "0" * 64
            with self.assertRaises(worker.WorkerError):
                worker.prepare_image(selected, output)

    def test_embedded_pbr_requires_real_geometry_and_no_external_resources(self):
        content = glb_fixture()
        document = worker.validate_embedded_glb(content)
        self.assertEqual(document["accessors"][0]["count"], 3)
        with self.assertRaises(worker.WorkerError):
            worker.validate_embedded_glb(glb_fixture(external=True))
        corrupted = bytearray(content)
        corrupted[8] ^= 1
        with self.assertRaises(worker.WorkerError):
            worker.validate_embedded_glb(bytes(corrupted))
        with self.assertRaises(worker.WorkerError):
            worker.validate_embedded_glb(b"glTF-not-an-artifact")

    def test_startup_cancellation_is_exact_and_pid_reuse_never_matches(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "new-output"
            self.assertFalse(worker.startup_cancelled(output))
            path = worker.startup_cancel_path(output)
            worker.write_new_json(path, {"schemaVersion": 1, "outputDir": str(output), "requested": True})
            self.assertTrue(worker.startup_cancelled(output))
            control = {"pid": 1200, "startTicks": 12345}
            with mock.patch.object(worker, "process_start_ticks", return_value=12346):
                self.assertFalse(worker.process_matches(control))
            with mock.patch.object(worker, "process_start_ticks", return_value=None):
                self.assertFalse(worker.process_matches(control))

    def test_pickle_and_online_bootstrap_guards_fail_closed(self):
        fake_torch = mock.Mock()
        fake_hub = mock.Mock()
        with mock.patch.dict("sys.modules", {"huggingface_hub": fake_hub}):
            worker.install_safe_model_guards(fake_torch)
            for call in (fake_torch.load, fake_torch.jit.load, fake_hub.hf_hub_download, fake_hub.snapshot_download):
                with self.assertRaises(worker.WorkerError):
                    call("must-not-be-read.bin")

    def test_runtime_lease_stays_busy_until_process_exit_or_pid_reuse(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            first = {"schemaVersion": 1, "pid": 1200, "nonce": "first", "startTicks": 345,
                     "outputDir": str(root / "first"), "workerPath": str(MODULE)}
            second = {**first, "pid": 1201, "nonce": "second", "startTicks": 456}
            with mock.patch.object(worker, "runtime_guard", side_effect=lambda _root: contextlib.nullcontext()):
                lease = worker.acquire_runtime_lock(root, first)
                with mock.patch.object(worker, "lock_process_state", return_value="alive"):
                    with self.assertRaises(worker.WorkerError) as error:
                        worker.acquire_runtime_lock(root, second)
                    self.assertEqual(error.exception.code, "runtime_busy")
                worker.release_runtime_lock(root, second)
                self.assertEqual(worker.read_json(lease)["nonce"], "first")
                with mock.patch.object(worker, "lock_process_state", return_value="reused"):
                    worker.acquire_runtime_lock(root, second)
                self.assertEqual(worker.read_json(lease)["nonce"], "second")
                worker.release_runtime_lock(root, first)
                self.assertTrue(lease.exists())
                worker.release_runtime_lock(root, second)
                self.assertFalse(lease.exists())

    def test_proc_permission_failure_is_indeterminate_not_stale(self):
        control = {"pid": 1200, "startTicks": 345}
        with mock.patch.object(Path, "read_text", side_effect=PermissionError("denied")):
            with self.assertRaises(worker.WorkerError) as error:
                worker.lock_process_state(control)
            self.assertEqual(error.exception.code, "runtime_lock_unverified")

    def test_watchdog_signals_only_matching_identity_and_releases_own_lease_after_exit(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            control = {"schemaVersion": 1, "pid": 1234, "startTicks": 345, "nonce": "job-nonce",
                       "outputDir": str(output), "runtimeRoot": str(output / "runtime"), "workerPath": str(MODULE)}
            path = output / "worker-pid.json"
            worker.write_new_json(path, control)
            worker.write_new_json(worker.startup_cancel_path(output), {"schemaVersion": 1, "outputDir": str(output), "requested": True})
            with (mock.patch.object(worker, "process_matches", side_effect=[True, True, False]),
                  mock.patch.object(worker, "lock_process_state", return_value="gone"),
                  mock.patch.object(worker, "release_runtime_lock") as release,
                  mock.patch.object(worker.os, "kill") as kill,
                  mock.patch.object(worker.time, "sleep")):
                self.assertEqual(worker.watchdog(path, "job-nonce"), 0)
                kill.assert_called_once_with(1234, worker.signal.SIGTERM)
                release.assert_called_once_with(Path(control["runtimeRoot"]), control)
            self.assertEqual(worker.read_json(output / "worker-cancellation.json")["signalRequested"], "SIGTERM")


if __name__ == "__main__":
    unittest.main(verbosity=2)
