# SPDX-License-Identifier: Apache-2.0
"""Local-only, pre-provisioned TRELLIS.2 CUDA worker. Never downloads or uploads."""
from __future__ import annotations

import argparse
import contextlib
from datetime import datetime, timezone
import hashlib
import importlib.machinery
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import signal
import socket
import stat
import struct
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
MODULE_ROOT = Path(__file__).resolve().parent
MODEL_ID = "TRELLIS.2-4B"
MINIMUM_VRAM_MB = 24576
MAX_INPUT_BYTES = 64 * 1024**2
MAX_INPUT_PIXELS = 16 * 1024**2
MAX_JSON_BYTES = 2 * 1024**2
MAX_GLB_BYTES = 64 * 1024**2
JOB_SECONDS = 20 * 60
PINS = {
    "codeRevision": "75fbf0183001ed9876c8dbb35de6b68552ee08bd",
    "modelRevision": "af44b45f2e35a493886929c6d786e563ec68364d",
    "sparseRevision": "25e0d31ffbebe4b5a97464dd851910efc3002d96",
    "dinoRevision": "ea8dc2863c51be0a264bab82070e3e8836b02d51",
}
MODEL_PREFIXES = {
    "sparse_structure_decoder": ("models/sparse-structure/ckpts/ss_dec_conv3d_16l8_fp16", "SparseStructureDecoder"),
    "sparse_structure_flow_model": ("models/trellis2/ckpts/ss_flow_img_dit_1_3B_64_bf16", "SparseStructureFlowModel"),
    "shape_slat_decoder": ("models/trellis2/ckpts/shape_dec_next_dc_f16c32_fp16", "FlexiDualGridVaeDecoder"),
    "shape_slat_flow_model_512": ("models/trellis2/ckpts/slat_flow_img2shape_dit_1_3B_512_bf16", "SLatFlowModel"),
    "shape_slat_flow_model_1024": ("models/trellis2/ckpts/slat_flow_img2shape_dit_1_3B_1024_bf16", "SLatFlowModel"),
    "tex_slat_decoder": ("models/trellis2/ckpts/tex_dec_next_dc_f16c32_fp16", "SparseUnetVaeDecoder"),
    "tex_slat_flow_model_512": ("models/trellis2/ckpts/slat_flow_imgshape2tex_dit_1_3B_512_bf16", "SLatFlowModel"),
    "tex_slat_flow_model_1024": ("models/trellis2/ckpts/slat_flow_imgshape2tex_dit_1_3B_1024_bf16", "SLatFlowModel"),
}
REQUIRED_DEPENDENCIES = {"torch", "torchvision", "transformers", "safetensors", "Pillow", "numpy", "trimesh", "cumesh", "flex-gemm", "nvdiffrast", "flash-attn"}


class WorkerError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def emit(event, **values):
    print(json.dumps({"event": event, **values}, ensure_ascii=False), flush=True)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise WorkerError("invalid_json", "Duplicate JSON keys are not accepted")
        result[key] = value
    return result


def read_json(path, limit=MAX_JSON_BYTES):
    path = Path(path)
    if not path.is_file() or path.is_symlink() or path.stat().st_size > limit:
        raise WorkerError("invalid_json", "A bounded regular local JSON file is required")
    with path.open("rb") as handle:
        content = handle.read(limit + 1)
    if len(content) > limit:
        raise WorkerError("invalid_json", "JSON file exceeds its bound")
    try:
        return json.loads(content.decode("utf-8-sig"), object_pairs_hook=_unique_pairs)
    except (UnicodeError, json.JSONDecodeError):
        raise WorkerError("invalid_json", "Invalid UTF-8 JSON") from None


def write_new_json(path, value):
    path = Path(path)
    content = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        # An exclusive hard-link publishes the complete JSON atomically without replacing files.
        os.link(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024**2), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_receipt(path):
    path = Path(path)
    return {"path": str(path), "sha256": sha256(path), "bytes": path.stat().st_size}


def offline_guard():
    for key in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
        os.environ.pop(key, None)
    os.environ.update({
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1", "TOKENIZERS_PARALLELISM": "false",
        "ATTN_BACKEND": "flash_attn", "SPARSE_BACKEND": "flex_gemm",
        "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
    })

    def denied(*_args, **_kwargs):
        raise WorkerError("offline_required", "Network access is disabled during local TRELLIS.2 work")

    socket.socket.connect = denied
    socket.socket.connect_ex = denied
    socket.socket.sendto = denied
    socket.create_connection = denied
    socket.getaddrinfo = denied


def local_file(root, relative):
    root = Path(root).resolve()
    if not isinstance(relative, str) or not relative or "\\" in relative or Path(relative).is_absolute():
        raise WorkerError("runtime_integrity", "Invalid runtime-relative file path")
    parts = relative.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise WorkerError("runtime_integrity", "Runtime file traversal is not accepted")
    path = root.joinpath(*parts)
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root):
        raise WorkerError("runtime_integrity", "Expected a regular file inside the prepared runtime")
    current = path.parent
    while current != root:
        if current.is_symlink():
            raise WorkerError("runtime_integrity", "Runtime directories cannot redirect checked imports")
        current = current.parent
    return path


