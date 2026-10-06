# SPDX-License-Identifier: MIT
"""Cache boundaries and native artifact reuse; never invokes a model."""
from pathlib import Path
import copy
import hashlib
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).absolute().parents[1]
sys.path.insert(0, str(ROOT))
sys.dont_write_bytecode = True
from raw_cache import RawCache, cache_descriptor, checked_path, descriptor_key
from runtime_common import WorkerError, file_receipt, prepare_output, read_json


class CacheFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.cache_root = self.root / "cache"
        self.job = {"name": "Fixture", "sourcePath": str(ROOT / "fixtures" / "blue-sphere.png"),
                    "sourceSha256": file_receipt(ROOT / "fixtures" / "blue-sphere.png")["sha256"],
                    "quality": "draft", "cpuThreads": 2}
        self.ready = {"pythonVersion": "3.12.10", "platform": "Windows", "machine": "AMD64",
                      "dependencies": {"torch": "2.2.2+cpu", "Pillow": "10.1.0"}}
        self.descriptor = cache_descriptor(self.job, self.ready)
        self.output = self.root / "first"
        self.output.mkdir()
        # Standard-library fixtures exercise storage/integrity, not inference.
        (self.output / "mesh.glb").write_bytes(b"bounded raw fixture, not an inference claim")
        (self.output / "prepared-input.png").write_bytes(b"conditioning fixture")
        self.write_generation()

    def tearDown(self):
        self.temporary.cleanup()

    def write_generation(self):
        primary = [file_receipt(self.output / name) for name in ("mesh.glb", "prepared-input.png")]
        generation = {k: self.descriptor[k] for k in ("modelId", "modelRevision", "codeRevision", "modelSha256", "dinoRevision",
                                                    "quality", "cpuThreads", "device")}
        generation.update(schemaVersion=1, generatedAt="2026-10-06T00:00:00+00:00", inferenceExecuted=True,
                          source={"sha256": self.job["sourceSha256"]}, runtime=self.ready,
                          geometry={"fixtureOnly": True}, meshCleanup={}, colorEncoding={},
                          artifacts=primary, stageDurations={"inferenceSeconds": 42})
        (self.output / "generation.json").write_text(json.dumps(generation), encoding="utf-8")

    def load(self, cache):
        return cache.load(file_receipt(self.output / "prepared-input.png"), lambda path, geometry: None)

    def publish(self):
        with RawCache(self.cache_root, self.descriptor) as cache:
            self.assertIsNone(self.load(cache))
            cache.publish(self.output)
            return cache.entry


