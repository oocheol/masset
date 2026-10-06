# SPDX-License-Identifier: MIT
"""Standard-library runtime contract, integrity checks and sanitized subprocesses."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys
import time
import zipfile
from datetime import datetime, timezone

MODULE_ROOT = Path(__file__).absolute().parent
MODEL_ID = "stabilityai/TripoSR"
MODEL_REVISION = "5b521936b01fbe1890f6f9baed0254ab6351c04a"
CODE_REVISION = "107cefdc244c39106fa830359024f6a2f1c78871"
MODEL_SHA256 = "429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee"
MODEL_BYTES = 1677246742
DINO_REVISION = "f205d5d8e640a89a2b8ef0369670dfc37cc07fc2"
SCHEMA_VERSION = 1
QUALITY = {"draft": 64, "standard": 128, "high": 192}
CPU_THREADS = 4


class WorkerError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def emit(kind, **fields):
    print(json.dumps({"type": kind, **fields}, ensure_ascii=True, allow_nan=False), flush=True)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise WorkerError("invalid_json", "Duplicate JSON field")
        result[key] = value
    return result


def read_json(path, limit=1024 * 1024):
    with open_regular(path, limit) as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise WorkerError("invalid_json", "JSON exceeds its size limit")
    try:
        return json.loads(data.decode("utf-8-sig"), object_pairs_hook=unique_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError):
        raise WorkerError("invalid_json", "Expected valid finite UTF-8 JSON") from None


def open_regular(path, limit):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(str(path), flags)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            os.close(descriptor)
            raise WorkerError("invalid_file", "Expected a regular file within the size limit")
        return os.fdopen(descriptor, "rb")
    except OSError:
        raise WorkerError("invalid_file", "Cannot read the requested regular file") from None


def file_receipt(path, basename=None):
    digest = hashlib.sha256()
    size = 0
    with open_regular(path, 4 * 1024 ** 3) as handle:
        for block in iter(lambda: handle.read(4 * 1024 ** 2), b""):
            digest.update(block)
            size += len(block)
    return {"basename": basename or Path(path).name, "sha256": digest.hexdigest(), "bytes": size}


def check_file(path, expected):
    actual = file_receipt(path)
    if actual["sha256"] != expected["sha256"] or actual["bytes"] != expected["bytes"]:
        raise WorkerError("runtime_integrity", "Runtime file integrity check failed: " + Path(path).name)
    return actual


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp-" + str(os.getpid()))
    with temporary.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=True, allow_nan=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(str(temporary), str(path))


def runtime_python(root):
    if os.name == "nt" and (root / "venv" / "python.exe").is_file():
        return root / "venv" / "python.exe"
    return root / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def clean_env(root, threads=CPU_THREADS):
    """Never inherit tokens, user Python paths, proxy credentials or HF caches."""
    private = root / "private"
    system_path = (str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32") if os.name == "nt" else os.defpath)
    env = {"PATH": str(runtime_python(root).parent) + os.pathsep + system_path,
           "HOME": str(private), "USERPROFILE": str(private),
           "XDG_CONFIG_HOME": str(private), "XDG_CACHE_HOME": str(private / "cache"),
           "TMPDIR": str(private / "tmp"), "TEMP": str(private / "tmp"), "TMP": str(private / "tmp"),
           "HF_HOME": str(private / "hf"), "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
           "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
           "DO_NOT_TRACK": "1", "TOKENIZERS_PARALLELISM": "false", "PYTHONNOUSERSITE": "1",
           "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1", "PIP_CONFIG_FILE": os.devnull,
           "OMP_NUM_THREADS": str(threads), "OPENBLAS_NUM_THREADS": str(threads),
           "MKL_NUM_THREADS": str(threads), "VECLIB_MAXIMUM_THREADS": str(threads),
           "NUMEXPR_NUM_THREADS": str(threads), "LANG": "en_US.UTF-8"}
    # CPython's Windows machine() falls back to these OS fields when WMI is
    # unavailable. Keep the architecture gate reliable in nested isolated
    # workers without inheriting credentials, proxies or user Python paths.
    for key in ("SystemRoot", "WINDIR", "COMSPEC", "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432"):
        if key in os.environ:
            env[key] = os.environ[key]
    return env


def run_json(command, root, timeout=60):
    result = subprocess.run(command, env=clean_env(root), cwd=str(root),
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    if result.returncode:
        # The process receives no inherited credentials. Preserve its native
        # loader diagnostics privately instead of silently discarding them.
        try:
            (root / "private" / "runtime-probe.log").write_text(result.stdout + "\n" + result.stderr, encoding="utf-8")
        except OSError:
            pass
        message = "Runtime interpreter/dependency probe failed; inspect private/runtime-probe.log"
        if os.name == "nt" and any(str(item).endswith("runtime_probe.py") for item in command):
            message += "; if the log reports a missing MSVC DLL, install Microsoft's Visual C++ 2015-2022 x64 runtime"
        raise WorkerError("runtime_probe", message)
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise WorkerError("runtime_probe", "Runtime probe did not return valid JSON") from None


def lock_path(system=None):
    system = platform.system() if system is None else system
    return MODULE_ROOT / ("runtime-lock-windows.json" if system == "Windows" else "runtime-lock.json")


def lock_data():
    return read_json(lock_path(), 8 * 1024 * 1024)


def interpreter_target(lock):
    # The original Mac lock is deliberately byte-for-byte unchanged.
    return lock.get("target", {"system": "Darwin", "machine": "arm64", "pythonMajorMinor": [3, 9], "device": "cpu"})


def validate_interpreter(base, lock):
    target = interpreter_target(lock)
    machine = str(base.get("machine", "")).lower()
    if (base.get("platform"), machine) != (target["system"], target["machine"].lower()):
        raise WorkerError("platform_unsupported", "Pinned CPU runtime requires " + target["system"] + " " + target["machine"])
    if base.get("implementation") != "CPython" or base.get("version", [])[:2] != target["pythonMajorMinor"]:
        required = ".".join(map(str, target["pythonMajorMinor"]))
        raise WorkerError("python_unsupported", "Pinned CPU runtime requires standard CPython " + required)
    if base.get("pointerBits", 64) != 64:
        raise WorkerError("python_unsupported", "Pinned CPU runtime requires a 64-bit interpreter")


def require_windows_vc_runtime():
    """Check the wheel's known external DLL prerequisite without installing it."""
    if os.name != "nt":
        return
    system = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "msvcp140.dll"
    # The pinned Torch wheel requires this DLL. The official Python ZIP supplies
    # VCRUNTIME140 and VCRUNTIME140_1, but MSVCP140 is an existing host prerequisite.
    if not system.is_file():
        raise WorkerError("msvc_runtime_missing",
                          "Microsoft Visual C++ 2015-2022 x64 runtime is required (MSVCP140.dll missing). "
                          "Install it from https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist "
                          "and prepare Image-to-3D again")


