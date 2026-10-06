#!/usr/bin/env python3
"""Verify and prepare the pinned native CLI without requiring the desktop app.

Only the checked-in release inventory is trusted. This script never generates
assets. Authentication remains in official Codex; login is opt-in if missing.
Use --local-only to skip provider checks and login. Local fixtures require
--test-mode.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import stat
import subprocess
import sys
import time
from typing import BinaryIO
import urllib.error
import urllib.parse
import urllib.request
import unicodedata
import uuid
import zipfile

FORMAT = "asset-studio-cli-runtime"
RECEIPT_FORMAT = "asset-studio-cli-installation"
OWNER = {"format": "asset-studio-cli-bootstrap", "schemaVersion": 1}
MAX_MANIFEST = 2 * 1024 * 1024
MAX_ARCHIVE = 512 * 1024 * 1024
MAX_TOTAL = 1024 * 1024 * 1024
MAX_FILE = 256 * 1024 * 1024
MAX_FILES = 4096
CHUNK = 1024 * 1024
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)),
            *(f"LPT{i}" for i in range(1, 10))}


class BootstrapError(Exception):
    """A safe, structured failure, without network URL queries or environment."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def fail(code: str, message: str) -> None:
    raise BootstrapError(code, message)


def emit(event: str, **fields: object) -> None:
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def relative_name(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 240:
        fail("invalid_inventory", "Inventory paths must be bounded relative paths.")
    if "\\" in value or ":" in value or "\x00" in value or value.startswith("/"):
        fail("unsafe_path", "Archive paths cannot be absolute, streams or Windows paths.")
    parts = value.split("/")
    if any(not part or part in (".", "..") or part.endswith((".", " "))
           or any(ord(c) < 32 for c in part) or any(c in '<>"|?*' for c in part)
           or part.split(".", 1)[0].upper() in RESERVED for part in parts):
        fail("unsafe_path", "Archive paths must use ordinary safe file names.")
    if str(PurePosixPath(value)) != value:
        fail("unsafe_path", "Archive paths must be canonical relative paths.")
    return value


def path_key(value: str) -> str:
    return unicodedata.normalize("NFD", value).casefold()


def no_links(path: Path) -> None:
    if not path.is_absolute() or ".." in path.parts:
        fail("unsafe_path", "Use an absolute path without parent traversal.")
    for component in [*reversed(path.parents), path]:
        try:
            info = component.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            fail("unsafe_path", "Runtime paths cannot contain symbolic links or reparse points.")


def ensure_directory(path: Path) -> None:
    no_links(path)
    if path.exists():
        if not path.is_dir():
            fail("unsafe_path", "A runtime parent is not a directory.")
        return
    ensure_directory(path.parent)
    try:
        path.mkdir()
    except FileExistsError:
        pass
    no_links(path)
    if not path.is_dir():
        fail("unsafe_path", "Runtime directory creation failed.")


@contextlib.contextmanager
def regular_read(path: Path):
    no_links(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        fail("unsafe_path", "Expected a regular file.")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        opened = os.fstat(stream.fileno())
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            fail("unsafe_path", "A runtime file changed while opening it.")
        no_links(path)
        yield stream


def read_json(path: Path) -> dict:
    with regular_read(path) as stream:
        if os.fstat(stream.fileno()).st_size > MAX_MANIFEST:
            fail("invalid_manifest", "Runtime metadata exceeds its size limit.")
        try:
            value = json.loads(stream.read(MAX_MANIFEST + 1))
        except (ValueError, UnicodeError):
            fail("invalid_manifest", "Runtime metadata must be valid UTF-8 JSON.")
    if not isinstance(value, dict):
        fail("invalid_manifest", "Runtime metadata must be a JSON object.")
    return value


def integer(value: object, maximum: int, allow_zero: bool = False) -> int:
    if (isinstance(value, bool) or not isinstance(value, int)
            or not (0 if allow_zero else 1) <= value <= maximum):
        fail("invalid_inventory", "Runtime byte counts must be bounded nonnegative integers.")
    return value


def digest(value: object) -> str:
    if not isinstance(value, str) or not SHA.fullmatch(value):
        fail("invalid_inventory", "Runtime checksums must be lowercase SHA-256.")
    return value


def release_url(value: object, version: str) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        fail("invalid_manifest", "A fixed GitHub release ZIP URL is required.")
    parsed = urllib.parse.urlsplit(value)
    prefix = f"/oocheol/masset/releases/download/v{version}/"
    suffix = parsed.path[len(prefix):] if parsed.path.startswith(prefix) else ""
    if (parsed.scheme != "https" or parsed.netloc != "github.com"
            or parsed.query or parsed.fragment or not suffix.endswith(".zip")
            or not re.fullmatch(r"[A-Za-z0-9._-]+\.zip", suffix)):
        fail("invalid_manifest", "Only the pinned oocheol/masset GitHub release ZIP is allowed.")
    return value


def package_spec(manifest: dict, host: str) -> dict:
    if manifest.get("format") != FORMAT or manifest.get("schemaVersion") != 1:
        fail("invalid_manifest", "Unsupported native runtime manifest format.")
    packages = manifest.get("packages")
    item = packages.get(host) if isinstance(packages, dict) else None
    if not isinstance(item, dict):
        fail("runtime_unavailable", "No verified native CLI package is published for this platform.")
    version = item.get("version")
    if not isinstance(version, str) or not VERSION.fullmatch(version) or len(version) > 64:
        fail("invalid_manifest", "The runtime release needs a fixed version.")
    license_name = item.get("license")
    if not isinstance(license_name, str) or not license_name.strip() or len(license_name) > 1024:
        fail("invalid_manifest", "The runtime package must identify its licenses.")
    files = item.get("files")
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        fail("invalid_inventory", "A complete bounded file inventory is required.")
    inventory = []
    seen = set()
    total = 0
    for entry in files:
        if not isinstance(entry, dict):
            fail("invalid_inventory", "Each inventory entry must be an object.")
        name = relative_name(entry.get("path"))
        folded = path_key(name)
        if folded in seen or folded == "installation.json":
            fail("invalid_inventory", "Inventory paths must be unique, including case and receipt names.")
        seen.add(folded)
        size = integer(entry.get("bytes"), MAX_FILE, allow_zero=True)
        total += size
        executable = entry.get("executable", False)
        if not isinstance(executable, bool):
            fail("invalid_inventory", "The executable flag must be boolean.")
        inventory.append({"path": name, "bytes": size,
                          "sha256": digest(entry.get("sha256")), "executable": executable})
    if total > MAX_TOTAL:
        fail("invalid_inventory", "The runtime inventory exceeds the unpacked size limit.")
    # A file cannot also be an ancestor directory, even on case insensitive hosts.
    for entry in inventory:
        if any(path_key(str(parent)) in seen for parent in PurePosixPath(entry["path"]).parents
               if str(parent) != "."):
            fail("invalid_inventory", "An inventory file collides with a parent directory.")
    cli = relative_name(item.get("cliPath"))
    resources = relative_name(item.get("resourcePath"))
    cli_entry = next((entry for entry in inventory if entry["path"] == cli), None)
    if cli_entry is None or (host == "macos-arm64" and not cli_entry["executable"]):
        fail("invalid_inventory", "The inventory must contain the executable native CLI.")
    if path_key(resources) in seen or not any(entry["path"].startswith(resources + "/") for entry in inventory):
        fail("invalid_inventory", "The resource path must be a directory with inventoried files.")
    if not any(entry["path"] == resources + "/workers/blender/worker.py" for entry in inventory):
        fail("invalid_inventory", "The runtime must contain its pinned Blender worker.")
    return {"version": version, "url": release_url(item.get("url"), version),
            "bytes": integer(item.get("bytes"), MAX_ARCHIVE), "sha256": digest(item.get("sha256")),
            "license": license_name, "cliPath": cli, "resourcePath": resources,
            "files": sorted(inventory, key=lambda entry: entry["path"])}


def host_platform() -> str:
    system, machine = platform.system(), platform.machine().lower()
    if system == "Windows" and machine in ("amd64", "x86_64"):
        return "windows-x64"
    if system == "Darwin" and machine in ("arm64", "aarch64"):
        return "macos-arm64"
    fail("unsupported_platform", "The native CLI supports Windows x64 and Apple Silicon macOS only.")


def runtime_root(host: str) -> Path:
    if host == "windows-x64":
        base = os.environ.get("LOCALAPPDATA")
        if not base:
            fail("missing_user_directory", "LOCALAPPDATA is unavailable.")
        return Path(base) / "AssetStudioCLI" / "runtimes"
    return Path.home() / "Library" / "Application Support" / "AssetStudioCLI" / "runtimes"


def write_new_json(path: Path, value: dict) -> None:
    data = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    no_links(path)
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


@contextlib.contextmanager
def install_lock(base: Path):
    ensure_directory(base)
    owner = base / ".bootstrap-owner.json"
    if not owner.exists():
        if any(base.iterdir()):
            fail("unmanaged_directory", "An unknown runtime directory was preserved without changes.")
        try:
            write_new_json(owner, OWNER)
        except FileExistsError:
            pass
    if read_json(owner) != OWNER:
        fail("unmanaged_directory", "The runtime directory ownership marker is not recognized.")
    path = base / ".bootstrap.lock"
    no_links(path)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0)
                         | getattr(os, "O_NOFOLLOW", 0), 0o600)
    os.set_inheritable(descriptor, False)
    with os.fdopen(descriptor, "r+b", buffering=0) as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            fail("unsafe_path", "Bootstrap lock must be a regular file.")
        no_links(path)
        locked = False
        try:
            if os.name == "nt":
                import msvcrt
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
            stream.seek(0)
            existing = stream.read(1025)
            if existing:
                try:
                    marker = json.loads(existing)
                except (ValueError, UnicodeError):
                    fail("unmanaged_directory", "An unknown lock file was preserved without changes.")
                if not isinstance(marker, dict) or marker.get("format") != OWNER["format"]:
                    fail("unmanaged_directory", "An unknown lock file was preserved without changes.")
            stream.seek(0)
            stream.write(json.dumps({**OWNER, "pid": os.getpid()}).encode("utf-8"))
            stream.truncate()
            os.fsync(stream.fileno())
            yield
        except OSError as error:
            if not locked:
                fail("bootstrap_busy", "Another native CLI preparation is running; try again after it finishes.")
            raise error
        finally:
            if locked:
                stream.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def hash_stream(stream: BinaryIO, expected: int) -> str:
    actual = 0
    sha = hashlib.sha256()
    while chunk := stream.read(min(CHUNK, expected - actual + 1)):
        actual += len(chunk)
        if actual > expected:
            fail("package_mismatch", "A runtime file exceeds its pinned byte count.")
        sha.update(chunk)
    if actual != expected:
        fail("package_mismatch", "A runtime file does not match its pinned byte count.")
    return sha.hexdigest()