class CacheBoundaries(CacheFixture):
    def test_reuse_verifies_actual_bytes_and_restores_exclusively(self):
        entry = self.publish()
        destination = self.root / "second"
        destination.mkdir()
        with RawCache(self.cache_root, self.descriptor) as cache:
            cached = self.load(cache)
            cache.restore_mesh(destination)
            self.assertEqual(file_receipt(destination / "mesh.glb"), file_receipt(self.output / "mesh.glb"))
            self.assertEqual(cache.info(True)["originGenerationSha256"], file_receipt(entry / "generation.json")["sha256"])
            self.assertEqual(cache.info(True)["originGeneratedAt"], cached["generatedAt"])
            self.assertFalse(cache.info(True)["inferenceProofUpdated"])
            with self.assertRaises(FileExistsError):
                cache.restore_mesh(destination)
        self.assertNotEqual(file_receipt(entry / "generation.json")["sha256"], file_receipt(entry / "mesh.glb")["sha256"])

    def test_descriptor_invalidates_source_runtime_code_quality_and_threads(self):
        initial = descriptor_key(self.descriptor)
        variants = [({**self.job, "sourceSha256": "1" * 64}, self.ready),
                    ({**self.job, "quality": "high"}, self.ready),
                    ({**self.job, "cpuThreads": 4}, self.ready),
                    (self.job, {**self.ready, "pythonVersion": "3.12.11"}),
                    (self.job, {**self.ready, "dependencies": {"torch": "new"}})]
        for job, ready in variants:
            self.assertNotEqual(descriptor_key(cache_descriptor(job, ready)), initial)
        for field in ("runtimeLock", "modelSha256", "implementations", "preprocessingVersion", "codeRevision"):
            changed = copy.deepcopy(self.descriptor)
            changed[field] = "changed"
            self.assertNotEqual(descriptor_key(changed), initial)
        # Renaming or moving the identical source is not a reconstruction input;
        # texture resolution, max triangles and physical height are downstream.
        self.assertEqual(descriptor_key(cache_descriptor({**self.job, "name": "Renamed", "sourcePath": str(self.root / "same.png"),
                                                          "maxTriangles": 1200, "textureResolution": 1024, "height": .1}, self.ready)), initial)

    def test_corruption_is_preserved_and_explicitly_rebuilt(self):
        entry = self.publish()
        corrupt = b"changed actual bytes"
        (entry / "mesh.glb").write_bytes(corrupt)
        with RawCache(self.cache_root, self.descriptor) as cache:
            self.assertIsNone(self.load(cache))
            self.assertEqual(cache.info()["state"], "recovered")
            self.assertFalse(cache.info()["integrityVerified"])
            preserved = list((self.cache_root / "quarantine").iterdir())
            self.assertEqual(len(preserved), 1)
            self.assertEqual((preserved[0] / "mesh.glb").read_bytes(), corrupt)
            cache.publish(self.output)
        with RawCache(self.cache_root, self.descriptor) as cache:
            self.assertIsNotNone(self.load(cache))

    def test_invalid_inventory_paths_duplicates_and_inference_claims_never_hit(self):
        for kind in ("traversal", "duplicate", "boolean-size", "bad-provenance", "restored-origin"):
            with self.subTest(kind=kind):
                self.cache_root = self.root / kind
                entry = self.publish()
                receipt = read_json(entry / "receipt.json")
                if kind == "traversal":
                    receipt["artifacts"][0]["basename"] = "../outside.glb"
                elif kind == "duplicate":
                    receipt["artifacts"][1] = receipt["artifacts"][0]
                elif kind == "boolean-size":
                    receipt["artifacts"][0]["bytes"] = True
                else:
                    generation = read_json(entry / "generation.json")
                    generation["inferenceExecuted"] = False if kind == "restored-origin" else True
                    if kind == "bad-provenance":
                        generation["source"] = []
                    (entry / "generation.json").write_text(json.dumps(generation), encoding="utf-8")
                    receipt["artifacts"][2] = file_receipt(entry / "generation.json")
                (entry / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
                with RawCache(self.cache_root, self.descriptor) as cache:
                    self.assertIsNone(self.load(cache))
                    self.assertTrue(cache.recovered)
        self.assertFalse((self.root / "outside.glb").exists())

    def test_ownership_marker_populated_dirs_and_traversal_preserve_originals(self):
        unknown = self.root / "user-originals"
        unknown.mkdir()
        original = unknown / "asset.png"
        original.write_bytes(b"original")
        for path in (unknown, Path("relative-cache"), self.root / "unowned" / ".." / "escaped"):
            with self.assertRaises(WorkerError) as caught, RawCache(path, self.descriptor):
                pass
            self.assertEqual(caught.exception.code, "cache_path")
        self.assertEqual(original.read_bytes(), b"original")
        self.assertFalse((self.root / "escaped").exists())

    def test_hard_links_and_junctions_are_rejected_without_following(self):
        entry = self.publish()
        external = self.root / "must-stay"
        external.write_bytes((entry / "mesh.glb").read_bytes())
        (entry / "mesh.glb").unlink()
        os.link(external, entry / "mesh.glb")
        with RawCache(self.cache_root, self.descriptor) as cache, self.assertRaises(WorkerError) as caught:
            self.load(cache)
        self.assertEqual(caught.exception.code, "cache_path")
        self.assertEqual(external.read_bytes(), b"bounded raw fixture, not an inference claim")
        alias = self.root / "alias"
        if os.name == "nt":
            result = subprocess.run(["cmd", "/c", "mklink", "/J", str(alias), str(self.cache_root)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            alias.symlink_to(self.cache_root, target_is_directory=True)
        try:
            with self.assertRaises(WorkerError) as caught, RawCache(alias, self.descriptor):
                pass
            self.assertEqual(caught.exception.code, "cache_path")
        finally:
            os.rmdir(alias) if os.name == "nt" else alias.unlink()

    def test_fresh_preprocessing_mismatch_never_reuses_an_old_prepared_image(self):
        self.publish()
        (self.output / "prepared-input.png").write_bytes(b"current source differs")
        with RawCache(self.cache_root, self.descriptor) as cache:
            self.assertIsNone(self.load(cache))
            self.assertTrue(cache.recovered)

    def test_geometry_verifier_runs_before_accepting_byte_valid_entry(self):
        self.publish()
        def reject(path, geometry):
            raise WorkerError("artifact_verification", "The actual GLB is invalid")
        with RawCache(self.cache_root, self.descriptor) as cache:
            self.assertIsNone(cache.load(file_receipt(self.output / "prepared-input.png"), reject))
            self.assertTrue(cache.recovered)

    def test_interrupted_unpublished_entry_is_preserved_and_never_reused(self):
        with RawCache(self.cache_root, self.descriptor) as cache:
            partial = self.cache_root / "entries" / (".publish-" + cache.key + "-abandoned")
            partial.mkdir()
            original = partial / "mesh.glb"
            original.write_bytes(b"interrupted partial output")
            self.assertIsNone(self.load(cache))
            cache.publish(self.output)
            self.assertEqual(original.read_bytes(), b"interrupted partial output")
        with RawCache(self.cache_root, self.descriptor) as cache:
            self.assertIsNotNone(self.load(cache))
        self.assertEqual(original.read_bytes(), b"interrupted partial output")

    def test_concurrent_owner_publishes_once_and_abrupt_death_releases_lock(self):
        script = """
from pathlib import Path
import json, sys
sys.path.insert(0, sys.argv[1])
from raw_cache import RawCache
from runtime_common import file_receipt
with RawCache(Path(sys.argv[2]), json.loads(sys.argv[3]), wait_seconds=5) as cache:
    print('owned', flush=True)
    if sys.argv[5] == 'hold':
        sys.stdin.buffer.read(1)
    output = Path(sys.argv[4])
    existing = cache.load(file_receipt(output / 'prepared-input.png'), lambda *args: None)
    if existing:
        print('hit', flush=True)
    else:
        cache.publish(output)
        print('published', flush=True)
"""
        command = [sys.executable, "-I", "-B", "-c", script, str(ROOT), str(self.cache_root),
                   json.dumps(self.descriptor), str(self.output)]
        owner = subprocess.Popen([*command, "hold"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        second = None
        try:
            self.assertEqual(owner.stdout.readline().strip(), b"owned")
            second = subprocess.Popen([*command, "once"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            time.sleep(.15)
            self.assertIsNone(second.poll(), "Second process must wait for the key owner")
            owner.stdin.write(b"x")
            owner.stdin.flush()
            first_stdout, first_stderr = owner.communicate(timeout=15)
            second_stdout, second_stderr = second.communicate(timeout=15)
            self.assertEqual(owner.returncode, 0, first_stderr)
            self.assertEqual(second.returncode, 0, second_stderr)
            self.assertIn(b"published", first_stdout)
            self.assertIn(b"hit", second_stdout)
            self.assertNotIn(b"published", second_stdout)
            self.assertEqual(len(list((self.cache_root / "entries").iterdir())), 1)
            owner = subprocess.Popen([*command, "hold"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(owner.stdout.readline().strip(), b"owned")
            owner.kill()
            owner.communicate(timeout=15)
            retry = subprocess.run([*command, "once"], capture_output=True, timeout=15)
            self.assertEqual(retry.returncode, 0, retry.stderr)
            self.assertIn(b"hit", retry.stdout)
        finally:
            for process in (owner, second):
                if process is not None:
                    if process.poll() is None:
                        process.kill()
                    process.communicate(timeout=15)

    def test_source_change_during_work_fails_before_success(self):
        from worker import verify_source_unchanged
        source = self.root / "source.png"
        source.write_bytes(b"original")
        job = {"sourcePath": str(source), "sourceSha256": hashlib.sha256(b"original").hexdigest()}
        verify_source_unchanged(job, 8)
        source.write_bytes(b"changed!")
        with self.assertRaises(WorkerError) as caught:
            verify_source_unchanged(job, 8)
        self.assertEqual(caught.exception.code, "source_changed")
        self.assertEqual(source.read_bytes(), b"changed!")


class NativeCacheGeometry(CacheFixture):
    @classmethod
    def setUpClass(cls):
        try:
            import numpy
            import trimesh
            import PIL
        except ImportError:
            raise unittest.SkipTest("Prepared runtime required for actual GLB/color/image checks")

    def setUp(self):
        super().setUp()
        import numpy as np
        import trimesh
        from PIL import Image
        from glb_color import export_linear_color0
        from worker import orient_and_verify
        mesh = trimesh.creation.icosphere(subdivisions=1)
        mesh.visual.vertex_colors = np.tile([60, 100, 180, 255], (len(mesh.vertices), 1))
        self.geometry = orient_and_verify(mesh)
        data, color_encoding = export_linear_color0(mesh.export(file_type="glb"), np.tile([.2, .3, .6], (len(mesh.vertices), 1)))
        self.geometry.update(vertexColorSpace="linear RGB", vertexColorComponentType="FLOAT32")
        (self.output / "mesh.glb").write_bytes(data)
        Image.new("RGB", (512, 512), (128, 128, 128)).save(self.output / "prepared-input.png")
        self.write_generation()
        generation = read_json(self.output / "generation.json")
        generation.update(geometry=self.geometry, colorEncoding=color_encoding)
        (self.output / "generation.json").write_text(json.dumps(generation), encoding="utf-8")

    # Only these native cases are needed; standard-library cases already run.
    def test_native_glb_round_trip_and_corrupt_geometry_recovery(self):
        from worker import verify_cached_mesh
        entry = self.publish()
        target = self.root / "reopened"
        target.mkdir()
        with RawCache(self.cache_root, self.descriptor) as cache:
            self.assertIsNotNone(cache.load(file_receipt(self.output / "prepared-input.png"), verify_cached_mesh))
            cache.restore_mesh(target)
            verify_cached_mesh(target / "mesh.glb", self.geometry)
        # Change actual geometry while deliberately recomputing its inventory:
        # byte receipts alone must not turn this into a valid cache hit.
        data = bytearray((entry / "mesh.glb").read_bytes())
        json_size = struct.unpack_from("<I", data, 12)[0]
        first_binary = 28 + json_size
        data[first_binary:first_binary+4] = struct.pack("<f", float("nan"))
        (entry / "mesh.glb").write_bytes(data)
        generation = read_json(entry / "generation.json")
        generation["artifacts"][0] = file_receipt(entry / "mesh.glb")
        (entry / "generation.json").write_text(json.dumps(generation), encoding="utf-8")
        receipt = read_json(entry / "receipt.json")
        receipt["artifacts"] = [file_receipt(entry / name) for name in ("mesh.glb", "prepared-input.png", "generation.json")]
        (entry / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
        with RawCache(self.cache_root, self.descriptor) as cache:
            self.assertIsNone(cache.load(file_receipt(self.output / "prepared-input.png"), verify_cached_mesh))
            self.assertTrue(cache.recovered)

    def test_cache_hit_receipt_keeps_ready_inference_proof_untouched(self):
        from worker import finish_generation
        self.publish()
        target = prepare_output(self.root / "hit")
        (target / "prepared-input.png").write_bytes((self.output / "prepared-input.png").read_bytes())
        ready_path = self.root / "ready.json"
        previous = b'{"installVerified":true,"inferenceVerified":false,"inferenceProof":"do-not-replace"}\n'
        ready_path.write_bytes(previous)
        with RawCache(self.cache_root, self.descriptor) as cache:
            cached = self.load(cache)
            cache.restore_mesh(target)
            finish_generation(self.root, {**self.job, "name": "New output"}, target,
                              {"sourceBytes": 123}, self.ready, cached["geometry"], {}, cached["colorEncoding"],
                              {"cacheRestoreSeconds": .1, "inferenceSeconds": 0}, time.monotonic(),
                              cache, cache.info(True), False)
        self.assertEqual(ready_path.read_bytes(), previous)
        current = read_json(target / "generation.json")
        self.assertFalse(current["inferenceExecuted"])
        self.assertTrue(current["cache"]["hit"])
        self.assertEqual(current["name"], "New output")
        self.assertEqual(current["artifacts"], [file_receipt(target / "mesh.glb"), file_receipt(target / "prepared-input.png")])
        self.assertEqual(current["stageDurations"]["inferenceSeconds"], 0)


if __name__ == "__main__":
    suite = unittest.TestSuite()
    suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(CacheBoundaries))
    suite.addTests(NativeCacheGeometry(name) for name in ("test_native_glb_round_trip_and_corrupt_geometry_recovery",
                                                        "test_cache_hit_receipt_keeps_ready_inference_proof_untouched"))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