def windows_setup_lock(path):
    """Hold a byte-range lock for the setup process lifetime, with a PID receipt."""
    import msvcrt
    path = Path(path)
    try:
        handle = path.open("x+b")
    except FileExistsError:
        handle = path.open("r+b")
    try:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise WorkerError("runtime_path", "Setup lock must be a regular owned file")
        handle.seek(0)
        # Windows permits locking a byte beyond EOF, so no unlocked pre-write
        # can race with another owner initializing this new lock file.
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        handle.close()
        raise WorkerError("setup_running", "Another setup process holds this runtime lock") from None
    except BaseException:
        handle.close()
        raise
    try:
        handle.seek(0)
        handle.write(str(os.getpid()).encode("ascii"))
        handle.truncate()
        handle.flush()
        os.fsync(handle.fileno())
        return handle
    except BaseException:
        release_windows_setup_lock(handle)
        raise


def release_windows_setup_lock(handle):
    import msvcrt
    try:
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    finally:
        handle.close()
    # Keep the same inode/file: deleting it could let two processes lock
    # different files after one already opened this path. A crash releases the
    # operating-system lock automatically; the next setup replaces the stale PID.


def setup_lock_active(path):
    path = Path(path)
    if os.name != "nt":
        return path.exists()
    import msvcrt
    try:
        handle = path.open("r+b")
    except FileNotFoundError:
        return False
    try:
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            return True
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        return False
    finally:
        handle.close()


def embedded_pth():
    return b"python312.zip\n.\nLib/site-packages\nimport site\n"


