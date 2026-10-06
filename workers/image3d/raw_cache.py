# SPDX-License-Identifier: MIT
"""Private, byte-verified raw reconstruction cache; no models or network APIs."""
from __future__ import annotations

import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

from runtime_common import (CODE_REVISION, DINO_REVISION, MODEL_ID, MODEL_REVISION,
                            MODEL_SHA256, MODULE_ROOT, QUALITY, WorkerError,
                            emit, file_receipt, lock_path, read_json, utc_now)

CACHE_SCHEMA = 1
PREPROCESSING_VERSION = "transparent-single-object-512-v1"
OWNER = {"schemaVersion": CACHE_SCHEMA, "owner": "asset-studio-image3d-raw-cache"}
FILES = {"mesh.glb": 128 * 1024 ** 2, "prepared-input.png": 8 * 1024 ** 2,
         "generation.json": 1024 ** 2}
KEY = re.compile(r"[a-f0-9]{64}\Z")


def canonical_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
                      allow_nan=False).encode("utf-8")


def cache_descriptor(job, ready):
    """Thread count stays in the key: cross-thread bit identity is unproven.

    Geometry budget, texture size and physical height are downstream settings;
    changing them does not change this raw one-metre reconstruction.
    """
    implementations = {}
    for name in ("worker.py", "image_input.py", "glb_color.py", "image3d_adapter.py",
                 "runtime_common.py", "raw_cache.py"):
        implementations[name] = file_receipt(MODULE_ROOT / name)
    return {"schemaVersion": CACHE_SCHEMA, "sourceSha256": job["sourceSha256"],
            "preprocessingVersion": PREPROCESSING_VERSION, "implementations": implementations,
            "runtimeLock": file_receipt(lock_path()), "modelId": MODEL_ID,
            "modelRevision": MODEL_REVISION, "codeRevision": CODE_REVISION,
            "modelSha256": MODEL_SHA256, "dinoRevision": DINO_REVISION,
            "pythonVersion": ready["pythonVersion"], "platform": ready["platform"],
            "machine": ready["machine"], "dependencies": ready["dependencies"],
            "quality": job["quality"], "gridResolution": QUALITY[job["quality"]],
            "cpuThreads": job["cpuThreads"], "device": "cpu", "densityThreshold": 25.0,
            "decoderChunkSize": 8192, "seed": 0}


def descriptor_key(descriptor):
    return hashlib.sha256(canonical_bytes(descriptor)).hexdigest()


def _linked(info):
    return (stat.S_ISLNK(info.st_mode)
            or bool(getattr(info, "st_file_attributes", 0)
                    & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)))


def checked_path(path, *, directory=False, missing=False):
    """Reject links/junctions at every existing component, before resolving it."""
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise WorkerError("cache_path", "Cache paths must be absolute without traversal")
    components = [*reversed(path.parents), path]
    for component in components:
        try:
            info = component.lstat()
        except FileNotFoundError:
            if missing:
                continue
            raise WorkerError("cache_integrity", "Cache path is missing") from None
        if _linked(info):
            raise WorkerError("cache_path", "Cache links and reparse points are not accepted")
        if component != path or directory:
            if not stat.S_ISDIR(info.st_mode):
                raise WorkerError("cache_path", "Cache parent paths must be real directories")
        elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise WorkerError("cache_path", "Cache artifacts must be owned regular files without hard links")
    return path


def _open_checked(path, *, write=False, create=False):
    path = checked_path(path, missing=create)
    flags = (os.O_RDWR if write else os.O_RDONLY) | getattr(os, "O_NOFOLLOW", 0)
    if create:
        flags |= os.O_CREAT
    before = path.lstat() if path.exists() else None
    descriptor = os.open(str(path), flags, 0o600)
    try:
        actual = os.fstat(descriptor)
        after = path.lstat()
        if (_linked(after) or not stat.S_ISREG(actual.st_mode) or actual.st_nlink != 1
                or (actual.st_dev, actual.st_ino) != (after.st_dev, after.st_ino)
                or (before and (before.st_dev, before.st_ino) != (actual.st_dev, actual.st_ino))):
            raise WorkerError("cache_path", "Cache file changed while it was being opened")
        return os.fdopen(descriptor, "r+b" if write else "rb")
    except BaseException:
        os.close(descriptor)
        raise


def _copy_checked(source, destination, expected):
    checked_path(destination, missing=True)
    digest = hashlib.sha256()
    size = 0
    with _open_checked(source) as input_file, Path(destination).open("xb") as output_file:
        for block in iter(lambda: input_file.read(1024 ** 2), b""):
            size += len(block)
            if size > expected["bytes"]:
                raise WorkerError("cache_integrity", "Cached artifact grew during copying")
            digest.update(block)
            output_file.write(block)
        output_file.flush()
        os.fsync(output_file.fileno())
    actual = {"basename": Path(destination).name, "bytes": size, "sha256": digest.hexdigest()}
    if actual != expected or file_receipt(destination) != expected:
        raise WorkerError("cache_integrity", "Copied cache artifact failed byte verification")


