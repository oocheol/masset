# SPDX-License-Identifier: MIT
"""Run only with the isolated interpreter. Stdout is one credential-free object."""
from __future__ import annotations
import argparse
import importlib.metadata
import json
from pathlib import Path
import platform
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).absolute().parent))
from runtime_common import lock_data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--collect-licenses", action="store_true")
    args = parser.parse_args()
    lock = lock_data()
    versions = {}
    licenses = {}
    for name, entry in lock["packages"].items():
        distribution = importlib.metadata.distribution(name)
        versions[name] = distribution.version
        if versions[name] != entry["version"]:
            raise RuntimeError("Installed package does not match pinned version: " + name)
        if args.collect_licenses:
            destination = args.runtime_root / "licenses" / "distributions" / name
            destination.mkdir(parents=True, exist_ok=True)
            files = []
            for relative in distribution.files or ():
                filename = str(relative)
                if (".dist-info/" in filename and
                        (any(part in relative.name.lower() for part in ("license", "licence", "copying", "notice", "copyright"))
                         or "/licenses/" in filename.lower())):
                    source = distribution.locate_file(relative)
                    # Wheels can contain nested vendored distributions, each
                    # with a LICENSE basename. Preserve its complete wheel path.
                    if relative.is_absolute() or ".." in relative.parts:
                        raise RuntimeError("Unexpected dependency license path")
                    target = destination.joinpath(*relative.parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    data = source.read_bytes()
                    if target.exists() and target.read_bytes() != data:
                        raise RuntimeError("Collected dependency license was modified")
                    target.write_bytes(data)
                    files.append(str(target.relative_to(args.runtime_root)).replace("\\", "/"))
            (destination / "METADATA").write_text(distribution.read_text("METADATA") or "", encoding="utf-8")
            licenses[name] = {"version": distribution.version, "license": entry["license"], "files": files,
                              "metadata": str((destination / "METADATA").relative_to(args.runtime_root)).replace("\\", "/")}
            supplemental = {"antlr4-python3-runtime": "ANTLR-BSD-3-Clause.txt", "tokenizers": "Tokenizers-Apache-2.0.txt",
                            "safetensors": "Safetensors-Apache-2.0.txt"}.get(name)
            if supplemental:
                licenses[name]["supplementalFiles"] = ["licenses/" + supplemental]
    import numpy as np
    import torch
    import PIL.Image
    import trimesh
    import transformers
    import omegaconf
    from skimage.measure import marching_cubes
    torch.set_num_threads(1)
    sample = torch.ones((2, 3), device="cpu") @ torch.ones((3, 2), device="cpu")
    if sample.device.type != "cpu" or sample.sum().item() != 12:
        raise RuntimeError("CPU tensor probe failed")
    volume = np.zeros((5, 5, 5), dtype=np.float32)
    volume[1:4, 1:4, 1:4] = 1
    vertices, faces, _, _ = marching_cubes(volume, 0.5)
    # Import all required upstream classes from the audited local code only.
    sys.path.insert(0, str(args.runtime_root / "code"))
    from tsr.system import TSR
    from tsr.models.tokenizers.image import DINOSingleImageTokenizer
    print(json.dumps({"pythonVersion": platform.python_version(), "interpreterPath": sys.executable,
                      "baseExecutable": getattr(sys, "_base_executable", sys.executable),
                      "prefix": sys.prefix, "platform": platform.system(), "machine": platform.machine(),
                      "dependencies": versions, "licenses": licenses, "device": "cpu",
                      "cpuTensorVerified": True, "marchingCubesVerified": len(faces) > 0,
                      "upstreamImportsVerified": True}, allow_nan=False))


if __name__ == "__main__":
    main()
