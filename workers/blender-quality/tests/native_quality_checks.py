# SPDX-License-Identifier: GPL-3.0-or-later
"""Native analytical regression cases for fidelity/atlas measurements."""
import argparse
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bpy
from quality_metrics import atlas, fidelity, shading_error
from worker import duplicate, mesh_inspection


def main(output):
    assert bpy.app.background and "--disable-autoexec" in sys.argv
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.mesh.primitive_cube_add(size=1)
    source = bpy.context.object
    unchanged = duplicate(source, "Identical derived cube", "game")
    same = fidelity(source, unchanged)
    assert same["passed"] and same["maximumSurfaceErrorMeters"] < 1e-6
    assert same["minimumSilhouetteIoU"] == 1
    hard_copy = duplicate(source, "Derived sharp-faced cube", "lod1")
    hard_shading = shading_error(source, hard_copy)
    assert hard_shading["maximumNormalDeviationDegrees"] < 0.01
    for face in hard_copy.data.polygons:
        face.use_smooth = True
    hard_copy.data.update()
    smooth_shading = shading_error(source, hard_copy)
    assert smooth_shading["p95NormalDeviationDegrees"] > 20
    unchanged.scale.x = 0.4
    changed = fidelity(source, unchanged)
    assert not changed["passed"] and "surface-maximum" in changed["failedMetrics"]

    bpy.ops.mesh.primitive_cube_add(size=1, location=(0,0,0.8))
    thin = bpy.context.object
    thin.scale=(0.02,0.02,0.70)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.ops.object.select_all(action="DESELECT")
    source.select_set(True)
    thin.select_set(True)
    bpy.context.view_layer.objects.active=source
    bpy.ops.object.join()
    bpy.ops.mesh.primitive_cube_add(size=1)
    missing=bpy.context.object
    lost = fidelity(source, missing)
    assert not lost["passed"]
    assert lost["thinFeatures"]["thinSurfaceSamples"] > 0
    assert lost["thinFeatures"]["lostThinSurfaceSamples"] > 0

    mesh=bpy.data.meshes.new("Two adjacent UV triangles")
    mesh.from_pydata([(0,0,0),(1,0,0),(1,1,0),(0,1,0)],[],[(0,1,2),(0,2,3)])
    plane=bpy.data.objects.new("UV analytical plane",mesh)
    bpy.context.scene.collection.objects.link(plane)
    layer=mesh.uv_layers.new(name="GameUV")
    for loop,item in zip(mesh.loops,layer.data):
        item.uv=mesh.vertices[loop.vertex_index].co[:2]
    packed, _, _=atlas(plane,64)
    assert packed["surfaceUsageFraction"] == 1
    assert packed["overlappingInteriorTexels"] == 0
    assert abs(packed["texelDensityPixelsPerMeter"]["median"]-64) < 1e-6
    for polygon in mesh.polygons:
        for loop,uv in zip(polygon.loop_indices,((0,0),(1,0),(1,1))):
            layer.data[loop].uv=uv
    overlapping, _, _=atlas(plane,64)
    assert overlapping["interiorOverlapFraction"] > 0.95
    panel_mesh=bpy.data.meshes.new("Open vertical panel")
    panel_mesh.from_pydata([(0,0,0),(1,0,0),(1,0,1),(0,0,1)],[],[(0,1,2),(0,2,3)])
    panel=bpy.data.objects.new("Identical vertical card",panel_mesh)
    bpy.context.scene.collection.objects.link(panel)
    panel_copy=duplicate(panel,"Derived vertical card","game")
    planar=fidelity(panel,panel_copy)
    assert planar["passed"] and planar["minimumSilhouetteIoU"]==1
    assert sum(not view["applicable"] for view in planar["silhouetteViews"])==2
    assert not planar["thinFeatures"]["applicable"]

    profile = [(0,0),(1,0),(1,0.45),(0.45,0.45),(0.45,1),(0,1)]
    notch_mesh = bpy.data.meshes.new("Closed extruded L-shaped notch")
    notch_vertices = [(x,y,z) for y in (-0.2,0.2) for x,z in profile]
    notch_faces = [tuple(range(6)), tuple(reversed(range(6,12)))]
    notch_faces += [((i+1)%6,i,i+6,(i+1)%6+6) for i in range(6)]
    notch_mesh.from_pydata(notch_vertices, [], notch_faces)
    notch = bpy.data.objects.new("L-shaped notch reference", notch_mesh)
    bpy.context.scene.collection.objects.link(notch)
    notch_copy = duplicate(notch, "Identical notched model", "game")
    retained_notch = fidelity(notch, notch_copy)
    assert retained_notch["passed"] and retained_notch["minimumSilhouetteIoU"] == 1
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0.5,0,0.5))
    filled_notch = bpy.context.object
    filled_notch.scale = (1,0.4,1)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    lost_notch = fidelity(notch, filled_notch)
    assert not lost_notch["passed"] and "silhouette" in lost_notch["failedMetrics"]
    report={"passed":True, "blenderVersion":bpy.app.version_string,
            "sameGeometry":same,"missingShape":changed,"missingThinFeature":lost,
            "validAtlas":packed,"overlappingAtlas":overlapping,"validPlanarCard":planar,
            "retainedNotch":retained_notch,"filledNotch":lost_notch,
            "hardFaceNormals":hard_shading,"smoothedHardFaceNormals":smooth_shading,
            "cases":8,"inputAssetsUsed":False}
    target=Path(output)
    target.parent.mkdir(parents=True,exist_ok=True)
    with target.open("x",encoding="utf-8") as stream:
        json.dump(report,stream,indent=2,allow_nan=False)
    print(json.dumps({"passed":True,"cases":8,"report":str(target)}))


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--output",required=True)
    args=parser.parse_args(sys.argv[sys.argv.index("--")+1:])
    main(args.output)
