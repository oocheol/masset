# SPDX-License-Identifier: MIT
"""Meaningful boundary, offline and CPU geometry checks; no inference mocks."""
from pathlib import Path
import hashlib
import json
import socket
import sys
import tempfile
import unittest

ROOT = Path(__file__).absolute().parents[1]
sys.path.insert(0, str(ROOT))
sys.dont_write_bytecode = True
from runtime_common import WorkerError, prepare_output, validate_job, read_json
from setup import wheel_for
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