def embedded_files(archive, entry):
    """Read only the hash-pinned official ZIP; never extract untrusted paths."""
    check_file(archive, entry)
    files = {}
    total = 0
    with zipfile.ZipFile(archive) as handle:
        for member in handle.infolist():
            name = member.filename
            # The official embedded distribution has only top-level files.
            # Reject paths, special files, duplicates and oversized extraction.
            mode = member.external_attr >> 16
            if (not name or "/" in name or "\\" in name or ":" in name or name in {".", ".."}
                    or name.endswith((".", " ")) or name in files or member.is_dir()
                    or stat.S_ISLNK(mode) or member.file_size > 128 * 1024 ** 2):
                raise WorkerError("archive_invalid", "Unexpected official embedded Python ZIP entry")
            total += member.file_size
            if total > 256 * 1024 ** 2:
                raise WorkerError("archive_invalid", "Embedded Python extraction exceeds its bound")
            files[name] = handle.read(member)
    if not {"python.exe", "python312.dll", "python312.zip", "python312._pth", "LICENSE.txt"} <= set(files):
        raise WorkerError("archive_invalid", "Embedded Python ZIP is incomplete")
    files["python312._pth"] = embedded_pth()
    return files


def verify_embedded_python(root, lock):
    entry = lock.get("embeddedPython")
    if not isinstance(entry, dict):
        raise WorkerError("runtime_integrity", "Embedded Python is unavailable for this platform lock")
    files = embedded_files(root / "downloads" / entry["filename"], entry)
    folder = root / "venv"
    actual = {p.name for p in folder.iterdir() if p.is_file()}
    if actual != set(files):
        raise WorkerError("runtime_integrity", "Unexpected or missing embedded interpreter files")
    for name, data in files.items():
        check_file(folder / name, {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})


def expected_code():
    return lock_data()["codeFiles"]


def verify_runtime(root, probe=True):
    # Read/inference callers may use a coordinator-owned alias to this runtime;
    # ready.json records the real absolute venv path, never the alias spelling.
    root = Path(root).resolve()
    ready = read_json(root / "ready.json")
    expected = {"schemaVersion": SCHEMA_VERSION, "state": "ready", "modelId": MODEL_ID,
                "modelRevision": MODEL_REVISION, "codeRevision": CODE_REVISION,
                "modelSha256": MODEL_SHA256, "installVerified": True,
                "interpreterPath": str(runtime_python(root)), "device": "cpu"}
    if not isinstance(ready, dict) or any(ready.get(k) != v for k, v in expected.items()):
        raise WorkerError("runtime_integrity", "Runtime ready metadata does not match the pinned worker")
    if type(ready.get("cpuThreads")) is not int or not 1 <= ready["cpuThreads"] <= 4:
        raise WorkerError("runtime_integrity", "Invalid runtime CPU thread setting")
    lock = lock_data()
    target = interpreter_target(lock)
    if (platform.system(), platform.machine().lower()) != (target["system"], target["machine"].lower()):
        raise WorkerError("platform_unsupported", "This platform does not match the pinned CPU runtime")
    require_windows_vc_runtime()
    version = str(ready.get("pythonVersion", "")).split(".")
    if (ready.get("platform"), str(ready.get("machine", "")).lower()) != (target["system"], target["machine"].lower()):
        raise WorkerError("runtime_integrity", "Runtime platform differs from its dependency lock")
    if version[:2] != [str(n) for n in target["pythonMajorMinor"]]:
        raise WorkerError("runtime_integrity", "Runtime Python version differs from its dependency lock")
    if ready.get("isolationMode", "venv") not in {"venv", "embedded"}:
        raise WorkerError("runtime_integrity", "Runtime isolation mode is unknown")
    if ready.get("isolationMode") == "embedded":
        verify_embedded_python(root, lock)
        if ready["pythonVersion"] != lock["embeddedPython"]["version"]:
            raise WorkerError("runtime_integrity", "Managed embedded Python version differs from its lock")
    for relative, expected_file in lock["runtimeFiles"].items():
        check_file(root / relative, expected_file)
    code_files = lock["codeFiles"]
    code = root / "code"
    # Namespace packages upstream need no __init__.py. Unexpected Python files,
    # bytecode and extension modules could shadow audited imports, so reject them.
    actual_files = {str(p.relative_to(code)).replace(os.sep, "/") for p in code.rglob("*") if p.is_file()}
    if actual_files != set(code_files):
        raise WorkerError("runtime_integrity", "Unexpected or missing files in pinned model code")
    for relative, expected_file in code_files.items():
        check_file(code / relative, expected_file)
    # The adapter is part of the worker implementation, copied during setup.
    adapter = file_receipt(MODULE_ROOT / "image3d_adapter.py")
    check_file(root / "code" / "image3d_adapter.py", adapter)
    pinned = {k: v["version"] for k, v in lock["packages"].items()}
    if ready.get("dependencies") != pinned:
        raise WorkerError("runtime_integrity", "Runtime dependency metadata differs from the lock")
    if probe:
        proof = run_json([str(runtime_python(root)), "-I", "-B", str(MODULE_ROOT / "runtime_probe.py"),
                          "--runtime-root", str(root)], root)
        if proof.get("dependencies") != pinned or proof.get("pythonVersion") != ready.get("pythonVersion"):
            raise WorkerError("runtime_integrity", "Installed interpreter/dependencies differ from ready metadata")
        if (proof.get("platform"), str(proof.get("machine", "")).lower()) != (target["system"], target["machine"].lower()):
            raise WorkerError("runtime_integrity", "Runtime interpreter platform differs from its lock")
        if (Path(proof.get("prefix", "")).resolve() != (root / "venv").resolve()
                or proof.get("interpreterPath") != ready["interpreterPath"]
                or not proof.get("cpuTensorVerified") or not proof.get("marchingCubesVerified")):
            raise WorkerError("runtime_integrity", "Recorded isolated CPU interpreter could not be verified")
    return ready


