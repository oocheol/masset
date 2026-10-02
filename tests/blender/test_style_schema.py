# SPDX-License-Identifier: GPL-3.0-or-later
"""Data-only style schema adversarial tests, run with the trusted Blender worker."""
import argparse
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    repo = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location("trusted_procedural_worker", repo / "workers" / "blender" / "worker.py")
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    if args.output_dir.exists():
        raise ValueError("Schema test directory must be fresh")
    args.output_dir.mkdir(parents=True)
    base = json.loads((Path(__file__).parent / "style.json").read_text(encoding="utf-8"))
    cases = {
        "unapproved": {"approved": False}, "unknown-script": {"script": "print('never executed')"},
        "reference-path": {"referenceAssetIds": ["../../outside.png"]}, "reference-url": {"referenceAssetIds": ["https://example.com/image.png"]},
        "unknown-camera": {"camera": "photorealistic drone"}, "unknown-lighting": {"lighting": "cinematic AI"},
        "invalid-palette": {"palette": ["red"]}, "boolean-lineweight": {"lineWeight": True},
        "nonfinite-margin": {"margin": float("nan")}, "excessive-lineweight": {"lineWeight": 25},
        "opaque-id-path": {"id": "../style"}, "duplicate-refs": {"referenceAssetIds": ["asset-1", "asset-1"]},
    }
    checks = []
    accepted = args.output_dir / "accepted.json"
    accepted.write_text(json.dumps(base), encoding="utf-8")
    if worker.read_style_guide(accepted) != base:
        raise AssertionError("Valid style was changed")
    for label, changes in cases.items():
        candidate = deepcopy(base)
        candidate.update(changes)
        path = args.output_dir / (label + ".json")
        path.write_text(json.dumps(candidate), encoding="utf-8")
        try:
            worker.read_style_guide(path)
        except ValueError:
            checks.append({"case": label, "rejected": True})
        else:
            raise AssertionError("Invalid style accepted: " + label)
    result = {"valid": True, "approvedAccepted": True, "invalidCasesRejected": len(checks), "checks": checks}
    (args.output_dir / "summary.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"type": "style-schema-test-failed", "error": str(exc)}), flush=True)
        raise SystemExit(1) from exc