def verify_file(path: Path, size: int, checksum: str) -> None:
    with regular_read(path) as stream:
        if os.fstat(stream.fileno()).st_size != size or hash_stream(stream, size) != checksum:
            fail("package_mismatch", "A runtime file does not match its pinned size and SHA-256.")


def expected_receipt(spec: dict, host: str, destination: Path) -> dict:
    return {"format": RECEIPT_FORMAT, "schemaVersion": 1, "platform": host,
            "package": spec, "cliPath": str(destination / spec["cliPath"]),
            "resourcePath": str(destination / spec["resourcePath"])}


def verify_tree(path: Path, spec: dict, receipt: dict | None = None) -> None:
    no_links(path)
    if not path.is_dir():
        fail("package_mismatch", "Native runtime installation is not a directory.")
    expected = {entry["path"] for entry in spec["files"]}
    directories = {str(parent) for name in expected for parent in PurePosixPath(name).parents
                   if str(parent) != "."}
    if receipt is not None:
        expected.add("installation.json")
    actual = set()
    for current, dirs, files in os.walk(path, followlinks=False):
        for name in dirs:
            child = Path(current) / name
            no_links(child)
            if child.relative_to(path).as_posix() not in directories:
                fail("package_mismatch", "Unknown runtime directories were preserved without changes.")
        for name in files:
            child = Path(current) / name
            no_links(child)
            if not stat.S_ISREG(child.lstat().st_mode):
                fail("package_mismatch", "The runtime contains an unexpected special file.")
            actual.add(child.relative_to(path).as_posix())
    if actual != expected:
        fail("package_mismatch", "Unknown, missing or edited runtime files were preserved without changes.")
    for entry in spec["files"]:
        file_path = path / entry["path"]
        verify_file(file_path, entry["bytes"], entry["sha256"])
        if os.name != "nt" and entry["executable"] and file_path.stat().st_mode & 0o111 != 0o111:
            fail("package_mismatch", "The native CLI executable permission was changed.")
    if receipt is not None and read_json(path / "installation.json") != receipt:
        fail("package_mismatch", "The installed runtime receipt does not match the pinned release.")


