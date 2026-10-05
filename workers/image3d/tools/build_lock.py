# SPDX-License-Identifier: MIT
"""Maintainer tool: refresh exact official hashes for the fixed dependency set.

Not part of installation. Review changes to runtime-lock.json before distribution.
"""
from pathlib import Path
import argparse
import hashlib
import json
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).absolute().parents[1]
sys.path.insert(0, str(ROOT))
from runtime_common import CODE_REVISION, MODEL_REVISION, MODEL_SHA256, MODEL_BYTES, DINO_REVISION
from upstream_patch import patch_source

PINS = {
    "pip": "24.3.1", "setuptools": "75.8.0", "wheel": "0.45.1",
    "torch": "2.2.2", "transformers": "4.35.0", "numpy": "1.26.4",
    "Pillow": "10.1.0", "einops": "0.7.0", "trimesh": "4.0.5", "omegaconf": "2.3.0",
    "antlr4-python3-runtime": "4.9.3", "scikit-image": "0.22.0", "scipy": "1.12.0",
    "networkx": "3.2.1", "imageio": "2.34.0", "tifffile": "2024.2.12", "lazy-loader": "0.3",
    "packaging": "24.2", "PyYAML": "6.0.2", "filelock": "3.13.1", "typing-extensions": "4.10.0",
    "sympy": "1.12", "mpmath": "1.3.0", "Jinja2": "3.1.6", "MarkupSafe": "2.1.5",
    "fsspec": "2023.12.2", "huggingface-hub": "0.17.3", "tokenizers": "0.14.1",
    "safetensors": "0.4.2", "regex": "2024.5.15", "requests": "2.32.3", "urllib3": "2.2.3",
    "idna": "3.10", "charset-normalizer": "3.4.0", "certifi": "2025.1.31",
    "tqdm": "4.66.5", "colorama": "0.4.6",
}


def digest(data):
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def fetch(url):
    return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=60).read()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--official-archive", type=Path, required=True)
    args = parser.parse_args()
    archive_bytes = args.official_archive.read_bytes()
    if digest(archive_bytes)["sha256"] != "bcb414550dcfcb9f5ea6a7b9c12f2bbff889f5b4a564a493178393360d9034ec":
        raise ValueError("Unexpected official code archive")
    lock = {"schemaVersion": 1, "codeArchive": {"url": "https://codeload.github.com/VAST-AI-Research/TripoSR/tar.gz/" + CODE_REVISION,
                                               **digest(archive_bytes)}, "codeFiles": {}, "originalCodeFiles": {},
            "runtimeFiles": {}, "packages": {}}
    with tarfile.open(args.official_archive) as archive:
        for member in archive.getmembers():
            parts = member.name.split("/", 1)
            if len(parts) < 2:
                continue
            relative = parts[1]
            if relative.startswith("tsr/") and relative.endswith(".py") and relative != "tsr/bake_texture.py":
                data = archive.extractfile(member).read()
                lock["originalCodeFiles"][relative] = digest(data)
                lock["codeFiles"][relative] = digest(patch_source(relative, data))
            elif relative == "LICENSE":
                lock["runtimeFiles"]["licenses/TripoSR-LICENSE.txt"] = digest(archive.extractfile(member).read())
    lock["codeFiles"]["image3d_adapter.py"] = digest((ROOT / "image3d_adapter.py").read_bytes())
    model_base = "https://huggingface.co/stabilityai/TripoSR/resolve/" + MODEL_REVISION + "/"
    lock["runtimeFiles"]["model/model.ckpt"] = {"url": model_base + "model.ckpt", "sha256": MODEL_SHA256, "bytes": MODEL_BYTES}
    for name in ("config.yaml", "README.md"):
        url = model_base + name
        lock["runtimeFiles"]["model/" + name] = {"url": url, **digest(fetch(url))}
    dino_base = "https://huggingface.co/facebook/dino-vitb16/resolve/" + DINO_REVISION + "/"
    for name in ("config.json", "preprocessor_config.json", "README.md"):
        url = dino_base + name
        lock["runtimeFiles"]["dino/" + name] = {"url": url, **digest(fetch(url))}
    for name, version in PINS.items():
        url = "https://pypi.org/pypi/" + name + "/" + version + "/json"
        metadata = json.loads(fetch(url))
        wheels = []
        source = None
        for item in metadata["urls"]:
            filename = item["filename"]
            record = {"filename": filename, "url": item["url"], "sha256": item["digests"]["sha256"], "bytes": item["size"]}
            if filename.endswith(".whl") and ("none-any.whl" in filename
                    or ("macosx" in filename and ("arm64" in filename or "universal2" in filename)
                        and ("-cp39-" in filename or ("-abi3-" in filename and any("-cp" + v + "-" in filename for v in ("37", "38")))))):
                wheels.append(record)
            if name == "antlr4-python3-runtime" and item["packagetype"] == "sdist":
                source = record
        license_text = metadata["info"].get("license") or ""
        license_label = license_text.splitlines()[0][:100] if license_text else "; ".join(
            c.split(" :: ")[-1] for c in metadata["info"]["classifiers"] if c.startswith("License ::"))
        lock["packages"][name] = {"version": version, "requiresPython": metadata["info"].get("requires_python"),
                                  "license": license_label, "metadataUrl": url, "wheels": wheels}
        if source:
            lock["packages"][name]["source"] = source
        print(name, version, "wheels", len(wheels), flush=True)
    lock["bundledLicenseFiles"] = {}
    sources = ROOT / "licenses" / "sources.json"
    lock["bundledLicenseSources"] = json.loads(sources.read_text()) if sources.exists() else {}
    for path in sorted((ROOT / "licenses").glob("*")):
        if path.is_file():
            relative = "licenses/" + path.name
            lock["bundledLicenseFiles"][relative] = digest(path.read_bytes())
            lock["runtimeFiles"][relative] = digest(path.read_bytes())
    (ROOT / "runtime-lock.json").write_text(json.dumps(lock, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
