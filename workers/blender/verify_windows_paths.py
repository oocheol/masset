# SPDX-License-Identifier: GPL-3.0-or-later
"""Trusted native diagnostic for the worker's Windows path boundary."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import traceback
import ctypes

parser = argparse.ArgumentParser()
parser.add_argument("--config", type=Path, required=True)
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
config = json.loads(args.config.read_text(encoding="utf-8"))
spec = importlib.util.spec_from_file_location("trusted_worker", Path(__file__).with_name("worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
target = worker.blender_interop_path(Path(config["prefixedOutput"]))
print(json.dumps({"target": str(target), "parts": [len(p) for p in target.parts], "exists": target.exists()}), flush=True)
get_short = ctypes.WinDLL("kernel32", use_last_error=True).GetShortPathNameW
get_short.argtypes = (ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32)
get_short.restype = ctypes.c_uint32
required = get_short(str(target), None, 0)
buffer = ctypes.create_unicode_buffer(required + 1)
length = get_short(str(target), buffer, len(buffer))
print(json.dumps({"shortPath": buffer.value, "shortPathCharacters": length}), flush=True)
if length:
    try:
        os.chdir(buffer.value)
        print(json.dumps({"shortCwd": os.getcwd(), "shortAliasSameDirectory": os.path.samefile(buffer.value, target)}), flush=True)
    except Exception as exc:
        print(json.dumps({"shortChdirError": str(exc)}), flush=True)
for step, operation in (("mkdir", lambda: target.mkdir(parents=True, exist_ok=True)),
                        ("absolute-file-io", lambda: (target / "path-probe.txt").write_text("native path probe", encoding="utf-8")),
                        ("chdir", lambda: os.chdir(target)),
                        ("relative-file-io", lambda: Path("relative-path-probe.txt").write_text("native relative probe", encoding="utf-8"))):
    try:
        operation()
        print(json.dumps({"step": step, "valid": True}), flush=True)
    except Exception as exc:
        print(json.dumps({"step": step, "valid": False, "error": str(exc)}), flush=True)
        traceback.print_exc()
        break
