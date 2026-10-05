# SPDX-License-Identifier: GPL-3.0-or-later
"""Audited, local static-mesh finishing worker. Execute with native Blender.

blender --background --factory-startup --disable-autoexec --threads 2 \
  --python workers/blender-quality/worker.py -- --input INPUT.json \
  --output-dir NEW_OR_EXISTING_EMPTY_DIRECTORY

GPL-3.0-or-later; see LICENSE. Input GLBs/JSON are data, never executable code.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time
import traceback
from datetime import datetime, timezone

# Bounded CPU work even when the caller forgets a library-level thread setting.
os.environ["OMP_NUM_THREADS"] = "2"
os.environ["OPENBLAS_NUM_THREADS"] = "2"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from audit import GLB, artifact, blender_filename, prepare_output, read_parameters, verify_source

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

THREADS = 2
STAGE = "startup"


def emit(kind, **fields):
    print(json.dumps({"type": kind, **fields}, ensure_ascii=True, allow_nan=False), flush=True)


def stage(name, **fields):
    global STAGE
    STAGE = name
    emit("stage", stage=name, **fields)


def select(objects, active=None):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.hide_set(False)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = active or objects[0]


def triangles(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def mesh_inspection(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    coordinates = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
    mesh.vertices.foreach_get("co", coordinates)
    coordinates = coordinates.reshape(-1, 3)
    # Rendering and glTF export use split corner normals. Averaged vertex
    # normals can cancel at sharp/non-manifold vertices and their lazy cache
    # may be stale after transforms; they do not describe exported shading.
    normals = np.empty(len(mesh.corner_normals) * 3, dtype=np.float32)
    mesh.corner_normals.foreach_get("vector", normals)
    normals = normals.reshape(-1, 3)
    if not len(coordinates) or not np.isfinite(coordinates).all():
        raise ValueError("Imported mesh has empty or non-finite geometry")
    minimum, maximum = coordinates.min(axis=0), coordinates.max(axis=0)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    boundary = sum(e.is_boundary for e in bm.edges)
    non_manifold = sum(not e.is_manifold for e in bm.edges)
    loose = sum(not e.link_faces for e in bm.edges)
    bm.free()
    uv = mesh.uv_layers.active
    uv_finite = uv_nonzero = False
    uv_range = None
    uv_area = 0.0
    uv_degenerate = 0
    if uv:
        values = np.empty(len(uv.data) * 2, dtype=np.float32)
        uv.data.foreach_get("uv", values)
        values = values.reshape(-1, 2)
        uv_finite = bool(np.isfinite(values).all())
        uv_range = [values.min(axis=0).tolist(), values.max(axis=0).tolist()]
        for tri in mesh.loop_triangles:
            a, b, c = (values[i] for i in tri.loops)
            area = abs(float((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))) * 0.5
            uv_area += area
            uv_degenerate += area <= 1e-12
        uv_nonzero = uv_area > 1e-8
    return {"vertices": len(mesh.vertices), "triangles": len(mesh.loop_triangles),
            "dimensionsZUp": (maximum - minimum).tolist(),
            "boundsZUp": [minimum.tolist(), maximum.tolist()],
            "uvLayers": [layer.name for layer in mesh.uv_layers],
            "uvFinite": uv_finite, "uvNonzero": uv_nonzero,
            "uvRange": uv_range, "uvTriangleAreaSum": uv_area,
            "degenerateUVTriangles": uv_degenerate,
            "finiteNormals": bool(np.isfinite(normals).all()),
            "normalDomain": "corner",
            "unitNormals": bool(np.all(np.abs(np.linalg.norm(normals, axis=1) - 1) < 0.002)),
            "boundaryEdges": boundary, "nonManifoldEdges": non_manifold,
            "looseEdges": loose, "materialCount": len(mesh.materials),
            "colorAttributes": [a.name for a in mesh.color_attributes]}


def cpu_scene():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.threads_mode = "FIXED"
    scene.render.threads = THREADS
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.bake.margin = 8
    scene.render.bake.use_clear = True
    scene.render.bake.normal_space = "TANGENT"
    scene.render.bake.normal_r = "POS_X"
    scene.render.bake.normal_g = "POS_Y"
    scene.render.bake.normal_b = "POS_Z"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "AgX"
    bpy.context.preferences.filepaths.use_scripts_auto_execute = False
    bpy.context.preferences.filepaths.save_version = 0
    return scene


def import_snapshot(data, output, height, name, neutral_image3d=False):
    # Import exactly the hash-checked bytes, rather than reopening a mutable
    # user original between verification and import. Remove only our snapshot.
    snapshot = output / ".verified-input.glb"
    with snapshot.open("xb") as stream:
        stream.write(data)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    try:
        bpy.ops.import_scene.gltf(filepath=blender_filename(snapshot), import_pack_images=True,
                                  import_shading="NORMALS", merge_vertices=False)
    finally:
        snapshot.unlink()
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes or len(meshes) > 1024:
        raise ValueError("Imported scene does not contain bounded static mesh objects")
    original_triangles = sum(triangles(obj) for obj in meshes)
    # Bake world transforms before dropping imported parent/camera/light nodes.
    for obj in meshes:
        world = obj.matrix_world.copy()
        obj.parent = None
        obj.data = obj.data.copy()
        obj.data.transform(world)
        obj.matrix_world = Matrix.Identity(4)
        obj.data.update()
    for obj in list(bpy.context.scene.objects):
        if obj not in meshes:
            bpy.data.objects.remove(obj, do_unlink=True)
    for obj in meshes:
        obj.animation_data_clear()
        obj.data.animation_data_clear()
        obj.modifiers.clear()
    select(meshes)
    bpy.ops.object.join()
    high = bpy.context.active_object
    high.name = name + " High detail"
    high.data.name = "High-detail original geometry"
    if any(obj.type != "MESH" for obj in bpy.context.scene.objects):
        raise ValueError("Unexpected non-mesh object after static import")
    inspected = mesh_inspection(high)
    minimum, maximum = (Vector(v) for v in inspected["boundsZUp"])
    extent = maximum - minimum
    if extent.z <= 1e-8 or max(extent) / extent.z > 1000 or max(extent) > 1e12:
        raise ValueError("Source has invalid height or extreme aspect ratio")
    scale = height / extent.z
    origin = Vector(((minimum.x + maximum.x) / 2, (minimum.y + maximum.y) / 2, minimum.z))
    high.data.transform(Matrix.Diagonal((scale, scale, scale, 1)) @ Matrix.Translation(-origin))
    high.data.update()
    if triangles(high) != original_triangles:
        raise ValueError("Normalization changed original triangle count")
    if not high.data.materials:
        mat = bpy.data.materials.new("glTF default white (source has no material)")
        mat.use_nodes = True
        mat.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (1, 1, 1, 1)
        high.data.materials.append(mat)
    for index, mat in enumerate(high.data.materials):
        if mat is None:
            fallback = bpy.data.materials.new("glTF default material")
            fallback.use_nodes = True
            fallback.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (1, 1, 1, 1)
            high.data.materials[index] = fallback
    if neutral_image3d:
        for mat in high.data.materials:
            for node in mat.node_tree.nodes if mat.use_nodes else ():
                if node.type == "BSDF_PRINCIPLED":
                    node.inputs["Metallic"].default_value = 0.0
                    node.inputs["Roughness"].default_value = 0.6
    high["assetStudioRole"] = "high-detail"
    high["sourceGeometryPreserved"] = True
    return high, original_triangles


def duplicate(obj, name, role):
    copy = obj.copy()
    copy.data = obj.data.copy()
    copy.name = name
    bpy.context.collection.objects.link(copy)
    copy["assetStudioRole"] = role
    copy["sourceGeometryPreserved"] = False
    return copy


def clean_game_geometry(obj, weld=False):
    """Repair importer seam splits only on the derived mesh, never high detail."""
    before = mesh_inspection(obj)
    epsilon = max(obj.dimensions) * 1e-7
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    if weld:
        bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=epsilon)
    loose_edges = [edge for edge in bm.edges if not edge.link_faces]
    if loose_edges:
        bmesh.ops.delete(bm, geom=loose_edges, context="EDGES")
    loose_vertices = [vertex for vertex in bm.verts if not vertex.link_faces]
    if loose_vertices:
        bmesh.ops.delete(bm, geom=loose_vertices, context="VERTS")
    bm.normal_update()
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    # Preserve sharp shading from geometric discontinuities on the game copy.
    # Stale custom loop normals must not survive a changed topology.
    select([obj])
    if obj.data.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    obj.data.set_sharp_from_angle(angle=math.radians(45))
    after = mesh_inspection(obj)
    if after["looseEdges"]:
        raise ValueError("Derived game mesh still contains loose geometry")
    return {"weld": weld, "weldToleranceMeters": epsilon, "before": before,
            "after": after, "highDetailModified": False,
            "shading": "Recomputed game normals with 45-degree sharp edges; original high-detail normals retained"}


def center_game(obj, height):
    info = mesh_inspection(obj)
    minimum, maximum = (Vector(v) for v in info["boundsZUp"])
    extent = maximum - minimum
    if extent.z <= 1e-8:
        raise ValueError("Decimation removed vertical extent")
    center = Vector(((minimum.x + maximum.x) / 2, (minimum.y + maximum.y) / 2, minimum.z))
    scale = height / extent.z
    obj.data.transform(Matrix.Diagonal((scale, scale, scale, 1)) @ Matrix.Translation(-center))
    obj.data.update()
    return {"translationZUpMeters": list(-center), "uniformScale": scale,
            "purpose": "Exact requested height and bottom-center pivot on derived mesh before bake/export"}


def decimate(obj, budget):
    original = triangles(obj)
    attempts = []
    # Each attempt starts with untouched geometry; no accumulated reductions.
    if original > budget:
        untouched = obj.data.copy()
        ratio = max(0.001, min(0.999, budget / original * 0.98))
        for attempt in range(5):
            if attempt:
                old = obj.data
                obj.data = untouched.copy()
                bpy.data.meshes.remove(old)
            select([obj])
            modifier = obj.modifiers.new("Budgeted collapse (not retopology)", "DECIMATE")
            modifier.decimate_type = "COLLAPSE"
            modifier.ratio = ratio
            modifier.use_collapse_triangulate = True
            bpy.ops.object.modifier_apply(modifier=modifier.name)
            count = triangles(obj)
            attempts.append({"ratio": ratio, "triangles": count})
            if 0 < count <= budget:
                break
            ratio *= budget / max(1, count) * 0.9
        bpy.data.meshes.remove(untouched)
        if not 0 < triangles(obj) <= budget:
            raise ValueError("Cannot satisfy triangle budget with bounded decimation")
    select([obj])
    modifier = obj.modifiers.new("Explicit game triangles", "TRIANGULATE")
    modifier.keep_custom_normals = True
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    return {"method": "Blender Decimate collapse", "originalTriangles": original,
            "budget": budget, "finalTriangles": triangles(obj), "attempts": attempts,
            "retopology": False}


def smart_uv(obj, resolution):
    select([obj])
    # Keep inherited UVs during baking/fallback; original materials still sample
    # them through explicit UVMap nodes. Only the baked atlas UV is exported.
    for layer in obj.data.uv_layers:
        layer.active_render = False
    layer = obj.data.uv_layers.new(name="GameUV")
    obj.data.uv_layers.active = layer
    layer.active_render = True
    bpy.ops.object.mode_set(mode="EDIT")
    try:
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=16 / resolution,
                                 margin_method="SCALED", area_weight=0.5,
                                 correct_aspect=True, scale_to_bounds=True)
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")
    info = mesh_inspection(obj)
    if not info["uvFinite"] or not info["uvNonzero"] or info["degenerateUVTriangles"]:
        raise ValueError("Game atlas UVs contain non-finite or zero-area triangles")
    return info


def source_uv_bind(materials, high):
    # A new low UV layer must never change where source images are sampled.
    # Source material copies receive explicit inherited UV names for fallback.
    copies = []
    original_uv = high.data.uv_layers.active.name if high.data.uv_layers.active else None
    for original in materials:
        mat = original.copy()
        if mat.use_nodes and original_uv:
            tree = mat.node_tree
            for node in list(tree.nodes):
                if node.type == "TEX_IMAGE" and not node.inputs["Vector"].is_linked:
                    uv = tree.nodes.new("ShaderNodeUVMap")
                    uv.uv_map = original_uv
                    tree.links.new(uv.outputs["UV"], node.inputs["Vector"])
        copies.append(mat)
    return copies


def emission_material(original, mode):
    mat = original.copy()
    mat.use_nodes = True
    tree = mat.node_tree
    shader = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    source_emission = next((n for n in tree.nodes if n.type == "EMISSION"), None)
    output = next((n for n in tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
    if output is None:
        raise ValueError("Source material lacks a supported material output")
    emission = tree.nodes.new("ShaderNodeEmission")
    emission.inputs["Strength"].default_value = 1.0
    def transfer(source_socket, target_socket):
        if source_socket.is_linked:
            tree.links.new(source_socket.links[0].from_socket, target_socket)
        else:
            target_socket.default_value = source_socket.default_value
    if mode == "basecolor":
        if shader:
            transfer(shader.inputs["Base Color"], emission.inputs["Color"])
        elif source_emission:
            transfer(source_emission.inputs["Color"], emission.inputs["Color"])
        else:
            raise ValueError("Source color graph is unsupported; refusing a flat replacement")
    elif mode == "orm":
        if not shader:
            emission.inputs["Color"].default_value = (1, 1, 0, 1)
        else:
            combined = tree.nodes.new("ShaderNodeCombineColor")
            combined.mode = "RGB"
            combined.inputs["Red"].default_value = 1.0  # Neutral AO, not inferred AO.
            transfer(shader.inputs["Roughness"], combined.inputs["Green"])
            transfer(shader.inputs["Metallic"], combined.inputs["Blue"])
            tree.links.new(combined.outputs[0], emission.inputs["Color"])
    elif mode == "alpha":
        if shader:
            transfer(shader.inputs["Alpha"], emission.inputs["Color"])
        else:
            emission.inputs["Color"].default_value = (1, 1, 1, 1)
    elif mode == "coverage":
        emission.inputs["Color"].default_value = (1, 1, 1, 1)
    elif mode == "emission":
        if shader:
            transfer(shader.inputs["Emission Color"], emission.inputs["Color"])
            transfer(shader.inputs["Emission Strength"], emission.inputs["Strength"])
        elif source_emission:
            transfer(source_emission.inputs["Color"], emission.inputs["Color"])
            transfer(source_emission.inputs["Strength"], emission.inputs["Strength"])
    tree.links.new(emission.outputs[0], output.inputs["Surface"])
    return mat


def pixels(image):
    data = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(data)
    return data.reshape(-1, 4)


def texture_stats(image, uv_mask=None):
    rgba = pixels(image)
    covered = rgba[:, 3] > 0.5
    if uv_mask is not None:
        covered &= uv_mask
    colors = rgba[covered, :3]
    if not len(colors) or not np.isfinite(rgba).all():
        raise ValueError("Bake produced no covered texture pixels")
    sample = colors[::max(1, len(colors) // 65536)]
    distinct = len(np.unique(np.rint(np.clip(sample, 0, 1) * 255).astype(np.uint8), axis=0))
    interior = rgba[:, 3] > 0.999
    if uv_mask is not None:
        interior &= uv_mask
    return {"resolution": list(image.size), "coveredPixels": int(covered.sum()),
            "coverageFraction": float(covered.mean()), "finite": bool(np.isfinite(rgba).all()),
            "coverageDefinition": "Rasterized UV triangle pixel centers with bake alpha > 0.5" if uv_mask is not None else "Bake alpha > 0.5; includes dilated padding",
            "interiorPixels": int(interior.sum()),
            "paddingPixels": int(((rgba[:, 3] > 0.5) & ~uv_mask).sum()) if uv_mask is not None else None,
            "minimumRGBLinear": colors.min(axis=0).tolist(),
            "maximumRGBLinear": colors.max(axis=0).tolist(),
            "meanRGBLinear": colors.mean(axis=0, dtype=np.float64).tolist(),
            "stddevRGBLinear": colors.std(axis=0, dtype=np.float64).tolist(),
            "sampleDistinctRGB8": distinct, "nonSolid": distinct > 1,
            "sampleCount": len(sample)}


def projection_settings(high, low, height):
    bm = bmesh.new()
    bm.from_mesh(high.data)
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    low.data.calc_loop_triangles()
    samples = list(low.data.loop_triangles)[::max(1, triangles(low) // 4096)]
    distances = []
    for tri in samples:
        center = sum((low.data.vertices[v].co for v in tri.vertices), Vector()) / 3
        nearest = tree.find_nearest(center)
        if nearest[0] is None:
            raise ValueError("High-detail mesh has no projection surface")
        distances.append(nearest[3])
    size = max(high.dimensions)
    extrusion = max(height * 0.003, max(distances, default=0) * 2.0 + height * 0.001)
    too_wide = extrusion > size * 0.1
    extrusion = min(extrusion, size * 0.1)
    hits = 0
    for tri in samples:
        center = sum((low.data.vertices[v].co for v in tri.vertices), Vector()) / 3
        normal = tri.normal.normalized()
        hit = tree.ray_cast(center + normal * extrusion, -normal, extrusion * 4)
        hits += hit[0] is not None
    fraction = hits / max(1, len(samples))
    return {"samples": len(samples), "rayHitFraction": fraction,
            "maxNearestSurfaceDistanceMeters": max(distances, default=0),
            "cageExtrusionMeters": extrusion, "maxRayDistanceMeters": extrusion * 4,
            "robust": fraction >= 0.98 and not too_wide,
            "source": "high-detail mesh ray projection", "statisticalCheck": True}


def uv_pixel_mask(obj, resolution):
    """Independently rasterize UV pixel centers; padding is not surface coverage."""
    mask = np.zeros((resolution, resolution), dtype=np.bool_)
    obj.data.calc_loop_triangles()
    uv = obj.data.uv_layers.active.data
    for tri in obj.data.loop_triangles:
        points = np.asarray([list(uv[i].uv) for i in tri.loops]) * resolution
        lo = np.maximum(0, np.floor(points.min(axis=0)).astype(int))
        hi = np.minimum(resolution, np.ceil(points.max(axis=0)).astype(int))
        if np.any(hi <= lo):
            continue
        x, y = np.meshgrid(np.arange(lo[0], hi[0]) + 0.5, np.arange(lo[1], hi[1]) + 0.5)
        edges = []
        for a, b in zip(points, np.roll(points, -1, axis=0)):
            edges.append((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]))
        inside = (np.logical_and.reduce([v >= -1e-8 for v in edges]) |
                  np.logical_and.reduce([v <= 1e-8 for v in edges]))
        mask[lo[1]:hi[1], lo[0]:hi[0]] |= inside
    core = np.zeros_like(mask)
    core[1:-1, 1:-1] = (mask[1:-1, 1:-1] & mask[:-2, 1:-1] & mask[2:, 1:-1] &
                        mask[1:-1, :-2] & mask[1:-1, 2:])
    return mask.ravel(), core.ravel()


def bake_image(high, low, mode, resolution, projection, source_materials, fallback_materials):
    scene = bpy.context.scene
    image = bpy.data.images.new("Mesh-derived normal" if mode == "normal" else "Baked " + mode,
                                width=resolution, height=resolution, alpha=True, float_buffer=True)
    image.colorspace_settings.name = "sRGB" if mode in {"basecolor", "emission"} else "Non-Color"
    image.generated_color = (0, 0, 0, 0)
    target = bpy.data.materials.new("Atlas bake target")
    target.use_nodes = True
    node = target.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = image
    target.node_tree.nodes.active = node
    high_indices = [p.material_index for p in high.data.polygons]
    old_indices = [p.material_index for p in low.data.polygons]
    high.data.materials.clear()
    low.data.materials.clear()
    robust = projection["robust"]
    temporary = []
    try:
        if mode == "normal":
            for mat in source_materials:
                high.data.materials.append(mat)
        else:
            temporary = [emission_material(mat, mode) for mat in (source_materials if robust else fallback_materials)]
            if robust:
                for mat in temporary:
                    high.data.materials.append(mat)
        for poly, index in zip(high.data.polygons, high_indices):
            poly.material_index = index
        if robust:
            low.data.materials.append(target)
            for poly in low.data.polygons:
                poly.material_index = 0
            high.hide_render = False
            select([high, low], active=low)
            scene.render.bake.use_selected_to_active = True
            scene.render.bake.cage_extrusion = projection["cageExtrusionMeters"]
            scene.render.bake.max_ray_distance = projection["maxRayDistanceMeters"]
        else:
            if mode == "normal":
                raise ValueError("Normal bake requires robust high-detail projection")
            for mat in temporary:
                low.data.materials.append(mat)
                tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
                tex.image = image
                mat.node_tree.nodes.active = tex
            for poly, index in zip(low.data.polygons, old_indices):
                poly.material_index = index
            high.hide_render = True
            select([low])
            scene.render.bake.use_selected_to_active = False
        scene.cycles.samples = 1
        bpy.ops.object.bake(type="NORMAL" if mode == "normal" else "EMIT", margin=8)
        image.update()
        texture_stats(image)  # Empty/non-finite output is never promoted.
        return image
    finally:
        high.data.materials.clear()
        for mat in source_materials:
            high.data.materials.append(mat)
        for poly, index in zip(high.data.polygons, high_indices):
            poly.material_index = index
        low.data.materials.clear()
        for mat in fallback_materials:
            low.data.materials.append(mat)
        for poly, index in zip(low.data.polygons, old_indices):
            poly.material_index = index
        for mat in temporary + [target]:
            if mat.users == 0:
                bpy.data.materials.remove(mat)
        high.hide_render = True
        scene.cycles.samples = 24


def save_png(image, output, basename):
    temporary = output / (Path(basename).stem + ".partial.png")
    image.filepath_raw = blender_filename(temporary)
    image.file_format = "PNG"
    image.save()
    # Exclusive final promotion never overwrites an existing user file.
    promote(temporary, output / basename)
    image.filepath_raw = blender_filename(output / basename)
    # Inspect/use the independently decoded PNG pixels, not Cycles' temporary
    # float bake buffer (which has a different sRGB representation in Blender).
    saved = bpy.data.images.load(blender_filename(output / basename), check_existing=False)
    saved.colorspace_settings.name = image.colorspace_settings.name
    saved.name = image.name + " PNG"
    saved.pack()
    saved.filepath = "//" + basename
    if image.users == 0:
        bpy.data.images.remove(image)
    return saved


def apply_coverage(image, coverage, unpremultiply=False):
    rgba = pixels(image)
    # Cycles emission bake anti-aliases RGB against black outside a UV island.
    # Unpremultiply by the independent white coverage bake, rather than putting
    # black RGB borders on an otherwise opaque source material.
    if unpremultiply:
        nonzero = coverage > 1e-6
        rgba[nonzero, :3] /= coverage[nonzero, None]
    rgba[:, 3] *= coverage
    image.pixels.foreach_set(rgba.ravel())
    image.update()


def promote(temporary, final):
    os.link(temporary, final)
    temporary.unlink()


def game_material(base, normal, orm, emission, emission_strength, transparent, double_sided, neutral_roughness=0.55):
    mat = bpy.data.materials.new("Baked source PBR atlas")
    mat.use_nodes = True
    mat.use_backface_culling = not double_sided
    tree = mat.node_tree
    shader = tree.nodes.get("Principled BSDF")
    uv = tree.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "GameUV"
    def texture(image, label):
        node = tree.nodes.new("ShaderNodeTexImage")
        node.name = label
        node.label = label
        node.image = image
        tree.links.new(uv.outputs["UV"], node.inputs["Vector"])
        return node
    tex = texture(base, "Source base color (baked, not invented)")
    tree.links.new(tex.outputs["Color"], shader.inputs["Base Color"])
    if transparent:
        tree.links.new(tex.outputs["Alpha"], shader.inputs["Alpha"])
        mat.surface_render_method = "DITHERED"
    if normal:
        tex = texture(normal, "Mesh-derived normal (high detail to game)")
        node = tree.nodes.new("ShaderNodeNormalMap")
        node.space = "TANGENT"
        node.uv_map = "GameUV"
        tree.links.new(tex.outputs["Color"], node.inputs["Color"])
        tree.links.new(node.outputs["Normal"], shader.inputs["Normal"])
    if orm:
        tex = texture(orm, "Source roughness/metallic; R is neutral AO")
        node = tree.nodes.new("ShaderNodeSeparateColor")
        node.mode = "RGB"
        tree.links.new(tex.outputs["Color"], node.inputs["Color"])
        tree.links.new(node.outputs["Green"], shader.inputs["Roughness"])
        tree.links.new(node.outputs["Blue"], shader.inputs["Metallic"])
    else:
        shader.inputs["Roughness"].default_value = neutral_roughness
        shader.inputs["Metallic"].default_value = 0.0
    if emission:
        tex = texture(emission, "Source emission")
        tree.links.new(tex.outputs["Color"], shader.inputs["Emission Color"])
        shader.inputs["Emission Strength"].default_value = emission_strength
    return mat


def remove_source_attributes(low):
    for layer in list(low.data.uv_layers):
        if layer.name != "GameUV":
            low.data.uv_layers.remove(layer)
    low.data.uv_layers.active = low.data.uv_layers["GameUV"]
    low.data.uv_layers.active.active_render = True
    # Colors are already in the texture. Exporting COLOR_0 would multiply twice.
    for attribute in list(low.data.color_attributes):
        low.data.color_attributes.remove(attribute)


def export_glb(obj, output, basename):
    select([obj])
    temporary = output / (Path(basename).stem + ".partial.glb")
    bpy.ops.export_scene.gltf(filepath=blender_filename(temporary), export_format="GLB", use_selection=True,
                              export_yup=True, export_normals=True, export_texcoords=True,
                              export_tangents=True, export_materials="EXPORT",
                              export_extras=False, export_animations=False,
                              export_cameras=False, export_lights=False)
    inspected = GLB(temporary.read_bytes(), maximum=128 * 1024 * 1024)
    if any(n.get("camera") is not None or n.get("extensions", {}).get("KHR_lights_punctual") for n in inspected.doc.get("nodes", [])):
        raise ValueError("Asset GLB unexpectedly includes studio camera/lights")
    if inspected.scene_triangles != triangles(obj):
        raise ValueError("Export changed measured triangle count")
    promote(temporary, output / basename)
    return inspected


def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def studio(game, high, lod, height):
    high.hide_render = True
    high.hide_set(True)
    lod.hide_render = True
    lod.hide_set(True)
    game.hide_render = False
    game.hide_set(False)
    scene = bpy.context.scene
    size = max(game.dimensions)
    center = (0, 0, height / 2)
    scene.world = bpy.data.worlds.new("Quality worker studio")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.16, 0.19, 0.24, 1)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.45
    bpy.ops.mesh.primitive_plane_add(size=size * 200, location=(0, 0, -height * 0.006))
    floor = bpy.context.object
    floor.name = "Studio floor (never exported)"
    floor["assetStudioRole"] = "studio"
    material = bpy.data.materials.new("Studio floor")
    material.use_nodes = True
    material.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.045, 0.055, 0.07, 1)
    material.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.8
    floor.data.materials.append(material)
    bpy.ops.object.camera_add(location=(size * 2.1, -size * 2.7, height / 2 + size * 1.5))
    camera = bpy.context.object
    camera.name = "Quality preview camera"
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = size * 1.6
    camera.data.clip_start = max(0.00001, size / 10000)
    camera.data.clip_end = size * 300
    aim(camera, center)
    scene.camera = camera
    for name, location, energy in (("Key", (2, -3, 4), 850), ("Fill", (-3, -1, 2), 500), ("Rim", (1, 3, 3), 750)):
        bpy.ops.object.light_add(type="AREA", location=tuple(size * v for v in location))
        light = bpy.context.object
        light.name = "Quality " + name
        light.data.energy = energy * size * size
        light.data.shape = "DISK"
        light.data.size = size * 2.5
        aim(light, center)
    return camera


def render_previews(output, camera, height, size):
    scene = bpy.context.scene
    def render(name, resolution):
        scene.render.resolution_x = scene.render.resolution_y = resolution
        temporary = output / (Path(name).stem + ".partial.png")
        scene.render.filepath = blender_filename(temporary)
        bpy.ops.render.render(write_still=True)
        promote(temporary, output / name)
    render("thumbnail.png", 1024)
    saved = camera.location.copy()
    for index in range(4):
        stage("render-turntable", index=index, views=4)
        angle = math.radians(-45 + index * 90)
        camera.location = (math.cos(angle) * size * 3.2, math.sin(angle) * size * 3.2, height / 2 + size * 1.5)
        aim(camera, (0, 0, height / 2))
        render(f"turntable-{index:02d}.png", 512)
    camera.location = saved
    aim(camera, (0, 0, height / 2))
    scene.render.resolution_x = scene.render.resolution_y = 1024
    scene.render.filepath = "//thumbnail.png"
    # Actual editable scene animation, four documented viewpoints.
    scene.frame_end = 4
    for index in range(4):
        angle = math.radians(-45 + index * 90)
        camera.location = (math.cos(angle) * size * 3.2, math.sin(angle) * size * 3.2, height / 2 + size * 1.5)
        aim(camera, (0, 0, height / 2))
        camera.keyframe_insert(data_path="location", frame=index + 1)
        camera.keyframe_insert(data_path="rotation_euler", frame=index + 1)
    scene.frame_set(1)


def write_json(path, value):
    temporary = path.with_suffix(".partial.json")
    with temporary.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=True, allow_nan=False)
        stream.write("\n")
    promote(temporary, path)


def execute(input_path, output_dir):
    started = time.monotonic()
    stage("validate-input")
    if not bpy.app.background or "--disable-autoexec" not in sys.argv or "--factory-startup" not in sys.argv:
        raise ValueError("Worker requires --background --factory-startup --disable-autoexec")
    job = read_parameters(input_path)
    stage("verify-source-hash")
    data, source = verify_source(job)
    output = prepare_output(output_dir)
    # Fail before expensive work if Blender cannot address the longest fixed
    # output filename. Python keeps the canonical path throughout the job.
    blender_filename(output / "game-ready.model.partial.glb")
    lock = output / ".quality-worker.lock"
    with lock.open("x") as stream:
        stream.write(str(os.getpid()))
    scene = cpu_scene()
    warnings = []
    neutral_image3d = (job["sourceKind"] == "image3d" and "COLOR_0" in source.attributes
                       and not source.doc.get("materials") and not source.images)
    if neutral_image3d:
        warnings.append("Neural vertex-color source has no authored PBR material. Neutral display defaults metallic=0 and roughness=0.6 apply to high/game meshes; vertex colors retain standard glTF linear interpretation. These PBR defaults are not inferred from the image.")
    stage("import-high-detail")
    high, original_triangles = import_snapshot(data, output, job["heightMeters"], job["name"], neutral_image3d)
    if original_triangles != source.scene_triangles:
        raise ValueError("Imported triangle count differs from preflight")
    del data
    high_info = mesh_inspection(high)
    stage("export-high-detail")
    high_glb = export_glb(high, output, "high-detail.glb")
    stage("decimate-game-mesh", originalTriangles=original_triangles, budget=job["maxTriangles"])
    game = duplicate(high, job["name"] + " Game ready", "game")
    seam_repair = clean_game_geometry(game, weld=True)
    reduction = decimate(game, job["maxTriangles"])
    game_cleanup = clean_game_geometry(game)
    game_centering = center_game(game, job["heightMeters"])
    stage("unwrap-game-uv")
    smart_uv(game, job["textureResolution"])
    source_materials = list(high.data.materials)
    fallback_materials = source_uv_bind(source_materials, high)
    projection = projection_settings(high, game, job["heightMeters"])
    if not projection["robust"]:
        warnings.append("High-detail projection did not pass the sampled ray check; base/PBR bake uses interpolated source attributes on the decimated mesh. Normal map omitted.")
    transparent = any(m.get("alphaMode", "OPAQUE") != "OPAQUE" or m.get("pbrMetallicRoughness", {}).get("baseColorFactor", [1, 1, 1, 1])[3] < 1 for m in source.doc.get("materials", []))
    emissive = any(any(m.get("emissiveFactor", [0, 0, 0])) or "emissiveTexture" in m for m in source.doc.get("materials", []))
    stage("bake-basecolor", source="imported material/vertex color graph", projection=projection)
    uv_mask, uv_core = uv_pixel_mask(game, job["textureResolution"])
    mask = bake_image(high, game, "coverage", job["textureResolution"], projection, source_materials, fallback_materials)
    coverage = np.clip(pixels(mask)[:, 0], 0, 1)
    bpy.data.images.remove(mask)
    projection["uvSurfaceTexels"] = int(uv_mask.sum())
    projection["uvInteriorTexels"] = int(uv_core.sum())
    projection["bakedUVHitFraction"] = float((coverage[uv_core] > 0.95).mean()) if uv_core.any() else 0.0
    if projection["robust"] and projection["bakedUVHitFraction"] < 0.98:
        projection["robust"] = False
        warnings.append("High-detail bake missed interior UV texels; rebaking from interpolated source attributes and omitting the normal map.")
        mask = bake_image(high, game, "coverage", job["textureResolution"], projection, source_materials, fallback_materials)
        coverage = np.clip(pixels(mask)[:, 0], 0, 1)
        bpy.data.images.remove(mask)
    base = bake_image(high, game, "basecolor", job["textureResolution"], projection, source_materials, fallback_materials)
    apply_coverage(base, coverage)
    if transparent:
        stage("bake-source-alpha")
        alpha = bake_image(high, game, "alpha", job["textureResolution"], projection, source_materials, fallback_materials)
        rgba = pixels(base)
        rgba[:, 3] *= np.clip(pixels(alpha)[:, 0], 0, 1)
        base.pixels.foreach_set(rgba.ravel())
        base.update()
        bpy.data.images.remove(alpha)
    base = save_png(base, output, "basecolor.png")
    base_stats = texture_stats(base, uv_mask)
    if not base_stats["nonSolid"]:
        warnings.append("Source color bake is uniform within RGB8 sampling; no invented texture detail was added.")
    orm = emission = normal = None
    orm_stats = emission_stats = normal_stats = None
    emission_strength = 1.0
    if job["preserveMaterials"]:
        stage("bake-source-pbr")
        orm = bake_image(high, game, "orm", job["textureResolution"], projection, source_materials, fallback_materials)
        apply_coverage(orm, coverage)
        orm_pixels = pixels(orm)
        orm_pixels[:, 0] = 1.0  # Neutral AO everywhere, including padding.
        orm_pixels[:, 1:3] = np.clip(orm_pixels[:, 1:3], 0, 1)
        # Uniform source PBR factors are exact data, not inferred PBR. Keep
        # their known values in the padding too, rather than dark bake borders.
        for channel, key, default in ((1, "roughnessFactor", 1.0), (2, "metallicFactor", 1.0)):
            materials = source.doc.get("materials", [])
            if materials and all("metallicRoughnessTexture" not in m.get("pbrMetallicRoughness", {}) for m in materials):
                values = [m.get("pbrMetallicRoughness", {}).get(key, default) for m in materials]
                if max(values) - min(values) < 1e-7:
                    orm_pixels[:, channel] = values[0]
        if neutral_image3d:
            orm_pixels[:, 1] = 0.6
            orm_pixels[:, 2] = 0.0
        orm.pixels.foreach_set(orm_pixels.ravel())
        orm.update()
        orm = save_png(orm, output, "orm.png")
        orm_stats = texture_stats(orm, uv_mask)
        if emissive:
            stage("bake-source-emission")
            emission = bake_image(high, game, "emission", job["textureResolution"], projection, source_materials, fallback_materials)
            apply_coverage(emission, coverage)
            rgba = pixels(emission)
            emission_strength = max(1.0, float(rgba[:, :3].max()))
            rgba[:, :3] /= emission_strength
            emission.pixels.foreach_set(rgba.ravel())
            emission.update()
            emission = save_png(emission, output, "emission.png")
            emission_stats = texture_stats(emission, uv_mask)
    else:
        warnings.append("Game roughness/metallic use neutral constants because preserveMaterials is false; source colors and high-detail source materials are retained.")
    normal_reason = "No geometry reduction or source normal texture"
    source_normal = any("normalTexture" in m for m in source.doc.get("materials", []))
    if projection["robust"] and (triangles(game) < original_triangles or source_normal):
        stage("bake-mesh-derived-normal")
        candidate = bake_image(high, game, "normal", job["textureResolution"], projection, source_materials, fallback_materials)
        apply_coverage(candidate, coverage)
        rgba = pixels(candidate)
        # Reject strongly opposed projection normals instead of baking dark
        # creases into an otherwise smooth low face. A >60-degree high/low
        # discrepancy is not a reliable detail transfer with this ray cage.
        opposed = (rgba[:, 2] < 0.75) & (rgba[:, 3] > 0.5)
        rejected_fraction = float(opposed[uv_core].mean()) if uv_core.any() else 1.0
        rejected_count = int((opposed & uv_mask).sum())
        if rejected_count and rejected_fraction < 0.02:
            shape = opposed.reshape(job["textureResolution"], job["textureResolution"])
            expanded = shape.copy()
            expanded[1:, :] |= shape[:-1, :]
            expanded[:-1, :] |= shape[1:, :]
            expanded[:, 1:] |= shape[:, :-1]
            expanded[:, :-1] |= shape[:, 1:]
            rgba[expanded.ravel(), :3] = (0.5, 0.5, 1.0)
            candidate.pixels.foreach_set(rgba.ravel())
            candidate.update()
            warnings.append("Strongly opposed high/low normal projections were omitted locally; those texels retain the game mesh normal. No color-derived normal detail was synthesized.")
        normal_stats = texture_stats(candidate, uv_mask)
        rgba = pixels(candidate)
        covered = rgba[uv_core & (rgba[:, 3] > 0.95), :3]
        if not len(covered):
            covered = rgba[uv_mask & (rgba[:, 3] > 0.5), :3]
        variation = float(np.std(covered[:, :2], axis=0).max())
        deviation = float(np.linalg.norm(covered[:, :2] - 0.5, axis=1).mean())
        invalid = float(np.mean(covered[:, 2] < 0.1))
        normal_stats.update({"label": "mesh-derived normal", "source": "high-detail mesh to low tangent space (plus any existing source normal material)",
                             "xyVariation": variation, "meanDeviationFromFlat": deviation,
                             "invertedOrMissedFraction": invalid,
                             "opposedProjectionTexels": rejected_count,
                             "opposedInteriorFraction": rejected_fraction,
                             "opposedNormalPolicy": "Projections more than 60 degrees from low tangent +Z omitted; at least 98 percent of interior texels must survive"})
        if variation > 0.003 and deviation > 0.005 and invalid < 0.02 and rejected_fraction < 0.02:
            normal = candidate
            normal_reason = "Meaningful high-detail to game tangent-space bake passed sampled checks"
            normal = save_png(normal, output, "normal.png")
        else:
            normal_reason = "Baked normal was flat or failed quality checks; omitted"
            bpy.data.images.remove(candidate)
            warnings.append(normal_reason)
    elif not projection["robust"]:
        normal_reason = "High-detail ray projection failed robustness threshold"
    mat = game_material(base, normal, orm, emission, emission_strength, transparent,
                        any(not m.use_backface_culling for m in source_materials), 0.6 if neutral_image3d else 0.55)
    game.data.materials.clear()
    game.data.materials.append(mat)
    for poly in game.data.polygons:
        poly.material_index = 0
    remove_source_attributes(game)
    game_info = mesh_inspection(game)
    stage("build-lod1")
    lod = duplicate(game, job["name"] + " LOD1", "lod1")
    lod_budget = max(1, min(job["maxTriangles"] // 2, triangles(game) // 2))
    lod_reduction = decimate(lod, lod_budget)
    lod_cleanup = clean_game_geometry(lod)
    lod_centering = center_game(lod, job["heightMeters"])
    lod_info = mesh_inspection(lod)
    if lod_info["triangles"] >= game_info["triangles"]:
        raise ValueError("LOD1 must have fewer triangles than game mesh")
    warnings.append("LOD1 inherits the game atlas and its interpolated UVs; it has no separate high-detail normal rebake.")
    warnings.append("Collapse decimation is not retopology. Watertight volume, CAD/manufacturing suitability, rigging and unseen image geometry are not certified.")
    if source.doc.get("extensionsUsed"):
        warnings.append("Optional source glTF extensions are recorded; the game shader bakes core color, alpha, roughness, metallic, emission and geometry normals only.")
    if high_info["nonManifoldEdges"]:
        warnings.append("Source contains boundary/non-manifold edges; original high-detail geometry is retained without topology repair.")
    stage("export-game-and-lod")
    game_glb = export_glb(game, output, "game-ready.model.glb")
    lod_glb = export_glb(lod, output, "lod1.glb")
    for glb in (game_glb, lod_glb):
        if not {"NORMAL", "TEXCOORD_0"} <= glb.attributes or not glb.images:
            raise ValueError("Game/LOD GLB is missing real embedded textures, UVs or normals")
        for material in glb.doc.get("materials", []):
            pbr = material.get("pbrMetallicRoughness", {})
            if "baseColorTexture" not in pbr:
                raise ValueError("Game/LOD material is missing embedded PBR base color")
        if normal and not all("normalTexture" in m for m in glb.doc.get("materials", [])):
            raise ValueError("Meaningful normal texture was not embedded in GLB")
        for basename, key in (("basecolor.png", "baseColorTexture"), ("normal.png", "normalTexture"),
                              ("orm.png", "metallicRoughnessTexture"), ("emission.png", "emissiveTexture")):
            path = output / basename
            if not path.exists():
                continue
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            for material in glb.doc.get("materials", []):
                texture = (material.get("pbrMetallicRoughness", {}).get(key)
                           if key in {"baseColorTexture", "metallicRoughnessTexture"} else material.get(key))
                if not texture or glb.images[glb.doc["textures"][texture["index"]]["source"]]["sha256"] != digest:
                    raise ValueError("Standalone texture bytes do not match embedded material image")
    stage("render-thumbnail")
    camera = studio(game, high, lod, job["heightMeters"])
    render_previews(output, camera, job["heightMeters"], max(game.dimensions))
    stage("save-editable-source")
    # GLB extras do not run scripts. Remove text blocks and any drivers anyway,
    # so the editable source has no runnable embedded script payload.
    for text in list(bpy.data.texts):
        bpy.data.texts.remove(text)
    for collection in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.node_groups, bpy.data.scenes):
        for block in collection:
            animation = getattr(block, "animation_data", None)
            if animation:
                for driver in list(animation.drivers):
                    animation.drivers.remove(driver)
    for image in bpy.data.images:
        if image.source == "FILE" and image.has_data and not image.packed_file:
            image.pack()
    select([game])
    high.hide_set(True)
    lod.hide_set(True)
    temporary = output / "source.partial.blend"
    bpy.ops.wm.save_as_mainfile(filepath=blender_filename(temporary), compress=True, check_existing=False)
    promote(temporary, output / "source.blend")
    # Prove the user original was never modified during finishing.
    _, after = verify_source(job)
    if after.sha256 != source.sha256:
        raise ValueError("Original source hash changed during processing")
    dimensions = game_info["dimensionsZUp"]
    mesh = {"vertices": game_glb.vertices, "triangles": game_glb.scene_triangles,
            "dimensions": [dimensions[0], dimensions[2], dimensions[1]],
            "unit": "m", "axis": "Y-up", "pivot": "bottom-center"}
    checks = [
        {"code": "source-hash-preserved", "status": "pass", "measured": source.sha256},
        {"code": "bounded-self-contained-glb", "status": "pass", "measured": source.bytes},
        {"code": "high-detail-geometry-preserved", "status": "pass", "measured": high_glb.scene_triangles},
        {"code": "game-triangle-budget", "status": "pass", "measured": game_glb.scene_triangles, "limit": job["maxTriangles"]},
        {"code": "lod1-lower-budget", "status": "pass", "measured": lod_glb.scene_triangles, "limit": lod_budget},
        {"code": "normalized-height-meters", "status": "pass" if abs(high_info["dimensionsZUp"][2] - job["heightMeters"]) <= job["heightMeters"] * 1e-5 else "fail",
         "measured": high_info["dimensionsZUp"][2], "requested": job["heightMeters"]},
        {"code": "game-height-meters", "status": "pass" if abs(dimensions[2] - job["heightMeters"]) <= job["heightMeters"] * 0.02 else "fail",
         "measured": dimensions[2], "requested": job["heightMeters"], "relativeTolerance": 0.02},
        {"code": "game-uv-finite-area", "status": "pass" if game_info["uvFinite"] and game_info["uvNonzero"] and not game_info["degenerateUVTriangles"] else "fail"},
        {"code": "lod-uv-finite-area", "status": "pass" if lod_info["uvFinite"] and lod_info["uvNonzero"] and not lod_info["degenerateUVTriangles"] else "fail"},
        {"code": "normals-finite-unit", "status": "pass" if game_info["finiteNormals"] and game_info["unitNormals"] and lod_info["finiteNormals"] and lod_info["unitNormals"] else "fail"},
        {"code": "game-loose-geometry", "status": "pass" if game_info["looseEdges"] == 0 else "fail",
         "message": "Derived game mesh has no loose wire geometry", "measured": game_info["looseEdges"]},
        {"code": "lod-loose-geometry", "status": "pass" if lod_info["looseEdges"] == 0 else "fail",
         "message": "Derived LOD mesh has no loose wire geometry", "measured": lod_info["looseEdges"]},
        {"code": "bottom-center-pivots", "status": "pass" if all(
            abs(info["boundsZUp"][0][2]) < job["heightMeters"] * 1e-5 and all(
                abs(info["boundsZUp"][0][axis] + info["boundsZUp"][1][axis]) < job["heightMeters"] * 1e-5 for axis in (0, 1))
            for info in (high_info, game_info, lod_info)) else "fail",
         "message": "High/game/LOD measured bounds have bottom-center pivots in meter units"},
        {"code": "standalone-embedded-textures", "status": "pass",
         "message": "All standalone texture PNG bytes exactly match their material image in both game and LOD GLBs"},
        {"code": "source-color-uv-bake", "status": "pass", "measured": base_stats["sampleDistinctRGB8"]},
        {"code": "embedded-pbr-basecolor", "status": "pass", "measured": len(game_glb.images)},
        {"code": "normal-map", "status": "pass" if normal else "warn", "message": normal_reason},
        {"code": "cpu-cycles-threads", "status": "pass", "measured": THREADS},
        {"code": "independent-native-reopen", "status": "warn", "message": "Run verify_native.py in a fresh Blender process; binary inspection above is not an independent reopen."},
    ]
    messages = {
        "source-hash-preserved": "Source hash matches before import and after finishing; original never written",
        "bounded-self-contained-glb": "Preflight accepts bounded GLB 2.0 with embedded bufferView images and no URI/required extensions",
        "high-detail-geometry-preserved": "Normalized high-detail export has the original triangle count",
        "game-triangle-budget": "Actual exported game triangles fit the requested budget",
        "lod1-lower-budget": "Actual LOD1 triangles are fewer than game triangles and fit half its budget",
        "normalized-height-meters": "Original high-detail height normalized to the requested meters",
        "game-height-meters": "Game height stays within two percent after collapse decimation",
        "game-uv-finite-area": "Smart-projected game UVs are finite with nonzero triangle area",
        "lod-uv-finite-area": "Inherited LOD UVs are finite with nonzero triangle area",
        "normals-finite-unit": "Game and LOD mesh normals are finite unit vectors",
        "source-color-uv-bake": "Source material and vertex colors are baked into a real UV texture; measured sampled RGB8 colors",
        "embedded-pbr-basecolor": "Game GLB contains embedded images referenced by its PBR base-color material",
        "cpu-cycles-threads": "Cycles baking and rendering use the CPU with two fixed threads",
    }
    for check in checks:
        check.setdefault("message", messages.get(check["code"], check["code"]))
    valid = not any(check["status"] == "fail" for check in checks)
    report = {"schemaVersion": 1, "valid": valid, "checks": checks, "warnings": warnings,
              "createdAt": datetime.now(timezone.utc).isoformat(), "blenderVersion": bpy.app.version_string,
              "parameters": job, "source": source.inspection(), "originalSourcePreserved": True,
              "mesh": mesh, "triangleCounts": {"original": original_triangles, "highDetail": high_glb.scene_triangles,
                                                  "game": game_glb.scene_triangles, "lod1": lod_glb.scene_triangles},
              "highDetail": high_info, "game": game_info, "lod1": lod_info,
              "gameReduction": reduction, "lod1Reduction": lod_reduction,
              "gameSeamWeld": seam_repair, "gameCleanup": game_cleanup, "lod1Cleanup": lod_cleanup,
              "gameCentering": game_centering, "lod1Centering": lod_centering,
              "textures": {"basecolor": base_stats, "orm": orm_stats, "emission": emission_stats,
                           "normal": {"included": normal is not None, "reason": normal_reason, "stats": normal_stats}},
              "bakeProjection": projection, "materialPreservation": {"highDetail": "original imported colors with explicitly recorded neutral neural display defaults" if neutral_image3d else "original imported material graphs/colors/textures",
                  "game": "source color/alpha and mesh normals; core roughness/metallic/emission baked" if job["preserveMaterials"] else "source color/alpha with neutral roughness/metallic",
                  "ambientOcclusion": "not baked/inferred; ORM R=1", "unseenDetailInvented": False},
              "neuralMaterialDefaults": {"applied": neutral_image3d,
                  "eligibility": "sourceKind=image3d, COLOR_0, no glTF material and no embedded images",
                  "metallic": 0.0 if neutral_image3d else None, "roughness": 0.6 if neutral_image3d else None,
                  "vertexColorInterpretation": "standard glTF linear; no sRGB reinterpretation"},
              "gltfInspection": {"highDetail": high_glb.inspection(), "game": game_glb.inspection(), "lod1": lod_glb.inspection()},
              "renderer": {"engine": "CYCLES", "device": "CPU", "threads": THREADS, "samples": 24,
                           "thumbnailResolution": [1024, 1024], "turntableResolution": [512, 512], "turntableViews": 4},
              "elapsedSeconds": round(time.monotonic() - started, 3)}
    write_json(output / "validation.json", report)
    lock.unlink()
    if not valid:
        raise ValueError("Finished artifact validation failed; see validation.json")
    names = [("high-detail.glb", "high-detail"), ("game-ready.model.glb", "output"), ("lod1.glb", "lod"),
             ("source.blend", "source"), ("basecolor.png", "texture"), ("thumbnail.png", "thumbnail"), ("validation.json", "metadata")]
    for basename in ("normal.png", "orm.png", "emission.png"):
        if (output / basename).exists():
            names.append((basename, "texture"))
    names.extend((f"turntable-{i:02d}.png", "thumbnail") for i in range(4))
    files = [artifact(output / name, role) for name, role in names]
    for file in files:
        emit("artifact", **file)
    emit("completed", artifacts=files, mesh=mesh, validation=report)


def main():
    parser = argparse.ArgumentParser(description="Data-only Blender mesh-quality finishing worker")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    try:
        execute(args.input, args.output_dir)
    except Exception as exc:
        # Do not print input JSON, credentials, or arbitrary exception paths.
        message = str(exc) if isinstance(exc, ValueError) else "Native finishing operation failed; inspect the local Blender log"
        emit("failed", stage=STAGE, error=message, errorType=type(exc).__name__)
        # Detailed native operator diagnostics stay in the local Blender log.
        traceback.print_exc(file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
