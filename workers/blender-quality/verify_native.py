# SPDX-License-Identifier: GPL-3.0-or-later
"""Fresh native process: independently reopen artifact GLBs and worker .blend."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
from datetime import datetime, timezone
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from audit import GLB, artifact, blender_filename, filesystem_path, image_dimensions, verify_source
import bpy
import numpy as np
import bmesh
from mathutils import Vector
from mathutils.kdtree import KDTree


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.use_scripts_auto_execute = False


def mesh_data(objects):
    coordinates, centers = [], []
    count = uv_triangles = degenerate = boundary = loose = 0
    normals_finite = normals_unit = uv_finite = True
    for obj in objects:
        mesh = obj.data
        mesh.calc_loop_triangles()
        count += len(mesh.loop_triangles)
        coords = [obj.matrix_world @ v.co for v in mesh.vertices]
        coordinates.extend(coords)
        centers.extend(sum((coords[i] for i in t.vertices), Vector()) / 3 for t in mesh.loop_triangles)
        for normal in mesh.corner_normals:
            n = normal.vector
            normals_finite &= all(math.isfinite(v) for v in n)
            normals_unit &= abs(n.length - 1) <= 0.003
        uv = mesh.uv_layers.active
        if not uv:
            uv_finite = False
        else:
            for item in uv.data:
                uv_finite &= all(math.isfinite(v) for v in item.uv)
            for t in mesh.loop_triangles:
                a, b, c = [uv.data[i].uv for i in t.loops]
                area = abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))*0.5
                uv_triangles += area > 1e-12
                degenerate += area <= 1e-12
        bm = bmesh.new()
        bm.from_mesh(mesh)
        boundary += sum(e.is_boundary for e in bm.edges)
        loose += sum(not e.link_faces for e in bm.edges)
        bm.free()
    array = np.asarray([list(v) for v in coordinates], dtype=np.float64)
    if not len(array):
        raise ValueError("Reopened asset contains no mesh vertices")
    minimum, maximum = array.min(axis=0), array.max(axis=0)
    dim = maximum-minimum
    return {"vertices":len(array), "triangles":count, "dimensionsZUp":dim.tolist(),
            "dimensionsYUp":[float(dim[0]), float(dim[2]), float(dim[1])],
            "boundsZUp":[minimum.tolist(),maximum.tolist()],
            "finitePositions":bool(np.isfinite(array).all()),
            "finiteNormals":bool(normals_finite),"unitNormals":bool(normals_unit),
            "uvFinite":bool(uv_finite),"uvTriangles":uv_triangles,
            "degenerateUVTriangles":degenerate,"boundaryEdges":boundary,"looseEdges":loose},coordinates,centers


def image_stats(image):
    data = np.empty(len(image.pixels),dtype=np.float32)
    image.pixels.foreach_get(data)
    rgba = data.reshape(-1,4)
    colors = rgba[rgba[:,3]>0.999,:3]
    if not len(colors):
        colors = rgba[:,:3]
    sample = colors[::max(1,len(colors)//65536)]
    return {"size":list(image.size),"finite":bool(np.isfinite(rgba).all()),
            "minimumRGB":colors.min(axis=0).tolist(),"maximumRGB":colors.max(axis=0).tolist(),
            "stddevRGB":colors.std(axis=0).tolist(),"sampleDistinctRGB8":len(np.unique(np.rint(np.clip(sample,0,1)*255).astype(np.uint8),axis=0)),
            "interiorPixels":int((rgba[:,3]>0.999).sum()),"packed":image.packed_file is not None},colors


def nearest_error(reference, actual):
    tree = KDTree(len(reference))
    for index,point in enumerate(reference):
        tree.insert(point,index)
    tree.balance()
    return max(tree.find(point)[2] for point in actual)


def run(directory,evidence,log=None):
    if not bpy.app.background or "--disable-autoexec" not in sys.argv or "--factory-startup" not in sys.argv:
        raise ValueError("Independent verification requires factory startup and disable-autoexec")
    requested_directory, requested_evidence = os.fspath(directory), os.fspath(evidence)
    directory = filesystem_path(filesystem_path(directory).resolve(strict=True))
    evidence = filesystem_path(evidence)
    log = filesystem_path(log) if log is not None else None
    if evidence.exists() or evidence.is_symlink() or filesystem_path(evidence.parent.resolve()).is_relative_to(directory):
        raise ValueError("Evidence must be new and outside the artifact directory")
    report = json.loads((directory/"validation.json").read_text())
    job = report["parameters"]
    _,source = verify_source(job)
    checks = []
    result = {"schemaVersion":1,"createdAt":datetime.now(timezone.utc).isoformat(),
              "blenderVersion":bpy.app.version_string,"nativePlatform":sys.platform,
              "artifacts":requested_directory,"sourceSha256":source.sha256,"checks":checks,
              "independentProcess":True,"scriptAutoexec":False,"glbs":{},"images":{},"blend":{}}
    def check(code,condition,message,measured=None):
        item = {"code":code,"status":"pass" if condition else "fail","message":message}
        if measured is not None:
            item["measured"] = measured
        checks.append(item)
    check("report-schema",report["valid"] is True and all(
        c.get("status") in {"pass","warn","fail"} and isinstance(c.get("message"),str)
        and ("measured" not in c or type(c["measured"]) in {int,float,str}) for c in report["checks"]),
        "Backend check schema has messages and scalar measurements")
    if log:
        completed = []
        for line in log.read_text().splitlines():
            try:
                item=json.loads(line)
            except ValueError:
                continue
            if item.get("type")=="completed":
                completed.append(item)
        check("one-completed-record",len(completed)==1,"Exactly one completed JSON record",len(completed))
        if completed:
            for item in completed[0]["artifacts"]:
                path=directory/item["path"]
                actual=artifact(path,item["role"])
                check("hash-"+item["path"],path.name==item["path"] and actual["sha256"]==item["sha256"] and actual["bytes"]==item["bytes"],
                      "Completed basename/hash/bytes match actual artifact")
    clear()
    bpy.ops.import_scene.gltf(filepath=blender_filename(job["sourcePath"]),import_pack_images=True)
    original,vertices,centers=mesh_data([o for o in bpy.context.scene.objects if o.type=="MESH"])
    array=np.asarray([list(v) for v in vertices])
    minimum,maximum=array.min(axis=0),array.max(axis=0)
    origin=Vector(((minimum[0]+maximum[0])/2,(minimum[1]+maximum[1])/2,minimum[2]))
    scale=job["heightMeters"]/(maximum[2]-minimum[2])
    ref_vertices=[(v-origin)*scale for v in vertices]
    ref_centers=[(v-origin)*scale for v in centers]
    source_colors=[m.get("pbrMetallicRoughness",{}).get("baseColorFactor",[1,1,1,1])[:3]
                   for m in source.doc.get("materials",[])
                   if "baseColorTexture" not in m.get("pbrMetallicRoughness",{})]
    counts={}
    for filename,role in (("high-detail.glb","highDetail"),("game-ready.model.glb","game"),("lod1.glb","lod1")):
        glb=GLB((directory/filename).read_bytes(),maximum=128*1024*1024)
        clear()
        bpy.ops.import_scene.gltf(filepath=blender_filename(directory/filename),import_pack_images=True)
        meshes=[o for o in bpy.context.scene.objects if o.type=="MESH"]
        info,vertices,centroids=mesh_data(meshes)
        info["binary"]=glb.inspection()
        info["loadedImages"]=[image_stats(i)[0] for i in bpy.data.images if i.has_data]
        result["glbs"][role]=info
        counts[role]=info["triangles"]
        check(role+"-mesh",info["triangles"]==glb.scene_triangles and info["finitePositions"] and info["finiteNormals"] and info["unitNormals"],
              "Fresh native import has actual indexed geometry and finite unit normals",info["triangles"])
        check(role+"-no-studio",all(o.type=="MESH" for o in bpy.context.scene.objects),"GLB has no camera/lights or extra studio objects")
        check(role+"-height",abs(info["dimensionsYUp"][1]-job["heightMeters"])<job["heightMeters"]*1e-5,
              "Fresh native geometry has requested meter height",info["dimensionsYUp"][1])
        if role=="highDetail":
            error=max(nearest_error(ref_vertices,vertices),nearest_error(ref_centers,centroids))
            info["originalGeometryMaxErrorMeters"]=error
            check("high-original-geometry",info["triangles"]==original["triangles"] and error<job["heightMeters"]*1e-5,
                  "Original triangles/vertices survive normalization and high-detail export",error)
            check("high-original-image-bytes",{i["sha256"] for i in source.images}<={i["sha256"] for i in glb.images},
                  "Original embedded source images survive high-detail export")
        else:
            check(role+"-uv",info["uvFinite"] and info["uvTriangles"]==info["triangles"] and info["degenerateUVTriangles"]==0,
                  "Actual imported UVs give every triangle finite nonzero area")
            budget=job["maxTriangles"] if role=="game" else min(job["maxTriangles"]//2,counts["game"]//2)
            check(role+"-budget",info["triangles"]<=budget,"Actual native mesh satisfies triangle budget",info["triangles"])
            check(role+"-bottom-center",abs(info["boundsZUp"][0][2])<job["heightMeters"]*1e-5 and
                  all(abs(info["boundsZUp"][0][i]+info["boundsZUp"][1][i])<job["heightMeters"]*1e-5 for i in (0,1)),
                  "Actual game/LOD origin is bottom-center")
            check(role+"-no-loose",info["looseEdges"]==0,"Actual reopened GLB has no loose wire geometry",info["looseEdges"])
            for basename,key in (("basecolor.png","baseColorTexture"),("normal.png","normalTexture"),("orm.png","metallicRoughnessTexture"),("emission.png","emissiveTexture")):
                path=directory/basename
                if not path.exists():
                    continue
                digest=hashlib.sha256(path.read_bytes()).hexdigest()
                found=[]
                for material in glb.doc.get("materials",[]):
                    texture=material.get("pbrMetallicRoughness",{}).get(key) if key in {"baseColorTexture","metallicRoughnessTexture"} else material.get(key)
                    if texture:
                        index=glb.doc["textures"][texture["index"]]["source"]
                        found.append(glb.images[index]["sha256"])
                check(role+"-embedded-"+basename,bool(found) and all(value==digest for value in found),
                      "Standalone texture bytes exactly match the actual embedded material image",digest)
            if role=="game":
                check("game-reported-dimensions",all(abs(a-b)<job["heightMeters"]*1e-5 for a,b in zip(info["dimensionsYUp"],report["mesh"]["dimensions"])),
                      "Fresh measured GLB Y-up dimensions match report")
    check("lod-strictly-lower",counts["lod1"]<counts["game"],"LOD1 has fewer actual triangles than game")
    clear()
    for basename in ("basecolor.png","normal.png","orm.png","emission.png","thumbnail.png",*[f"turntable-{i:02d}.png" for i in range(4)]):
        path=directory/basename
        if not path.exists():
            continue
        dims=image_dimensions(path.read_bytes(),"image/png")
        expected=1024 if basename=="thumbnail.png" else 512 if basename.startswith("turntable-") else job["textureResolution"]
        image=bpy.data.images.load(blender_filename(path),check_existing=False)
        if basename in {"normal.png","orm.png"}:
            image.colorspace_settings.name="Non-Color"
        stats,colors=image_stats(image)
        result["images"][basename]=stats
        check("decoded-"+basename,dims==[expected,expected] and stats["size"]==dims and stats["finite"],
              "PNG header/native pixels have required finite resolution")
        if basename=="basecolor.png" and len(source_colors)>1 and "COLOR_0" not in source.attributes:
            errors=[float(np.linalg.norm(colors-np.asarray(c),axis=1).min()) for c in source_colors]
            check("source-material-colors",max(errors)<0.025,"Every original constant material color exists in the baked atlas (linear RGB)",max(errors))
            stats["sourceColorNearestErrors"]=errors
        if basename=="normal.png":
            variation=float(np.std(colors[:,:2],axis=0).max())
            check("normal-meaningful",variation>0.003,"Decoded high-to-low normal texture contains real variation",variation)
        if basename=="orm.png":
            check("orm-neutral-ao",bool(np.all(np.abs(colors[:,0]-1)<0.001)),"ORM R is explicitly neutral one, not fabricated AO")
            if all("metallicRoughnessTexture" not in m.get("pbrMetallicRoughness",{}) for m in source.doc.get("materials",[])):
                errors=[float(np.linalg.norm(colors[:,1:3]-np.asarray([m.get("pbrMetallicRoughness",{}).get("roughnessFactor",1),
                                                                      m.get("pbrMetallicRoughness",{}).get("metallicFactor",1)]),axis=1).min())
                        for m in source.doc.get("materials",[])]
                check("orm-source-factors",not errors or max(errors)<0.005,"Source roughness/metallic factors appear in actual ORM interior pixels",max(errors,default=0))
        if basename=="thumbnail.png" or basename.startswith("turntable-"):
            check("preview-not-solid-"+basename,stats["sampleDistinctRGB8"]>100,"Rendered preview contains actual non-solid image pixels",stats["sampleDistinctRGB8"])
    hashes={hashlib.sha256((directory/f"turntable-{i:02d}.png").read_bytes()).hexdigest() for i in range(4)}
    check("distinct-turntable",len(hashes)==4,"Four viewpoints produce four different PNGs",len(hashes))
    clear()
    bpy.ops.wm.open_mainfile(filepath=blender_filename(directory/"source.blend"),load_ui=False,use_scripts=False)
    roles={o.get("assetStudioRole"):o for o in bpy.context.scene.objects if o.type=="MESH" and o.get("assetStudioRole") in {"high-detail","game","lod1"}}
    info={"roles":sorted(roles),"textBlocks":len(bpy.data.texts),"engine":bpy.context.scene.render.engine,
          "device":bpy.context.scene.cycles.device,"threads":bpy.context.scene.render.threads,
          "unitScale":bpy.context.scene.unit_settings.scale_length,"camera":bpy.context.scene.camera is not None,
          "lights":sum(o.type=="LIGHT" for o in bpy.context.scene.objects),
          "images":[image_stats(i)[0] for i in bpy.data.images if i.has_data]}
    result["blend"]=info
    check("blend-editable-meshes",set(roles)=={"high-detail","game","lod1"},"Editable source reopens with separate high/game/LOD meshes")
    for role,obj in roles.items():
        inspected,_,_=mesh_data([obj])
        info[role]=inspected
        expected=counts["highDetail" if role=="high-detail" else role]
        check("blend-count-"+role,inspected["triangles"]==expected,"Editable mesh agrees with independently reopened GLB",inspected["triangles"])
        if role!="high-detail":
            check("blend-loose-"+role,inspected["looseEdges"]==0,"Editable game/LOD contains no loose geometry")
    if "high-detail" in roles:
        slots={p.material_index for p in roles["high-detail"].data.polygons}
        source_slots={p.get("material",-1) for m in source.doc["meshes"] for p in m["primitives"]}
        check("blend-high-materials",len(slots)>=len(source_slots),"Original high-detail material assignments survived all bakes",len(slots))
    drivers=0
    for table in (bpy.data.objects,bpy.data.meshes,bpy.data.materials,bpy.data.node_groups,bpy.data.scenes):
        for block in table:
            animation=getattr(block,"animation_data",None)
            if animation:
                drivers+=len(animation.drivers)
            tree=getattr(block,"node_tree",None)
            if tree and tree.animation_data:
                drivers+=len(tree.animation_data.drivers)
    check("blend-no-scripts",info["textBlocks"]==0 and drivers==0 and not bpy.context.preferences.filepaths.use_scripts_auto_execute,
          "Editable source has no text scripts/drivers; autoexec disabled",drivers)
    check("blend-packed-images",all(i["packed"] for i in info["images"]),"All editable source texture pixels are packed")
    check("blend-cpu-studio",info["engine"]=="CYCLES" and info["device"]=="CPU" and info["threads"]==2 and info["unitScale"]==1 and info["camera"] and info["lights"]==3,
          "CPU studio scene has bounded threads, camera/lights and meter units")
    _,after=verify_source(job)
    check("original-unchanged",after.sha256==source.sha256,"Original source hash is preserved",after.sha256)
    result["valid"]=all(c["status"]=="pass" for c in checks)
    evidence.parent.mkdir(parents=True,exist_ok=True)
    with evidence.open("x",encoding="utf-8") as stream:
        json.dump(result,stream,indent=2,allow_nan=False)
        stream.write("\n")
    print(json.dumps({"type":"independent-verification","valid":result["valid"],"evidence":requested_evidence,
                      "triangleCounts":counts,"failedChecks":[c for c in checks if c["status"]!="pass"]}),flush=True)
    if not result["valid"]:
        raise SystemExit(1)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--artifacts",required=True)
    parser.add_argument("--evidence",required=True)
    parser.add_argument("--worker-log")
    args=parser.parse_args(sys.argv[sys.argv.index("--")+1:])
    run(args.artifacts,args.evidence,args.worker_log)


if __name__=="__main__":
    main()