def verify_entry(root, entry, full_hash=True):
    path = local_file(root, entry["path"])
    if type(entry.get("bytes")) is not int or path.stat().st_size != entry["bytes"]:
        raise WorkerError("runtime_integrity", "Runtime file size differs from the pinned manifest")
    algorithm = entry.get("algorithm")
    expected = entry.get("digest")
    if algorithm not in {"sha256", "gitBlobSha1"} or not isinstance(expected, str):
        raise WorkerError("runtime_integrity", "Runtime file digest is not a reviewed format")
    if algorithm == "gitBlobSha1":
        if len(expected) != 40 or entry["bytes"] > MAX_JSON_BYTES:
            raise WorkerError("runtime_integrity", "Pinned source/config file digest is invalid")
        content = path.read_bytes()
        digest = hashlib.sha1(b"blob " + str(len(content)).encode("ascii") + b"\0" + content).hexdigest()
    elif full_hash:
        if len(expected) != 64:
            raise WorkerError("runtime_integrity", "Pinned SHA-256 digest is invalid")
        digest = sha256(path)
    else:
        return {"path": entry["path"], "algorithm": algorithm, "digest": None, "bytes": entry["bytes"]}
    if digest != expected:
        raise WorkerError("runtime_integrity", "Runtime file digest differs from the pinned manifest")
    return {"path": entry["path"], "algorithm": algorithm, "digest": digest, "bytes": entry["bytes"]}


def runtime_metadata(root, full_hash=False):
    root = Path(root)
    if not root.is_absolute() or any(part == ".." for part in root.parts) or not root.is_dir():
        raise WorkerError("runtime_missing", "An existing absolute local Linux runtime root is required")
    root = root.resolve()
    manifest = read_json(root / "runtime-manifest.json")
    lock = read_json(MODULE_ROOT / "runtime-lock.json")
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1 or manifest.get("pins") != PINS:
        raise WorkerError("runtime_integrity", "Prepared runtime revisions differ from the worker's official pins")
    if manifest.get("acceptedSources") is not True or manifest.get("acceptedDependencyLicenses") is not True:
        raise WorkerError("license_review_required", "The prepared runtime needs explicit source and dependency-license acceptance")
    if lock.get("pins") != PINS or lock.get("downloadAllowed") is not False:
        raise WorkerError("runtime_integrity", "Worker's local-only dependency lock is invalid")
    dependencies = manifest.get("dependencyVersions")
    if not isinstance(dependencies, dict) or not REQUIRED_DEPENDENCIES <= dependencies.keys():
        raise WorkerError("runtime_integrity", "Prepared runtime dependency versions are incomplete")
    if any(not isinstance(value, str) or not value or len(value) > 80 for value in dependencies.values()):
        raise WorkerError("runtime_integrity", "Dependency versions must be explicit bounded strings")
    site_dirs = list((root / "venv/lib").glob("python3.*/site-packages"))
    if len(site_dirs) != 1 or not site_dirs[0].is_dir() or not site_dirs[0].resolve().is_relative_to(root):
        raise WorkerError("runtime_integrity", "Expected one acknowledged venv site-packages directory")
    # -I -S bypasses site/.pth execution. Add only this explicitly accepted environment.
    if str(site_dirs[0]) not in sys.path:
        sys.path.insert(0, str(site_dirs[0]))
    actual_dependencies = {}
    for name, version in dependencies.items():
        try:
            actual = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            raise WorkerError("runtime_missing", "A declared prepared-runtime package is missing") from None
        if actual != version:
            raise WorkerError("runtime_integrity", "Installed dependencies differ from accepted runtime metadata")
        actual_dependencies[name] = actual
    source = root / "source"
    expected_code = {entry["path"] for entry in lock["codeFiles"]}
    observed_code = {path.relative_to(source).as_posix()
                     for folder in (source / "trellis2", source / "o-voxel/o_voxel")
                     for path in folder.rglob("*.py") if path.is_file()}
    if observed_code != expected_code:
        raise WorkerError("runtime_integrity", "Unexpected or missing source files could change the reviewed local pipeline")
    code_files = [verify_entry(source, entry, True) for entry in lock["codeFiles"]]
    model_files = [verify_entry(root, entry, full_hash) for entry in lock["modelFiles"]]
    native_entries = manifest.get("nativeFiles")
    if not isinstance(native_entries, list) or not native_entries or len(native_entries) > 4096:
        raise WorkerError("runtime_integrity", "Native CUDA library files need an accepted local hash manifest")
    expected_native = set()
    native_files = []
    for entry in native_entries:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256", "bytes"}:
            raise WorkerError("runtime_integrity", "Invalid accepted native-library record")
        relative = entry.get("path")
        digest = entry.get("sha256")
        if (not isinstance(relative, str) or relative in expected_native or ".so" not in Path(relative).name
                or not isinstance(digest, str) or len(digest) != 64):
            raise WorkerError("runtime_integrity", "Duplicate or unsupported native-library record")
        expected_native.add(relative)
        native_files.append(verify_entry(root, {"path": relative, "algorithm": "sha256", "digest": digest, "bytes": entry["bytes"]}, full_hash))
    observed_native = {path.relative_to(root).as_posix()
                       for folder in (source, site_dirs[0])
                       for path in folder.rglob("*.so*") if path.is_file()}
    if observed_native != expected_native:
        raise WorkerError("runtime_integrity", "An undeclared native library could change the accepted runtime")
    install_source_guard(source, lock["codeFiles"])
    for folder in (source, source / "o-voxel"):
        sys.path.insert(0, str(folder))
    return {"root": root, "source": source, "dependencies": actual_dependencies,
            "codeFiles": code_files, "modelFiles": model_files, "nativeFiles": native_files,
            "hashesVerified": bool(full_hash)}


