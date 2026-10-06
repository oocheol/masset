"""Offline boundary tests; fixture executables are never launched."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import urllib.request
import zipfile

SCRIPT = Path(__file__).absolute().parents[1] / "bootstrap.py"
MODULE = importlib.util.spec_from_file_location("asset_studio_bootstrap", SCRIPT)
bootstrap = importlib.util.module_from_spec(MODULE)
MODULE.loader.exec_module(bootstrap)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="asset-bootstrap-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).absolute()
        self.root = self.base / "runtimes"
        self.archive = self.base / "fixture.zip"
        self.content = {"asset-cli.exe": b"not-an-executable\n",
                        "resources/workers/blender/worker.py": b"# fixture worker, never executed\n",
                        "resources/licenses/NOTICE.txt": b"Fixture notice\n"}
        self.manifest, self.spec = self.package()

    def package(self, entries=None, content=None, metadata=None):
        content = content or self.content
        if entries is None:
            entries = list(content.items())
        with zipfile.ZipFile(self.archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for name, data in entries:
                if isinstance(name, str):
                    entry = zipfile.ZipInfo(name)
                    entry.filename = name  # Preserve malicious raw ZIP paths on Windows.
                    entry.compress_type = zipfile.ZIP_DEFLATED
                    bundle.writestr(entry, data)
                else:
                    bundle.writestr(name, data)
        data = self.archive.read_bytes()
        item = {"version": "0.1.11", "url": "https://github.com/oocheol/masset/releases/download/v0.1.11/fixture.zip",
                "bytes": len(data), "sha256": sha(data), "license": "Apache-2.0; fixture-only",
                "cliPath": "asset-cli.exe", "resourcePath": "resources",
                "files": [{"path": name, "bytes": len(value), "sha256": sha(value),
                           "executable": name == "asset-cli.exe"} for name, value in content.items()]}
        if metadata:
            item.update(metadata)
        manifest = {"schemaVersion": 1, "format": bootstrap.FORMAT,
                    "packages": {"windows-x64": item}}
        return manifest, bootstrap.package_spec(manifest, "windows-x64")

    def install(self, spec=None):
        return bootstrap.ensure_runtime(spec or self.spec, "windows-x64", self.root, True, self.archive)

    def assert_rejected(self, code, function, *args):
        with self.assertRaises(bootstrap.BootstrapError) as raised:
            function(*args)
        self.assertEqual(raised.exception.code, code)

    def test_consent_does_not_download_write_or_launch(self):
        output = io.StringIO()
        with (contextlib.redirect_stdout(output), mock.patch.object(bootstrap, "download_archive") as download,
              mock.patch.object(bootstrap.subprocess, "run") as run):
            self.assertIsNone(bootstrap.ensure_runtime(self.spec, "windows-x64", self.root, False))
        event = json.loads(output.getvalue())
        self.assertEqual(event["event"], "needs_consent")
        self.assertEqual(event["downloads"][0]["bytes"], self.spec["bytes"])
        self.assertEqual(event["downloads"][0]["sha256"], self.spec["sha256"])
        self.assertFalse(self.root.exists())
        download.assert_not_called()
        run.assert_not_called()

    def test_actual_inventory_install_is_idempotent_without_consent(self):
        ready = self.install()
        destination = Path(ready["runtimePath"])
        self.assertFalse(ready["unchanged"])
        self.assertTrue(Path(ready["cliPath"]).is_file())
        receipt = bootstrap.read_json(destination / "installation.json")
        self.assertEqual(receipt, bootstrap.expected_receipt(self.spec, "windows-x64", destination))
        before = {path.relative_to(destination).as_posix(): sha(path.read_bytes())
                  for path in destination.rglob("*") if path.is_file()}
        with mock.patch.object(bootstrap, "download_archive") as download:
            second = bootstrap.ensure_runtime(self.spec, "windows-x64", self.root, False)
        self.assertTrue(second["unchanged"])
        self.assertEqual(before, {path.relative_to(destination).as_posix(): sha(path.read_bytes())
                                 for path in destination.rglob("*") if path.is_file()})
        download.assert_not_called()

    def test_edited_cli_is_preserved_and_never_repaired(self):
        ready = self.install()
        path = Path(ready["cliPath"])
        changed = b"user-edited CLI\n"
        path.write_bytes(changed)
        self.assert_rejected("package_mismatch", self.install)
        self.assertEqual(path.read_bytes(), changed)

    def test_edited_receipt_is_preserved(self):
        ready = self.install()
        path = Path(ready["runtimePath"]) / "installation.json"
        value = bootstrap.read_json(path)
        value["cliPath"] = str(self.base / "unverified.exe")
        path.write_text(json.dumps(value), encoding="utf-8")
        before = path.read_bytes()
        self.assert_rejected("package_mismatch", self.install)
        self.assertEqual(path.read_bytes(), before)

    def test_unknown_existing_runtime_and_files_are_preserved(self):
        destination = self.root / f"{self.spec['version']}-windows-x64-{self.spec['sha256'][:16]}"
        destination.mkdir(parents=True)
        source = destination / "original.txt"
        source.write_text("User original", encoding="utf-8")
        self.assert_rejected("package_mismatch", self.install)
        self.assertEqual(source.read_text(encoding="utf-8"), "User original")
        self.assertFalse((self.root / ".bootstrap-owner.json").exists())

    def test_unknown_root_or_lock_never_overwritten(self):
        self.root.mkdir()
        original = self.root / "my-content.txt"
        original.write_bytes(b"original")
        self.assert_rejected("unmanaged_directory", self.install)
        self.assertEqual(original.read_bytes(), b"original")
        original.unlink()
        with bootstrap.install_lock(self.root):
            pass
        lock = self.root / ".bootstrap.lock"
        lock.write_bytes(b"unknown-lock")
        self.assert_rejected("unmanaged_directory", self.install)
        self.assertEqual(lock.read_bytes(), b"unknown-lock")

    def test_extra_file_or_empty_directory_rejects_reuse(self):
        ready = self.install()
        path = Path(ready["runtimePath"])
        extra = path / "extra.exe"
        extra.write_bytes(b"unverified")
        self.assert_rejected("package_mismatch", self.install)
        self.assertEqual(extra.read_bytes(), b"unverified")
        extra.unlink()
        (path / "unknown-empty-directory").mkdir()
        self.assert_rejected("package_mismatch", self.install)

    def test_bad_archive_hash_or_size_never_finalizes(self):
        self.archive.write_bytes(self.archive.read_bytes() + b"tampered")
        self.assert_rejected("package_mismatch", self.install)
        self.assertFalse((self.root / f"0.1.11-windows-x64-{self.spec['sha256'][:16]}").exists())
        self.assertEqual(len(list(self.root.glob(".stage-*"))), 1)

    def test_inventory_hash_mismatch_never_finalizes(self):
        item = self.manifest["packages"]["windows-x64"]
        item["files"][0]["sha256"] = "0" * 64
        spec = bootstrap.package_spec(self.manifest, "windows-x64")
        self.assert_rejected("package_mismatch", self.install, spec)
        self.assertEqual(len(list(self.root.glob(".stage-*"))), 1)

    def test_missing_and_extra_zip_files_are_rejected_before_extraction(self):
        for kind, entries in (("missing", list(self.content.items())[1:]),
                              ("extra", list(self.content.items()) + [("untracked.exe", b"unknown")])):
            with self.subTest(kind=kind):
                _, spec = self.package(entries)
                self.assert_rejected("unsafe_archive", self.install, spec)
        for stage in self.root.glob(".stage-*"):
            self.assertEqual(list(stage.iterdir()), [])

    def test_path_traversal_stream_absolute_device_and_windows_paths(self):
        for name in ("../escape", "/absolute", "C:/escape", "nested\\escape", "CON.txt",
                     "resource/file:stream", "trailing.", "trailing ", "a//b", "a/./b", "a/../b"):
            with self.subTest(name=name):
                _, spec = self.package(list(self.content.items()) + [(name, b"malicious")])
                self.assert_rejected("unsafe_path", self.install, spec)
        self.assertFalse((self.base / "escape").exists())

    def test_duplicate_and_case_colliding_zip_entries(self):
        for name in ("asset-cli.exe", "ASSET-CLI.EXE"):
            with self.subTest(name=name), contextlib.redirect_stderr(io.StringIO()):
                _, spec = self.package(list(self.content.items()) + [(name, b"duplicate")])
                self.assert_rejected("unsafe_archive", self.install, spec)

    def test_symlink_special_reparse_and_wrong_directory_zip_entries(self):
        for kind in (stat.S_IFLNK, stat.S_IFIFO, stat.S_IFDIR, "reparse"):
            with self.subTest(kind=kind):
                entry = zipfile.ZipInfo("asset-cli.exe")
                entry.create_system = 3
                entry.external_attr = ((kind | 0o644) << 16) if kind != "reparse" else 0x400
                _, spec = self.package([(entry, self.content["asset-cli.exe"]),
                                       *list(self.content.items())[1:]])
                self.assert_rejected("unsafe_archive", self.install, spec)

    def test_zip_bomb_size_is_declared_and_compression_budgeted(self):
        content = {**self.content, "resources/large.txt": b"0" * (2 * 1024 * 1024)}
        _, spec = self.package(content=content)
        self.assert_rejected("unsafe_archive", self.install, spec)

    def test_inventory_duplicate_parent_file_and_reserved_receipt(self):
        for name in ("ASSET-CLI.EXE", "resources", "installation.json"):
            with self.subTest(name=name):
                self.manifest["packages"]["windows-x64"]["files"].append(
                    {"path": name, "bytes": 1, "sha256": sha(b"x")})
                self.assert_rejected("invalid_inventory", bootstrap.package_spec, self.manifest, "windows-x64")
                self.manifest["packages"]["windows-x64"]["files"].pop()

    def test_unicode_normalization_collisions_are_rejected(self):
        content = {**self.content, "resources/caf\u00e9.txt": b"one", "resources/cafe\u0301.txt": b"two"}
        with self.assertRaises(bootstrap.BootstrapError) as raised:
            self.package(content=content)
        self.assertEqual(raised.exception.code, "invalid_inventory")

    def test_only_fixed_official_versioned_https_zip_is_allowed(self):
        for url in ("http://github.com/oocheol/masset/releases/download/v0.1.11/f.zip",
                    "https://example.com/f.zip", "https://github.com/other/repo/releases/download/v0.1.11/f.zip",
                    "https://github.com/oocheol/masset/releases/download/v0.1.12/f.zip",
                    "https://github.com/oocheol/masset/releases/download/v0.1.11/f.zip?override=1",
                    "https://github.com/oocheol/masset/releases/latest/download/f.zip",
                    "https://user@github.com/oocheol/masset/releases/download/v0.1.11/f.zip"):
            with self.subTest(url=url):
                self.assert_rejected("invalid_manifest", bootstrap.release_url, url, "0.1.11")

    def test_redirects_are_bounded_official_https_hosts(self):
        request = urllib.request.Request(self.spec["url"])
        for url in ("http://release-assets.githubusercontent.com/f.zip", "https://evil.example/f.zip",
                    "https://user:secret@github.com/f.zip", "https://github.com:444/f.zip",
                    "https://github.com/f.zip#fragment"):
            with self.subTest(url=url):
                redirect = bootstrap.ReleaseRedirects()
                self.assert_rejected("unsafe_redirect", redirect.redirect_request,
                                     request, None, 302, "Found", {}, url)
        redirect = bootstrap.ReleaseRedirects()
        for _ in range(5):
            result = redirect.redirect_request(request, None, 302, "Found", {},
                                               "https://release-assets.githubusercontent.com/f.zip?token=not-logged")
            self.assertIsInstance(result, urllib.request.Request)
        self.assert_rejected("unsafe_redirect", redirect.redirect_request, request, None, 302,
                             "Found", {}, "https://github.com/f.zip")

    def test_streaming_download_checks_size_sha_and_content_length(self):
        data = self.archive.read_bytes()
        for kind, body, length, accepted in (("verified", data, str(len(data)), True),
                                             ("oversized", data + b"extra", None, False),
                                             ("short", data[:-1], None, False),
                                             ("hash", bytes([data[0] ^ 1]) + data[1:], None, False),
                                             ("length", data, str(len(data) + 1), False)):
            with self.subTest(kind=kind):
                response = io.BytesIO(body)
                response.headers = {} if length is None else {"Content-Length": length}
                opener = mock.Mock()
                opener.open.return_value = response
                destination = self.base / (kind + ".zip")
                with mock.patch.object(bootstrap.urllib.request, "build_opener", return_value=opener):
                    if accepted:
                        bootstrap.download_archive(self.spec, destination)
                        self.assertEqual(destination.read_bytes(), data)
                    else:
                        self.assert_rejected("package_mismatch", bootstrap.download_archive, self.spec, destination)
                opener.open.assert_called_once()

    def test_network_error_never_prints_redirect_tokens_or_environment(self):
        opener = mock.Mock()
        opener.open.side_effect = bootstrap.urllib.error.URLError("https://example.com/?secret=do-not-log")
        with mock.patch.object(bootstrap.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(bootstrap.BootstrapError) as raised:
                bootstrap.download_archive(self.spec, self.base / "download.zip")
        self.assertEqual(raised.exception.code, "download_failed")
        self.assertNotIn("do-not-log", str(raised.exception))
        self.assertFalse((self.base / "download.zip").exists())

    def test_exclusive_finalize_preserves_racing_empty_destination(self):
        stage = self.base / "stage"
        stage.mkdir()
        (stage / "new.txt").write_bytes(b"owned staged bytes")
        destination = self.base / "existing-empty"
        destination.mkdir()
        with self.assertRaises((bootstrap.BootstrapError, OSError)):
            bootstrap.finalize_stage(stage, destination)
        self.assertTrue(destination.is_dir())
        self.assertEqual(list(destination.iterdir()), [])
        self.assertEqual((stage / "new.txt").read_bytes(), b"owned staged bytes")

    def test_supported_platforms_and_unavailable_package(self):
        for system, machine, expected in (("Windows", "AMD64", "windows-x64"),
                                         ("Darwin", "arm64", "macos-arm64")):
            with (mock.patch.object(bootstrap.platform, "system", return_value=system),
                  mock.patch.object(bootstrap.platform, "machine", return_value=machine)):
                self.assertEqual(bootstrap.host_platform(), expected)
        for system, machine in (("Darwin", "x86_64"), ("Windows", "ARM64"), ("Linux", "x86_64")):
            with (mock.patch.object(bootstrap.platform, "system", return_value=system),
                  mock.patch.object(bootstrap.platform, "machine", return_value=machine)):
                self.assert_rejected("unsupported_platform", bootstrap.host_platform)
        self.assert_rejected("runtime_unavailable", bootstrap.package_spec, self.manifest, "macos-arm64")

    def test_busy_lock_and_stale_pid_crash_recovery(self):
        with bootstrap.install_lock(self.root):
            self.assert_rejected("bootstrap_busy", self.install)
        lock = self.root / ".bootstrap.lock"
        lock.write_text(json.dumps({**bootstrap.OWNER, "pid": 99999999}), encoding="utf-8")
        ready = self.install()
        self.assertTrue(ready["installed"])
        self.assertEqual(json.loads(lock.read_text(encoding="utf-8"))["pid"], os.getpid())

    def test_os_lock_releases_after_process_termination(self):
        # Real child owns the OS lock. Termination must not require deleting a marker.
        child_script = self.base / "hold_lock.py"
        child_script.write_text(
            "import importlib.util, pathlib, time\n"
            f"s=importlib.util.spec_from_file_location('b', {str(SCRIPT)!r})\n"
            "b=importlib.util.module_from_spec(s); s.loader.exec_module(b)\n"
            f"with b.install_lock(pathlib.Path({str(self.root)!r})):\n"
            " print('locked', flush=True)\n time.sleep(30)\n", encoding="utf-8")
        child = subprocess.Popen([sys.executable, str(child_script)], stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "locked")
            self.assert_rejected("bootstrap_busy", self.install)
            child.terminate()
            child.wait(timeout=10)
            self.assertTrue(self.install()["installed"])
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=10)
            child.stdout.close()
            child.stderr.close()

    def test_symbolic_link_ancestor_or_runtime_file_is_rejected(self):
        linked = self.base / "linked"
        target = self.base / "real"
        target.mkdir()
        try:
            linked.symlink_to(target, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("This Windows account cannot create symbolic links.")
        self.assert_rejected("unsafe_path", bootstrap.ensure_runtime,
                             self.spec, "windows-x64", linked / "runtimes", True, self.archive)
        self.assertFalse((target / "runtimes").exists())

    def test_commands_keep_auth_environment_and_optional_downloads_scoped(self):
        ready = self.install()
        data = self.base / "isolated-data"
        prepare, doctor = bootstrap.commands(ready, True, True, True, data)
        self.assertEqual(prepare, [ready["cliPath"], "prepare", "--resources", ready["resourcePath"],
                                   "--data-dir", str(data), "--needs-3d", "--consent-downloads", "--login-if-needed"])
        self.assertEqual(doctor, [ready["cliPath"], "doctor", "--resources", ready["resourcePath"],
                                  "--data-dir", str(data), "--check-gpt"])
        prepare, _ = bootstrap.commands(ready, False, False)
        self.assertNotIn("--needs-3d", prepare)
        self.assertNotIn("--consent-downloads", prepare)
        self.assertNotIn("--login-if-needed", prepare)

    def test_local_only_commands_prepare_existing_assets_without_provider_checks(self):
        ready = self.install()
        data = self.base / "isolated-local-data"
        prepare, doctor = bootstrap.commands(ready, True, False, data_dir=data, local_only=True)
        self.assertIn("--local-only", prepare)
        self.assertIn("--needs-3d", prepare)
        self.assertNotIn("--login-if-needed", prepare)
        self.assertNotIn("--consent-downloads", prepare)
        self.assertNotIn("--check-gpt", doctor)
        self.assertNotIn("--allow-gpt", prepare + doctor)
        self.assertEqual(doctor, [ready["cliPath"], "doctor", "--resources", ready["resourcePath"],
                                  "--data-dir", str(data)])

    def test_local_only_and_login_cannot_be_combined_before_installation(self):
        with (contextlib.redirect_stderr(io.StringIO()),
              mock.patch.object(bootstrap, "ensure_runtime") as install,
              mock.patch.object(bootstrap.subprocess, "run") as run):
            with self.assertRaises(SystemExit) as rejected:
                bootstrap.main(["ensure", "--local-only", "--login-if-needed"])
        self.assertEqual(rejected.exception.code, 2)
        install.assert_not_called()
        run.assert_not_called()
        self.assert_rejected("invalid_options", bootstrap.commands, {}, False, False, True, None, True)

    def default_manifest(self):
        script_dir = self.base / "skill" / "scripts"
        references = script_dir.parent / "references"
        script_dir.mkdir(parents=True)
        references.mkdir()
        (references / "native-runtime.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        return script_dir / "bootstrap.py"

    def test_real_flow_reuses_inherited_auth_environment_and_no_shell(self):
        self.install()
        script = self.default_manifest()
        output = io.StringIO()
        with (contextlib.redirect_stdout(output), mock.patch.object(bootstrap, "__file__", str(script)),
              mock.patch.object(bootstrap, "host_platform", return_value="windows-x64"),
              mock.patch.object(bootstrap, "runtime_root", return_value=self.root),
              mock.patch.object(bootstrap.subprocess, "run", return_value=mock.Mock(returncode=0)) as run):
            code = bootstrap.main(["ensure"])
        self.assertEqual(code, 0)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(json.loads(output.getvalue())["event"], "runtime_ready")
        self.assertEqual(run.call_args_list[0].args[0][1], "prepare")
        self.assertEqual(run.call_args_list[1].args[0][1], "doctor")
        for call in run.call_args_list:
            self.assertEqual(call.kwargs, {"shell": False, "check": False})
            self.assertNotIn("produce", call.args[0])
            self.assertNotIn("--allow-gpt", call.args[0])

    def test_doctor_auth_attention_preserves_native_runtime_ready_fact(self):
        self.install()
        script = self.default_manifest()
        output = io.StringIO()
        with (contextlib.redirect_stdout(output), mock.patch.object(bootstrap, "__file__", str(script)),
              mock.patch.object(bootstrap, "host_platform", return_value="windows-x64"),
              mock.patch.object(bootstrap, "runtime_root", return_value=self.root),
              mock.patch.object(bootstrap.subprocess, "run", side_effect=[mock.Mock(returncode=0), mock.Mock(returncode=2)])):
            code = bootstrap.main(["ensure"])
        self.assertEqual(code, 2)
        ready = json.loads(output.getvalue())
        self.assertEqual(ready["event"], "runtime_ready")
        self.assertTrue(Path(ready["installationPath"]).is_file())

    def test_print_command_never_invokes_native_prepare_or_doctor(self):
        self.install()
        script = self.default_manifest()
        output = io.StringIO()
        with (contextlib.redirect_stdout(output), mock.patch.object(bootstrap, "__file__", str(script)),
              mock.patch.object(bootstrap, "host_platform", return_value="windows-x64"),
              mock.patch.object(bootstrap, "runtime_root", return_value=self.root),
              mock.patch.object(bootstrap.subprocess, "run") as run):
            code = bootstrap.main(["ensure", "--print-command", "--needs-3d", "--login-if-needed"])
        self.assertEqual(code, 0)
        ready = json.loads(output.getvalue())
        self.assertIn("--needs-3d", ready["prepareCommand"])
        self.assertIn("--login-if-needed", ready["prepareCommand"])
        run.assert_not_called()

    def test_local_only_print_command_never_invokes_or_requests_provider(self):
        self.install()
        script = self.default_manifest()
        output = io.StringIO()
        with (contextlib.redirect_stdout(output), mock.patch.object(bootstrap, "__file__", str(script)),
              mock.patch.object(bootstrap, "host_platform", return_value="windows-x64"),
              mock.patch.object(bootstrap, "runtime_root", return_value=self.root),
              mock.patch.object(bootstrap.subprocess, "run") as run):
            code = bootstrap.main(["ensure", "--local-only", "--print-command", "--needs-3d"])
        self.assertEqual(code, 0)
        ready = json.loads(output.getvalue())
        self.assertTrue(ready["localOnly"])
        self.assertIn("--local-only", ready["prepareCommand"])
        self.assertNotIn("--check-gpt", ready["doctorCommand"])
        run.assert_not_called()

    def test_overrides_require_test_mode_and_fixture_mode_never_executes(self):
        manifest = self.base / "manifest.json"
        manifest.write_text(json.dumps(self.manifest), encoding="utf-8")
        output = io.StringIO()
        with contextlib.redirect_stdout(output), mock.patch.object(bootstrap.subprocess, "run") as run:
            code = bootstrap.main(["ensure", "--package", str(self.archive)])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(output.getvalue())["code"], "test_mode_required")
        run.assert_not_called()
        output = io.StringIO()
        with (contextlib.redirect_stdout(output), mock.patch.object(bootstrap, "host_platform", return_value="windows-x64"),
              mock.patch.object(bootstrap, "download_archive") as download,
              mock.patch.object(bootstrap.subprocess, "run") as run):
            code = bootstrap.main(["ensure", "--test-mode", "--package", str(self.archive),
                                   "--manifest", str(manifest), "--runtime-root", str(self.root),
                                   "--consent-downloads", "--needs-3d"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["event"], "runtime_ready")
        download.assert_not_called()
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
