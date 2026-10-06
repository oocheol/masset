"""Exercise native loaders with local ZIPs; no download, GUI or CLI execution.

The same suite runs under stock Windows PowerShell or macOS JXA via Bash. A fake
executable remains data in every fixture. Native CLI proof belongs to release CI.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import unittest
import zipfile

SCRIPTS = Path(__file__).resolve().parents[1]
WINDOWS = os.name == "nt"
MAC = platform.system() == "Darwin" and platform.machine() == "arm64"
HOST = "windows-x64" if WINDOWS else "macos-arm64"
CLI = "asset-cli.exe" if WINDOWS else "asset-cli"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@unittest.skipUnless(WINDOWS or MAC, "Native loaders require Windows x64 or Apple Silicon Mac")
class NativeLoaderTests(unittest.TestCase):
    def setUp(self):
        # Resolve macOS /var -> /private/var once; runtime paths reject symlinks.
        self.temporary = tempfile.TemporaryDirectory(prefix="asset-native-bootstrap-")
        self.root = Path(self.temporary.name).resolve()
        self.package = self.root / "fixture.zip"
        self.manifest = self.root / "fixture.json"
        self.base = self.root / "private runtime"
        self.files = {
            CLI: b"Native loader fixture; never execute.\n",
            "resources/LICENSE": b"MIT\n",
            "resources/workers/blender/worker.py": b"# Fixture data; never execute.\n",
        }
        self.write_fixture()

    def tearDown(self):
        self.temporary.cleanup()

    def write_fixture(self, extras=None, *, symlink=False, duplicate=False, empty_file=False):
        if empty_file:
            self.files["resources/empty.txt"] = b""
        with zipfile.ZipFile(self.package, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in self.files.items():
                item = zipfile.ZipInfo(name, (2000, 1, 1, 0, 0, 0))
                item.create_system = 3
                item.external_attr = (0o100755 if name == CLI else 0o100644) << 16
                item.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(item, data)
            for name, data in extras or []:
                item = zipfile.ZipInfo(name, (2000, 1, 1, 0, 0, 0))
                item.create_system = 3
                item.external_attr = (0o120777 if symlink else 0o100644) << 16
                archive.writestr(item, data)
            if duplicate:
                archive.writestr(CLI.upper(), self.files[CLI])
        raw = self.package.read_bytes()
        self.spec = {
            "version": "0.1.11",
            "url": "https://github.com/oocheol/masset/releases/download/v0.1.11/fixture.zip",
            "bytes": len(raw),
            "sha256": sha(raw),
            "license": "MIT",
            "cliPath": CLI,
            "resourcePath": "resources",
            "files": [{"path": name, "bytes": len(data), "sha256": sha(data), "executable": name == CLI}
                      for name, data in self.files.items()],
        }
        self.write_manifest()

    def write_manifest(self):
        self.manifest.write_text(json.dumps({"schemaVersion": 1, "format": "asset-studio-cli-runtime",
                                             "packages": {HOST: self.spec}}), encoding="utf-8")

    @property
    def destination(self):
        return self.base / f"{self.spec['version']}-{HOST}-{self.spec['sha256'][:16]}"

    def invoke(self, *, consent=True, test=True, package=True, manifest=True, runtime=True, extra=()):
        if WINDOWS:
            powershell = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
            command = [str(powershell), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
                       str(SCRIPTS / "bootstrap.ps1"), "-PrintCommand"]
            if test:
                command.append("-TestMode")
            if consent:
                command.append("-ConsentDownloads")
            if package:
                command.extend(("-Package", str(self.package)))
            if manifest:
                command.extend(("-Manifest", str(self.manifest)))
            if runtime:
                command.extend(("-RuntimeRoot", str(self.base)))
        else:
            command = ["/bin/bash", str(SCRIPTS / "bootstrap.sh"), "ensure", "--print-command"]
            if test:
                command.append("--test-mode")
            if consent:
                command.append("--consent-downloads")
            if package:
                command.extend(("--package", str(self.package)))
            if manifest:
                command.extend(("--manifest", str(self.manifest)))
            if runtime:
                command.extend(("--runtime-root", str(self.base)))
        result = subprocess.run([*command, *extra], capture_output=True, text=True, timeout=90)
        events = []
        for line in result.stdout.splitlines():
            if line.strip():
                try:
                    events.append(json.loads(line))
                except ValueError:
                    self.fail(f"Native loader emitted non-JSON output: {line!r}; stderr={result.stderr!r}")
        self.assertTrue(events, f"No native JSON output; rc={result.returncode}; stderr={result.stderr!r}")
        return result, events

    def test_missing_consent_creates_nothing(self):
        result, events = self.invoke(consent=False)
        self.assertEqual(result.returncode, 3, (events, result.stderr))
        self.assertEqual(events[-1]["event"], "needs_consent")
        self.assertEqual(events[-1]["downloads"][0]["sha256"], self.spec["sha256"])
        self.assertFalse(self.base.exists())

    def test_test_overrides_require_test_mode(self):
        result, events = self.invoke(test=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events[-1]["code"], "test_only_option")
        self.assertFalse(self.base.exists())

    def test_install_and_reuse_exact_receipt(self):
        result, events = self.invoke()
        self.assertEqual(result.returncode, 0, (events, result.stderr))
        self.assertFalse(events[-1]["unchanged"])
        self.assertEqual(events[-1]["prepareCommand"][1], "prepare")
        receipt = json.loads((self.destination / "installation.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["format"], "asset-studio-cli-installation")
        self.assertEqual(receipt["cliPath"], str(self.destination / CLI))
        self.assertEqual(receipt["resourcePath"], str(self.destination / "resources"))
        self.assertEqual(receipt["package"]["files"], sorted(self.spec["files"], key=lambda entry: entry["path"]))
        again, again_events = self.invoke(consent=False)
        self.assertEqual(again.returncode, 0, (again_events, again.stderr))
        self.assertTrue(again_events[-1]["unchanged"])

    def test_zero_byte_inventory_file_is_supported(self):
        self.write_fixture(empty_file=True)
        result, events = self.invoke()
        self.assertEqual(result.returncode, 0, (events, result.stderr))
        self.assertEqual((self.destination / "resources/empty.txt").read_bytes(), b"")

    def test_local_only_preserves_headless_offline_arguments(self):
        flags = ("-LocalOnly", "-Needs3d", "-DataDir", str(self.root / "private data")) if WINDOWS else (
            "--local-only", "--needs-3d", "--data-dir", str(self.root / "private data"))
        result, events = self.invoke(extra=flags)
        self.assertEqual(result.returncode, 0, (events, result.stderr))
        self.assertIn("--local-only", events[-1]["prepareCommand"])
        self.assertIn("--needs-3d", events[-1]["prepareCommand"])
        self.assertNotIn("--check-gpt", events[-1]["doctorCommand"])
        self.assertEqual(events[-1]["prepareCommand"][-2:], ["--data-dir", str(self.root / "private data")])

    def test_local_only_rejects_login_flag_before_any_writes(self):
        flags = ("-LocalOnly", "-LoginIfNeeded") if WINDOWS else ("--local-only", "--login-if-needed")
        result, events = self.invoke(extra=flags)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events[-1]["code"], "invalid_arguments")
        self.assertFalse(self.base.exists())

    def test_hash_mismatch_preserves_package_and_refuses_publish(self):
        original = self.package.read_bytes()
        self.spec["sha256"] = "0" * 64
        self.write_manifest()
        result, events = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events[-1]["code"], "package_mismatch")
        self.assertFalse(self.destination.exists())
        self.assertEqual(self.package.read_bytes(), original)

    def test_unpinned_source_refused_before_any_writes(self):
        self.spec["url"] = "https://example.org/fixture.zip"
        self.write_manifest()
        result, events = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events[-1]["code"], "invalid_manifest")
        self.assertFalse(self.base.exists())

    def test_traversal_zip_refused_without_outside_write(self):
        self.write_fixture([("../escaped.txt", b"outside")])
        result, events = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(events[-1]["code"], ("unsafe_path", "unsafe_archive"))
        self.assertFalse(self.destination.exists())
        self.assertFalse((self.root / "escaped.txt").exists())

    def test_extra_zip_file_refused(self):
        self.write_fixture([("unknown.txt", b"extra")])
        result, events = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events[-1]["code"], "unsafe_archive")
        self.assertFalse(self.destination.exists())

    def test_symlink_zip_refused(self):
        self.write_fixture([("resources/link", b"../../outside")], symlink=True)
        result, events = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events[-1]["code"], "unsafe_archive")
        self.assertFalse(self.destination.exists())

    def test_case_colliding_zip_refused(self):
        self.write_fixture(duplicate=True)
        result, events = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events[-1]["code"], "unsafe_archive")
        self.assertFalse(self.destination.exists())

    def test_edited_runtime_refused_and_preserved(self):
        result, events = self.invoke()
        self.assertEqual(result.returncode, 0, (events, result.stderr))
        edited = self.destination / "resources/LICENSE"
        edited.write_bytes(b"User original edits must remain.\n")
        again, again_events = self.invoke()
        self.assertNotEqual(again.returncode, 0)
        self.assertEqual(again_events[-1]["code"], "package_mismatch")
        self.assertEqual(edited.read_bytes(), b"User original edits must remain.\n")

    def test_unknown_runtime_directory_preserved(self):
        self.base.mkdir()
        original = self.base / "user-original.txt"
        original.write_bytes(b"Do not replace.\n")
        result, events = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events[-1]["code"], "unmanaged_directory")
        self.assertEqual(original.read_bytes(), b"Do not replace.\n")

    def test_empty_private_directory_can_be_claimed(self):
        self.base.mkdir()
        result, events = self.invoke()
        self.assertEqual(result.returncode, 0, (events, result.stderr))

    def test_live_os_lock_refuses_another_preparation(self):
        self.base.mkdir()
        owner = {"format": "asset-studio-cli-bootstrap", "schemaVersion": 1}
        (self.base / ".bootstrap-owner.json").write_text(json.dumps(owner), encoding="utf-8")
        with (self.base / ".bootstrap.lock").open("w+b") as stream:
            stream.write(json.dumps({**owner, "pid": os.getpid()}).encode())
            stream.flush()
            stream.seek(0)
            if WINDOWS:
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            result, events = self.invoke()
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(events[-1]["code"], "bootstrap_busy")
            self.assertFalse(self.destination.exists())

    def test_unknown_lock_file_is_not_modified(self):
        self.base.mkdir()
        owner = {"format": "asset-studio-cli-bootstrap", "schemaVersion": 1}
        (self.base / ".bootstrap-owner.json").write_text(json.dumps(owner), encoding="utf-8")
        original = self.base / ".bootstrap.lock"
        original.write_bytes(b"User original lock file.")
        result, events = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events[-1]["code"], "unmanaged_directory")
        self.assertEqual(original.read_bytes(), b"User original lock file.")

    def test_data_dir_parent_traversal_rejected_before_any_writes(self):
        invalid = str(self.root / "valid") + os.sep + ".." + os.sep + "other"
        flags = ("-DataDir", invalid) if WINDOWS else ("--data-dir", invalid)
        result, events = self.invoke(extra=flags)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events[-1]["code"], "unsafe_path")
        self.assertFalse(self.base.exists())

    def test_python_loader_receipt_interoperability(self):
        result, events = self.invoke()
        self.assertEqual(result.returncode, 0, (events, result.stderr))
        import sys
        command = [sys.executable, str(SCRIPTS / "bootstrap.py"), "ensure", "--test-mode", "--package", str(self.package),
                   "--manifest", str(self.manifest), "--runtime-root", str(self.base), "--print-command"]
        reused = subprocess.run(command, capture_output=True, text=True, timeout=90)
        self.assertEqual(reused.returncode, 0, reused.stdout + reused.stderr)
        self.assertTrue(json.loads(reused.stdout.splitlines()[0])["unchanged"])


if __name__ == "__main__":
    unittest.main()