def install_source_guard(source, entries):
    """Compile checked source directly; never trust a matching-timestamp cached .pyc."""
    source = Path(source).resolve()
    pins = {entry["path"]: entry for entry in entries}
    original = importlib.machinery.SourceFileLoader.get_code
    original_bytecode = importlib.machinery.SourcelessFileLoader.get_code

    def checked_code(loader, fullname):
        path = Path(loader.path).resolve()
        if not path.is_relative_to(source):
            return original(loader, fullname)
        relative = path.relative_to(source).as_posix()
        if relative not in pins:
            raise WorkerError("runtime_integrity", "Unreviewed model source cannot be imported")
        entry = pins[relative]
        local_file(source, relative)
        content = path.read_bytes()
        digest = hashlib.sha1(b"blob " + str(len(content)).encode("ascii") + b"\0" + content).hexdigest()
        if len(content) != entry["bytes"] or digest != entry["digest"]:
            raise WorkerError("runtime_integrity", "Model source changed before its checked import")
        # Compile the exact verified bytes, closing a read/verify/read source race.
        return compile(content, str(path), "exec", dont_inherit=True)

    def checked_bytecode(loader, fullname):
        if Path(loader.path).resolve().is_relative_to(source):
            raise WorkerError("runtime_integrity", "Model bytecode-only imports are not accepted")
        return original_bytecode(loader, fullname)

    importlib.machinery.SourceFileLoader.get_code = checked_code
    importlib.machinery.SourcelessFileLoader.get_code = checked_bytecode


