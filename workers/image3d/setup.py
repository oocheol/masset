# SPDX-License-Identifier: MIT
"""Pinned runtime preparation using standard CPython and an isolated venv.

This file is a CLI, not setuptools metadata. No uv, credentials, Git, CUDA,
background-removal model, user source execution, or cloud inference is involved.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import itertools
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import threading
import time
import uuid
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).absolute().parent))
from runtime_common import (CODE_REVISION, CPU_THREADS, DINO_REVISION, MODEL_ID,
                            MODEL_REVISION, MODEL_SHA256, MODULE_ROOT, SCHEMA_VERSION,
                            WorkerError, atomic_json, check_file, clean_env, emit,
                            file_receipt, lock_data, read_json, run_json, runtime_python,
                            utc_now, verify_runtime)
from upstream_patch import patch_source

PRINT_LOCK = threading.Lock()


def progress(stage, message, **fields):
    with PRINT_LOCK:
        emit("stage", stage=stage, message=message, **fields)


def approved_url(url):
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""
    allowed = host in {"pypi.org", "files.pythonhosted.org", "codeload.github.com", "huggingface.co"}
    allowed = allowed or host.endswith((".huggingface.co", ".hf.co", ".xethub.hf.co"))
    if parsed.scheme != "https" or not allowed or parsed.username or parsed.password:
        raise WorkerError("download_origin", "Runtime download requires an approved public HTTPS origin")


class PublicRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        approved_url(new_url)
        return super().redirect_request(request, response, code, message, headers, new_url)


def download(entry, target):
    if target.exists():
        check_file(target, entry)
        return
    approved_url(entry["url"])
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".part-" + str(os.getpid()) + "-" + uuid.uuid4().hex[:8])
    # Partial downloads from an interrupted run are retained, never used as models.
    if temporary.exists():
        raise WorkerError("download_partial", "A partial download already exists for this setup process")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), PublicRedirect())
    start = last = time.monotonic()
    size = 0
    digest = hashlib.sha256()
    try:
        request = urllib.request.Request(entry["url"], headers={"User-Agent": "AssetStudio-Image3D-Setup/1"})
        with opener.open(request, timeout=90) as response, temporary.open("xb") as handle:
            while True:
                block = response.read(4 * 1024 * 1024)
                if not block:
                    break
                size += len(block)
                if size > entry["bytes"]:
                    raise WorkerError("download_integrity", "Downloaded file exceeded its pinned size")
                handle.write(block)
                digest.update(block)
                if time.monotonic() - last >= 5:
                    progress("download", "Downloading " + target.name, basename=target.name,
                             downloadedBytes=size, totalBytes=entry["bytes"])
                    last = time.monotonic()
        if size != entry["bytes"] or digest.hexdigest() != entry["sha256"]:
            raise WorkerError("download_integrity", "Downloaded file did not match its pinned size and SHA-256")
        os.replace(str(temporary), str(target))
        progress("download", "Verified " + target.name, basename=target.name, downloadedBytes=size,
                 totalBytes=size, elapsedSeconds=round(time.monotonic() - start, 3))
    except WorkerError:
        raise
    except Exception as exc:
        # URL exceptions can contain signed CDN URLs. Never print their contents.
        raise WorkerError("download_failed", "Public runtime download failed (" + type(exc).__name__ + ")") from None


def write_verified(path, data, expected):
    if hashlib.sha256(data).hexdigest() != expected["sha256"] or len(data) != expected["bytes"]:
        raise WorkerError("runtime_integrity", "Audited source transformation did not match its lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        check_file(path, expected)
    else:
        with path.open("xb") as handle:
            handle.write(data)


def install_code(root, lock):
    archive_path = root / "downloads" / ("TripoSR-" + CODE_REVISION + ".tar.gz")
    download(lock["codeArchive"], archive_path)
    found = set()
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive.getmembers():
            prefix, separator, relative = member.name.partition("/")
            if not separator:
                continue
            if relative in lock["originalCodeFiles"]:
                if not member.isfile():
                    raise WorkerError("runtime_integrity", "Unexpected archived model source type")
                original = archive.extractfile(member).read()
                entry = lock["originalCodeFiles"][relative]
                if file_bytes(original) != {"sha256": entry["sha256"], "bytes": entry["bytes"]}:
                    raise WorkerError("runtime_integrity", "Pinned model source hash mismatch")
                write_verified(root / "code" / relative, patch_source(relative, original), lock["codeFiles"][relative])
                found.add(relative)
            elif relative == "LICENSE":
                write_verified(root / "licenses" / "TripoSR-LICENSE.txt", archive.extractfile(member).read(),
                               lock["runtimeFiles"]["licenses/TripoSR-LICENSE.txt"])
    if found != set(lock["originalCodeFiles"]):
        raise WorkerError("runtime_integrity", "Pinned model code archive is incomplete")
    write_verified(root / "code" / "image3d_adapter.py", (MODULE_ROOT / "image3d_adapter.py").read_bytes(),
                   lock["codeFiles"]["image3d_adapter.py"])


def install_license_bundle(root, lock):
    for relative, expected in lock.get("bundledLicenseFiles", {}).items():
        write_verified(root / relative, (MODULE_ROOT / relative).read_bytes(), expected)


def file_bytes(data):
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def call(command, root, log_name, timeout=600):
    log = root / "private" / log_name
    with log.open("w", encoding="utf-8") as handle:
        result = subprocess.run(command, cwd=str(root), env=clean_env(root), stdout=handle,
                                stderr=subprocess.STDOUT, timeout=timeout)
    if result.returncode:
        raise WorkerError("install_failed", "Isolated runtime step failed; inspect private/" + log_name)


def wheel_for(entry, supported):
    rank = {tag: i for i, tag in enumerate(supported)}
    choices = []
    for wheel in entry["wheels"]:
        _, py, abi, platform = wheel["filename"][:-4].rsplit("-", 3)
        tags = {"-".join(parts) for parts in itertools.product(py.split("."), abi.split("."), platform.split("."))}
        compatible = tags & rank.keys()
        if compatible:
            choices.append((min(rank[t] for t in compatible), wheel))
    if not choices:
        raise WorkerError("wheel_unavailable", "No pinned binary wheel is available for this interpreter/platform")
    return min(choices, key=lambda item: item[0])[1]


def build_antlr(root, entry):
    source = entry["source"]
    archive_path = root / "downloads" / source["filename"]
    download(source, archive_path)
    build_root = root / "private" / "antlr-source"
    build_root.mkdir(exist_ok=True)
    with tarfile.open(archive_path) as archive:
        for member in archive.getmembers():
            parts = Path(member.name).parts
            if not parts or Path(member.name).is_absolute() or ".." in parts or member.issym() or member.islnk():
                raise WorkerError("archive_invalid", "Unsafe pinned dependency archive entry")
            target = build_root.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile() and member.size <= 20 * 1024 ** 2:
                target.parent.mkdir(parents=True, exist_ok=True)
                data = archive.extractfile(member).read()
                if target.exists():
                    if target.read_bytes() != data:
                        raise WorkerError("runtime_integrity", "Pure-Python build source was modified")
                else:
                    target.write_bytes(data)
            else:
                raise WorkerError("archive_invalid", "Unsupported dependency archive entry")
    progress("dependencies", "Building the pinned pure-Python ANTLR runtime; no native compilation")
    call([str(runtime_python(root)), "-I", "-B", "-m", "pip", "--isolated", "--disable-pip-version-check",
          "wheel", "--no-index", "--no-deps", "--no-build-isolation", "--no-cache-dir", "--wheel-dir",
          str(root / "wheelhouse"), str(archive_path)], root, "antlr-build.log")
    matches = list((root / "wheelhouse").glob("antlr4_python3_runtime-4.9.3-*-none-any.whl"))
    if len(matches) != 1:
        raise WorkerError("install_failed", "Expected one pure-Python ANTLR wheel")
    return {"filename": matches[0].name, **file_receipt(matches[0]), "sourceSha256": source["sha256"],
            "sourceUrl": source["url"], "locallyBuiltPurePython": True}


def install_dependencies(root, lock):
    python = str(runtime_python(root))
    tags = run_json([python, "-I", "-B", "-c",
                     "import json; from pip._vendor.packaging.tags import sys_tags; print(json.dumps([str(t) for t in sys_tags()]))"], root)
    selected = {name: wheel_for(entry, tags) for name, entry in lock["packages"].items() if "source" not in entry}
    progress("dependencies", "Downloading exact compatible wheels from public PyPI", packageCount=len(selected))
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(download, entry, root / "wheelhouse" / entry["filename"]) for entry in selected.values()]
        for future in futures:
            future.result()
    bootstrap = [str(root / "wheelhouse" / selected[name]["filename"]) for name in ("pip", "setuptools", "wheel")]
    call([python, "-I", "-B", "-m", "pip", "--isolated", "--disable-pip-version-check", "install",
          "--no-index", "--no-deps", "--no-cache-dir", *bootstrap], root, "bootstrap.log")
    selected["antlr4-python3-runtime"] = build_antlr(root, lock["packages"]["antlr4-python3-runtime"])
    requirements = root / "requirements-installed.txt"
    requirements.write_text("".join(name + "==" + lock["packages"][name]["version"] + " --hash=sha256:" + entry["sha256"] + "\n"
                                    for name, entry in sorted(selected.items())), encoding="utf-8")
    progress("dependencies", "Installing isolated, hash-verified dependencies")
    call([python, "-I", "-B", "-m", "pip", "--isolated", "--disable-pip-version-check", "install",
          "--no-index", "--no-deps", "--require-hashes", "--no-cache-dir", "--find-links", str(root / "wheelhouse"),
          "-r", str(requirements)], root, "dependencies.log")
    call([python, "-I", "-B", "-m", "pip", "--isolated", "--disable-pip-version-check", "check"], root, "dependency-check.log")
    return selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--python-executable", type=Path, required=True)
    args = parser.parse_args()
    started = time.monotonic()
    root = args.runtime_root.absolute()
    acquired = False
    try:
        if root.is_symlink() or (root.exists() and not root.is_dir()):
            raise WorkerError("runtime_path", "runtime-root must be a real directory")
        marker = root / ".image3d-runtime.json"
        if root.exists() and any(root.iterdir()) and not marker.is_file():
            raise WorkerError("runtime_path", "Refusing a populated directory not owned by this runtime")
        root.mkdir(parents=True, exist_ok=True)
        if marker.exists():
            if read_json(marker) != {"schemaVersion": SCHEMA_VERSION, "modelId": MODEL_ID, "modelRevision": MODEL_REVISION}:
                raise WorkerError("runtime_path", "This directory belongs to another runtime version")
        else:
            atomic_json(marker, {"schemaVersion": SCHEMA_VERSION, "modelId": MODEL_ID, "modelRevision": MODEL_REVISION})
        try:
            with (root / ".setup-lock").open("x") as handle:
                handle.write(str(os.getpid()))
            acquired = True
        except FileExistsError:
            raise WorkerError("setup_running", "Another setup owns this runtime; check its progress or interrupted setup lock") from None
        for folder in ("private/tmp", "private/cache", "private/hf", "downloads", "wheelhouse", "licenses"):
            (root / folder).mkdir(parents=True, exist_ok=True)
        lock = lock_data()
        install_license_bundle(root, lock)
        if (root / "ready.json").exists():
            ready = verify_runtime(root)
            proof = run_json([str(runtime_python(root)), "-I", "-B", str(MODULE_ROOT / "runtime_probe.py"),
                              "--runtime-root", str(root), "--collect-licenses"], root, timeout=180)
            ready["provenance"]["runtimeFiles"] = lock["runtimeFiles"]
            ready["provenance"]["licenses"] = proof["licenses"]
            ready["provenance"]["bundledLicenseSources"] = lock.get("bundledLicenseSources", {})
            ready["provenance"]["workerRuntimeLock"] = file_receipt(MODULE_ROOT / "runtime-lock.json")
            atomic_json(root / "ready.json", ready)
            atomic_json(root / "setup-state.json", {"state": "ready", "message": "Pinned runtime installation verified", "installed": True})
            emit("completed", state="ready", installed=True, message="Pinned runtime already verified",
                 interpreterPath=ready["interpreterPath"], installVerified=True,
                 inferenceVerified=ready.get("inferenceVerified", False), elapsedSeconds=round(time.monotonic()-started, 3))
            return 0
        progress("interpreter", "Checking supplied standard CPython interpreter")
        if not args.python_executable.is_absolute() or not args.python_executable.is_file():
            raise WorkerError("python_unsupported", "python-executable must be an absolute installed CPython path")
        base = run_json([str(args.python_executable), "-I", "-B", "-c",
                         "import json,platform,sys; print(json.dumps({'implementation':platform.python_implementation(), 'version':list(sys.version_info[:3]), 'platform':platform.system(), 'machine':platform.machine(), 'executable':sys.executable}))"], root)
        if base["implementation"] != "CPython" or tuple(base["version"][:2]) != (3, 9):
            raise WorkerError("python_unsupported", "This release requires standard CPython 3.9 on Mac arm64. Python 3.10–3.12 have not been verified; use /usr/bin/python3 when it is version 3.9")
        if (base["platform"], base["machine"].lower()) != ("Darwin", "arm64"):
            raise WorkerError("platform_unsupported", "This runtime release has native proof only for Mac arm64 with CPython 3.9")
        progress("interpreter", "Creating isolated venv with the supplied interpreter", pythonVersion=".".join(map(str, base["version"])))
        if not runtime_python(root).exists():
            call([str(args.python_executable), "-I", "-B", "-m", "venv", str(root / "venv")], root, "venv.log")
        install_code(root, lock)
        progress("model", "Caching pinned TripoSR weights, model configuration and DINO configuration")
        for relative, entry in lock["runtimeFiles"].items():
            if "url" in entry:
                download(entry, root / relative)
        selected = install_dependencies(root, lock)
        progress("verify", "Verifying native CPU imports, dependency versions and mesh extraction")
        proof = run_json([str(runtime_python(root)), "-I", "-B", str(MODULE_ROOT / "runtime_probe.py"),
                          "--runtime-root", str(root), "--collect-licenses"], root, timeout=180)
        if Path(proof["prefix"]).resolve() != (root / "venv").resolve():
            raise WorkerError("runtime_probe", "Interpreter is not using the isolated runtime venv")
        ready = {"schemaVersion": SCHEMA_VERSION, "state": "ready", "installed": True,
                 "interpreterPath": str(runtime_python(root)), "pythonVersion": proof["pythonVersion"],
                 "baseInterpreterPath": base["executable"], "modelId": MODEL_ID, "modelRevision": MODEL_REVISION,
                 "codeRevision": CODE_REVISION, "modelSha256": MODEL_SHA256, "device": "cpu", "cpuThreads": CPU_THREADS,
                 "installVerified": True, "inferenceVerified": False, "installedAt": utc_now(),
                 "dependencies": proof["dependencies"], "platform": proof["platform"], "machine": proof["machine"],
                 "provenance": {"codeArchive": lock["codeArchive"], "runtimeFiles": lock["runtimeFiles"],
                                "codeFiles": lock["codeFiles"], "originalCodeFiles": lock["originalCodeFiles"],
                                "dinoModelId": "facebook/dino-vitb16", "dinoRevision": DINO_REVISION,
                                "dependencyArchives": selected, "licenses": proof["licenses"],
                                "bundledLicenseSources": lock.get("bundledLicenseSources", {}),
                                "workerRuntimeLock": file_receipt(MODULE_ROOT / "runtime-lock.json"),
                                "patches": ["local DINO config", "offline local-only checkpoint loader with weights_only=True",
                                            "no rembg import/background removal", "CPU scikit-image marching-cubes adapter"]},
                 "installProof": {k: proof[k] for k in ("cpuTensorVerified", "marchingCubesVerified", "upstreamImportsVerified")}}
        atomic_json(root / "ready.json", ready)
        verify_runtime(root, probe=False)
        atomic_json(root / "setup-state.json", {"state": "ready", "message": "Pinned runtime installation verified", "installed": True})
        emit("completed", state="ready", installed=True, message="Pinned runtime installation verified",
             interpreterPath=ready["interpreterPath"], pythonVersion=ready["pythonVersion"],
             installVerified=True, inferenceVerified=False, elapsedSeconds=round(time.monotonic()-started, 3))
        return 0
    except Exception as exc:
        code = exc.code if isinstance(exc, WorkerError) else "setup_failed"
        message = str(exc) if isinstance(exc, WorkerError) else "Runtime preparation failed (" + type(exc).__name__ + ")"
        if acquired:
            atomic_json(root / "setup-state.json", {"state": "error", "message": message, "installed": False, "code": code})
        emit("failed", state="error", installed=False, code=code, message=message, elapsedSeconds=round(time.monotonic()-started, 3))
        return 1
    finally:
        if acquired:
            (root / ".setup-lock").unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