class ReleaseRedirects(urllib.request.HTTPRedirectHandler):
    def __init__(self):
        self.count = 0

    def redirect_request(self, request, response, code, message, headers, newurl):
        self.count += 1
        parsed = urllib.parse.urlsplit(newurl)
        if (self.count > 5 or parsed.scheme != "https" or parsed.username or parsed.password
                or parsed.port not in (None, 443) or parsed.fragment
                or parsed.hostname not in {"github.com", "release-assets.githubusercontent.com",
                                           "objects.githubusercontent.com"}):
            fail("unsafe_redirect", "The release download redirected outside the official HTTPS asset hosts.")
        return super().redirect_request(request, response, code, message, headers, newurl)


def download_archive(spec: dict, path: Path) -> None:
    opener = urllib.request.build_opener(ReleaseRedirects())
    request = urllib.request.Request(spec["url"], headers={"User-Agent": "AssetStudioSkillBootstrap/1"})
    started = time.monotonic()
    try:
        with opener.open(request, timeout=30) as response, path.open("xb") as output:
            content_length = response.headers.get("Content-Length")
            if content_length is not None and content_length != str(spec["bytes"]):
                fail("package_mismatch", "The download does not match the pinned Content-Length.")
            size, sha = 0, hashlib.sha256()
            while chunk := response.read(min(CHUNK, spec["bytes"] - size + 1)):
                size += len(chunk)
                if size > spec["bytes"] or time.monotonic() - started > 900:
                    fail("package_mismatch", "The download exceeded its pinned size or time limit.")
                output.write(chunk)
                sha.update(chunk)
            output.flush()
            os.fsync(output.fileno())
            if size != spec["bytes"] or sha.hexdigest() != spec["sha256"]:
                fail("package_mismatch", "The downloaded ZIP failed the pinned size and SHA-256 verification.")
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        fail("download_failed", "The fixed GitHub runtime ZIP could not be downloaded; no CLI was executed.")