def hardware():
    if platform.system() != "Linux":
        raise WorkerError("platform_unsupported", "Local TRELLIS.2 requires Linux CUDA; Windows uses an experimental WSL2 wrapper")
    import torch
    if not torch.cuda.is_available():
        raise WorkerError("hardware_blocked", "No usable NVIDIA CUDA device is available")
    gpus = []
    selected = None
    for index in range(torch.cuda.device_count()):
        properties = torch.cuda.get_device_properties(index)
        memory = int(properties.total_memory // 1024**2)
        gpus.append({"name": properties.name, "vramMb": memory, "deviceIndex": index})
        if memory >= MINIMUM_VRAM_MB and selected is None:
            selected = index
    if selected is None:
        raise WorkerError("hardware_blocked", "NVIDIA GPU memory is below the required 24 GiB")
    torch.cuda.set_device(selected)
    return {"system": platform.system(), "machine": platform.machine(), "pythonVersion": platform.python_version(),
            "cudaVersion": torch.version.cuda, "gpus": gpus, "selectedDevice": selected}


def probe(root):
    result = {"status": "runtimeMissing", "ready": False, "prepared": False, "available": False,
              "hashesVerified": False, "inferenceVerified": False, "hardwareEligible": False,
              "requestedModel": MODEL_ID, "actualModel": None, "minimumVramMb": MINIMUM_VRAM_MB,
              "gpus": [], "dependencies": {}, "experimental": True,
              "licensingStatus": "dependencies_require_review"}
    try:
        if platform.system() != "Linux":
            raise WorkerError("platform_unsupported", "This worker's inference and export require Linux CUDA")
        verified = runtime_metadata(root, full_hash=False)
        gpu = hardware()
        import cumesh  # noqa: F401
        import flex_gemm  # noqa: F401
        import nvdiffrast.torch  # noqa: F401
        import safetensors.torch  # noqa: F401
        from transformers import DINOv3ViTModel  # noqa: F401
        result.update({"status": "preparedUnverified", "prepared": True, "available": True,
                       "hardwareEligible": True, "gpus": gpu["gpus"], "dependencies": verified["dependencies"],
                       "reason": "Prepared files and CUDA imports checked. Full model hashes are checked before every run; inference is unverified."})
    except WorkerError as error:
        result.update({"status": error.code, "code": error.code, "reason": error.message})
    except Exception:
        result.update({"status": "runtimeUnverified", "code": "runtime_unverified", "reason": "Prepared CUDA dependencies could not be imported"})
    return result


def validate_job(path):
    job = read_json(path, 64 * 1024)
    required = {"name", "sourcePath", "sourceSha256", "quality", "seed", "textureResolution", "maxTriangles"}
    if not isinstance(job, dict) or set(job) != required:
        raise WorkerError("invalid_job", "TRELLIS.2 jobs must use the fixed local image schema")
    name = job["name"]
    if not isinstance(name, str) or not name.strip() or len(name) > 160 or any(ord(char) < 32 for char in name):
        raise WorkerError("invalid_job", "A bounded asset name is required")
    source = job["sourcePath"]
    if not isinstance(source, str) or not Path(source).is_absolute() or ".." in Path(source).parts:
        raise WorkerError("invalid_job", "Source must be an absolute local image path")
    digest = job["sourceSha256"]
    if not isinstance(digest, str) or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise WorkerError("invalid_job", "A source SHA-256 receipt is required")
    if job["quality"] not in {"draft", "standard", "high"} or type(job["seed"]) is not int or not 0 <= job["seed"] <= 2147483647:
        raise WorkerError("invalid_job", "Invalid quality or seed setting")
    if type(job["textureResolution"]) is not int or job["textureResolution"] not in {512, 1024, 2048, 4096}:
        raise WorkerError("invalid_job", "Invalid texture size")
    if type(job["maxTriangles"]) is not int or not 100000 <= job["maxTriangles"] <= 500000 or job["maxTriangles"] % 10000:
        raise WorkerError("invalid_job", "Invalid dense-source decimation setting")
    return job


def prepare_image(job, output):
    from PIL import Image
    import numpy as np
    source = Path(job["sourcePath"])
    if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_INPUT_BYTES:
        raise WorkerError("invalid_input", "A bounded regular local PNG input is required")
    with source.open("rb") as handle:
        header = handle.read(12)
        if not (header.startswith(b"\x89PNG\r\n\x1a\n") or (header[:4] == b"RIFF" and header[8:12] == b"WEBP")):
            raise WorkerError("invalid_input", "Only local PNG/WebP image input is accepted")
    if sha256(source) != job["sourceSha256"]:
        raise WorkerError("source_changed", "Source image differs from its selected SHA-256 receipt")
    with Image.open(source) as opened:
        if opened.format not in {"PNG", "WEBP"} or opened.mode != "RGBA" or getattr(opened, "n_frames", 1) != 1:
            raise WorkerError("invalid_input", "Input must be one pre-masked RGBA PNG/WebP; background models are disabled")
        if min(opened.size) < 32 or opened.width * opened.height > MAX_INPUT_PIXELS or max(opened.size) > 4096:
            raise WorkerError("invalid_input", "Input exceeds the 4096-side/16-Mipixel bounds")
        opened.load()
        image = opened.copy()
    alpha = np.asarray(image)[:, :, 3]
    if np.all(alpha == 255) or not np.any(alpha > 204):
        raise WorkerError("mask_required", "A real transparent foreground mask is required")
    original_size = image.size
    scale = min(1, 1024 / max(image.size))
    if scale < 1:
        image = image.resize((int(image.width * scale), int(image.height * scale)), Image.Resampling.LANCZOS)
    array = np.asarray(image)
    foreground = np.argwhere(array[:, :, 3] > 204)
    if foreground.size == 0:
        raise WorkerError("mask_empty", "Foreground mask is empty after resampling")
    left, top = np.min(foreground[:, 1]), np.min(foreground[:, 0])
    right, bottom = np.max(foreground[:, 1]), np.max(foreground[:, 0])
    center = (float(left + right) / 2, float(top + bottom) / 2)
    side = int(max(right - left, bottom - top))
    if side < 4:
        raise WorkerError("mask_empty", "Foreground is too small for shape reconstruction")
    crop = (center[0] - side // 2, center[1] - side // 2, center[0] + side // 2, center[1] + side // 2)
    cropped = image.crop(crop)
    values = np.asarray(cropped).astype(np.float32) / 255
    prepared = Image.fromarray((values[:, :, :3] * values[:, :, 3:4] * 255).astype(np.uint8))
    destination = Path(output) / "prepared-input.png"
    with destination.open("xb") as handle:
        prepared.save(handle, format="PNG")
    provenance = {"method": "official_rgba_square_crop_black_composite", "backgroundRemoval": "disabled",
                  "sourceBytes": source.stat().st_size, "sourceSize": list(original_size),
                  "maximumPreprocessSide": 1024, "resizedSize": list(image.size),
                  "alphaThreshold": 204, "crop": list(crop), "preparedSize": list(prepared.size),
                  "preparedSha256": sha256(destination)}
    return prepared, provenance


def install_safe_model_guards(torch):
    def denied(*_args, **_kwargs):
        raise WorkerError("unsafe_checkpoint", "Only reviewed local safetensors are accepted; pickle/TorchScript loaders are disabled")
    torch.load = denied
    torch.jit.load = denied
    # Fail on any accidental repository/network bootstrap even before the socket guard.
    import huggingface_hub
    huggingface_hub.hf_hub_download = denied
    huggingface_hub.snapshot_download = denied


def build_pipeline(root):
    import torch
    from safetensors.torch import load_file
    from trellis2 import models
    from trellis2.pipelines import Trellis2ImageTo3DPipeline
    from trellis2.pipelines.samplers import FlowEulerGuidanceIntervalSampler
    from trellis2.modules.image_feature_extractor import DinoV3FeatureExtractor
    from torchvision import transforms
    from transformers import DINOv3ViTModel
    install_safe_model_guards(torch)
    config = read_json(Path(root) / "models/trellis2/pipeline.json")
    if config.get("name") != "Trellis2ImageTo3DPipeline":
        raise WorkerError("runtime_integrity", "Unexpected pipeline class in pinned config")
    args = config["args"]
    loaded = {}
    for name, (relative, expected_class) in MODEL_PREFIXES.items():
        prefix = Path(root) / relative
        config_path = local_file(root, relative + ".json")
        weight_path = local_file(root, relative + ".safetensors")
        model_config = read_json(config_path)
        if model_config.get("name") != expected_class or not isinstance(model_config.get("args"), dict):
            raise WorkerError("runtime_integrity", "Unexpected model constructor in pinned JSON")
        constructor = getattr(models, expected_class)
        model = constructor(**model_config["args"])
        # The upstream loader uses strict=False; the worker refuses partially loaded weights.
        state = load_file(str(weight_path), device="cpu")
        incompatible = model.load_state_dict(state, strict=False)
        if incompatible.missing_keys or incompatible.unexpected_keys:
            raise WorkerError("runtime_integrity", "Checkpoint keys do not fully match the reviewed model constructor")
        model.eval()
        loaded[name] = model
        del state
    dino_root = Path(root) / "models/dinov3"
    dino_config = read_json(dino_root / "config.json")
    if dino_config.get("model_type") != "dinov3_vit" or "auto_map" in dino_config:
        raise WorkerError("runtime_integrity", "DINO config is not the pinned local ViT architecture")
    # Reuse the reviewed extractor methods without invoking its online constructor.
    extractor = DinoV3FeatureExtractor.__new__(DinoV3FeatureExtractor)
    extractor.model_name = str(dino_root)
    extractor.model = DINOv3ViTModel.from_pretrained(str(dino_root), local_files_only=True,
                                                  use_safetensors=True, trust_remote_code=False)
    extractor.model.eval()
    extractor.image_size = 512
    extractor.transform = transforms.Compose([transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])])
    kwargs = {}
    for prefix in ("sparse_structure", "shape_slat", "tex_slat"):
        sampler = args[prefix + "_sampler"]
        if sampler["name"] != "FlowEulerGuidanceIntervalSampler" or sampler["args"] != {"sigma_min": 1e-5}:
            raise WorkerError("runtime_integrity", "Unexpected sampler config")
        kwargs[prefix + "_sampler"] = FlowEulerGuidanceIntervalSampler(sigma_min=1e-5)
        kwargs[prefix + "_sampler_params"] = sampler["params"]
    pipeline = Trellis2ImageTo3DPipeline(
        models=loaded, **kwargs,
        shape_slat_normalization=args["shape_slat_normalization"], tex_slat_normalization=args["tex_slat_normalization"],
        image_cond_model=extractor, rembg_model=None, low_vram=True, default_pipeline_type="1024_cascade")
    pipeline.cuda()
    return pipeline


