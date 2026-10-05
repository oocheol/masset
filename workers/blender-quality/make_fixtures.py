# SPDX-License-Identifier: GPL-3.0-or-later
"""Trusted synthetic fixtures for vertex-color and RGB embedded texture proofs.

These are test geometry, never claimed to be neural inference output.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
import bpy
import numpy as np


def fresh():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.use_scripts_auto_execute=False


def export(obj,directory,name):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active=obj
    path=directory/(name+".glb")
    bpy.ops.export_scene.gltf(filepath=str(path),export_format="GLB",use_selection=True,
                              export_yup=True,export_normals=True,export_texcoords=True,
                              export_materials="EXPORT",export_animations=False,export_extras=False)
    data=path.read_bytes()
    job={"sourcePath":str(path),"sourceSha256":hashlib.sha256(data).hexdigest(),"name":name,
         "heightMeters":1.2,"maxTriangles":1000,"textureResolution":512,
         "sourceKind":"model","preserveMaterials":True}
    (directory/(name+"-input.json")).write_text(json.dumps(job,indent=2)+"\n")


def make(directory):
    directory=directory.absolute()
    directory.mkdir(parents=True,exist_ok=False)
    fresh()
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=5,radius=1)
    obj=bpy.context.object
    obj.name="Vertex-colored organic test mesh (synthetic)"
    for v in obj.data.vertices:
        theta=math.atan2(v.co.y,v.co.x)
        wave=1+0.12*math.cos(theta*5)*(1-v.co.z*v.co.z)
        v.co.x*=wave*0.7
        v.co.y*=wave*0.85
        v.co.z*=1.15
    obj.data.update()
    for p in obj.data.polygons:
        p.use_smooth=True
    attr=obj.data.color_attributes.new(name="Color",type="FLOAT_COLOR",domain="CORNER")
    for loop,item in zip(obj.data.loops,attr.data):
        x,y,z=obj.data.vertices[loop.vertex_index].co
        item.color=(0.08+0.75*(z/2.3+0.5),0.1+0.6*(math.sin(x*8)+1)/2,
                    0.08+0.7*(math.cos(y*7)+1)/2,1)
    obj.data.color_attributes.active_color=attr
    mat=bpy.data.materials.new("Original vertex color gradient")
    mat.use_nodes=True
    shader=mat.node_tree.nodes["Principled BSDF"]
    node=mat.node_tree.nodes.new("ShaderNodeVertexColor")
    node.layer_name="Color"
    mat.node_tree.links.new(node.outputs["Color"],shader.inputs["Base Color"])
    shader.inputs["Roughness"].default_value=0.38
    shader.inputs["Metallic"].default_value=0.15
    obj.data.materials.append(mat)
    export(obj,directory,"vertex-color")
    fresh()
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64,ring_count=32)
    obj=bpy.context.object
    obj.name="Embedded RGB textured test mesh (synthetic)"
    obj.scale=(0.75,0.65,1)
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    for p in obj.data.polygons:
        p.use_smooth=True
    image=bpy.data.images.new("Original RGB quadrant texture",width=128,height=128,alpha=False,float_buffer=True)
    image.colorspace_settings.name="sRGB"
    values=np.zeros((128,128,4),dtype=np.float32)
    values[:,:,3]=1
    for y in range(128):
        for x in range(128):
            palette=((0.8,0.025,0.015),(0.025,0.75,0.04),(0.015,0.06,0.85),(0.8,0.6,0.025))
            base=palette[(x//64)+2*(y//64)]
            factor=0.6+0.4*(math.sin(x*0.2)*math.cos(y*0.15)+1)/2
            values[y,x,:3]=np.asarray(base)*factor
    image.pixels.foreach_set(values.ravel())
    image.filepath_raw=str(directory/"original-rgb.png")
    image.file_format="PNG"
    image.save()
    image.pack()
    mat=bpy.data.materials.new("Original embedded RGB PBR")
    mat.use_nodes=True
    shader=mat.node_tree.nodes["Principled BSDF"]
    texture=mat.node_tree.nodes.new("ShaderNodeTexImage")
    texture.image=image
    mat.node_tree.links.new(texture.outputs["Color"],shader.inputs["Base Color"])
    shader.inputs["Roughness"].default_value=0.23
    shader.inputs["Metallic"].default_value=0.65
    obj.data.materials.append(mat)
    export(obj,directory,"embedded-rgb")
    mat.node_tree.links.new(texture.outputs["Color"],shader.inputs["Emission Color"])
    shader.inputs["Emission Strength"].default_value=0.35
    export(obj,directory,"embedded-rgb-emission")
    print(json.dumps({"fixtures":str(directory),"synthetic":True}),flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--output-dir",type=Path,required=True)
    args=parser.parse_args(sys.argv[sys.argv.index("--")+1:])
    make(args.output_dir)
