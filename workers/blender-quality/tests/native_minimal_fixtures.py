# SPDX-License-Identifier: GPL-3.0-or-later
"""Create bounded native cube/card/triangle fixtures for full finishing tests.

The only write target is a new directory. No user asset, external image or
generated Python is loaded; all meshes and materials below are fixed test data.
Run worker.py and verify_native.py on each manifest job in fresh processes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bpy
from audit import GLB, blender_filename, read_parameters


def write_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)


def main(output):
    assert bpy.app.background and "--disable-autoexec" in sys.argv and "--factory-startup" in sys.argv
    target = Path(output)
    target.mkdir(parents=True, exist_ok=False)
    cases = []
    for case, expected_triangles in (("cube", 12), ("vertical-card", 2), ("single-triangle", 1)):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.context.preferences.filepaths.use_scripts_auto_execute = False
        if case == "cube":
            bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
            obj = bpy.context.object
        else:
            mesh = bpy.data.meshes.new(case + " fixed geometry")
            faces = [(0, 1, 2), (0, 2, 3)] if case == "vertical-card" else [(0, 1, 2)]
            vertices = [(-0.5, 0, 0), (0.5, 0, 0), (0.5, 0, 1), (-0.5, 0, 1)]
            if case == "single-triangle":
                vertices = [(-0.5, 0, 0), (0.5, 0, 0), (0, 0, 1)]
            mesh.from_pydata(vertices, [], faces)
            obj = bpy.data.objects.new(case, mesh)
            bpy.context.scene.collection.objects.link(obj)
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            layer = mesh.uv_layers.new(name="SourceUV")
            for loop, item in zip(mesh.loops, layer.data):
                vertex = mesh.vertices[loop.vertex_index].co
                item.uv = (vertex.x + 0.5, vertex.z)
        obj.name = case + " native fixture"
        mat = bpy.data.materials.new(case + " source PBR")
        mat.use_nodes = True
        mat.use_backface_culling = False
        shader = mat.node_tree.nodes.get("Principled BSDF")
        shader.inputs["Base Color"].default_value = (0.18, 0.55, 0.07, 1)
        shader.inputs["Roughness"].default_value = 0.37
        shader.inputs["Metallic"].default_value = 0.15
        obj.data.materials.append(mat)
        source = target / (case + ".glb")
        bpy.ops.export_scene.gltf(filepath=blender_filename(source), export_format="GLB", use_selection=True,
                                  export_materials="EXPORT", export_normals=True, export_texcoords=True,
                                  export_yup=True, export_animations=False, export_cameras=False, export_lights=False)
        data = source.read_bytes()
        glb = GLB(data)
        assert glb.scene_triangles == expected_triangles
        job = {"sourcePath": str(source.resolve()), "sourceSha256": hashlib.sha256(data).hexdigest(),
               "name": case + " native fixture", "heightMeters": 1, "maxTriangles": 1000,
               "textureResolution": 512, "sourceKind": "model", "preserveMaterials": True,
               "previewMode": "deferred"}
        job_path = target / (case + "-input.json")
        write_json(job_path, job)
        assert read_parameters(job_path) == job
        cases.append({"name": case, "source": str(source), "sourceSha256": job["sourceSha256"],
                      "sourceBytes": len(data), "sourceTriangles": expected_triangles,
                      "job": str(job_path), "expectedReductionApplied": False})
    manifest = target / "fixture-manifest.json"
    write_json(manifest, {"blenderVersion": bpy.app.version_string, "cases": cases,
                          "fixtureSourcesCreated": True, "existingUserInputsModified": False})
    print(json.dumps({"fixtures": len(cases), "manifest": str(manifest)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    main(args.output)
