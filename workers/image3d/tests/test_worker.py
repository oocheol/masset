# SPDX-License-Identifier: MIT
"""Meaningful boundary, offline and CPU geometry checks; no inference mocks."""
from pathlib import Path
import hashlib
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

ROOT = Path(__file__).absolute().parents[1]
sys.path.insert(0, str(ROOT))
sys.dont_write_bytecode = True
from runtime_common import (WorkerError, clean_env, embedded_files, embedded_pth, file_receipt,
                            interpreter_target, lock_path, prepare_output,
                            require_windows_vc_runtime, setup_lock_active,
                            validate_interpreter, validate_job, read_json,
                            release_windows_setup_lock, windows_setup_lock)
from setup import approved_url, wheel_for
from status import status


class Boundaries(unittest.TestCase):
    def setUp(self):
        (ROOT / "output").mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=str(ROOT / "output"))
        self.root = Path(self.temporary.name)
        self.job = {"name": "One object", "sourcePath": str(ROOT / "fixtures/blue-sphere.png"),
                    "sourceSha256": hashlib.sha256((ROOT / "fixtures/blue-sphere.png").read_bytes()).hexdigest(),
                    "quality": "draft", "cpuThreads": 4}

    def tearDown(self):
        self.temporary.cleanup()

    def write_job(self, job):
        path = self.root / "input.json"
        path.write_text(json.dumps(job))
        return path

    def test_exact_valid_schema(self):
        self.assertEqual(validate_job(self.write_job(self.job)), self.job)

    def test_unknown_or_missing_keys(self):
        for job in ({**self.job, "code": "print('do not run')"}, {k: v for k, v in self.job.items() if k != "quality"}):
            with self.assertRaises(WorkerError):
                validate_job(self.write_job(job))

    def test_unsafe_names(self):
        for name in ("", " ", " leading", "trailing ", ".", "..", "../code", "a\\b", "a\x00", "a\n", "NUL", "COM1.png", "a.", "a"*81, "a\u202eb"):
            with self.subTest(name=name), self.assertRaises(WorkerError):
                validate_job(self.write_job({**self.job, "name": name}))

    def test_threads_quality_and_hash_types(self):
        for key, values in {"cpuThreads": (True, False, 0, 5, 1.0, "2"), "quality": ([], "ultra", None),
                            "sourceSha256": ("f"*63, "g"*64, None)}.items():
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(WorkerError):
                    validate_job(self.write_job({**self.job, key: value}))

    def test_source_must_be_absolute_raster_path(self):
        for path in ("relative.png", str(self.root / "generated.py"), str(self.root / "source.blend"), "/a\x00.png"):
            with self.assertRaises(WorkerError):
                validate_job(self.write_job({**self.job, "sourcePath": path}))

    def test_duplicate_and_nonfinite_json(self):
        path = self.root / "bad.json"
        for text in ('{"name":"first","name":"second"}', '{"value":NaN}', '{"value":Infinity}', "[]\n[]"):
            path.write_text(text)
            with self.assertRaises(WorkerError):
                read_json(path)

    def test_oversized_job(self):
        path = self.root / "big.json"
        path.write_bytes(b" "*20000)
        with self.assertRaises(WorkerError):
            validate_job(path)

    def test_output_empty_existing_and_reservation(self):
        target = self.root / "existing-empty"
        target.mkdir()
        prepare_output(target)
        with self.assertRaises(WorkerError):
            prepare_output(target)

    def test_populated_output_preserves_contents(self):
        target = self.root / "populated"
        target.mkdir()
        original = target / "original.png"
        original.write_bytes(b"untouched")
        with self.assertRaises(WorkerError):
            prepare_output(target)
        self.assertEqual(original.read_bytes(), b"untouched")

    def test_output_symlink_rejected(self):
        if sys.platform == "win32":
            self.skipTest("Symlink privilege is not assumed on Windows")
        target = self.root / "real"
        target.mkdir()
        link = self.root / "alias"
        link.symlink_to(target, target_is_directory=True)
        with self.assertRaises(WorkerError):
            prepare_output(link)
        self.assertEqual(list(target.iterdir()), [])

    def test_missing_and_forged_runtime_status(self):
        self.assertEqual(status(self.root)["state"], "missing")
        (self.root / "ready.json").write_text(json.dumps({"state": "ready", "token": "not-for-output"}))
        result = status(self.root)
        self.assertEqual(result["state"], "error")
        self.assertFalse(result["installed"])
        self.assertNotIn("not-for-output", json.dumps(result))

    def test_only_compatible_pinned_wheel_selected(self):
        entry = {"wheels": [{"filename": "thing-1-cp39-cp39-macosx_11_0_arm64.whl"},
                             {"filename": "thing-1-cp39-cp39-win_amd64.whl"}]}
        result = wheel_for(entry, ["cp39-cp39-macosx_11_0_arm64"])
        self.assertTrue(result["filename"].endswith("arm64.whl"))
        with self.assertRaises(WorkerError):
            wheel_for(entry, ["cp312-cp312-linux_x86_64"])

    def test_platform_locks_preserve_model_and_code_but_select_windows_binaries(self):
        mac = read_json(lock_path("Darwin"))
        windows = read_json(lock_path("Windows"))
        self.assertEqual(interpreter_target(mac)["pythonMajorMinor"], [3, 9])
        self.assertEqual(interpreter_target(windows)["pythonMajorMinor"], [3, 12])
        for key in ("codeArchive", "codeFiles", "originalCodeFiles", "runtimeFiles"):
            self.assertEqual(mac[key], windows[key])
        self.assertEqual(windows["packages"]["torch"]["version"], "2.2.2+cpu")
        self.assertEqual(windows["packages"]["tokenizers"]["version"], "0.15.2")
        self.assertEqual(windows["packages"]["transformers"]["version"], "4.35.2")
        for name, entry in windows["packages"].items():
            if "source" not in entry:
                selected = wheel_for(entry, ["cp312-cp312-win_amd64", "cp312-none-win_amd64", "cp38-abi3-win_amd64", "py3-none-any"])
                self.assertNotIn("macos", selected["filename"])
                self.assertNotIn("linux", selected["filename"])

    def test_wrong_platform_python_or_pointer_width_rejected(self):
        windows = read_json(lock_path("Windows"))
        base = {"implementation": "CPython", "platform": "Windows", "machine": "AMD64", "version": [3, 12, 10], "pointerBits": 64}
        validate_interpreter(base, windows)
        for change in ({"version": [3, 11, 9]}, {"machine": "ARM64"}, {"platform": "Darwin"}, {"pointerBits": 32}, {"implementation": "PyPy"}):
            with self.subTest(change=change), self.assertRaises(WorkerError):
                validate_interpreter({**base, **change}, windows)

    @unittest.skipUnless(sys.platform == "win32" and sys.version_info[:2] == (3, 12),
                         "Pinned Windows CPython 3.12 WMI fallback")
    def test_isolated_python_identifies_cpu_when_wmi_is_unavailable(self):
        # CPython 3.12 uses these OS fields when WMI is unavailable. Exercise
        # the real interpreter after environment sanitation, including an
        # unsupported architecture; missing WMI must not relax the platform gate.
        probe = ("import json,platform,struct,sys,_wmi; "
                 "_wmi.exec_query=lambda *_: (_ for _ in ()).throw(OSError('QA WMI unavailable')); "
                 "platform._uname_cache=None; "
                 "print(json.dumps({'implementation':platform.python_implementation(), "
                 "'platform':platform.system(),'machine':platform.machine(), "
                 "'version':list(sys.version_info[:3]),'pointerBits':struct.calcsize('P')*8}))")
        target = read_json(lock_path("Windows"))
        for architecture in ("AMD64", "ARM64"):
            with self.subTest(architecture=architecture), patch.dict(os.environ, {
                "PROCESSOR_ARCHITECTURE": architecture,
                "PROCESSOR_ARCHITEW6432": architecture,
                "HF_TOKEN": "qa-token-must-be-removed", "HTTPS_PROXY": "qa-proxy",
                "PYTHONPATH": "qa-user-code",
            }):
                env = clean_env(self.root)
                for secret in ("HF_TOKEN", "HTTPS_PROXY", "PYTHONPATH"):
                    self.assertNotIn(secret, env)
                result = subprocess.run([sys.executable, "-I", "-B", "-c", probe],
                                        env=env, cwd=str(self.root), capture_output=True,
                                        text=True, timeout=20, check=True)
                identity = json.loads(result.stdout)
                self.assertEqual(identity["machine"], architecture)
                if architecture == "AMD64":
                    validate_interpreter(identity, target)
                else:
                    with self.assertRaises(WorkerError):
                        validate_interpreter(identity, target)

    def embedded_zip(self, extras=()):
        archive = self.root / "embedded.zip"
        with zipfile.ZipFile(archive, "w") as handle:
            for name in ("python.exe", "python312.dll", "python312.zip", "python312._pth", "LICENSE.txt"):
                handle.writestr(name, b"unexecuted test data")
            for name in extras:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    handle.writestr(name, b"unexecuted test data")
        return archive, file_receipt(archive)

    def test_embedded_zip_integrity_and_explicit_isolation_paths(self):
        archive, expected = self.embedded_zip()
        files = embedded_files(archive, expected)
        self.assertEqual(files["python312._pth"], embedded_pth())
        self.assertNotIn(b"..", files["python312._pth"])
        archive.write_bytes(archive.read_bytes() + b"changed")
        with self.assertRaisesRegex(WorkerError, "integrity"):
            embedded_files(archive, expected)

    def test_embedded_zip_rejects_escape_duplicate_and_special_entries(self):
        for name in ("../escape.exe", "C:/escape.exe", "folder/file.py", "folder\\file.py", "python.exe", "name.", "name "):
            with self.subTest(name=name):
                archive, expected = self.embedded_zip([name])
                with self.assertRaisesRegex(WorkerError, "ZIP entry"):
                    embedded_files(archive, expected)
        archive, _ = self.embedded_zip()
        link = zipfile.ZipInfo("link.exe")
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(archive, "a") as handle:
            handle.writestr(link, "python.exe")
        with self.assertRaisesRegex(WorkerError, "ZIP entry"):
            embedded_files(archive, file_receipt(archive))
        self.assertFalse((self.root.parent / "escape.exe").exists())

    def test_download_origins_do_not_accept_lookalike_or_cleartext_hosts(self):
        approved_url("https://download.pytorch.org/whl/cpu/torch.whl")
        approved_url("https://www.python.org/ftp/python/runtime.zip")
        for url in ("http://download.pytorch.org/file", "https://download.pytorch.org.attacker.example/file",
                    "https://www.python.org@attacker.example/file", "https://user:secret@www.python.org/file"):
            with self.assertRaises(WorkerError):
                approved_url(url)

    @unittest.skipUnless(sys.platform == "win32", "Native Windows memory API")
    def test_real_windows_memory_and_hardware_are_measured(self):
        from worker import hardware, peak_memory
        self.assertGreater(peak_memory(), 0)
        self.assertGreater(hardware(self.root)["ramBytes"], 0)
        self.assertEqual(hardware(self.root)["system"], "Windows")

    @unittest.skipUnless(sys.platform == "win32", "Windows DLL prerequisite")
    def test_missing_msvc_prerequisite_has_an_actionable_error(self):
        with patch.dict(os.environ, {"SystemRoot": str(self.root / "missing-system")}), self.assertRaises(WorkerError) as caught:
            require_windows_vc_runtime()
        self.assertEqual(caught.exception.code, "msvc_runtime_missing")
        self.assertIn("MSVCP140.dll", str(caught.exception))
        self.assertIn("https://learn.microsoft.com", str(caught.exception))

    @unittest.skipUnless(sys.platform == "win32", "Windows process-lifetime byte-range locks")
    def test_setup_rejects_live_owner_and_recovers_after_abrupt_process_death(self):
        lock = self.root / ".setup-lock"
        script = """
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from runtime_common import WorkerError, windows_setup_lock, release_windows_setup_lock
try:
    handle = windows_setup_lock(Path(sys.argv[2]))
except WorkerError as error:
    print(error.code, flush=True)
    sys.exit(42)
print('acquired', flush=True)
if sys.argv[3] == 'hold':
    sys.stdin.buffer.read(1)
release_windows_setup_lock(handle)
"""
        command = [sys.executable, "-I", "-B", "-c", script, str(ROOT), str(lock)]
        owner = subprocess.Popen([*command, "hold"], cwd=str(self.root), env=clean_env(self.root),
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertEqual(owner.stdout.readline().strip(), b"acquired")
            self.assertTrue(setup_lock_active(lock))
            rejected = subprocess.run([*command, "once"], cwd=str(self.root), env=clean_env(self.root),
                                      capture_output=True, timeout=15)
            self.assertEqual(rejected.returncode, 42, rejected.stderr)
            self.assertEqual(rejected.stdout.strip(), b"setup_running")
            owner.kill()
            owner.communicate(timeout=15)
            self.assertTrue(lock.is_file())
            self.assertFalse(setup_lock_active(lock))
            retry = subprocess.run([*command, "once"], cwd=str(self.root), env=clean_env(self.root),
                                   capture_output=True, timeout=15)
            self.assertEqual(retry.returncode, 0, retry.stderr)
            self.assertEqual(retry.stdout.strip(), b"acquired")
            self.assertFalse(setup_lock_active(lock))
        finally:
            if owner.poll() is None:
                owner.kill()
            owner.communicate(timeout=15)

    @unittest.skipUnless(sys.platform == "win32", "Windows inactive lock receipt")
    def test_inactive_windows_lock_receipt_does_not_claim_setup_in_progress(self):
        lock = self.root / ".setup-lock"
        handle = windows_setup_lock(lock)
        release_windows_setup_lock(handle)
        self.assertTrue(lock.exists())
        self.assertFalse(setup_lock_active(lock))
        self.assertEqual(status(self.root)["message"], "Pinned CPU runtime is not installed")


class NativeCPU(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import torch
            import numpy
            import skimage
            import trimesh
        except ImportError:
            raise unittest.SkipTest("Run with the prepared runtime interpreter for native CPU checks")

    def test_asymmetric_ellipsoid_axes_and_outward_winding(self):
        import numpy as np
        import torch
        import trimesh
        from image3d_adapter import marching_cubes
        n = 41
        x, y, z = np.meshgrid(*(np.linspace(-1, 1, n) for _ in range(3)), indexing="ij")
        density = 1 - ((x-.2)/.5)**2 - ((y+.15)/.3)**2 - ((z-.1)/.2)**2
        vertices, faces = marching_cubes(torch.tensor(density, dtype=torch.float32), 0)
        mesh = trimesh.Trimesh(vertices=vertices.numpy()[:, ::-1]/(n-1)*2-1, faces=faces.numpy(), process=False)
        np.testing.assert_allclose(mesh.bounds, [[-.3, -.45, -.1], [.7, .15, .3]], atol=.003)
        self.assertTrue(mesh.is_watertight)
        self.assertTrue(mesh.is_winding_consistent)
        self.assertGreater(mesh.volume, 0)

    def test_empty_density_rejected(self):
        import torch
        from image3d_adapter import marching_cubes
        with self.assertRaisesRegex(ValueError, "No surface"):
            marching_cubes(torch.zeros((5, 5, 5)), 0)

    def test_standard_srgb_transfer_values(self):
        import numpy as np
        from glb_color import srgb_to_linear, linear_to_srgb
        rgb = np.array([0, .04045, .2, .5, 1], dtype=np.float32)
        np.testing.assert_allclose(srgb_to_linear(rgb), [0, .003130805, .033104767, .21404114, 1], atol=1e-7)
        np.testing.assert_allclose(linear_to_srgb(srgb_to_linear(rgb)), rgb, atol=2e-7)

    def test_glb_float_colors_preserve_geometry_and_precision(self):
        import numpy as np
        import trimesh
        from glb_color import export_linear_color0, unpack_glb, read_color0, srgb_to_linear, linear_to_srgb
        mesh = trimesh.creation.icosphere(subdivisions=1)
        mesh.visual.vertex_colors = np.tile([50, 70, 90, 255], (len(mesh.vertices), 1))
        before = mesh.export(file_type="glb")
        original_document, original_binary = unpack_glb(before)
        rgb = np.linspace(.00001, .99999, len(mesh.vertices)*3, dtype=np.float32).reshape(-1, 3)
        after, metadata = export_linear_color0(before, rgb)
        document, binary = unpack_glb(after)
        self.assertEqual(binary[:len(original_binary)], original_binary)
        self.assertEqual(document["meshes"][0]["primitives"][0]["indices"], original_document["meshes"][0]["primitives"][0]["indices"])
        self.assertEqual(document["meshes"][0]["primitives"][0]["attributes"]["POSITION"], original_document["meshes"][0]["primitives"][0]["attributes"]["POSITION"])
        colors, accessor = read_color0(after)
        self.assertEqual(accessor["componentType"], 5126)
        self.assertEqual(accessor["type"], "VEC4")
        self.assertFalse(accessor.get("normalized", False))
        np.testing.assert_array_equal(colors[:, :3], srgb_to_linear(rgb))
        np.testing.assert_array_equal(colors[:, 3], np.ones(len(mesh.vertices), dtype=np.float32))
        np.testing.assert_allclose(linear_to_srgb(colors[:, :3]), rgb, atol=2e-7)
        self.assertFalse(metadata["uint8QuantizationBeforeExport"])
        self.assertLess(metadata["roundTripMaxAbsoluteError"], 2e-7)
        self.assertEqual(unpack_glb(before)[1], original_binary)

    def test_glb_rejects_invalid_color_samples(self):
        import numpy as np
        import trimesh
        from glb_color import export_linear_color0
        mesh = trimesh.creation.box()
        mesh.visual.vertex_colors = np.tile([50, 70, 90, 255], (len(mesh.vertices), 1))
        data = mesh.export(file_type="glb")
        for rgb in (np.zeros((len(mesh.vertices)-1, 3)), np.full((len(mesh.vertices), 3), np.nan),
                    np.full((len(mesh.vertices), 3), -.1), np.full((len(mesh.vertices), 3), 1.1)):
            with self.assertRaises(ValueError):
                export_linear_color0(data, rgb)

    @staticmethod
    def mesh_with_numeric_slivers(count=1, scale=1):
        import numpy as np
        import trimesh
        base = trimesh.creation.icosphere(subdivisions=2)
        vertices = base.vertices.tolist()
        faces = base.faces.tolist()
        for _ in range(count):
            index = len(vertices)
            vertices.extend([[.2, .2, .2], [.2000001, .2, .2], [.2, .2000001, .2]])
            faces.append([index, index+1, index+2])
        mesh = trimesh.Trimesh(vertices=np.asarray(vertices)*scale, faces=faces, process=False)
        mesh.visual.vertex_colors = np.tile([50, 70, 90, 255], (len(mesh.vertices), 1))
        return base, mesh

    def test_numeric_cleanup_is_scale_relative_and_preserves_remaining_faces(self):
        import numpy as np
        from worker import remove_numeric_degenerates
        for scale in (.001, 1, 1000):
            with self.subTest(scale=scale):
                base, mesh = self.mesh_with_numeric_slivers(scale=scale)
                result = remove_numeric_degenerates(mesh)
                self.assertEqual(result["removedTriangleCount"], 1)
                self.assertEqual(result["removedUnreferencedVertexCount"], 3)
                self.assertLess(result["removedSurfaceAreaFraction"], 1e-8)
                np.testing.assert_array_equal(mesh.faces, base.faces)
                np.testing.assert_allclose(mesh.vertices, base.vertices*scale)
                np.testing.assert_allclose(mesh.face_normals, base.face_normals, atol=1e-12)
                np.testing.assert_array_equal(mesh.visual.vertex_colors, np.tile([50, 70, 90, 255], (len(base.vertices), 1)))
                self.assertTrue(mesh.is_watertight and mesh.is_winding_consistent)

    def test_cleanup_rejects_excessive_removal(self):
        from worker import remove_numeric_degenerates
        _, mesh = self.mesh_with_numeric_slivers(count=4)
        with self.assertRaisesRegex(WorkerError, "Too many"):
            remove_numeric_degenerates(mesh)

    def test_strict_geometry_check_requires_cleanup(self):
        from worker import orient_and_verify, remove_numeric_degenerates
        _, mesh = self.mesh_with_numeric_slivers()
        with self.assertRaisesRegex(WorkerError, "degenerate triangles"):
            orient_and_verify(mesh)
        _, mesh = self.mesh_with_numeric_slivers()
        remove_numeric_degenerates(mesh)
        result = orient_and_verify(mesh)
        self.assertGreater(result["minimumTriangleAreaSquareMeters"], 1e-12)

    def test_offline_guard_denies_network(self):
        from worker import offline_guard
        original = (socket.socket.connect, socket.socket.connect_ex, socket.create_connection)
        try:
            offline_guard()
            with self.assertRaisesRegex(WorkerError, "Network access is disabled"):
                socket.create_connection(("huggingface.co", 443))
            with socket.socket() as handle, self.assertRaises(WorkerError):
                handle.connect(("127.0.0.1", 9))
        finally:
            socket.socket.connect, socket.socket.connect_ex, socket.create_connection = original

    def test_owned_alpha_fixture_and_source_hash(self):
        from image_input import prepare_image
        source = ROOT / "fixtures/blue-sphere.png"
        job = {"sourcePath": str(source), "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest()}
        prepared, receipt = prepare_image(job)
        self.assertEqual(prepared.size, (512, 512))
        self.assertEqual(prepared.mode, "RGB")
        self.assertFalse(receipt["backgroundRemoval"])
        with self.assertRaisesRegex(WorkerError, "Source SHA-256 differs"):
            prepare_image({**job, "sourceSha256": "0"*64})

    def test_source_text_disguised_as_png_is_not_executed(self):
        from image_input import prepare_image
        with tempfile.TemporaryDirectory(dir=str(ROOT / "output")) as folder:
            folder = Path(folder)
            source = folder / "generated.png"
            marker = folder / "must-not-exist"
            source.write_text("from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('executed')\n")
            with self.assertRaises(WorkerError) as caught:
                prepare_image({"sourcePath": str(source), "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest()})
            self.assertEqual(caught.exception.code, "invalid_image")
            self.assertFalse(marker.exists())

    def test_opaque_and_multiple_objects_rejected(self):
        from PIL import Image, ImageDraw
        from image_input import prepare_image
        with tempfile.TemporaryDirectory(dir=str(ROOT / "output")) as folder:
            folder = Path(folder)
            for kind in ("opaque", "multiple", "empty"):
                source = folder / (kind + ".png")
                image = Image.new("RGBA", (128, 128), (60, 120, 200, 255) if kind == "opaque" else (0, 0, 0, 0))
                if kind == "multiple":
                    draw = ImageDraw.Draw(image)
                    draw.ellipse((10, 30, 40, 80), fill=(255, 0, 0, 255))
                    draw.ellipse((75, 30, 110, 80), fill=(0, 255, 0, 255))
                image.save(source)
                with self.subTest(kind=kind), self.assertRaises(WorkerError) as caught:
                    prepare_image({"sourcePath": str(source), "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest()})
                self.assertEqual(caught.exception.code, {"opaque": "unsupported_background", "multiple": "multiple_objects", "empty": "empty_foreground"}[kind])


if __name__ == "__main__":
    unittest.main(verbosity=2)