def validate_job(path):
    job = read_json(path, 16 * 1024)
    keys = {"name", "sourcePath", "sourceSha256", "quality", "cpuThreads"}
    if not isinstance(job, dict) or set(job) != keys:
        raise WorkerError("invalid_input", "Input requires exactly name, sourcePath, sourceSha256, quality, cpuThreads")
    name = job["name"]
    if (not isinstance(name, str) or not 1 <= len(name) <= 80 or name.strip() != name
            or name in {".", ".."} or name.endswith(".")
            or re.search(r'[\x00-\x1f\x7f-\x9f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]', name)):
        raise WorkerError("invalid_input", "name must contain 1–80 safe characters without path syntax")
    reserved = {"CON", "PRN", "AUX", "NUL"} | {"COM" + str(i) for i in range(1, 10)} | {"LPT" + str(i) for i in range(1, 10)}
    if name.split(".")[0].upper() in reserved:
        raise WorkerError("invalid_input", "name cannot be a reserved Windows device name")
    source = job["sourcePath"]
    if not isinstance(source, str) or "\x00" in source or not Path(source).is_absolute():
        raise WorkerError("invalid_input", "sourcePath must be an absolute path to one image")
    if Path(source).suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise WorkerError("invalid_input", "Only PNG, JPEG and WebP image inputs are accepted")
    sha = job["sourceSha256"]
    if not isinstance(sha, str) or re.fullmatch(r"[a-fA-F0-9]{64}", sha) is None:
        raise WorkerError("invalid_input", "sourceSha256 must be 64 hexadecimal characters")
    if not isinstance(job["quality"], str) or job["quality"] not in QUALITY:
        raise WorkerError("invalid_input", "quality must be draft, standard or high")
    if type(job["cpuThreads"]) is not int or not 1 <= job["cpuThreads"] <= 4:
        raise WorkerError("invalid_input", "cpuThreads must be an integer from 1 through 4")
    job["sourceSha256"] = sha.lower()
    return job


def prepare_output(path):
    path = Path(path).absolute()
    if path.is_symlink() or (path.exists() and (not path.is_dir() or any(path.iterdir()))):
        raise WorkerError("output_not_empty", "output-dir must be a new directory or an existing empty directory")
    path.mkdir(parents=True, exist_ok=True)
    # Exclusive reservation prevents two workers from using the same empty dir.
    try:
        (path / ".image3d-running").open("x").close()
    except FileExistsError:
        raise WorkerError("output_not_empty", "output-dir is already in use") from None
    return path