def extract_archive(archive: Path, stage: Path, spec: dict) -> None:
    expected = {entry["path"]: entry for entry in spec["files"]}
    directories = {str(parent) for name in expected for parent in PurePosixPath(name).parents
                   if str(parent) != "."}
    with regular_read(archive) as source, zipfile.ZipFile(source) as bundle:
        members = bundle.infolist()
        if len(members) > MAX_FILES * 2:
            fail("unsafe_archive", "The ZIP contains too many entries.")
        seen, actual, total = set(), set(), 0
        for member in members:
            # ZipInfo can normalize backslashes or truncate NULs when decoding.
            # Reject the original central-directory name rather than trusting it.
            name = relative_name(member.orig_filename[:-1] if member.is_dir() else member.orig_filename)
            if name != member.filename.rstrip("/"):
                fail("unsafe_path", "The ZIP path was normalized by its decoder.")
            if path_key(name) in seen:
                fail("unsafe_archive", "The ZIP contains duplicate or case-colliding paths.")
            seen.add(path_key(name))
            mode = member.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if (member.flag_bits & 1 or kind not in (0, stat.S_IFREG, stat.S_IFDIR)
                    or (member.external_attr & 0x400)
                    or member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                fail("unsafe_archive", "The ZIP contains encrypted, linked, special or unsupported entries.")
            if member.is_dir():
                if name not in directories or member.file_size:
                    fail("unsafe_archive", "The ZIP has an unexpected directory entry.")
                continue
            entry = expected.get(name)
            if entry is None or member.file_size != entry["bytes"]:
                fail("unsafe_archive", "The ZIP file inventory differs from the pinned release.")
            if kind == stat.S_IFDIR or (member.file_size > CHUNK
                    and member.file_size > max(1, member.compress_size) * 1000):
                fail("unsafe_archive", "The ZIP has an invalid file type or excessive compression ratio.")
            total += member.file_size
            actual.add(name)
        if actual != set(expected) or total > MAX_TOTAL:
            fail("unsafe_archive", "The ZIP is incomplete or exceeds its unpacked byte budget.")
        for member in members:
            if member.is_dir():
                continue
            entry = expected[member.filename]
            destination = stage / entry["path"]
            ensure_directory(destination.parent)
            sha, size = hashlib.sha256(), 0
            with bundle.open(member) as stream, destination.open("xb") as output:
                while chunk := stream.read(min(CHUNK, entry["bytes"] - size + 1)):
                    size += len(chunk)
                    if size > entry["bytes"]:
                        fail("unsafe_archive", "An extracted file exceeds its pinned byte budget.")
                    output.write(chunk)
                    sha.update(chunk)
                output.flush()
                os.fsync(output.fileno())
            if size != entry["bytes"] or sha.hexdigest() != entry["sha256"]:
                fail("package_mismatch", "An extracted file failed its pinned size and SHA-256 verification.")
            if os.name != "nt":
                destination.chmod(0o755 if entry["executable"] else 0o644)
    verify_tree(stage, spec)


def finalize_stage(stage: Path, destination: Path) -> None:
    """Atomically publish, never replacing a racing user-created destination."""
    no_links(stage)
    no_links(destination)
    if os.name == "nt":
        # Windows rename fails if any destination already exists.
        stage.rename(destination)
        return
    if platform.system() != "Darwin":
        fail("unsupported_platform", "Atomic native CLI installation supports Windows and macOS only.")
    import ctypes
    import errno
    library = ctypes.CDLL(None, use_errno=True)
    rename_exclusive = getattr(library, "renamex_np", None)
    if rename_exclusive is None:
        fail("atomic_finalize_unavailable", "macOS exclusive rename is unavailable; the staged runtime was preserved.")
    rename_exclusive.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    rename_exclusive.restype = ctypes.c_int
    # macOS RENAME_EXCL forbids replacing files or empty directories.
    if rename_exclusive(os.fsencode(stage), os.fsencode(destination), 0x00000004) != 0:
        code = ctypes.get_errno()
        if code in (errno.EEXIST, errno.ENOTEMPTY):
            fail("package_mismatch", "A runtime destination appeared during preparation and was preserved.")
        raise OSError(code, "Exclusive native runtime publication failed")


def ensure_runtime(spec: dict, host: str, base: Path, consent: bool,
                   local_package: Path | None = None) -> dict | None:
    name = f"{spec['version']}-{host}-{spec['sha256'][:16]}"
    destination = base / name
    no_links(destination)
    receipt = expected_receipt(spec, host, destination)
    # No download, writes or executable launch is needed to inspect a receipt.
    if destination.exists():
        verify_tree(destination, spec, receipt)
        return {**receipt, "installed": True, "unchanged": True, "runtimePath": str(destination)}
    if not consent:
        emit("needs_consent", code="runtime_download_consent_required", platform=host,
             version=spec["version"], downloads=[{key: spec[key] for key in ("url", "bytes", "sha256", "license")}],
             message="Native CLI download requires --consent-downloads; no files were downloaded or installed.")
        return None
    with install_lock(base):
        if destination.exists():
            verify_tree(destination, spec, receipt)
            return {**receipt, "installed": True, "unchanged": True, "runtimePath": str(destination)}
        stage = base / (".stage-" + uuid.uuid4().hex)
        stage.mkdir()
        archive = local_package or base / (".download-" + uuid.uuid4().hex + ".zip")
        if local_package is None:
            emit("progress", phase="download_native_cli", bytes=spec["bytes"], version=spec["version"])
            download_archive(spec, archive)
        verify_file(archive, spec["bytes"], spec["sha256"])
        extract_archive(archive, stage, spec)
        write_new_json(stage / "installation.json", receipt)
        verify_tree(stage, spec, receipt)
        # A racing unknown destination is preserved: never replace an existing directory.
        if destination.exists():
            fail("package_mismatch", "A runtime destination appeared during preparation and was preserved.")
        finalize_stage(stage, destination)
        verify_tree(destination, spec, receipt)
        return {**receipt, "installed": True, "unchanged": False, "runtimePath": str(destination)}


def commands(ready: dict, needs_3d: bool, consent: bool, login_if_needed: bool = False,
             data_dir: Path | None = None, local_only: bool = False) -> tuple[list[str], list[str]]:
    if local_only and login_if_needed:
        fail("invalid_options", "--local-only and --login-if-needed cannot be combined.")
    shared = ["--resources", ready["resourcePath"]]
    if data_dir is not None:
        no_links(data_dir)
        shared += ["--data-dir", str(data_dir)]
    prepare = [ready["cliPath"], "prepare", *shared]
    if needs_3d:
        prepare.append("--needs-3d")
    if consent:
        prepare.append("--consent-downloads")
    if login_if_needed:
        prepare.append("--login-if-needed")
    if local_only:
        prepare.append("--local-only")
    doctor = [ready["cliPath"], "doctor", *shared]
    if not local_only:
        doctor.append("--check-gpt")
    return prepare, doctor


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["ensure"])
    parser.add_argument("--consent-downloads", action="store_true")
    parser.add_argument("--needs-3d", action="store_true")
    auth_options = parser.add_mutually_exclusive_group()
    auth_options.add_argument("--login-if-needed", action="store_true", help="Allow native CLI login only if inherited authentication is missing.")
    auth_options.add_argument("--local-only", action="store_true", help="Prepare local tooling only; skip provider checks and login.")
    parser.add_argument("--data-dir", type=Path, help="Absolute isolated native user-data directory.")
    parser.add_argument("--print-command", action="store_true", help="Verify/install, then print argv without running native commands.")
    parser.add_argument("--test-mode", action="store_true", help="Internal fixture QA only; never runs native commands.")
    parser.add_argument("--package", type=Path, help="Internal fixture ZIP; requires --test-mode.")
    parser.add_argument("--manifest", type=Path, help="Internal fixture inventory; requires --test-mode.")
    parser.add_argument("--runtime-root", type=Path, help="Internal fixture directory; requires --test-mode.")
    args = parser.parse_args(argv)
    try:
        if (args.package or args.manifest or args.runtime_root) and not args.test_mode:
            fail("test_mode_required", "Local package, manifest and runtime-root overrides require --test-mode.")
        if args.test_mode and not (args.package and args.manifest and args.runtime_root):
            fail("invalid_test_mode", "Fixture QA requires a local package, manifest and runtime root; network is disabled.")
        if args.data_dir is not None:
            no_links(args.data_dir)
        host = host_platform()
        manifest_path = args.manifest or Path(__file__).absolute().parent.parent / "references/native-runtime.json"
        spec = package_spec(read_json(manifest_path.absolute()), host)
        base = args.runtime_root.absolute() if args.runtime_root else runtime_root(host)
        local_package = args.package.absolute() if args.package else None
        ready = ensure_runtime(spec, host, base, args.consent_downloads, local_package)
        if ready is None:
            return 3
        prepare, doctor = commands(ready, args.needs_3d, args.consent_downloads,
                                   args.login_if_needed, args.data_dir, args.local_only)
        emit("runtime_ready", version=spec["version"], platform=host, installed=True,
             unchanged=ready["unchanged"], cliPath=ready["cliPath"], resourcePath=ready["resourcePath"],
             installationPath=str(Path(ready["runtimePath"]) / "installation.json"),
             prepareCommand=prepare, doctorCommand=doctor, testMode=args.test_mode, localOnly=args.local_only)
        if args.print_command or args.test_mode:
            return 0
        # Use argv directly. The inherited Codex environment/login stays intact.
        # Recheck immediately before each launch; no generated content is executed.
        for command in (prepare, doctor):
            verify_tree(Path(ready["runtimePath"]), spec,
                        expected_receipt(spec, host, Path(ready["runtimePath"])))
            result = subprocess.run(command, shell=False, check=False)
            if result.returncode:
                return result.returncode if 0 < result.returncode < 256 else 1
        return 0
    except BootstrapError as error:
        event = "needs_attention" if error.code in ("bootstrap_busy", "runtime_unavailable", "unsupported_platform") else "error"
        emit(event, code=error.code, message=str(error))
        return 2
    except (OSError, ValueError, http.client.HTTPException, zipfile.BadZipFile, zipfile.LargeZipFile, RuntimeError):
        emit("error", code="bootstrap_failed", message="Native CLI preparation failed. Existing files and failed preparation evidence were preserved.")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
