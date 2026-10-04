# SPDX-License-Identifier: GPL-3.0-or-later
"""Local-only native QA runner. Requires installed Blender and repo Node deps.

python3 workers/blender/run_game_qa.py \
  --blender '/Applications/Blender.app/Contents/MacOS/Blender'

Every invocation reserves a fresh output/game-bundle/worker-qa run, preserving
all prior artifacts, failed processes, exact commands, stdout and stderr.
This verifies the worker and actual files, not Tauri/browser integration.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import shlex
import shutil
import subprocess
import sys
import time
import uuid


RECIPES = {
    "sword": (.28, .065, 1.10, "#9caec9", .002),
    "rifle": (1.10, .16, .34, "#72889e", .002),
    "spaceship": (1.60, 2.20, .60, "#799993", .003),
    "barrel": (.64, .64, .90, "#a47443", .003),
    "rock": (1.20, .86, .72, "#899189", 0),
    "tree": (1.30, 1.30, 2.60, "#417e53", .003),
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--blender", type=Path, required=True)
    parser.add_argument("--output-root", type=Path)
    parser.add_argument("--geometry-only", action="store_true")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    blender = args.blender.resolve(strict=True)
    output_root = (args.output_root or repo / "output/game-bundle/worker-qa").resolve()
    run = output_root / (datetime.now(timezone.utc).strftime("run-%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:12])
    run.mkdir(parents=True, exist_ok=False)
    (run / "inputs").mkdir()
    (run / "logs").mkdir()
    result = {"schemaVersion": 1, "valid": False, "scope": "Native Blender worker and real artifact verification",
              "nativeAppIntegrationVerified": False, "runDirectory": str(run),
              "host": {"system": platform.system(), "machine": platform.machine(), "version": platform.mac_ver()[0]},
              "blenderExecutable": str(blender), "policy": {"networkUsed": False, "loginUsed": False,
              "scriptAutoExecution": False, "generatedAssetCodeExecuted": False, "originalsPreserved": True},
              "commands": [], "models": [], "errors": []}
    started = time.monotonic()

    def save():
        # This summary is runner-owned metadata inside this uniquely reserved run.
        (run / "summary.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    def command(label, argv, expect_success=True):
        argv = [str(value) for value in argv]
        stdout_path, stderr_path = run / "logs" / f"{label}.stdout.log", run / "logs" / f"{label}.stderr.log"
        print(json.dumps({"type": "qa-stage", "label": label, "runDirectory": str(run)}), flush=True)
        before = time.monotonic()
        record = {"label": label, "argv": argv, "shellDisplay": shlex.join(argv),
                  "cwd": str(repo), "stdout": str(stdout_path), "stderr": str(stderr_path)}
        result["commands"].append(record)
        with stdout_path.open("x", encoding="utf-8") as stdout, stderr_path.open("x", encoding="utf-8") as stderr:
            try:
                process = subprocess.run(argv, cwd=repo, stdout=stdout, stderr=stderr, timeout=900, check=False)
                record["exitCode"] = process.returncode
            except (OSError, subprocess.TimeoutExpired) as exc:
                record["error"] = str(exc)
                record["exitCode"] = -1
        record["elapsedSeconds"] = round(time.monotonic() - before, 3)
        valid = (record["exitCode"] == 0) if expect_success else (record["exitCode"] > 0)
        record["expectedSuccess"], record["valid"] = expect_success, valid
        if not valid:
            result["errors"].append({"label": label, "exitCode": record["exitCode"], "stderr": str(stderr_path), "stdout": str(stdout_path)})
        save()
        print(json.dumps({"type": "qa-command", "label": label, "valid": valid, "exitCode": record["exitCode"]}), flush=True)
        return valid

    def native(label, script, arguments, expect_success=True):
        return command(label, [blender, "--background", "--factory-startup", "--disable-autoexec", "--threads", "2",
                               "--python-exit-code", "1", "--python", repo / script, "--", *arguments], expect_success)

    command("blender-version", [blender, "--version"])
    if not native("geometry-boundaries", "workers/blender/test_game_recipes.py", ["--output-dir", run / "geometry"]):
        print(json.dumps({"valid": False, "summary": str(run / "summary.json"), "error": "Geometry boundary checks failed"}), flush=True)
        return 1
    if args.geometry_only:
        result["valid"] = not result["errors"]
        save()
        print(json.dumps({"valid": result["valid"], "summary": str(run / "summary.json")}), flush=True)
        return 0 if result["valid"] else 1
    native("existing-style-schema", "tests/blender/test_style_schema.py", ["--output-dir", run / "style-schema"])
    style = {"id": "qa-fixed-game-style", "name": "Approved native game recipe QA", "palette": ["#c78272", "#405568", "#abc4a2"],
             "lineWeight": 2, "camera": "orthographic 3/4", "lighting": "soft studio", "detail": "readable low polygon silhouettes",
             "margin": 24, "referenceAssetIds": ["qa-palette-provenance"], "approved": True}
    style_path = run / "inputs" / "style.json"
    style_path.write_text(json.dumps(style, indent=2) + "\n", encoding="utf-8")
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node is required for the existing independent artifact verifier")
    for template, (width, depth, height, color, bevel) in RECIPES.items():
        parameters = {"template": template, "name": f"QA {template} 개별 게임 에셋", "width": width, "depth": depth,
                      "height": height, "color": color, "bevel": bevel}
        input_path, artifacts = run / "inputs" / f"{template}.json", run / template
        input_path.write_text(json.dumps(parameters, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        args_worker = ["--input", input_path, "--output-dir", artifacts, "--style-file", style_path]
        if not native(f"{template}-production", "workers/blender/worker.py", args_worker):
            continue
        report = json.loads((artifacts / "validation.json").read_text(encoding="utf-8"))
        model_record = {"template": template, "parameters": parameters, "artifactDirectory": str(artifacts),
                        "source": report["sourceInspection"], "glb": report["gltfInspection"],
                        "workerElapsedSeconds": report["elapsedSeconds"], "componentCount": report["componentCount"]}
        result["models"].append(model_record)
        for mode in ("glb", "blend"):
            native(f"{template}-existing-{mode}-oracle", "tests/blender/verify_artifacts.py",
                   ["--input", input_path, "--artifact-dir", artifacts, "--mode", mode])
            native(f"{template}-game-{mode}-oracle", "workers/blender/verify_game_recipes.py",
                   ["--input", input_path, "--artifact-dir", artifacts, "--style-file", style_path, "--mode", mode])
        command(f"{template}-independent-loader", [node, repo / "tests/artifact/inspect-blender.mjs", artifacts, run / f"{template}-independent-copy"])
        before = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in artifacts.iterdir() if path.is_file()}
        rejected = native(f"{template}-reject-overwrite", "workers/blender/worker.py", args_worker, expect_success=False)
        after = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in artifacts.iterdir() if path.is_file()}
        model_record["overwriteRejectedOriginalsUnchanged"] = rejected and before == after
        if before != after:
            result["errors"].append({"label": template + "-preservation", "error": "Existing artifacts changed"})
        save()
    for label, candidate_style, extra in (("unapproved-style", {**style, "approved": False}, {}),
                                         ("script-field", style, {"script": "raise RuntimeError('never executed')"})):
        input_path, invalid_style = run / "inputs" / f"reject-{label}.json", run / "inputs" / f"reject-{label}-style.json"
        input_path.write_text(json.dumps({"template": "sword", "name": "Rejected", "width": .3, "depth": .08,
                                          "height": 1, "color": "#799993", "bevel": .002, **extra}), encoding="utf-8")
        invalid_style.write_text(json.dumps(candidate_style), encoding="utf-8")
        native("reject-" + label, "workers/blender/worker.py",
               ["--input", input_path, "--output-dir", run / ("rejected-" + label), "--style-file", invalid_style], expect_success=False)
        if (run / ("rejected-" + label)).exists():
            result["errors"].append({"label": label, "error": "Rejected input wrote an output directory"})
    result["valid"] = not result["errors"] and len(result["models"]) == len(RECIPES)
    result["elapsedSeconds"] = round(time.monotonic() - started, 3)
    save()
    print(json.dumps({"valid": result["valid"], "models": len(result["models"]), "errors": result["errors"],
                      "elapsedSeconds": result["elapsedSeconds"], "summary": str(run / "summary.json")}), flush=True)
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
