# SPDX-License-Identifier: GPL-3.0-or-later
"""Render original/game from a generated .blend with identical studio cameras."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import bpy
from mathutils import Vector


def render(artifacts,output):
    if "--disable-autoexec" not in sys.argv or "--factory-startup" not in sys.argv:
        raise ValueError("Reference render requires factory startup and autoexec disabled")
    output=output.absolute()
    output.mkdir(parents=True,exist_ok=False)
    report=json.loads((artifacts/"validation.json").read_text())
    bpy.context.preferences.filepaths.use_scripts_auto_execute=False
    bpy.ops.wm.open_mainfile(filepath=str((artifacts/"source.blend").absolute()),load_ui=False,use_scripts=False)
    scene=bpy.context.scene
    camera=scene.camera
    camera.animation_data_clear()
    meshes={o.get("assetStudioRole"):o for o in scene.objects if o.get("assetStudioRole") in {"high-detail","game","lod1"}}
    size=max(meshes["game"].dimensions)
    height=report["parameters"]["heightMeters"]
    camera.location=(size*2.1,-size*2.7,height/2+size*1.5)
    camera.rotation_euler=(Vector((0,0,height/2))-camera.location).to_track_quat("-Z","Y").to_euler()
    scene.render.resolution_x=scene.render.resolution_y=1024
    scene.cycles.samples=24
    records=[]
    for role,basename in (("high-detail","source-reference.png"),("game","game-reference.png")):
        for name,obj in meshes.items():
            obj.hide_render=name!=role
            obj.hide_set(name!=role)
        scene.render.filepath=str(output/basename)
        bpy.ops.render.render(write_still=True)
        data=(output/basename).read_bytes()
        records.append({"path":basename,"sha256":hashlib.sha256(data).hexdigest(),"bytes":len(data),"role":role})
    for mat in meshes["game"].data.materials:
        shader=next((node for node in mat.node_tree.nodes if node.type=="BSDF_PRINCIPLED"),None)
        if shader:
            for link in list(shader.inputs["Normal"].links):
                mat.node_tree.links.remove(link)
    scene.render.filepath=str(output/"game-without-normal-reference.png")
    bpy.ops.render.render(write_still=True)
    data=(output/"game-without-normal-reference.png").read_bytes()
    records.append({"path":"game-without-normal-reference.png","sha256":hashlib.sha256(data).hexdigest(),"bytes":len(data),
                    "role":"game-normal-disabled-diagnostic"})
    result={"artifacts":str(artifacts.absolute()),"sameCameraLighting":True,"samples":24,"resolution":[1024,1024],
            "originalHighDetailModified":False,"artifactsRendered":records,
            "note":"Reference views compare actual original geometry/materials with actual welded, baked game mesh. No artifact .blend is saved or modified."}
    (output/"reference-proof.json").write_text(json.dumps(result,indent=2)+"\n")
    print(json.dumps(result),flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--artifacts",type=Path,required=True)
    parser.add_argument("--output-dir",type=Path,required=True)
    args=parser.parse_args(sys.argv[sys.argv.index("--")+1:])
    render(args.artifacts,args.output_dir)
