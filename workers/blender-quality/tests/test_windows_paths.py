# SPDX-License-Identifier: GPL-3.0-or-later
"""Path identity regressions; deterministic Win32 cases also run on other OSes."""
import hashlib
import json
import ntpath
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from audit import (_ordinary_windows_path, _windows_blender_filename,
                   blender_filename, filesystem_path, prepare_output,
                   read_parameters, verify_source)
from test_audit import container, fixture


class WindowsSyntaxTests(unittest.TestCase):
    def test_drive_and_unc_canonical_names(self):
        for original, ordinary in (
            (r"\\?\C:\project\한글 경로\model.glb", r"C:\project\한글 경로\model.glb"),
            (r"\\?\UNC\server\share\project\model.glb", r"\\server\share\project\model.glb"),
            ("\\\\?\\C:/project/model.glb", r"C:\project\model.glb"),
        ):
            with self.subTest(path=original):
                self.assertEqual(_ordinary_windows_path(original), ordinary)

    def test_verbatim_target_changes_and_devices_are_rejected(self):
        cases = [r"\\.\C:\model.glb", r"\\?\GLOBALROOT\Device\file.glb",
                 r"\\?\Volume{fake}\file.glb", r"\\?\C:\project.\model.glb",
                 "\\\\?\\C:\\project \\model.glb", r"\\?\C:\project\..\model.glb",
                 r"\\?\C:\project\.\model.glb", r"\\?\C:\project\NUL.glb",
                 r"\\?\C:\project\COM1.glb", r"\\?\C:\project\model.glb:stream",
                 r"\\?\UNC\server\share.\model.glb", "\\\\?\\C:\\project\\a\0.glb"]
        for path in cases:
            with self.subTest(path=path), self.assertRaises(ValueError):
                _ordinary_windows_path(path)

    def test_short_canonical_path_checks_parent_and_existing_file_identity(self):
        original = r"\\?\C:\project\model.glb"
        with patch("audit.os.path.samefile", return_value=True) as same, \
                patch("audit.os.path.exists", return_value=True), \
                patch("audit._windows_short_path") as short:
            self.assertEqual(_windows_blender_filename(original), r"C:\project\model.glb")
            self.assertEqual(same.call_args_list[0].args, (r"C:\project", r"\\?\C:\project"))
            self.assertEqual(same.call_args_list[1].args, (r"C:\project\model.glb", original))
            short.assert_not_called()

    def test_long_parent_uses_only_verified_alias_without_changing_basename(self):
        original = "\\\\?\\C:\\" + ("한글 경로" * 60) + "\\game-ready.model.partial.glb"
        alias = r"\\?\C:\PROJECT~1\OUTPUT~1"
        with patch("audit._windows_short_path", return_value=alias) as short, \
                patch("audit.os.path.samefile", return_value=True) as same, \
                patch("audit.os.path.exists", return_value=False):
            result = _windows_blender_filename(original)
            self.assertEqual(result, r"C:\PROJECT~1\OUTPUT~1\game-ready.model.partial.glb")
            short.assert_called_once_with(ntpath.dirname(original))
            same.assert_called_once_with(r"C:\PROJECT~1\OUTPUT~1", ntpath.dirname(original))

    def test_filename_and_utf16_units_count_toward_max_path(self):
        for component in ("x" * 232, "😀" * 117):
            original = "\\\\?\\C:\\" + component + "\\game-ready.model.partial.glb"
            with self.subTest(component=component), \
                    patch("audit._windows_short_path", return_value=r"C:\SHORT~1") as short, \
                    patch("audit.os.path.samefile", return_value=True), \
                    patch("audit.os.path.exists", return_value=False):
                self.assertEqual(_windows_blender_filename(original), r"C:\SHORT~1\game-ready.model.partial.glb")
                short.assert_called_once()

    def test_missing_long_or_wrong_alias_fails_closed(self):
        original = "\\\\?\\C:\\" + "x" * 270 + "\\model.glb"
        for alias, identity in ((r"C:\WRONG~1", False), ("C:\\" + "y" * 270, True)):
            with self.subTest(alias=alias), \
                    patch("audit._windows_short_path", return_value=alias), \
                    patch("audit.os.path.samefile", return_value=identity), \
                    patch("audit.os.path.exists", return_value=False), \
                    self.assertRaisesRegex(ValueError, "shorter project path"):
                _windows_blender_filename(original)
        with patch("audit._windows_short_path", side_effect=ValueError("No Windows short path alias")), \
                self.assertRaisesRegex(ValueError, "short path alias"):
            _windows_blender_filename(original)

    def test_existing_file_identity_mismatch_is_rejected(self):
        original = r"\\?\C:\project\model.glb"
        with patch("audit._windows_short_path", return_value=r"C:\PROJECT~1"), \
                patch("audit.os.path.exists", return_value=True), \
                patch("audit.os.path.samefile", side_effect=[True, False, True, False]), \
                self.assertRaisesRegex(ValueError, "safe short alias"):
            _windows_blender_filename(original)


class FilesystemIdentityTests(unittest.TestCase):
    def test_native_absolute_path_names_original_file(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "original.glb"
            source.write_bytes(b"original")
            compatible = blender_filename(filesystem_path(source))
            self.assertTrue(os.path.isabs(compatible))
            self.assertTrue(source.samefile(compatible))
            self.assertEqual(source.read_bytes(), b"original")
            if os.name == "nt":
                self.assertFalse(compatible.startswith("\\\\?\\"))

    @unittest.skipUnless(os.name == "nt", "Actual canonical Windows filesystem boundary")
    def test_canonical_job_source_provenance_and_output_preservation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            doc, binary = fixture()
            source = root / "원본 모델.glb"
            source.write_bytes(container(doc, binary))
            canonical = str(filesystem_path(source))
            job = {"sourcePath": canonical, "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                   "name": "Preserved source", "heightMeters": 1, "maxTriangles": 1000,
                   "textureResolution": 512, "sourceKind": "model", "preserveMaterials": True}
            input_path = filesystem_path(root / "job.json")
            input_path.write_text(json.dumps(job), encoding="utf-8")
            actual = read_parameters(input_path)
            data, inspected = verify_source(actual)
            self.assertEqual(actual["sourcePath"], canonical)
            self.assertEqual(data, source.read_bytes())
            self.assertEqual(inspected.scene_triangles, 1)
            output = prepare_output(filesystem_path(root / "결과 폴더"))
            self.assertTrue(output.samefile(root / "결과 폴더"))
            preserved = output / "user-original.txt"
            preserved.write_text("Keep this", encoding="utf-8")
            with self.assertRaises(ValueError):
                prepare_output(output)
            self.assertEqual(preserved.read_text(encoding="utf-8"), "Keep this")
            self.assertEqual(source.read_bytes(), data)


if __name__ == "__main__":
    unittest.main()
