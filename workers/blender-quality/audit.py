# SPDX-License-Identifier: GPL-3.0-or-later
"""Data-only preflight and binary artifact inspection; no Blender dependency.

This worker boundary is GPL-3.0-or-later, like workers/blender. See LICENSE.
Input assets are data. Nothing from a GLB, JSON field, or material is evaluated
as Python, loaded as a .blend, or used as a script/module path.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import struct

INPUT_BYTES = 16 * 1024
GLB_BYTES = 64 * 1024 * 1024
JSON_BYTES = 4 * 1024 * 1024
MAX_ELEMENTS = 2_000_000
KEYS = frozenset({"sourcePath", "sourceSha256", "name", "heightMeters",
                  "maxTriangles", "textureResolution", "sourceKind", "preserveMaterials"})
COMPONENTS = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2),
              5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
WIDTHS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def json_data(data: bytes):
    def bad_constant(_):
        raise ValueError("Non-finite JSON number")
    try:
        return json.loads(data.decode("utf-8-sig"), object_pairs_hook=unique_object,
                          parse_constant=bad_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ValueError("Invalid bounded UTF-8 JSON") from exc


def read_bounded(path: Path, maximum: int) -> bytes:
    # fstat and a bounded read also protect against size changes after stat.
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise ValueError("Expected a bounded regular file")
        data = stream.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError("File exceeds worker byte limit")
    return data


def read_parameters(path: Path) -> dict:
    job = json_data(read_bounded(path, INPUT_BYTES))
    if not isinstance(job, dict) or set(job) != KEYS:
        raise ValueError("Job must contain exactly the eight documented finishing fields")
    source = job["sourcePath"]
    if (not isinstance(source, str) or not source or len(source) > 4096
            or "\0" in source or not Path(source).is_absolute()
            or Path(source).suffix.lower() != ".glb"):
        raise ValueError("sourcePath must be an absolute GLB file path")
    if not isinstance(job["sourceSha256"], str) or not re.fullmatch(r"[0-9a-fA-F]{64}", job["sourceSha256"]):
        raise ValueError("sourceSha256 must be 64 hexadecimal characters")
    name = job["name"]
    if (not isinstance(name, str) or not 1 <= len(name) <= 80 or not name.strip()
            or name != name.strip() or name in {".", ".."}
            or name.endswith(".") or re.search(r'[\x00-\x1f\x7f<>:"/\\|?*]', name)):
        raise ValueError("name must be safe plain text of 1 to 80 characters")
    height = job["heightMeters"]
    if isinstance(height, bool) or not isinstance(height, (int, float)) or not math.isfinite(height) or not 0.03 <= height <= 100:
        raise ValueError("heightMeters must be finite and between 0.03 and 100")
    if type(job["maxTriangles"]) is not int or not 1000 <= job["maxTriangles"] <= 100000:
        raise ValueError("maxTriangles must be an integer from 1000 to 100000")
    if type(job["textureResolution"]) is not int or job["textureResolution"] not in {512, 1024, 2048}:
        raise ValueError("textureResolution must be 512, 1024, or 2048")
    if not isinstance(job["sourceKind"], str) or job["sourceKind"] not in {"image3d", "model"}:
        raise ValueError("sourceKind must be image3d or model")
    if type(job["preserveMaterials"]) is not bool:
        raise ValueError("preserveMaterials must be boolean")
    return job


def prepare_output(path: Path) -> Path:
    if path.is_symlink() or (path.exists() and (not path.is_dir() or any(path.iterdir()))):
        raise ValueError("Output directory must be new or empty; existing files are preserved")
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve(strict=True)


def integer(value, minimum=0, maximum=MAX_ELEMENTS):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("Invalid bounded GLB integer")
    return value


def finite(values, width):
    if not isinstance(values, list) or len(values) != width or any(
            isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
        raise ValueError("Invalid finite GLB vector")
    return values


def image_dimensions(data: bytes, mime: str):
    if mime == "image/png":
        if len(data) < 33 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
            raise ValueError("Invalid embedded PNG header")
        width, height = struct.unpack_from(">II", data, 16)
    elif mime == "image/jpeg":
        if not data.startswith(b"\xff\xd8"):
            raise ValueError("Invalid embedded JPEG header")
        offset = 2
        width = height = 0
        while offset + 4 <= len(data):
            if data[offset] != 255:
                raise ValueError("Invalid JPEG marker")
            while offset < len(data) and data[offset] == 255:
                offset += 1
            if offset >= len(data):
                break
            marker = data[offset]
            offset += 1
            if marker in {0xD9, 0xDA}:
                break
            if marker in {0xD8, 0x01} or 0xD0 <= marker <= 0xD7:
                continue
            length = struct.unpack_from(">H", data, offset)[0]
            if length < 2 or offset + length > len(data):
                raise ValueError("Invalid JPEG segment")
            if marker in {0xC0, 0xC1, 0xC2} and length >= 8:
                height, width = struct.unpack_from(">HH", data, offset + 3)
                break
            offset += length
    else:
        raise ValueError("Only embedded PNG/JPEG textures are accepted")
    if not 1 <= width <= 8192 or not 1 <= height <= 8192 or width * height > 32 * 1024 * 1024:
        raise ValueError("Embedded image exceeds decoded pixel bound")
    return [width, height]


class GLB:
    """Inspect explicit binary accessors and bounds before a native importer.

    Sparse, compressed, animated, skinned and morph assets fail closed. This
    static finishing worker does not silently flatten rigs or animations.
    Embedded bufferView PNG/JPEG images are the supported texture transport.
    """
    def __init__(self, data: bytes, maximum=GLB_BYTES):
        if not 28 <= len(data) <= maximum:
            raise ValueError("GLB must be bounded to 64 MiB")
        magic, version, length = struct.unpack_from("<4sII", data)
        if magic != b"glTF" or version != 2 or length != len(data):
            raise ValueError("Expected a complete GLB 2.0 container")
        offset = 12
        chunks = []
        while offset < len(data):
            if offset + 8 > len(data):
                raise ValueError("Truncated GLB chunk")
            size, kind = struct.unpack_from("<II", data, offset)
            offset += 8
            if size % 4 or offset + size > len(data):
                raise ValueError("Invalid GLB chunk bounds")
            chunks.append((kind, data[offset:offset + size]))
            offset += size
        if len(chunks) != 2 or [c[0] for c in chunks] != [0x4E4F534A, 0x004E4942] or len(chunks[0][1]) > JSON_BYTES:
            raise ValueError("Expected bounded JSON followed by one embedded BIN chunk")
        self.doc = json_data(chunks[0][1])
        self.binary = chunks[1][1]
        self.sha256 = hashlib.sha256(data).hexdigest()
        self.bytes = len(data)
        self._validate()

    def ref(self, table, value):
        items = self.doc.get(table, [])
        index = integer(value, 0, max(0, len(items) - 1))
        if index >= len(items):
            raise ValueError("Missing GLB table reference")
        return items[index]

    def view(self, index):
        view = self.ref("bufferViews", index)
        if view.get("buffer", 0) != 0:
            raise ValueError("GLB must use its single embedded buffer")
        offset = integer(view.get("byteOffset", 0), maximum=len(self.binary))
        length = integer(view.get("byteLength"), 1, len(self.binary))
        if offset + length > getattr(self, "buffer_length", len(self.binary)):
            raise ValueError("GLB bufferView escapes embedded buffer")
        return view, offset, length

    def accessor(self, index):
        accessor = self.ref("accessors", index)
        if "sparse" in accessor or "bufferView" not in accessor:
            raise ValueError("Sparse or missing GLB accessors are unsupported")
        component = COMPONENTS.get(accessor.get("componentType"))
        width = WIDTHS.get(accessor.get("type"))
        if component is None or width is None:
            raise ValueError("Unsupported GLB accessor representation")
        fmt, size = component
        count = integer(accessor.get("count"), 1)
        view, start, length = self.view(accessor["bufferView"])
        offset = integer(accessor.get("byteOffset", 0), maximum=length)
        stride = integer(view.get("byteStride", size * width), size * width, 252)
        if stride % size or offset % size or offset + (count - 1) * stride + size * width > length:
            raise ValueError("GLB accessor escapes bufferView or is misaligned")
        for row in range(count):
            values = struct.unpack_from("<" + fmt * width, self.binary, start + offset + row * stride)
            if fmt == "f" and any(not math.isfinite(v) for v in values):
                raise ValueError("Non-finite GLB binary coordinate")
            yield values

    def _validate(self):
        doc = self.doc
        if not isinstance(doc, dict) or not isinstance(doc.get("asset"), dict) or doc["asset"].get("version") != "2.0":
            raise ValueError("Expected glTF asset version 2.0")
        if doc.get("extensionsRequired"):
            raise ValueError("Required GLB extensions are not accepted")
        if any(doc.get(k) for k in ("animations", "skins")):
            raise ValueError("Only static, unskinned meshes can be finished")
        # Never resolve a URI, including data URIs. Self-contained images must
        # reside in the already bounded binary payload; extras are not imported.
        def walk(value, depth=0):
            if depth > 48:
                raise ValueError("GLB JSON nesting exceeds limit")
            if isinstance(value, dict):
                if "uri" in value:
                    raise ValueError("GLB URI references are forbidden; embed bufferView images")
                for child in value.values():
                    walk(child, depth + 1)
            elif isinstance(value, list):
                for child in value:
                    walk(child, depth + 1)
            elif isinstance(value, float) and not math.isfinite(value):
                raise ValueError("Non-finite GLB JSON value")
        walk(doc)
        for key, bound in (("nodes", 1024), ("meshes", 256), ("materials", 256),
                           ("textures", 128), ("images", 64), ("accessors", 8192),
                           ("bufferViews", 8192), ("scenes", 32), ("buffers", 1)):
            if not isinstance(doc.get(key, []), list) or len(doc.get(key, [])) > bound:
                raise ValueError("GLB table exceeds worker limit")
            if any(not isinstance(item, dict) for item in doc.get(key, [])):
                raise ValueError("GLB table must contain objects")
        if len(doc.get("buffers", [])) != 1:
            raise ValueError("GLB must contain one embedded buffer")
        declared = integer(doc["buffers"][0].get("byteLength"), 1, len(self.binary))
        self.buffer_length = declared
        if not 0 <= len(self.binary) - declared <= 3:
            raise ValueError("Embedded GLB buffer length mismatch")
        for i in range(len(doc.get("bufferViews", []))):
            self.view(i)
        for i in range(len(doc.get("accessors", []))):
            for _ in self.accessor(i):
                pass
        self.images = []
        total_pixels = 0
        for image in doc.get("images", []):
            _, start, length = self.view(image.get("bufferView"))
            blob = self.binary[start:start + length]
            dimensions = image_dimensions(blob, image.get("mimeType"))
            total_pixels += dimensions[0] * dimensions[1]
            self.images.append({"dimensions": dimensions, "bytes": length,
                                "sha256": hashlib.sha256(blob).hexdigest(), "mimeType": image["mimeType"]})
        if total_pixels > 64 * 1024 * 1024:
            raise ValueError("Total embedded texture pixels exceed limit")
        for texture in doc.get("textures", []):
            self.ref("images", texture.get("source"))
        self.mesh_triangles = []
        self.vertices = 0
        self.attributes = set()
        for mesh in doc.get("meshes", []):
            primitives = mesh.get("primitives")
            if not isinstance(primitives, list) or not 1 <= len(primitives) <= 256:
                raise ValueError("Invalid bounded mesh primitives")
            triangles = 0
            for primitive in primitives:
                if not isinstance(primitive, dict) or primitive.get("mode", 4) != 4 or primitive.get("targets"):
                    raise ValueError("Only static triangle primitives are supported")
                if primitive.get("extensions"):
                    raise ValueError("Compressed/extended mesh primitives are unsupported")
                attrs = primitive.get("attributes")
                if not isinstance(attrs, dict) or "POSITION" not in attrs:
                    raise ValueError("GLB mesh requires POSITION")
                position = self.ref("accessors", attrs["POSITION"])
                if position.get("type") != "VEC3" or position.get("componentType") != 5126:
                    raise ValueError("POSITION must be a float VEC3")
                count = position["count"]
                self.vertices += count
                self.attributes.update(attrs)
                for semantic, index in attrs.items():
                    a = self.ref("accessors", index)
                    if a["count"] != count:
                        raise ValueError("Primitive attribute counts differ")
                    if semantic == "NORMAL" and (a.get("type") != "VEC3" or a.get("componentType") != 5126):
                        raise ValueError("NORMAL must be a float VEC3")
                    if semantic.startswith("TEXCOORD_") and a.get("type") != "VEC2":
                        raise ValueError("TEXCOORD must be VEC2")
                if "indices" in primitive:
                    indices = self.ref("accessors", primitive["indices"])
                    if indices.get("type") != "SCALAR" or indices.get("componentType") not in {5121, 5123, 5125}:
                        raise ValueError("Indices must be unsigned scalar values")
                    index_count = indices["count"]
                    if any(v[0] >= count for v in self.accessor(primitive["indices"])):
                        raise ValueError("GLB triangle index is out of range")
                else:
                    index_count = count
                if index_count % 3:
                    raise ValueError("Triangle index count must be divisible by three")
                triangles += index_count // 3
                if "material" in primitive:
                    self.ref("materials", primitive["material"])
            self.mesh_triangles.append(triangles)
        if not self.mesh_triangles or not 1 <= sum(self.mesh_triangles) <= MAX_ELEMENTS or self.vertices > MAX_ELEMENTS:
            raise ValueError("Empty mesh or mesh exceeds worker geometry bound")
        self._validate_scene()

    def _validate_scene(self):
        nodes = self.doc.get("nodes", [])
        scenes = self.doc.get("scenes", [])
        if not scenes:
            raise ValueError("GLB requires an explicit active scene")
        scene = self.ref("scenes", self.doc.get("scene", 0))
        roots = scene.get("nodes", [])
        if not isinstance(roots, list) or not roots:
            raise ValueError("GLB active scene must contain mesh nodes")
        parents = set()
        for node in nodes:
            if "skin" in node or node.get("weights"):
                raise ValueError("Skinned/morphed nodes are unsupported")
            if "mesh" in node:
                self.ref("meshes", node["mesh"])
            if "matrix" in node:
                matrix = finite(node["matrix"], 16)
                if any(abs(matrix[i] - expected) > 1e-6 for i, expected in ((3, 0), (7, 0), (11, 0), (15, 1))):
                    raise ValueError("Node transform must be affine")
            for key, width in (("translation", 3), ("rotation", 4), ("scale", 3)):
                if key in node:
                    finite(node[key], width)
            children = node.get("children", [])
            if not isinstance(children, list) or len(children) > 1024:
                raise ValueError("Invalid node children")
            for child in children:
                self.ref("nodes", child)
                if child in parents:
                    raise ValueError("GLB nodes must have only one parent")
                parents.add(child)
        visited = set()
        stack = set()
        self.scene_triangles = 0
        def visit(index, depth=0):
            if depth > 64 or index in stack or index in visited:
                raise ValueError("Cyclic, deep, or duplicate GLB scene graph")
            node = self.ref("nodes", index)
            stack.add(index)
            visited.add(index)
            if "mesh" in node:
                self.scene_triangles += self.mesh_triangles[node["mesh"]]
            for child in node.get("children", []):
                visit(child, depth + 1)
            stack.remove(index)
        for root in roots:
            if root in parents:
                raise ValueError("Scene root must not have a parent")
            visit(root)
        if not 1 <= self.scene_triangles <= MAX_ELEMENTS:
            raise ValueError("Instanced scene geometry exceeds worker limit")
        # Validate unused graphs too: an importer may choose another scene.
        def acyclic(index, chain):
            if index in chain or len(chain) > 64:
                raise ValueError("Cyclic or deep unused GLB nodes")
            for child in nodes[index].get("children", []):
                acyclic(child, chain | {index})
        for index in range(len(nodes)):
            acyclic(index, set())

    def inspection(self):
        return {"bytes": self.bytes, "sha256": self.sha256,
                "triangles": self.scene_triangles, "vertices": self.vertices,
                "attributes": sorted(self.attributes), "images": self.images,
                "materialCount": len(self.doc.get("materials", [])),
                "requiredExtensions": self.doc.get("extensionsRequired", []),
                "usedExtensions": self.doc.get("extensionsUsed", [])}


def verify_source(job):
    data = read_bounded(Path(job["sourcePath"]), GLB_BYTES)
    if hashlib.sha256(data).hexdigest().lower() != job["sourceSha256"].lower():
        raise ValueError("Source SHA-256 does not match job; import refused")
    return data, GLB(data)


def artifact(path: Path, role: str):
    data = path.read_bytes()
    return {"path": path.name, "format": path.suffix.lstrip("."), "role": role,
            "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