def _write_new_json(path, value):
    checked_path(path, missing=True)
    with Path(path).open("xb") as handle:
        handle.write(canonical_bytes(value) + b"\n")
        handle.flush()
        os.fsync(handle.fileno())


def _lock(handle, acquire):
    handle.seek(0)
    if os.name == "nt":
        import msvcrt
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK if acquire else msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle.fileno(), (fcntl.LOCK_EX | fcntl.LOCK_NB) if acquire else fcntl.LOCK_UN)


class RawCache:
    """One OS-owned key lock covers lookup, inference and atomic publication.

    Lock files remain in place. Process death releases the OS lock, allowing a
    new process to recover without trusting stale PIDs or half-written entries.
    """
    def __init__(self, root, descriptor, wait_seconds=900):
        self.root = Path(root)
        self.descriptor = descriptor
        self.key = descriptor_key(descriptor)
        self.wait_seconds = wait_seconds
        self.handle = None
        self.recovered = False
        self.cached = None
        self.entry = self.root / "entries" / self.key

    def __enter__(self):
        checked_path(self.root, directory=True, missing=True)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        marker = self.root / ".image3d-cache.json"
        if not marker.exists():
            # Never adopt a populated directory whose ownership is unknown.
            if any(self.root.iterdir()) and not marker.exists():
                raise WorkerError("cache_path", "Cache root must be new, empty or carry its exact ownership marker")
            try:
                _write_new_json(marker, OWNER)
            except FileExistsError:
                pass  # A concurrent first owner wrote the same marker.
        checked_path(marker)
        # Another first-use worker may have exclusively created the tiny marker
        # but not finished flushing it yet. A bounded retry never adopts a
        # different marker or touches any existing user file.
        owner = None
        for attempt in range(20):
            try:
                owner = read_json(marker, 4096)
                break
            except WorkerError as exc:
                if exc.code != "invalid_json" or attempt == 19:
                    raise
                time.sleep(.01)
        if owner != OWNER:
            raise WorkerError("cache_path", "Cache root ownership marker is invalid")
        for name in ("entries", "locks", "quarantine"):
            folder = self.root / name
            checked_path(folder, directory=True, missing=True)
            folder.mkdir(mode=0o700, exist_ok=True)
        lock = self.root / "locks" / (self.key + ".lock")
        self.handle = _open_checked(lock, write=True, create=True)
        deadline = time.monotonic() + self.wait_seconds
        waiting = False
        try:
            while True:
                try:
                    _lock(self.handle, True)
                    break
                except OSError as exc:
                    if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                        raise
                    if not waiting:
                        emit("stage", stage="cache-wait", message="Waiting for the current raw reconstruction cache owner", cacheKey=self.key)
                        waiting = True
                    if time.monotonic() >= deadline:
                        raise WorkerError("cache_busy", "Another reconstruction holds this cache key; retry after it finishes") from None
                    time.sleep(min(.1, max(0, deadline - time.monotonic())))
            checked_path(self.root, directory=True)
            return self
        except BaseException:
            self.handle.close()
            self.handle = None
            raise

    def __exit__(self, *args):
        if self.handle is not None:
            try:
                _lock(self.handle, False)
            finally:
                self.handle.close()
                self.handle = None

    def info(self, hit=False):
        result = {"enabled": True, "hit": hit, "key": self.key,
                  "integrityVerified": hit, "state": "hit" if hit else ("recovered" if self.recovered else "miss")}
        if hit and self.cached:
            origin = self.cached["generation"]
            result.update(originGenerationSha256=self.cached["inventory"]["generation.json"]["sha256"],
                          originGeneratedAt=origin["generatedAt"],
                          originStageDurations=origin.get("stageDurations", {}),
                          originRuntime=origin["runtime"], originCpuThreads=origin["cpuThreads"],
                          inferenceProofUpdated=False)
        return result

    def quarantine(self, reason):
        # Keep all bytes for inspection. Fixed hash names remain inside this
        # owned root; unsafe links/reparse points fail before this mutation.
        checked_path(self.entry, directory=True)
        for child in self.entry.iterdir():
            checked_path(child, directory=child.is_dir())
        destination = self.root / "quarantine" / (self.key + "-" + uuid.uuid4().hex)
        checked_path(destination, directory=True, missing=True)
        os.rename(str(self.entry), str(destination))
        self.recovered = True
        self.cached = None
        emit("stage", stage="cache-invalid", message="Preserved an invalid raw cache entry; reconstruction will run again",
             cacheKey=self.key, reason=reason, quarantineEntry=destination.name)

    def load(self, prepared_receipt, verify_geometry):
        if not self.entry.exists() and not self.entry.is_symlink():
            return None
        checked_path(self.entry, directory=True)
        try:
            if {p.name for p in self.entry.iterdir()} != {*FILES, "receipt.json"}:
                raise WorkerError("cache_integrity", "Unexpected or missing raw cache artifacts")
            for name in (*FILES, "receipt.json"):
                checked_path(self.entry / name)
            receipt = read_json(self.entry / "receipt.json")
            if (not isinstance(receipt, dict) or set(receipt) != {"schemaVersion", "key", "descriptor", "createdAt", "artifacts"}
                    or receipt["schemaVersion"] != CACHE_SCHEMA or receipt["key"] != self.key
                    or receipt["descriptor"] != self.descriptor or not isinstance(receipt["createdAt"], str)):
                raise WorkerError("cache_integrity", "Raw cache receipt does not match the current reconstruction")
            if not isinstance(receipt["artifacts"], list) or len(receipt["artifacts"]) != len(FILES):
                raise WorkerError("cache_integrity", "Raw cache receipt requires the exact artifact inventory")
            inventory = {}
            for item in receipt["artifacts"]:
                if (not isinstance(item, dict) or set(item) != {"basename", "bytes", "sha256"}
                        or item["basename"] not in FILES or item["basename"] in inventory
                        or type(item["bytes"]) is not int or not 1 <= item["bytes"] <= FILES[item["basename"]]
                        or not isinstance(item["sha256"], str) or KEY.fullmatch(item["sha256"]) is None):
                    raise WorkerError("cache_integrity", "Raw cache artifact inventory is invalid")
                path = self.entry / item["basename"]
                if file_receipt(path) != item:
                    raise WorkerError("cache_integrity", "Raw cache artifact bytes differ from their receipt")
                inventory[item["basename"]] = item
            if inventory["prepared-input.png"] != prepared_receipt:
                raise WorkerError("cache_integrity", "Cached conditioning image differs from the currently decoded source")
            generation = read_json(self.entry / "generation.json")
            self._validate_generation(generation, inventory)
            verify_geometry(self.entry / "mesh.glb", generation["geometry"])
            self.cached = {"generation": generation, "inventory": inventory}
            return generation
        except WorkerError as exc:
            if exc.code == "cache_path":
                raise
            self.quarantine(exc.code)
            return None
        except (ValueError, KeyError, TypeError, OSError) as exc:
            self.quarantine(type(exc).__name__)
            return None

    def _validate_generation(self, generation, inventory):
        pinned = {k: self.descriptor[k] for k in ("modelId", "modelRevision", "codeRevision", "modelSha256", "dinoRevision",
                                                "quality", "cpuThreads", "device")}
        if (not isinstance(generation, dict) or generation.get("schemaVersion") != 1
                or generation.get("inferenceExecuted") is not True
                or any(generation.get(k) != v for k, v in pinned.items())
                or type(generation.get("cpuThreads")) is not int
                or not isinstance(generation.get("source"), dict)
                or not isinstance(generation.get("runtime"), dict)
                or generation.get("source", {}).get("sha256") != self.descriptor["sourceSha256"]
                or generation.get("runtime", {}).get("dependencies") != self.descriptor["dependencies"]
                or generation.get("runtime", {}).get("pythonVersion") != self.descriptor["pythonVersion"]
                or not isinstance(generation.get("generatedAt"), str)
                or not isinstance(generation.get("geometry"), dict)
                or not isinstance(generation.get("meshCleanup"), dict)
                or not isinstance(generation.get("colorEncoding"), dict)
                or generation.get("artifacts") != [inventory["mesh.glb"], inventory["prepared-input.png"]]):
            raise WorkerError("cache_integrity", "Raw cache provenance does not match its verified artifacts and runtime")

    def restore_mesh(self, output):
        if self.cached is None:
            raise WorkerError("cache_integrity", "A verified cache lookup is required before restoring")
        _copy_checked(self.entry / "mesh.glb", Path(output) / "mesh.glb", self.cached["inventory"]["mesh.glb"])

    def publish(self, output):
        if self.cached is not None or self.entry.exists():
            raise WorkerError("cache_integrity", "Raw cache entries are immutable and cannot be overwritten")
        checked_path(self.root / "entries", directory=True)
        staging = self.root / "entries" / (".publish-" + self.key + "-" + uuid.uuid4().hex)
        staging.mkdir(mode=0o700)
        inventory = {name: file_receipt(Path(output) / name) for name in FILES}
        if any(not 1 <= item["bytes"] <= FILES[name] for name, item in inventory.items()):
            raise WorkerError("cache_integrity", "Raw reconstruction artifacts exceed cache bounds")
        generation = read_json(Path(output) / "generation.json")
        self._validate_generation(generation, inventory)
        for name, item in inventory.items():
            _copy_checked(Path(output) / name, staging / name, item)
        _write_new_json(staging / "receipt.json", {"schemaVersion": CACHE_SCHEMA, "key": self.key,
                                                 "descriptor": self.descriptor, "createdAt": utc_now(),
                                                 "artifacts": list(inventory.values())})
        checked_path(staging, directory=True)
        checked_path(self.entry, directory=True, missing=True)
        os.rename(str(staging), str(self.entry))
        emit("stage", stage="cache-stored", message="Stored the verified raw reconstruction for later finish-setting changes",
             cacheKey=self.key)
