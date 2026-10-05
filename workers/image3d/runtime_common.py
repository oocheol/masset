# SPDX-License-Identifier: MIT
"""Standard-library runtime contract, integrity checks and sanitized subprocesses."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
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
    return root / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def clean_env(root, threads=CPU_THREADS):
    """Never inherit tokens, user Python paths, proxy credentials or HF caches."""
    private = root / "private"
    env = {"PATH": str(runtime_python(root).parent) + os.pathsep + os.defpath,
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
    for key in ("SystemRoot", "WINDIR", "COMSPEC"):
        if key in os.environ:
            env[key] = os.environ[key]
    return env


def run_json(command, root, timeout=60):
    result = subprocess.run(command, env=clean_env(root), cwd=str(root),
                            capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise WorkerError("runtime_probe", "Runtime interpreter/dependency probe failed")
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise WorkerError("runtime_probe", "Runtime probe did not return valid JSON") from None


def lock_data():
    return read_json(MODULE_ROOT / "runtime-lock.json", 8 * 1024 * 1024)


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