def validate_embedded_glb(content):
    if not isinstance(content, bytes) or len(content) < 28 or len(content) > MAX_GLB_BYTES:
        raise WorkerError("invalid_artifact", "A bounded binary GLB is required")
    magic, version, size = struct.unpack_from("<4sII", content)
    if magic != b"glTF" or version != 2 or size != len(content):
        raise WorkerError("invalid_artifact", "Invalid GLB header or actual length")
    offset, document, bin_size = 12, None, None
    while offset + 8 <= len(content):
        length, kind = struct.unpack_from("<I4s", content, offset)
        end = offset + 8 + length
        if length % 4 or end > len(content):
            raise WorkerError("invalid_artifact", "Invalid GLB chunk bounds")
        if kind == b"JSON" and offset == 12 and length <= 16 * 1024**2:
            document = json.loads(content[offset + 8:end], object_pairs_hook=_unique_pairs)
        elif kind == b"BIN\0" and document is not None and bin_size is None:
            bin_size = length
        else:
            raise WorkerError("invalid_artifact", "Unexpected GLB chunks")
        offset = end
    if offset != len(content) or document is None or bin_size is None:
        raise WorkerError("invalid_artifact", "GLB chunks are incomplete")
    if document.get("asset", {}).get("version") != "2.0" or not document.get("meshes"):
        raise WorkerError("invalid_artifact", "GLB has no actual mesh")
    buffers = document.get("buffers", [])
    if len(buffers) != 1 or "uri" in buffers[0] or not 0 < buffers[0].get("byteLength", 0) <= bin_size:
        raise WorkerError("invalid_artifact", "GLB buffer must be embedded")
    if bin_size - buffers[0]["byteLength"] > 3:
        raise WorkerError("invalid_artifact", "Unexpected BIN padding")
    images = document.get("images", [])
    if not images or any("uri" in image or type(image.get("bufferView")) is not int
                         or image.get("mimeType") not in {"image/png", "image/jpeg"} for image in images):
        raise WorkerError("invalid_artifact", "PBR textures must be embedded PNG/JPEG images")
    materials = document.get("materials", [])
    if not materials or not any("baseColorTexture" in item.get("pbrMetallicRoughness", {})
                                and "metallicRoughnessTexture" in item.get("pbrMetallicRoughness", {}) for item in materials):
        raise WorkerError("invalid_artifact", "Actual base color and metallic/roughness PBR textures are required")
    if "EXT_texture_webp" in document.get("extensionsRequired", []):
        raise WorkerError("invalid_artifact", "Game-compatible export cannot require WebP")
    views = document.get("bufferViews", [])
    accessors = document.get("accessors", [])
    if not views or not accessors:
        raise WorkerError("invalid_artifact", "GLB has no embedded geometry/texture data views")
    for view in views:
        start, length = view.get("byteOffset", 0), view.get("byteLength")
        if (view.get("buffer") != 0 or type(start) is not int or type(length) is not int
                or start < 0 or length < 1 or start + length > buffers[0]["byteLength"]):
            raise WorkerError("invalid_artifact", "GLB buffer view exceeds its embedded BIN chunk")
    for image in images:
        if not 0 <= image["bufferView"] < len(views):
            raise WorkerError("invalid_artifact", "GLB texture references a missing embedded data view")
    for mesh in document["meshes"]:
        primitives = mesh.get("primitives", [])
        if not primitives:
            raise WorkerError("invalid_artifact", "GLB mesh has no primitives")
        for primitive in primitives:
            attributes = primitive.get("attributes", {})
            for key in ("POSITION", "TEXCOORD_0"):
                index = attributes.get(key)
                if type(index) is not int or not 0 <= index < len(accessors):
                    raise WorkerError("invalid_artifact", "Textured GLB geometry requires positions and UVs")
            position = accessors[attributes["POSITION"]]
            if position.get("type") != "VEC3" or type(position.get("count")) is not int or position["count"] < 3:
                raise WorkerError("invalid_artifact", "GLB has no actual position vertices")
    return document


