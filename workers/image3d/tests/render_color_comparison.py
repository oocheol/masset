# SPDX-License-Identifier: MIT
"""Native Blender import/color audit and equal-camera raw mesh comparison.

Run with --background --factory-startup --disable-autoexec --python this file.
Only fixed owned proof GLBs are imported; the source image is never modified.
"""
import json
from pathlib import Path
import time

import bpy
from mathutils import Vector

ROOT = Path(__file__).absolute().parents[1]
OUTPUT = ROOT / "output" / "color-comparison-wide"
OUTPUT.mkdir(exist_ok=False)
CASES = {
    "old-standard": ROOT / "output/native-game-standard/mesh.glb",
    "linear-standard": ROOT / "output/native-game-standard-linear-final/mesh.glb",
    "linear-high": ROOT / "output/native-game-high-linear-final/mesh.glb",
}
report = {"blenderVersion": bpy.app.version_string, "autoExecutionEnabled": bpy.context.preferences.filepaths.use_scripts_auto_execute,
          "camera": {"position": [5, 0, .5], "target": [0, 0, .5], "orthographicScale": 2.5}, "cases": {}}

for name, path in CASES.items():
    start = time.monotonic()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    assert len(meshes) == 1
    obj = meshes[0]
    assert len(obj.data.color_attributes) == 1
    attribute = obj.data.color_attributes[0]
    samples = [tuple(item.color) for item in attribute.data]
    assert len(samples) and max(c[0] for c in samples) > min(c[0] for c in samples)
    report["cases"][name] = {"glbPath": str(path), "vertices": len(obj.data.vertices), "triangles": len(obj.data.polygons),
                             "attributeName": attribute.name, "attributeType": attribute.data_type, "attributeDomain": attribute.domain,
                             "attributeSamples": len(samples), "meanImportedLinearRgb": [sum(c[i] for c in samples)/len(samples) for i in range(3)]}
    material = bpy.data.materials.new("Audited vertex colors")
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    nodes.clear()
    color = nodes.new("ShaderNodeVertexColor")
    color.layer_name = attribute.name
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeEmission")
    links.new(color.outputs["Color"], shader.inputs["Color"])
    links.new(shader.outputs[0], output.inputs["Surface"])
    obj.data.materials.clear()
    obj.data.materials.append(material)

    scene = bpy.context.scene
    camera_data = bpy.data.cameras.new("Same camera")
    camera = bpy.data.objects.new("Same camera", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (5, 0, .5)
    camera.rotation_euler = (Vector((0, 0, .5))-camera.location).to_track_quat("-Z", "Y").to_euler()
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 2.5
    scene.camera = camera
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 16
    scene.render.resolution_x, scene.render.resolution_y = 640, 320
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure, scene.view_settings.gamma = 0, 1
    scene.render.filepath = str(OUTPUT / (name + ".png"))
    bpy.ops.render.render(write_still=True)

    # A second equal-lighting view shows the raw geometric softness separately.
    nodes.remove(shader)
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    shader.inputs["Roughness"].default_value = .7
    links.new(color.outputs["Color"], shader.inputs["Base Color"])
    links.new(shader.outputs[0], output.inputs["Surface"])
    world = bpy.data.worlds.new("Same ambient")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (.15, .15, .15, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = .4
    light_data = bpy.data.lights.new("Same key", "AREA")
    light_data.energy, light_data.shape, light_data.size = 500, "DISK", 5
    light = bpy.data.objects.new("Same key", light_data)
    scene.collection.objects.link(light)
    light.location = (4, -3, 5)
    light.rotation_euler = (Vector((0, 0, .5))-light.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = str(OUTPUT / (name + "-lit.png"))
    bpy.ops.render.render(write_still=True)
    report["cases"][name]["elapsedSeconds"] = round(time.monotonic()-start, 3)

(OUTPUT / "blender-color-proof.json").write_text(json.dumps(report, indent=2) + "\n")
