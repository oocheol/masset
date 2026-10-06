# SPDX-License-Identifier: GPL-3.0-or-later
"""Native receipt regression against copied, separately rendered previews.

Mutations touch only new fixture copies. The source artifact set is read-only,
hashed before and after. Actual PNG pixels are decoded by native Blender.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys

sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import bpy
import numpy as np
from audit import blender_filename
from verify_native import PREVIEW_NAMES,verify_deferred_preview_set
from worker import texture_stats


def file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def clone(source,target,excluded=()):
    target.mkdir()
    for name in ("source.blend","preview-validation.json",*PREVIEW_NAMES):
        if name in excluded:
            continue
        with (target/name).open("xb") as stream:
            stream.write((source/name).read_bytes())
    return target


def decode(directory):
    measurements={}
    for name in PREVIEW_NAMES:
        if not (directory/name).is_file():
            continue
        image=bpy.data.images.load(blender_filename(directory/name),check_existing=False)
        image.colorspace_settings.name="sRGB"
        measurements[name]=texture_stats(image)
        bpy.data.images.remove(image)
    return measurements


def write_receipt(directory,value):
    # This is an owned test copy created above, never a user/version original.
    (directory/"preview-validation.json").write_text(json.dumps(value,indent=2,allow_nan=False),encoding="utf-8")


def main(source,output):
    assert bpy.app.background and "--disable-autoexec" in sys.argv and "--factory-startup" in sys.argv
    source=Path(source).resolve(strict=True)
    target=Path(output)
    target.mkdir(parents=True,exist_ok=False)
    original_hashes={path.name:file_hash(path) for path in source.iterdir() if path.is_file()}
    original_receipt=json.loads((source/"preview-validation.json").read_text())
    job={"name":original_receipt["name"]}
    core={"preview":{"status":"deferred"}}
    outcomes=[]

    def expect(case,directory,accepted,measurements=None):
        try:
            result=verify_deferred_preview_set(directory,job,core,decode(directory) if measurements is None else measurements)
        except ValueError as exc:
            assert not accepted,(case,str(exc))
            outcomes.append({"case":case,"passed":True,"rejected":True,"reason":str(exc)})
        else:
            assert accepted,(case,"unexpected acceptance")
            outcomes.append({"case":case,"passed":True,"rejected":False,"mode":result["mode"]})

    valid=clone(source,target/"valid-combined")
    valid_measurements=decode(valid)
    expect("valid-combined",valid,True,valid_measurements)
    empty=clone(source,target/"empty-deferred",excluded=("preview-validation.json",*PREVIEW_NAMES))
    expect("empty-deferred",empty,True,{})
    expect("missing-receipt",clone(source,target/"missing-receipt",excluded=("preview-validation.json",)),False)
    expect("incomplete-previews",clone(source,target/"incomplete-previews",excluded=("turntable-03.png",)),False)
    unexpected=clone(source,target/"unexpected-preview")
    with (unexpected/"turntable-04.png").open("xb") as stream:
        stream.write((source/"turntable-00.png").read_bytes())
    expect("unexpected-preview",unexpected,False,valid_measurements)
    wrong_scene=clone(source,target/"mismatched-scene-hash")
    receipt=copy.deepcopy(original_receipt)
    receipt["sourceSha256"]="0"*64
    write_receipt(wrong_scene,receipt)
    expect("mismatched-scene-hash",wrong_scene,False,valid_measurements)
    for field,value in (("scriptAutoExecution",True),("drivers",1),("textBlocks",False),
                        ("linkedLibraries",1),("externalResources",1)):
        unsafe=clone(source,target/("unsafe-"+field))
        receipt=copy.deepcopy(original_receipt)
        receipt[field]=value
        write_receipt(unsafe,receipt)
        expect("unsafe-"+field,unsafe,False,valid_measurements)
    mismatched=clone(source,target/"mismatched-pixel-receipt")
    receipt=copy.deepcopy(original_receipt)
    receipt["imageMeasurements"]["thumbnail.png"]["meanRGBLinear"][0]+=0.05
    write_receipt(mismatched,receipt)
    expect("mismatched-pixel-receipt",mismatched,False,valid_measurements)
    swapped=clone(source,target/"same-resolution-swapped-frame",excluded=("turntable-00.png",))
    with (swapped/"turntable-00.png").open("xb") as stream:
        stream.write((source/"turntable-01.png").read_bytes())
    expect("same-resolution-swapped-frame",swapped,False)
    tampered=clone(source,target/"same-resolution-changed-pixels",excluded=("thumbnail.png",))
    image=bpy.data.images.load(blender_filename(source/"thumbnail.png"),check_existing=False)
    image.colorspace_settings.name="sRGB"
    rgba=np.empty(len(image.pixels),dtype=np.float32)
    image.pixels.foreach_get(rgba)
    rgba=rgba.reshape(-1,4)
    rgba[:,:3]*=0.75
    image.pixels.foreach_set(rgba.ravel())
    image.filepath_raw=blender_filename(tampered/"thumbnail.png")
    image.file_format="PNG"
    image.save()
    bpy.data.images.remove(image)
    expect("same-resolution-changed-pixels",tampered,False)
    bad_renderer=clone(source,target/"mismatched-renderer")
    receipt=copy.deepcopy(original_receipt)
    receipt["preview"]["engine"]="CYCLES"
    write_receipt(bad_renderer,receipt)
    expect("mismatched-renderer",bad_renderer,False,valid_measurements)
    bad_mode=clone(source,target/"malformed-mode")
    receipt=copy.deepcopy(original_receipt)
    receipt["preview"]["mode"]=[]
    write_receipt(bad_mode,receipt)
    expect("malformed-mode",bad_mode,False,valid_measurements)
    orphan=clone(source,target/"receipt-without-images",excluded=PREVIEW_NAMES)
    expect("receipt-without-images",orphan,False,{})
    after={path.name:file_hash(path) for path in source.iterdir() if path.is_file()}
    assert after==original_hashes
    report={"passed":True,"cases":len(outcomes),"blenderVersion":bpy.app.version_string,
            "sourceOriginalPreserved":True,"originalArtifactHashes":original_hashes,"checks":outcomes,
            "receiptUsesPixelStatistics":True,"receiptIsCryptographicSignature":False}
    evidence=target/"receipt-regression.json"
    with evidence.open("x",encoding="utf-8") as stream:
        json.dump(report,stream,indent=2,allow_nan=False)
    print(json.dumps({"passed":True,"cases":len(outcomes),"evidence":str(evidence)}))


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--artifacts",required=True)
    parser.add_argument("--output-dir",required=True)
    args=parser.parse_args(sys.argv[sys.argv.index("--")+1:])
    main(args.artifacts,args.output_dir)
