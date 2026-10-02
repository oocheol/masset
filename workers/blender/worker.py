# SPDX-License-Identifier: GPL-3.0-or-later
"""Bounded, data-only procedural model worker. Run inside Blender, never CPython.

blender --background --factory-startup --disable-autoexec --threads 2 \
  --python workers/blender/worker.py -- --input job.json --output-dir fresh-directory
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import sys
import time
from datetime import datetime, timezone

import bpy
import bmesh
from mathutils import Vector


TRIANGLE_BUDGET = 10_000
INPUT_BYTES = 16_384
KEYS = {"template", "name", "width", "depth", "height", "color", "bevel"}
STYLE_KEYS = {"id", "name", "palette", "lineWeight", "camera", "lighting", "detail", "margin", "referenceAssetIds", "approved"}
CAMERA_ALIASES = {
    "orthographic 3/4": "orthographic 3/4", "orthographic three-quarter": "orthographic 3/4", "직교 3/4": "orthographic 3/4",
    "orthographic front": "orthographic front", "직교 정면": "orthographic front",
    "orthographic top": "orthographic top", "직교 상단": "orthographic top",
}
LIGHTING_ALIASES = {"soft studio": "soft studio", "studio soft": "soft studio", "스튜디오 소프트": "soft studio"}


def emit(kind: str, **fields) -> None:
    print(json.dumps({"type": kind, **fields}, ensure_ascii=True, allow_nan=False), flush=True)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON field")
        result[key] = value
    return result


def blender_interop_path(path: Path | None) -> Path | None:
    r"""Preserve canonical targets with long-path-capable filesystem syntax.

    Rust's Windows canonicalize returns \\?\ drive paths even when short. The
    glTF exporter appends '/' to its directory, which is invalid in the verbatim
    namespace. Keep the prefix for Python I/O, and give Blender ordinary paths
    or verified short aliases to the same fresh directory. Do not remap targets.
    """
    if path is None:
        return None
    if os.name != "nt":
        return Path(os.path.abspath(path))
    raw = os.fspath(path).replace("/", "\\")
    verbatim = raw.startswith("\\\\?\\")
    if raw.startswith("\\\\.\\"):
        raise ValueError("Windows device namespace paths are unsupported")
    if verbatim:
        tail = raw[4:]
        if tail.upper().startswith("UNC\\"):
            raw = "\\\\" + tail[4:]
        elif re.match(r"^[A-Za-z]:\\", tail):
            raw = tail
        else:
            raise ValueError("Unsupported Windows verbatim path namespace")
        # Stripping a verbatim prefix must not change a filesystem name by
        # allowing Win32 to trim a trailing space/dot, or interpret dot traversal.
        parts = Path(raw).parts[1:]
        if any(part in {".", ".."} or part.rstrip(" .") != part for part in parts):
            raise ValueError("Ambiguous verbatim path components are unsupported")
        reserved = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}
        if any(part.split(".", 1)[0].upper() in reserved for part in parts):
            raise ValueError("Windows reserved device filenames are unsupported")
    raw = os.path.abspath(raw)
    if raw.startswith("\\\\"):
        return Path("\\\\?\\UNC\\" + raw[2:])
    if re.match(r"^[A-Za-z]:\\", raw):
        return Path("\\\\?\\" + raw)
    raise ValueError("Expected an absolute Windows filesystem path")


def blender_working_directory(output_dir: Path) -> dict:
    """Enter the exact fresh directory using a supported Windows path alias."""
    if os.name != "nt":
        os.chdir(output_dir)
        return {"filesystem": "native", "blenderFilenames": "absolute-compatible", "workingDirectory": "native"}
    absolute = str(output_dir)
    ordinary = ("\\\\" + absolute[8:]) if absolute.upper().startswith("\\\\?\\UNC\\") else absolute[4:]
    alias_required = len(ordinary) + 25 >= 260
    if not alias_required:
        try:
            os.chdir(ordinary)
        except OSError as exc:
            if exc.winerror not in {3, 206}:
                raise
            alias_required = True
    mode = "ordinary-windows"
    if alias_required:
        # A short NTFS alias names the same directory and avoids SetCurrentDirectoryW's
        # MAX_PATH limit; it does not create a junction, move files, or escape the job.
        import ctypes
        get_short = ctypes.WinDLL("kernel32", use_last_error=True).GetShortPathNameW
        get_short.argtypes = (ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32)
        get_short.restype = ctypes.c_uint32
        required = get_short(absolute, None, 0)
        if not required:
            raise ValueError("Blender requires a shorter project path: no Windows short path alias is available")
        buffer = ctypes.create_unicode_buffer(required + 1)
        length = get_short(absolute, buffer, len(buffer))
        short = buffer.value
        if short.upper().startswith("\\\\?\\UNC\\"):
            short = "\\\\" + short[8:]
        elif short.startswith("\\\\?\\"):
            short = short[4:]
        if not length or len(short) + 25 >= 260 or not os.path.samefile(short, absolute):
            raise ValueError("Blender requires a shorter project path: a safe short alias could not be verified")
        os.chdir(short)
        mode = "windows-short-alias"
    return {"filesystem": "windows-verbatim", "blenderFilenames": "absolute-compatible", "workingDirectory": mode,
            "outputPathCharacters": len(ordinary)}


def blender_output_filename(name: str) -> str:
    # This receives only fixed worker basenames, never asset/user-provided names.
    # Blender render/save operations resolve './' against its unsaved .blend,
    # so use the absolute ordinary/short cwd instead of a relative render path.
    return os.path.join(os.getcwd(), name)


def read_parameters(path: Path) -> dict:
    if not path.is_file() or path.stat().st_size > INPUT_BYTES:
        raise ValueError("Job JSON must be a regular file of at most 16 KiB")
    parameters = json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=unique_object,
                            parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Non-finite JSON number")))
    if not isinstance(parameters, dict) or set(parameters) != KEYS:
        raise ValueError("ModelParameters requires exactly template, name, width, depth, height, color, bevel")
    if parameters["template"] not in {"crate", "table", "shelf"}:
        raise ValueError("Unsupported procedural template")
    name = parameters["name"]
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
        raise ValueError("Name must have 1 to 80 characters")
    if re.search(r'[\x00-\x1f\x7f<>:"/\\|?*]', name) or name in {".", ".."}:
        raise ValueError("Name cannot contain control characters or path syntax")
    for key in ("width", "depth", "height", "bevel"):
        value = parameters[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{key} must be a finite number")
    if any(not 0.03 <= parameters[key] <= 100 for key in ("width", "depth", "height")):
        raise ValueError("Dimensions must be between 0.03 and 100 meters")
    if not 0 <= parameters["bevel"] <= min(parameters[key] for key in ("width", "depth", "height")) / 4:
        raise ValueError("Bevel must be between zero and a quarter of the smallest dimension")
    if not isinstance(parameters["color"], str) or re.fullmatch(r"#[0-9a-fA-F]{6}", parameters["color"]) is None:
        raise ValueError("Color must be a six-digit #RRGGBB value")
    return parameters


def read_style_guide(path: Path | None) -> dict | None:
    if path is None:
        return None
    if not path.is_file() or path.stat().st_size > INPUT_BYTES:
        raise ValueError("Style JSON must be a regular file of at most 16 KiB")
    style = json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=unique_object,
                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Non-finite JSON number")))
    if not isinstance(style, dict) or set(style) != STYLE_KEYS:
        raise ValueError("StyleGuide must contain exactly its ten shared schema fields")
    if style["approved"] is not True:
        raise ValueError("StyleGuide must be explicitly approved")
    if not isinstance(style["id"], str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", style["id"]) is None:
        raise ValueError("StyleGuide id must be an opaque identifier, never a path")
    for key, maximum in (("name", 80), ("detail", 256)):
        value = style[key]
        if not isinstance(value, str) or not 1 <= len(value.strip()) <= maximum or re.search(r"[\x00-\x1f\x7f]", value):
            raise ValueError(f"StyleGuide {key} must be bounded plain text")
    palette = style["palette"]
    if not isinstance(palette, list) or not 1 <= len(palette) <= 16 or any(
            not isinstance(color, str) or re.fullmatch(r"#[0-9a-fA-F]{6}", color) is None for color in palette):
        raise ValueError("StyleGuide palette requires 1 to 16 six-digit hex colors")
    for key, maximum in (("lineWeight", 24), ("margin", 128)):
        value = style[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= maximum:
            raise ValueError(f"StyleGuide {key} must be a finite bounded nonnegative number")
    if not isinstance(style["camera"], str) or style["camera"].strip().lower() not in CAMERA_ALIASES:
        raise ValueError("Unsupported StyleGuide camera; use orthographic 3/4, front or top")
    if not isinstance(style["lighting"], str) or style["lighting"].strip().lower() not in LIGHTING_ALIASES:
        raise ValueError("Unsupported StyleGuide lighting; use soft studio")
    references = style["referenceAssetIds"]
    if not isinstance(references, list) or len(references) > 64 or any(
            not isinstance(ref, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", ref) is None for ref in references):
        raise ValueError("StyleGuide references must be opaque asset ids, never paths or URLs")
    if len(references) != len(set(references)):
        raise ValueError("StyleGuide reference ids cannot be duplicated")
    return style


def prepare_output(path: Path) -> None:
    # An existing empty directory is allowed for bridges that reserve a UUID folder.
    # Existing artifacts are never overwritten, including files from failed runs.
    if path.is_symlink() or (path.exists() and (not path.is_dir() or any(path.iterdir()))):
        raise ValueError("Output directory must be new or empty; existing assets are preserved")
    path.mkdir(parents=True, exist_ok=True)


def srgb_to_linear(value: float) -> float:
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def material(name: str, color: str, factor: float, metallic: float = 0.0):
    channels = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    rgba = (*[srgb_to_linear(min(1.0, max(0.0, c * factor))) for c in channels], 1.0)
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = rgba
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = rgba
    shader.inputs["Roughness"].default_value = 0.56 if not metallic else 0.34
    shader.inputs["Metallic"].default_value = metallic
    return mat


def box(name: str, center: tuple, dimensions: tuple, mat, bevel: float):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    obj = bpy.context.active_object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    if bevel > 0:
        modifier = obj.modifiers.new("Baked edge bevel", "BEVEL")
        modifier.width = min(bevel, min(dimensions) / 4)
        modifier.segments = 2
        modifier.affect = "EDGES"
        modifier.limit_method = "NONE"
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    for polygon in obj.data.polygons:
        polygon.use_smooth = False
    return obj


def build_model(parameters: dict, style: dict | None = None):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.unit_settings.length_unit = "METERS"
    w, d, h, bevel = (float(parameters[k]) for k in ("width", "depth", "height", "bevel"))
    base = material("Base · sRGB input", parameters["color"], 1.0)
    if style is None:
        detail = material("Dark edge", parameters["color"], 0.73)
        accent = material("Light face", parameters["color"], 1.12)
    else:
        palette = style["palette"]
        detail = material("Style detail", palette[min(1, len(palette) - 1)], 1.0)
        accent = material("Style accent", palette[min(2, len(palette) - 1)], 1.0)
    parts = []

    def add(name, center, dimensions, mat=base):
        parts.append(box(name, center, dimensions, mat, bevel))

    if parameters["template"] == "crate":
        t = min(w, d, h) * 0.095
        add("Closed container body", (0, 0, h / 2), (w - t, d - t, h - t))
        # Four edge rails and crossbars form a readable crate, each a closed solid.
        for x in (-1, 1):
            for y in (-1, 1):
                add("Corner rail", (x * (w - t) / 2, y * (d - t) / 2, h / 2), (t, t, h), detail)
        for z in (t / 2, h - t / 2):
            for y in (-1, 1):
                add("Front back crossbar", (0, y * (d - t) / 2, z), (w - 2 * t, t, t), detail)
            for x in (-1, 1):
                add("Side crossbar", (x * (w - t) / 2, 0, z), (t, d - 2 * t, t), detail)
        for y in (-1, 1):
            add("Center band", (0, y * (d - t) / 2, h / 2), (t, t, h - 2 * t), accent)
    elif parameters["template"] == "table":
        top = h * 0.11
        leg = min(w, d) * 0.12
        add("Tabletop", (0, 0, h - top / 2), (w, d, top), accent)
        for x in (-1, 1):
            for y in (-1, 1):
                add("Table leg", (x * (w / 2 - leg), y * (d / 2 - leg), (h - top) / 2),
                    (leg, leg, h - top), base)
        rail = min(top * 0.65, leg * 0.75)
        for y in (-1, 1):
            add("Long apron", (0, y * (d / 2 - leg), h - top - rail / 2), (w - 2 * leg, rail, rail), detail)
        for x in (-1, 1):
            add("Short apron", (x * (w / 2 - leg), 0, h - top - rail / 2), (rail, d - 2 * leg, rail), detail)
    else:
        side = w * 0.085
        panel = h * 0.055
        back = d * 0.065
        for x in (-1, 1):
            add("Shelf side", (x * (w - side) / 2, 0, h / 2), (side, d, h), base)
        add("Shelf back", (0, (d - back) / 2, h / 2), (w - 2 * side, back, h), detail)
        for level in range(4):
            z = panel / 2 + level * (h - panel) / 3
            add("Shelf board", (0, -back / 2, z), (w - 2 * side, d - back, panel), accent)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in parts:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    model = bpy.context.active_object
    model.name = parameters["name"]
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    model["assetStudioModel"] = True
    model["assetStudioTemplate"] = parameters["template"]
    model["assetStudioUnit"] = "m"
    model["assetStudioPivot"] = "bottom-center"
    model["assetStudioSourceAxis"] = "Z-up"
    model["assetStudioExportAxis"] = "Y-up"
    model["assetStudioAssembly"] = "Closed overlapping solid components; visualization mesh, not a CAD solid"
    model["assetStudioRequestedBevel"] = bevel
    model["assetStudioTriangleBudget"] = TRIANGLE_BUDGET
    if style is not None:
        model["assetStudioStyleId"] = style["id"]
        model["assetStudioStyleName"] = style["name"]
        model["assetStudioReferenceAssetIds"] = json.dumps(style["referenceAssetIds"], ensure_ascii=True)
    bm = bmesh.new()
    bm.from_mesh(model.data)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(model.data)
    bm.free()
    model.data.update()
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.025)
    bpy.ops.object.mode_set(mode="OBJECT")
    return model, len(parts)


def inspect_model(model) -> dict:
    mesh = model.data
    mesh.calc_loop_triangles()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    open_edges = sum(not edge.is_manifold for edge in bm.edges)
    bm.free()
    bounds = [model.matrix_world @ Vector(corner) for corner in model.bound_box]
    mins = [min(v[i] for v in bounds) for i in range(3)]
    maxs = [max(v[i] for v in bounds) for i in range(3)]
    normals = [entry.vector for entry in mesh.corner_normals]
    return {"vertices": len(mesh.vertices), "triangles": len(mesh.loop_triangles),
            "sourceDimensions": [maxs[i] - mins[i] for i in range(3)],
            "boundsMin": mins, "boundsMax": maxs, "openEdges": open_edges,
            "uvLayers": len(mesh.uv_layers), "uvLoops": len(mesh.uv_layers.active.data) if mesh.uv_layers.active else 0,
            "materialSlots": len(mesh.materials), "normalCount": len(normals),
            "finiteNormals": all(math.isfinite(value) for normal in normals for value in normal),
            "origin": list(model.location)}


def inspect_glb(path: Path) -> dict:
    blob = path.read_bytes()
    if len(blob) < 20:
        raise ValueError("Truncated GLB")
    magic, version, length = struct.unpack_from("<4sII", blob, 0)
    chunk_length, chunk_type = struct.unpack_from("<II", blob, 12)
    if magic != b"glTF" or version != 2 or length != len(blob) or chunk_type != 0x4E4F534A:
        raise ValueError("Invalid GLB 2.0 container")
    gltf = json.loads(blob[20:20 + chunk_length])
    primitives = [primitive for mesh in gltf.get("meshes", []) for primitive in mesh["primitives"]]
    triangle_count = 0
    vertex_count = 0
    for primitive in primitives:
        attrs = primitive["attributes"]
        if not {"POSITION", "NORMAL", "TEXCOORD_0"}.issubset(attrs) or "material" not in primitive:
            raise ValueError("GLB lacks positions, UV, normals, or material references")
        if primitive.get("mode", 4) != 4:
            raise ValueError("GLB must export triangles")
        triangle_count += gltf["accessors"][primitive["indices"]]["count"] // 3
        vertex_count += gltf["accessors"][attrs["POSITION"]]["count"]
    if not primitives or triangle_count > TRIANGLE_BUDGET:
        raise ValueError("Empty GLB or triangle budget exceeded")
    return {"version": version, "meshes": len(gltf["meshes"]), "primitives": len(primitives),
            "vertices": vertex_count, "triangles": triangle_count, "materials": len(gltf.get("materials", [])),
            "uvNormalsMaterialReferences": True, "generator": gltf["asset"].get("generator")}


def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def setup_studio(parameters: dict, style: dict | None = None):
    scene = bpy.context.scene
    w, d, h = (float(parameters[k]) for k in ("width", "depth", "height"))
    size = max(w, d, h)
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 12
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("Studio world")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.16, 0.20, 0.27, 1)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.55
    bpy.ops.mesh.primitive_plane_add(size=size * 200, location=(0, 0, -size * 0.004))
    ground = bpy.context.active_object
    ground.name = "Studio ground · excluded from asset export"
    ground.data.materials.append(material("Studio floor", "#263340", 1.0))
    camera_preset = "orthographic 3/4" if style is None else CAMERA_ALIASES[style["camera"].strip().lower()]
    lighting_preset = "soft studio" if style is None else LIGHTING_ALIASES[style["lighting"].strip().lower()]
    camera_location = {"orthographic 3/4": (size * 2.1, -size * 2.7, h / 2 + size * 1.8),
                       "orthographic front": (0, -size * 3.4, h / 2),
                       "orthographic top": (0, 0, h / 2 + size * 3.4)}[camera_preset]
    bpy.ops.object.camera_add(location=camera_location)
    camera = bpy.context.active_object
    camera.name = "Studio camera"
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = size * 1.9
    camera.data.clip_start = max(0.0001, size / 1000)
    camera.data.clip_end = size * 300
    aim(camera, (0, 0, h / 2))
    scene.camera = camera
    scene["assetStudioCameraPreset"] = camera_preset
    scene["assetStudioLightingPreset"] = lighting_preset
    for name, xyz, energy in (("Key", (2, -3, 4), 850), ("Fill", (-3, -1, 2), 500), ("Rim", (1, 3, 3), 750)):
        bpy.ops.object.light_add(type="AREA", location=tuple(size * v for v in xyz))
        light = bpy.context.active_object
        light.name = name
        light.data.energy = energy * size * size
        light.data.shape = "DISK"
        light.data.size = size * 2.5
        aim(light, (0, 0, h / 2))
    return camera


def style_inspection(parameters: dict, style: dict | None, model, camera) -> dict | None:
    if style is None:
        return None
    lights = [obj for obj in bpy.context.scene.objects if obj.type == "LIGHT"]
    palette = style["palette"]
    return {"id": style["id"], "name": style["name"], "approved": style["approved"],
            "requestedCamera": style["camera"], "requestedLighting": style["lighting"],
            "referenceAssetIds": style["referenceAssetIds"], "referenceUse": "provenance-only; no referenced files opened",
            "requested": style,
            "actual": {"camera": {"preset": bpy.context.scene["assetStudioCameraPreset"], "type": camera.data.type,
                                  "locationMetersZUp": list(camera.location), "orthoScaleMeters": camera.data.ortho_scale},
                       "lighting": {"preset": bpy.context.scene["assetStudioLightingPreset"],
                                    "worldStrength": bpy.context.scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value,
                                    "lights": [{"name": obj.name, "type": obj.data.type, "energyWatts": obj.data.energy,
                                                "sizeMeters": obj.data.size, "locationMetersZUp": list(obj.location)} for obj in lights]},
                       "materials": [{"role": "primary", "color": parameters["color"], "source": "ModelParameters.color explicit override"},
                                     {"role": "detail", "color": palette[min(1, len(palette) - 1)], "source": "StyleGuide.palette"},
                                     {"role": "accent", "color": palette[min(2, len(palette) - 1)], "source": "StyleGuide.palette"}],
                       "materialSlots": len(model.data.materials)},
            "notApplied": [{"field": key, "value": style[key],
                            "reason": "No line drawing, silhouette inference or exact pixel-margin layout in this procedural 3D renderer"}
                           for key in ("lineWeight", "detail", "margin")],
            "identityGuarantee": False, "turntable": "Fixed four 90-degree viewpoints; requested camera applies to thumbnail and source scene"}


def atomic_json(path: Path, value: dict):
    temp = path.with_suffix(path.suffix + ".partial")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(temp, path)


def artifact(path: Path, role: str):
    return {"path": path.name, "format": path.suffix.lstrip("."), "role": role,
            "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def execute(input_path: Path, output_dir: Path, style_path: Path | None = None):
    started = time.monotonic()
    emit("stage", stage="validate-input")
    input_path = blender_interop_path(input_path)
    output_dir = blender_interop_path(output_dir)
    style_path = blender_interop_path(style_path)
    parameters = read_parameters(input_path)
    style = read_style_guide(style_path)
    prepare_output(output_dir)
    # All filesystem paths above are absolute. Blender receives ordinary paths
    # or verified aliases to this same fresh directory, while Python keeps
    # verbatim long-path syntax for atomic file promotion and validation.
    io_interop = blender_working_directory(output_dir)
    emit("stage", stage="build-mesh")
    model, component_count = build_model(parameters, style)
    inspected = inspect_model(model)
    requested = [parameters[key] for key in ("width", "depth", "height")]
    tolerance = max(requested) * 1e-5
    if inspected["openEdges"] or not inspected["finiteNormals"] or not inspected["uvLayers"]:
        raise ValueError("Generated mesh failed topology, normals, or UV validation")
    if any(abs(actual - wanted) > tolerance for actual, wanted in zip(inspected["sourceDimensions"], requested)):
        raise ValueError("Generated mesh dimensions differ from requested dimensions")
    if inspected["triangles"] > TRIANGLE_BUDGET:
        raise ValueError("Triangle budget exceeded")
    emit("stage", stage="export-glb")
    bpy.ops.object.select_all(action="DESELECT")
    model.select_set(True)
    bpy.context.view_layer.objects.active = model
    temp_glb = output_dir / "model.partial.glb"
    bpy.ops.export_scene.gltf(filepath=blender_output_filename("model.partial.glb"), export_format="GLB", use_selection=True,
                              export_yup=True, export_normals=True, export_texcoords=True,
                              export_materials="EXPORT", export_extras=True, export_animations=False,
                              export_cameras=False, export_lights=False)
    glb = inspect_glb(temp_glb)
    os.replace(temp_glb, output_dir / "model.glb")
    emit("stage", stage="render-preview")
    camera = setup_studio(parameters, style)
    scene = bpy.context.scene
    temp_png = output_dir / "thumbnail.partial.png"
    scene.render.filepath = blender_output_filename("thumbnail.partial.png")
    bpy.ops.render.render(write_still=True)
    os.replace(temp_png, output_dir / "thumbnail.png")
    saved_camera = camera.location.copy()
    h, size = parameters["height"], max(requested)
    scene.render.resolution_x = 256
    scene.render.resolution_y = 256
    for index in range(4):
        angle = math.radians(-45 + index * 90)
        camera.location = (math.cos(angle) * size * 3.2, math.sin(angle) * size * 3.2, h / 2 + size * 1.6)
        aim(camera, (0, 0, h / 2))
        path = output_dir / f"turntable-{index:02d}.png"
        temp = path.with_name(path.stem + ".partial.png")
        scene.render.filepath = blender_output_filename(temp.name)
        bpy.ops.render.render(write_still=True)
        os.replace(temp, path)
    camera.location = saved_camera
    aim(camera, (0, 0, h / 2))
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.filepath = "//thumbnail.png"
    bpy.ops.object.select_all(action="DESELECT")
    model.select_set(True)
    bpy.context.view_layer.objects.active = model
    applied_style = style_inspection(parameters, style, model, camera)
    emit("stage", stage="save-editable-source")
    temp_blend = output_dir / "source.partial.blend"
    bpy.ops.wm.save_as_mainfile(filepath=blender_output_filename("source.partial.blend"), compress=True)
    os.replace(temp_blend, output_dir / "source.blend")
    checks = [
        {"code": "real-mesh", "status": "pass", "message": "Non-planar procedural vertices and indexed faces", "measured": inspected["vertices"]},
        {"code": "triangle-budget", "status": "pass", "message": "Below the 10000-triangle worker ceiling", "measured": glb["triangles"]},
        {"code": "dimensions-m", "status": "pass", "message": "Requested meter dimensions within relative tolerance 1e-5"},
        {"code": "closed-components", "status": "pass", "message": "Every component edge has two adjacent faces", "measured": inspected["openEdges"]},
        {"code": "uv-normals-materials", "status": "pass", "message": "GLB contains UV, normals and material references"},
        {"code": "pivot-axis", "status": "pass", "message": "Bottom-center origin; .blend Z-up, GLB Y-up, meters"},
        {"code": "assembly-not-cad", "status": "warn", "message": "Overlapping solid components form a visualization mesh, not a manufacturing CAD solid"},
    ]
    if style is not None:
        checks.append({"code": "approved-style-render", "status": "pass",
                       "message": "Approved style palette, supported camera and soft-studio lights applied; explicit primary color preserved"})
        checks.append({"code": "style-scope", "status": "warn",
                       "message": "Line weight, semantic detail and exact pixel margin are recorded but not applied; reference ids are provenance only"})
    report = {"schemaVersion": 1, "valid": True, "createdAt": datetime.now(timezone.utc).isoformat(),
              "checks": checks, "parameters": parameters, "blenderVersion": bpy.app.version_string,
              "mesh": {"vertices": glb["vertices"], "triangles": glb["triangles"],
                       "dimensions": [parameters["width"], parameters["height"], parameters["depth"]],
                       "unit": "m", "axis": "Y-up", "pivot": "bottom-center"},
              "sourceInspection": inspected, "gltfInspection": glb, "componentCount": component_count,
              "ioInterop": io_interop,
              "elapsedSeconds": round(time.monotonic() - started, 3),
              "roundTrip": {"status": "not-run-in-worker", "note": "Fresh-process round-trip is performed by tests/blender"}}
    if applied_style is not None:
        report["styleGuide"] = applied_style
    atomic_json(output_dir / "validation.json", report)
    files = [artifact(output_dir / "model.glb", "output"), artifact(output_dir / "source.blend", "source"),
             artifact(output_dir / "thumbnail.png", "thumbnail"), artifact(output_dir / "validation.json", "metadata")]
    files.extend(artifact(output_dir / f"turntable-{i:02d}.png", "thumbnail") for i in range(4))
    for item in files:
        emit("artifact", **item)
    emit("completed", mesh=report["mesh"], validation=report, artifacts=files)


def main():
    parser = argparse.ArgumentParser(description="Data-only procedural Blender worker")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--style-file", type=Path, help="Optional approved StyleGuide JSON; data only")
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    args = parser.parse_args(argv)
    try:
        execute(args.input, args.output_dir, args.style_file)
    except Exception as exc:
        # Do not echo arbitrary input contents, environment variables, or paths.
        emit("failed", stage="blender-worker", error=f"{type(exc).__name__}: {exc}")
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
