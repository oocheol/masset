# SPDX-License-Identifier: GPL-3.0-or-later
"""Loaded-scene boundary regressions; all mutations are in-memory test copies."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import bpy
from audit import blender_filename
from preview_worker import verify_generated_scene


def run(source, output):
    assert bpy.app.background and "--disable-autoexec" in sys.argv
    original=hashlib.sha256(source.read_bytes()).hexdigest()
    bpy.context.preferences.filepaths.use_scripts_auto_execute=False
    bpy.ops.wm.open_mainfile(filepath=blender_filename(source),load_ui=False,use_scripts=False)
    verify_generated_scene()
    checks=["actual generated scene accepted"]

    def rejected(label):
        try:
            verify_generated_scene()
        except ValueError:
            checks.append(label)
        else:
            raise AssertionError(label+" was accepted")

    scene=bpy.context.scene
    scene["assetStudioGeneratedScene"]="forged-old-marker"
    rejected("wrong marker rejected")
    scene["assetStudioGeneratedScene"]="quality-worker-v2"
    text=bpy.data.texts.new("Non-executed test text")
    rejected("text datablock rejected")
    bpy.data.texts.remove(text)
    camera=scene.camera
    camera.driver_add("location",0)
    rejected("driver rejected")
    camera.driver_remove("location",0)
    image=bpy.data.images.new("Unpacked test image",width=4,height=4)
    image.source="FILE"
    image.filepath="//never-read-test-file.png"
    rejected("external image rejected without reading it")
    bpy.data.images.remove(image)
    verify_generated_scene()
    assert hashlib.sha256(source.read_bytes()).hexdigest()==original
    checks.append("source bytes unchanged")
    report={"passed":True,"checks":checks,"sourceSha256":original,
            "scriptAutoExecution":False,"blenderVersion":bpy.app.version_string}
    with output.open("x",encoding="utf-8") as stream:
        json.dump(report,stream,indent=2)
    print(json.dumps({"passed":True,"checks":len(checks),"evidence":str(output)}))


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--source",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args(sys.argv[sys.argv.index("--")+1:])
    run(args.source,args.output)
