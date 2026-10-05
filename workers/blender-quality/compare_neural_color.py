# SPDX-License-Identifier: GPL-3.0-or-later
"""Read-only native raw-GLB/render and atlas color-fidelity comparison."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from audit import verify_source
import bpy
import bmesh
import numpy as np
from mathutils import Matrix,Vector,geometry
from mathutils.bvhtree import BVHTree


def compare(artifacts,output):
    if "--disable-autoexec" not in sys.argv or "--factory-startup" not in sys.argv:
        raise ValueError("Comparison requires native factory startup with autoexec disabled")
    output=output.absolute()
    output.mkdir(parents=True,exist_ok=False)
    report=json.loads((artifacts/"validation.json").read_text())
    job=report["parameters"]
    _,glb=verify_source(job)
    bpy.context.preferences.filepaths.use_scripts_auto_execute=False
    bpy.ops.wm.open_mainfile(filepath=str((artifacts/"source.blend").absolute()),load_ui=False,use_scripts=False)
    scene=bpy.context.scene
    camera=scene.camera
    camera.animation_data_clear()
    roles={o.get("assetStudioRole"):o for o in scene.objects if o.get("assetStudioRole") in {"high-detail","game","lod1"}}
    game=roles["game"]
    size=max(game.dimensions)
    height=job["heightMeters"]
    camera.location=(size*2.1,-size*2.7,height/2+size*1.5)
    camera.rotation_euler=(Vector((0,0,height/2))-camera.location).to_track_quat("-Z","Y").to_euler()
    scene.render.resolution_x=scene.render.resolution_y=1024
    scene.cycles.samples=24
    previous=set(scene.objects)
    bpy.ops.import_scene.gltf(filepath=job["sourcePath"],import_pack_images=True,import_shading="NORMALS",merge_vertices=False)
    raw_meshes=[o for o in scene.objects if o not in previous and o.type=="MESH"]
    for obj in raw_meshes:
        world=obj.matrix_world.copy()
        obj.parent=None
        obj.data=obj.data.copy()
        obj.data.transform(world)
        obj.matrix_world=Matrix.Identity(4)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in raw_meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active=raw_meshes[0]
    if len(raw_meshes)>1:
        bpy.ops.object.join()
    raw=bpy.context.object
    positions=np.asarray([list(v.co) for v in raw.data.vertices])
    lo,hi=positions.min(axis=0),positions.max(axis=0)
    origin=Vector(((lo[0]+hi[0])/2,(lo[1]+hi[1])/2,lo[2]))
    scale=height/(hi[2]-lo[2])
    raw.data.transform(Matrix.Diagonal((scale,scale,scale,1))@Matrix.Translation(-origin))
    raw.data.update()
    raw.data.calc_loop_triangles()
    game.data.calc_loop_triangles()
    original_pbr=[]
    for mat in raw.data.materials:
        for shader in mat.node_tree.nodes if mat and mat.use_nodes else ():
            if shader.type=="BSDF_PRINCIPLED":
                original_pbr.append({"metallic":float(shader.inputs["Metallic"].default_value),
                                     "roughness":float(shader.inputs["Roughness"].default_value)})
    color=raw.data.color_attributes.active_color
    if color is None:
        color=next(iter(raw.data.color_attributes),None)
    bm=bmesh.new()
    bm.from_mesh(raw.data)
    tree=BVHTree.FromBMesh(bm)
    bm.free()
    image=bpy.data.images.load(str((artifacts/"basecolor.png").absolute()),check_existing=False)
    pixels=np.asarray(image.pixels[:],dtype=np.float64).reshape(image.size[1],image.size[0],4)
    uv=game.data.uv_layers.active.data
    errors=[]
    nearest_distances=[]
    reference_colors=[]
    baked_colors=[]
    source_alpha=[]
    for tri in game.data.loop_triangles[::max(1,len(game.data.loop_triangles)//4096)]:
        uv_points=[uv[i].uv for i in tri.loops]
        area=abs((uv_points[1]-uv_points[0]).cross(uv_points[2]-uv_points[0]))*0.5*image.size[0]*image.size[1]
        if area<4:
            continue
        uv_center=sum(uv_points,Vector((0,0)))/3
        x=float(uv_center.x*image.size[0]-0.5);y=float(uv_center.y*image.size[1]-0.5)
        x0=max(0,min(image.size[0]-2,int(np.floor(x))));y0=max(0,min(image.size[1]-2,int(np.floor(y))))
        fx=max(0,min(1,x-x0));fy=max(0,min(1,y-y0))
        sample=(pixels[y0,x0]*(1-fx)*(1-fy)+pixels[y0,x0+1]*fx*(1-fy)+
                pixels[y0+1,x0]*(1-fx)*fy+pixels[y0+1,x0+1]*fx*fy)
        if sample[3]<0.999:
            continue
        position=sum((game.data.vertices[i].co for i in tri.vertices),Vector())/3
        nearest,_,face_index,distance=tree.find_nearest(position)
        face=raw.data.polygons[face_index]
        loops=list(face.loop_indices)
        if len(loops)!=3 or color is None:
            continue
        vertices=[raw.data.vertices[raw.data.loops[i].vertex_index].co for i in loops]
        channels=[Vector(color.data[raw.data.loops[i].vertex_index if color.domain=="POINT" else i].color[:3]) for i in loops]
        expected=geometry.barycentric_transform(nearest,*vertices,*channels)
        errors.append(np.abs(sample[:3]-np.asarray(expected)))
        nearest_distances.append(distance)
        reference_colors.append(list(expected))
        baked_colors.append(sample[:3].tolist())
        source_alpha.append(float(sample[3]))
    values=np.asarray(errors)
    fidelity={"samples":len(errors),"method":"Bilinear decoded PNG at actual game UV triangle centers compared with nearest raw GLB triangle barycentric linear COLOR_0; only >=4 pixel UV triangles and alpha>=0.999",
              "meanAbsoluteChannelError":values.mean(axis=0).tolist() if len(values) else None,
              "p95MaximumChannelError":float(np.quantile(values.max(axis=1),0.95)) if len(values) else None,
              "maxSurfaceDistanceMeters":max(nearest_distances,default=None),
              "sourceMeanSampledRGBLinear":np.mean(reference_colors,axis=0).tolist() if reference_colors else None,
              "bakeMeanSampledRGBLinear":np.mean(baked_colors,axis=0).tolist() if baked_colors else None}
    measurement={"sourceSha256":glb.sha256,"rawImportedPBRDefaults":original_pbr,"colorFidelity":fidelity}
    (output/"color-measurement.json").write_text(json.dumps(measurement,indent=2,allow_nan=False)+"\n")
    print(json.dumps({"type":"color-measurement",**measurement}),flush=True)
    records=[]
    def view(name,visible):
        for obj in roles.values():
            obj.hide_render=obj!=visible
            obj.hide_set(obj!=visible)
        raw.hide_render=visible!=raw
        raw.hide_set(visible!=raw)
        scene.render.filepath=str(output/name)
        bpy.ops.render.render(write_still=True)
        data=(output/name).read_bytes()
        records.append({"path":name,"sha256":hashlib.sha256(data).hexdigest(),"bytes":len(data)})
    view("raw-default-material.png",raw)
    if not glb.doc.get("materials") and "COLOR_0" in glb.attributes:
        for mat in raw.data.materials:
            for shader in mat.node_tree.nodes if mat and mat.use_nodes else ():
                if shader.type=="BSDF_PRINCIPLED":
                    shader.inputs["Metallic"].default_value=0
                    shader.inputs["Roughness"].default_value=0.6
    view("raw-neutral-material.png",raw)
    view("finished-game.png",game)
    result={"sourceSha256":glb.sha256,"rawTriangles":len(raw.data.loop_triangles),
            "gameTriangles":len(game.data.loop_triangles),"rawImportedPBRDefaults":original_pbr,
            "sourceCoordinateSystem":"standard GLB Y-up","vertexColorInterpretation":"standard glTF linear, unchanged",
            "sameCameraAndLighting":True,"colorFidelity":fidelity,"artifactsRendered":records,
            "limitations":"These comparisons assess source-to-finished fidelity. They do not establish reconstructed geometry or colors match the input photograph."}
    (output/"color-fidelity.json").write_text(json.dumps(result,indent=2,allow_nan=False)+"\n")
    print(json.dumps(result),flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--artifacts",type=Path,required=True)
    parser.add_argument("--output-dir",type=Path,required=True)
    args=parser.parse_args(sys.argv[sys.argv.index("--")+1:])
    compare(args.artifacts,args.output_dir)
