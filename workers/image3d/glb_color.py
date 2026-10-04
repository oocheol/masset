# SPDX-License-Identifier: MIT
"""Small audited GLB color writer: decoder sRGB -> linear FLOAT32 COLOR_0.

trimesh 4.0.5 always quantizes ColorVisuals to uint8. Append a float stream to
its already exported embedded buffer, preserving all geometry bytes/indices.
Only one mesh primitive and a single embedded GLB buffer are accepted here.
"""
import json
import struct


def srgb_to_linear(rgb):
    import numpy as np
    rgb = np.asarray(rgb, dtype=np.float32)
    if not np.isfinite(rgb).all() or (rgb < 0).any() or (rgb > 1).any():
        raise ValueError("Predicted sRGB colors must be finite and in [0,1]")
    return np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4).astype(np.float32)


def linear_to_srgb(rgb):
    import numpy as np
    rgb = np.asarray(rgb, dtype=np.float32)
    return np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.maximum(rgb, 0) ** (1 / 2.4) - 0.055).astype(np.float32)


def unpack_glb(data):
    if len(data) < 28 or struct.unpack_from("<4sII", data) != (b"glTF", 2, len(data)):
        raise ValueError("Expected a bounded GLB 2.0")
    length, kind = struct.unpack_from("<II", data, 12)
    if kind != 0x4e4f534a or length % 4:
        raise ValueError("Expected an aligned GLB JSON chunk")
    document = json.loads(data[20:20+length])
    offset = 20 + length
    binary_length, binary_kind = struct.unpack_from("<II", data, offset)
    if binary_kind != 0x004e4942 or offset + 8 + binary_length != len(data):
        raise ValueError("Expected one embedded GLB binary chunk")
    if len(document["buffers"]) != 1 or "uri" in document["buffers"][0]:
        raise ValueError("External/multiple buffers are unsupported")
    return document, data[offset+8:]


def read_color0(data):
    import numpy as np
    document, binary = unpack_glb(data)
    primitives = [p for mesh in document["meshes"] for p in mesh["primitives"]]
    if len(primitives) != 1:
        raise ValueError("Expected one primitive")
    accessor = document["accessors"][primitives[0]["attributes"]["COLOR_0"]]
    view = document["bufferViews"][accessor["bufferView"]]
    dimensions = {"VEC3": 3, "VEC4": 4}[accessor["type"]]
    dtype = {5121: "u1", 5123: "<u2", 5126: "<f4"}[accessor["componentType"]]
    size = np.dtype(dtype).itemsize
    stride = view.get("byteStride", size * dimensions)
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    end = offset + (accessor["count"] - 1) * stride + dimensions * size
    if "sparse" in accessor or view["buffer"] != 0 or end > len(binary):
        raise ValueError("Unsupported/out-of-range color accessor")
    colors = np.ndarray((accessor["count"], dimensions), dtype=dtype, buffer=binary,
                        offset=offset, strides=(stride, size)).copy()
    if accessor.get("normalized", False):
        colors = colors.astype(np.float32) / np.iinfo(np.dtype(dtype)).max
    return colors, accessor


def export_linear_color0(exported_glb, predicted_srgb):
    import numpy as np
    document, binary = unpack_glb(exported_glb)
    primitives = [p for mesh in document["meshes"] for p in mesh["primitives"]]
    if len(primitives) != 1:
        raise ValueError("Expected one inferred mesh primitive")
    primitive = primitives[0]
    count = document["accessors"][primitive["attributes"]["POSITION"]]["count"]
    predicted_srgb = np.asarray(predicted_srgb, dtype=np.float32)
    if predicted_srgb.shape != (count, 3):
        raise ValueError("Decoder RGB samples must match every exported vertex")
    linear = srgb_to_linear(predicted_srgb)
    rgba = np.ones((count, 4), dtype="<f4")
    rgba[:, :3] = linear
    padding = b"\0" * (-len(binary) % 4)
    offset = len(binary) + len(padding)
    color_bytes = rgba.tobytes(order="C")
    binary = binary + padding + color_bytes
    view_index = len(document["bufferViews"])
    document["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": len(color_bytes), "target": 34962})
    accessor_index = len(document["accessors"])
    document["accessors"].append({"bufferView": view_index, "componentType": 5126, "type": "VEC4", "count": count,
                                  "min": rgba.min(axis=0).tolist(), "max": rgba.max(axis=0).tolist()})
    primitive["attributes"]["COLOR_0"] = accessor_index
    document["buffers"][0]["byteLength"] = len(binary)
    header = json.dumps(document, separators=(",", ":"), allow_nan=False).encode("utf-8")
    header += b" " * (-len(header) % 4)
    result = (struct.pack("<4sII", b"glTF", 2, 28 + len(header) + len(binary))
              + struct.pack("<II", len(header), 0x4e4f534a) + header
              + struct.pack("<II", len(binary), 0x004e4942) + binary)
    actual, accessor = read_color0(result)
    if accessor["componentType"] != 5126 or not np.array_equal(actual, rgba):
        raise ValueError("FLOAT32 vertex color export did not round-trip")
    error = float(np.abs(linear_to_srgb(actual[:, :3]) - predicted_srgb).max())
    if error > 2e-6:
        raise ValueError("sRGB transfer did not round-trip")
    return result, {"decoderColorInterpretation": "sRGB, matching upstream direct PNG display",
                    "exportColorSpace": "linear RGB", "attribute": "COLOR_0", "componentType": "FLOAT32",
                    "alpha": 1.0, "transfer": "IEC 61966-2-1 inverse sRGB",
                    "sampleSource": "float32 renderer.query_triplane at original model-space vertices",
                    "uint8QuantizationBeforeExport": False, "roundTripMaxAbsoluteError": error,
                    "meanPredictedSrgb": predicted_srgb.mean(axis=0).tolist(), "meanExportedLinear": linear.mean(axis=0).tolist()}
