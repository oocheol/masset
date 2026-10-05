# SPDX-License-Identifier: MIT
"""Print sanitized, verified runtime status using only the standard library."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).absolute().parent))
from runtime_common import WorkerError, read_json, setup_lock_active, verify_runtime


def status(root):
    root = root.resolve()
    if not (root / "ready.json").is_file():
        if (root / "setup-state.json").is_file():
            try:
                state = read_json(root / "setup-state.json")
                if state.get("state") == "error":
                    return {"state": "error", "installed": False, "message": "Runtime setup failed; run setup again and inspect its JSON-lines progress"}
            except Exception:
                return {"state": "error", "installed": False, "message": "Runtime setup metadata is invalid"}
        return {"state": "missing", "installed": False,
                "message": "Runtime setup is in progress" if setup_lock_active(root / ".setup-lock") else "Pinned CPU runtime is not installed"}
    try:
        ready = verify_runtime(root)
        result = {k: ready[k] for k in ("interpreterPath", "pythonVersion", "modelId", "modelRevision",
                                       "codeRevision", "modelSha256", "device", "cpuThreads", "installVerified")}
        result.update(state="ready", installed=True, inferenceVerified=ready.get("inferenceVerified", False),
                      message="Pinned CPU runtime integrity and installed dependencies verified")
        return result
    except Exception as exc:
        return {"state": "error", "installed": False,
                "message": str(exc) if isinstance(exc, WorkerError) else "Runtime verification failed"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(status(args.runtime_root), allow_nan=False))


if __name__ == "__main__":
    main()