def process_start_ticks(pid):
    try:
        # /proc comm may include spaces or parentheses; split after the final closing parenthesis.
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        return int(fields[19])
    except (OSError, ValueError, IndexError):
        return None


def lock_process_state(control):
    """Only actual /proc absence or different start ticks proves a lease is stale."""
    pid, ticks = control.get("pid"), control.get("startTicks")
    if type(pid) is not int or not 2 <= pid <= 2**32 - 1 or type(ticks) is not int or ticks <= 0:
        raise WorkerError("runtime_lock_unverified", "Runtime lock process identity is invalid")
    path = Path(f"/proc/{pid}/stat")
    try:
        fields = path.read_text().rsplit(") ", 1)[1].split()
        actual = int(fields[19])
    except FileNotFoundError:
        # A missing stat inside a still-existing process directory is indeterminate.
        if Path(f"/proc/{pid}").exists():
            raise WorkerError("runtime_lock_unverified", "Runtime lock process state could not be confirmed") from None
        return "gone"
    except (OSError, ValueError, IndexError):
        raise WorkerError("runtime_lock_unverified", "Runtime lock process state could not be confirmed") from None
    return "alive" if actual == ticks else "reused"


@contextlib.contextmanager
def runtime_guard(root):
    """Serialize this app's lease publication/stale cleanup without deleting the guard inode."""
    import fcntl
    root = Path(root)
    if not root.is_absolute() or not root.is_dir():
        raise WorkerError("runtime_missing", "Runtime root must exist before reserving a local GPU job")
    guard = root / ".asset-studio-trellis2.guard"
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(guard, flags, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise WorkerError("runtime_lock_unverified", "Runtime lease guard must be a regular local file")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def acquire_runtime_lock(root, control):
    path = Path(root) / ".asset-studio-trellis2.lock.json"
    with runtime_guard(root):
        if path.exists() or path.is_symlink():
            previous = read_json(path, 8192)
            if not isinstance(previous, dict) or previous.get("schemaVersion") != 1:
                raise WorkerError("runtime_lock_unverified", "Existing runtime lease is not a valid app job")
            if lock_process_state(previous) == "alive":
                raise WorkerError("runtime_busy", "Another local TRELLIS.2 process still owns this runtime; termination is unconfirmed")
            # All app lease writers hold the persistent flock guard. Only confirmed stale leases are removed.
            path.unlink()
        lease = {key: control[key] for key in ("schemaVersion", "pid", "nonce", "startTicks", "outputDir", "workerPath")}
        write_new_json(path, lease)
    return path


def release_runtime_lock(root, control):
    path = Path(root) / ".asset-studio-trellis2.lock.json"
    with runtime_guard(root):
        if not path.exists():
            return
        previous = read_json(path, 8192)
        if all(previous.get(key) == control[key] for key in ("nonce", "pid", "startTicks")):
            path.unlink()


def process_matches(control):
    pid = control.get("pid")
    if type(pid) is not int or pid < 2 or process_start_ticks(pid) != control.get("startTicks"):
        return False
    try:
        args = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        worker = str(MODULE_ROOT / "worker.py").encode()
        output = str(control["outputDir"]).encode()
        return worker in args and b"--output-dir" in args and output in args
    except (OSError, KeyError):
        return False


def startup_cancel_path(output):
    output = Path(output)
    return output.with_name(output.name + ".cancel-request.json")


def startup_cancelled(output):
    path = startup_cancel_path(output)
    if not path.exists():
        return False
    request = read_json(path, 8192)
    return request == {"schemaVersion": 1, "outputDir": str(output), "requested": True}


def watchdog(control_path, expected_nonce):
    """Separate stdlib-only process can stop a CUDA worker even while native code holds its GIL."""
    control = read_json(control_path, 8192)
    output = Path(control_path).parent
    if control.get("schemaVersion") != 1 or control.get("nonce") != expected_nonce or control.get("outputDir") != str(output):
        return 1
    deadline = time.monotonic() + JOB_SECONDS
    completed_at = None
    while process_matches(control):
        done_path = output / "worker-completed.json"
        if done_path.exists() and read_json(done_path, 8192).get("nonce") == expected_nonce:
            # A success event/finally block does not prove Linux CUDA has exited.
            completed_at = completed_at or time.monotonic()
            if time.monotonic() - completed_at < 30 and time.monotonic() < deadline:
                time.sleep(0.2)
                continue
        cancel = startup_cancelled(output)
        request_path = output / "cancellation-request.json"
        if request_path.exists():
            request = read_json(request_path, 8192)
            cancel |= request == {key: control[key] for key in ("nonce", "pid", "startTicks")}
        if cancel or time.monotonic() >= deadline or (completed_at is not None and time.monotonic() - completed_at >= 30):
            if not process_matches(control):
                return 0
            reason = "cancelled" if cancel else "timeout"
            try:
                write_new_json(output / "worker-cancellation.json", {"nonce": expected_nonce, "pid": control["pid"],
                               "startTicks": control["startTicks"], "reason": reason, "signalRequested": "SIGTERM"})
                os.kill(control["pid"], signal.SIGTERM)
                time.sleep(2)
                if process_matches(control):
                    os.kill(control["pid"], signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
            break
        time.sleep(0.2)
    # Release only this nonce's lease after actual /proc absence or PID reuse evidence.
    # If state is indeterminate or the process is still alive, leave the lease blocked.
    for _ in range(50):
        try:
            state = lock_process_state(control)
        except WorkerError:
            return 0
        if state != "alive":
            try:
                release_runtime_lock(Path(control["runtimeRoot"]), control)
            except (WorkerError, OSError, KeyError):
                pass
            return 0
        time.sleep(0.2)
    return 0


def start_watchdog(root, input_path, output):
    nonce = str(uuid.uuid4())
    pid = os.getpid()
    ticks = process_start_ticks(pid)
    if ticks is None:
        raise WorkerError("cancel_guard_missing", "Linux process identity is required before CUDA work")
    control = {"schemaVersion": 1, "pid": pid, "nonce": nonce, "startTicks": ticks,
               "outputDir": str(output), "runtimeRoot": str(root), "inputPath": str(input_path),
               "workerPath": str(MODULE_ROOT / "worker.py"), "startedAt": utc_now()}
    path = Path(output) / "worker-pid.json"
    write_new_json(path, control)
    environment = {"PATH": "/usr/bin:/bin", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
    subprocess.Popen([sys.executable, "-I", "-S", str(MODULE_ROOT / "worker.py"), "--watchdog", str(path),
                      "--expected-nonce", nonce], env=environment, stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True)
    return control


def run(root, input_path, output):
    started = time.monotonic()
    if platform.system() != "Linux":
        raise WorkerError("platform_unsupported", "Local TRELLIS.2 requires Linux CUDA")
    job = validate_job(input_path)
    output = Path(output)
    if not output.is_absolute() or any(part == ".." for part in output.parts) or output.exists() or output.is_symlink():
        raise WorkerError("unsafe_output", "A new absolute caller-owned output directory is required")
    if not output.parent.is_dir() or output.parent.is_symlink():
        raise WorkerError("unsafe_output", "Output parent directory must already exist")
    if startup_cancelled(output):
        raise WorkerError("cancelled", "This local job was cancelled before startup")
    output.mkdir()
    control = start_watchdog(root, input_path, output)
    nonce = control["nonce"]
    stages = {}
    inference_attempted = False
    inference_executed = False
    try:
        acquire_runtime_lock(root, control)
        emit("stage", stage="verifyingRuntime")
        stage_started = time.monotonic()
        # Validate an accepted environment and the image before hashing more than 15 GiB.
        verified = runtime_metadata(root, full_hash=False)
        gpu = hardware()
        stages["verifyingRuntime"] = time.monotonic() - stage_started
        emit("stage", stage="preprocessing")
        stage_started = time.monotonic()
        image, preprocessing = prepare_image(job, output)
        stages["preprocessing"] = time.monotonic() - stage_started
        emit("stage", stage="verifyingRuntime")
        stage_started = time.monotonic()
        verified = runtime_metadata(root, full_hash=True)
        stages["verifyingRuntime"] += time.monotonic() - stage_started
        emit("stage", stage="loadingModels")
        stage_started = time.monotonic()
        with contextlib.redirect_stdout(sys.stderr):
            pipeline = build_pipeline(root)
        stages["loadingModels"] = time.monotonic() - stage_started
        emit("stage", stage="generating")
        stage_started = time.monotonic()
        pipeline_type = {"draft": "512", "standard": "1024_cascade", "high": "1536_cascade"}[job["quality"]]
        import torch
        inference_attempted = True
        with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
            meshes = pipeline.run(image, seed=job["seed"], preprocess_image=False, pipeline_type=pipeline_type)
        inference_executed = True
        if not isinstance(meshes, list) or len(meshes) != 1:
            raise WorkerError("generation_failed", "The local pipeline did not return exactly one mesh")
        mesh = meshes[0]
        stages["generating"] = time.monotonic() - stage_started
        emit("stage", stage="exporting")
        stage_started = time.monotonic()
        import o_voxel
        with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
            mesh.simplify(16777216)
            exported = o_voxel.postprocess.to_glb(
                vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs, coords=mesh.coords,
                attr_layout=pipeline.pbr_attr_layout, voxel_size=mesh.voxel_size,
                aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
                decimation_target=job["maxTriangles"], texture_size=max(1024, job["textureResolution"]),
                remesh=False, verbose=False, use_tqdm=False)
            content = exported.export(file_type="glb", extension_webp=False)
        validate_embedded_glb(content)
        mesh_path = output / "mesh.glb"
        with mesh_path.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        stages["exporting"] = time.monotonic() - stage_started
        emit("stage", stage="verifyingArtifact")
        import numpy as np
        import trimesh
        validate_embedded_glb(mesh_path.read_bytes())
        with contextlib.redirect_stdout(sys.stderr):
            scene = trimesh.load(mesh_path, force="scene", process=False)
        if not scene.geometry:
            raise WorkerError("invalid_artifact", "Exported GLB could not be reopened with actual geometry")
        vertices = sum(len(geometry.vertices) for geometry in scene.geometry.values())
        triangles = sum(len(geometry.faces) for geometry in scene.geometry.values())
        if vertices < 3 or triangles < 1 or not all(np.isfinite(geometry.vertices).all() for geometry in scene.geometry.values()):
            raise WorkerError("invalid_artifact", "Exported geometry is empty or nonfinite")
        geometry = {"vertices": vertices, "triangles": triangles, "materialSlots": len(scene.geometry),
                    "bounds": scene.bounds.tolist(), "pbrTexturesEmbedded": True}
        artifacts = [file_receipt(mesh_path), file_receipt(output / "prepared-input.png")]
        receipt = {
            "schemaVersion": 1, "name": job["name"], "generatedAt": utc_now(),
            "modelId": MODEL_ID, "model": MODEL_ID, "requestedModel": MODEL_ID,
            "modelRevision": PINS["modelRevision"], "codeRevision": PINS["codeRevision"],
            "dinoRevision": PINS["dinoRevision"], "sparseRevision": PINS["sparseRevision"],
            "device": "cuda", "quality": job["quality"], "inferenceExecuted": True,
            "elapsedSeconds": round(time.monotonic() - started, 3),
            "stageDurations": {name: round(seconds, 3) for name, seconds in stages.items()},
            "source": {"path": job["sourcePath"], "sha256": job["sourceSha256"], "bytes": preprocessing["sourceBytes"]},
            "preprocessing": preprocessing, "geometry": geometry, "artifacts": artifacts,
            "hardware": gpu,
            "settings": {"seed": job["seed"], "pipelineType": pipeline_type, "lowVram": True,
                         "requestedTextureSize": job["textureResolution"], "exportTextureSize": max(1024, job["textureResolution"]),
                         "decimationTarget": job["maxTriangles"], "remesh": False},
            "runtime": {"interpreterPath": sys.executable, "pythonVersion": platform.python_version(), "dependencies": verified["dependencies"]},
            "runtimeVerification": {key: verified[key] for key in ("codeFiles", "modelFiles", "nativeFiles")},
            "offline": {"networkBlocked": True, "localConfigOnly": True, "safetensorsOnly": True, "weightsOnly": True, "backgroundModelDisabled": True},
            "cameraConvention": {"sourceUp": "+Z", "glbUp": "+Y", "conversion": "official O-Voxel exporter: y=z, z=-y", "physicalScaleEstimated": False},
            "licensingStatus": "dependencies_require_review",
            "limitations": ["Experimental WSL2 wrapper; Linux CUDA >=24 GiB required", "Dependency licenses require separate review",
                            "Single-view reconstruction does not attest hidden surfaces or physical scale", "Dense source mesh needs separate game preparation",
                            "Default alpha mode is opaque; generated normal/AO/emissive maps are not claimed"],
        }
        generation = output / "generation.json"
        write_new_json(generation, receipt)
        artifacts.append(file_receipt(generation))
        for artifact in artifacts:
            emit("artifact", **artifact)
        emit("completed", artifacts=artifacts, modelId=MODEL_ID, model=MODEL_ID, device="cuda", quality=job["quality"],
             geometry=geometry, inferenceExecuted=True, elapsedSeconds=receipt["elapsedSeconds"])
        return 0
    except WorkerError as error:
        failure = {"schemaVersion": 1, "modelId": MODEL_ID, "inferenceExecuted": inference_executed,
                   "inferenceAttempted": inference_attempted, "artifactVerified": False,
                   "errorCode": error.code, "message": error.message, "licensingStatus": "dependencies_require_review", "offline": True}
        if not (output / "generation.json").exists():
            write_new_json(output / "generation.json", failure)
        raise
    except Exception:
        failure = {"schemaVersion": 1, "modelId": MODEL_ID, "inferenceExecuted": inference_executed,
                   "inferenceAttempted": inference_attempted, "artifactVerified": False,
                   "errorCode": "local_generation_failed", "licensingStatus": "dependencies_require_review", "offline": True}
        if not (output / "generation.json").exists():
            write_new_json(output / "generation.json", failure)
        raise WorkerError("local_generation_failed", "Local processing failed; no automatic retry or fallback was used") from None
    finally:
        write_new_json(output / "worker-completed.json", {"nonce": nonce})
        # The separate watchdog removes only this nonce's lease after actual Linux process exit.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", type=Path)
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--watchdog", type=Path)
    parser.add_argument("--expected-nonce")
    arguments = parser.parse_args()
    offline_guard()
    if arguments.watchdog:
        if not arguments.expected_nonce or any((arguments.probe, arguments.input, arguments.output_dir)):
            return 2
        return watchdog(arguments.watchdog, arguments.expected_nonce)
    if arguments.runtime_root is None:
        parser.error("--runtime-root is required")
    if arguments.probe:
        if arguments.input or arguments.output_dir:
            parser.error("--probe does not accept image work")
        print(json.dumps(probe(arguments.runtime_root), ensure_ascii=False), flush=True)
        return 0
    if arguments.input is None or arguments.output_dir is None:
        parser.error("--input and --output-dir are required for local image work")
    return run(arguments.runtime_root, arguments.input, arguments.output_dir)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except WorkerError as error:
        emit("failed", code=error.code, message=error.message)
        raise SystemExit(1)
    except Exception:
        # Do not expose arbitrary dependency tracebacks, credentials or environment values.
        emit("failed", code="local_generation_failed", message="Local TRELLIS.2 processing failed; no automatic retry or fallback was used")
        raise SystemExit(1)
