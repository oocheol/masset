# SPDX-License-Identifier: GPL-3.0-or-later
"""Bounded native measurements of derived mesh fidelity and UV atlas usage.

These are sampled acceptance gates, not a watertightness, CAD or unseen-detail
certificate. Measurements use actual source/derived geometry, never a render
whose material/lighting can hide a missing thin feature.
"""
from __future__ import annotations

import math
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform

SURFACE_SAMPLES = 1024
SILHOUETTE_RESOLUTION = 64


def geometry(obj):
    bpy.context.view_layer.update()
    obj.data.calc_loop_triangles()
    vertices = np.asarray([list(obj.matrix_world @ v.co) for v in obj.data.vertices], dtype=np.float64)
    faces = np.asarray([list(t.vertices) for t in obj.data.loop_triangles], dtype=np.int32)
    if not len(vertices) or not len(faces) or not np.isfinite(vertices).all():
        raise ValueError("Fidelity measurement requires finite nonempty triangle geometry")
    return vertices, faces, BVHTree.FromPolygons(vertices.tolist(), faces.tolist(), all_triangles=True)


def sample_points(vertices, faces):
    vi = np.linspace(0, len(vertices) - 1, min(SURFACE_SAMPLES // 2, len(vertices)), dtype=int)
    fi = np.linspace(0, len(faces) - 1, min(SURFACE_SAMPLES // 2, len(faces)), dtype=int)
    # Always retain support extrema, even when a small feature lies between
    # deterministic evenly spaced samples.
    extreme = np.concatenate((vertices.argmin(axis=0), vertices.argmax(axis=0)))
    return np.concatenate((vertices[vi], vertices[extreme], vertices[faces[fi]].mean(axis=1)))


def distances(points, tree):
    values = []
    for point in points:
        nearest = tree.find_nearest(Vector(point))
        if nearest[0] is None or not math.isfinite(nearest[3]):
            raise ValueError("Fidelity measurement could not find a derived surface")
        values.append(nearest[3])
    return np.asarray(values, dtype=np.float64)


def silhouette(tree, bounds, axis, resolution=SILHOUETTE_RESOLUTION):
    low, high = bounds
    axes = [i for i in range(3) if i != axis]
    padding = max(high - low) * 0.02
    direction = Vector([(-1 if i == axis else 0) for i in range(3)])
    result = np.zeros((resolution, resolution), dtype=bool)
    for row in range(resolution):
        for column in range(resolution):
            point = high.copy()
            point[axis] += padding
            point[axes[0]] = low[axes[0]] - padding + (column + 0.5) / resolution * (high[axes[0]] - low[axes[0]] + padding * 2)
            point[axes[1]] = low[axes[1]] - padding + (row + 0.5) / resolution * (high[axes[1]] - low[axes[1]] + padding * 2)
            result[row, column] = tree.ray_cast(Vector(point), direction, float(high[axis] - low[axis] + padding * 2))[0] is not None
    return result


def thin_features(vertices, faces, source_tree, derived_tree, scale):
    selected = np.linspace(0, len(faces) - 1, min(SURFACE_SAMPLES, len(faces)), dtype=int)
    points = vertices[faces[selected]]
    centers = points.mean(axis=1)
    normals = np.cross(points[:, 1] - points[:, 0], points[:, 2] - points[:, 0])
    normals /= np.maximum(np.linalg.norm(normals, axis=1)[:, None], 1e-30)
    epsilon = scale * 1e-6
    thicknesses, lost = [], 0
    for center, normal in zip(centers, normals):
        # Ray starts just inside the measured source face. Open/nonorientable
        # surfaces may have no opposing surface and are explicitly unmeasured.
        hit = source_tree.ray_cast(Vector(center - normal * epsilon), Vector(-normal), scale * 2)
        if (hit[0] is None or hit[3] <= epsilon * 2 or hit[1] is None
                or hit[1].dot(Vector(normal)) > -0.5):
            continue
        thickness = hit[3] + epsilon
        if thickness > scale * 0.03:
            continue
        thicknesses.append(thickness)
        nearest = derived_tree.find_nearest(Vector(center))
        if nearest[0] is None or nearest[3] > max(thickness * 0.5, scale * 0.001):
            lost += 1
    return {"sampledSourceFaces": len(selected), "thinSurfaceSamples": len(thicknesses),
            "thinThresholdMeters": scale * 0.03,
            "minimumMeasuredThicknessMeters": min(thicknesses) if thicknesses else None,
            "lostThinSurfaceSamples": lost,
            "lostThinSurfaceFraction": lost / len(thicknesses) if thicknesses else None,
            "applicable": len(thicknesses) >= 8,
            "method": "source inward ray with opposing-face normal dot <= -0.5; derived nearest surface",
            "limitation": "Sampled source geometry only; open sheets and features below the sampling/pixel grid are not certified"}


def fidelity(reference, derived, role="game"):
    rv, rf, rt = geometry(reference)
    dv, df, dt = geometry(derived)
    scale = float(max(rv.max(axis=0) - rv.min(axis=0)))
    if scale <= 0:
        raise ValueError("Reference mesh has no measurable extent")
    forward = distances(sample_points(rv, rf), dt)
    backward = distances(sample_points(dv, df), rt)
    both = np.concatenate((forward, backward))
    bounds = (np.minimum(rv.min(axis=0), dv.min(axis=0)), np.maximum(rv.max(axis=0), dv.max(axis=0)))
    views = []
    for axis in range(3):
        original = silhouette(rt, bounds, axis)
        result = silhouette(dt, bounds, axis)
        union = int((original | result).sum())
        intersection = int((original & result).sum())
        views.append({"viewAxis": "XYZ"[axis], "intersectionOverUnion": intersection / union if union else 1.0,
                      "applicable": union > 0,
                      "missingSourcePixelFraction": int((original & ~result).sum()) / max(1, int(original.sum())),
                      "sourcePixels": int(original.sum()), "derivedPixels": int(result.sum()),
                      "emptyViewPolicy": "Jointly empty edge-on views are equal/nonapplicable; one empty view remains a mismatch"})
    thin = thin_features(rv, rf, rt, dt, scale)
    limits = {"p95RelativeSurfaceError": 0.015 if role == "game" else 0.035,
              "maximumRelativeSurfaceError": 0.06 if role == "game" else 0.10,
              "minimumSilhouetteIoU": 0.88 if role == "game" else 0.78,
              "maximumLostThinSurfaceFraction": 0.03 if role == "game" else 0.10}
    p95, maximum = float(np.quantile(both, 0.95)), float(both.max())
    minimum_iou = min(v["intersectionOverUnion"] for v in views)
    failures = []
    if p95 / scale > limits["p95RelativeSurfaceError"]:
        failures.append("surface-p95")
    if maximum / scale > limits["maximumRelativeSurfaceError"]:
        failures.append("surface-maximum")
    if minimum_iou < limits["minimumSilhouetteIoU"]:
        failures.append("silhouette")
    if thin["applicable"] and thin["lostThinSurfaceFraction"] > limits["maximumLostThinSurfaceFraction"]:
        failures.append("thin-features")
    return {"passed": not failures, "failedMetrics": failures, "role": role,
            "normalizingExtentMeters": scale, "surfaceSampleCount": len(both),
            "p95SurfaceErrorMeters": p95, "maximumSurfaceErrorMeters": maximum,
            "p95RelativeSurfaceError": p95 / scale, "maximumRelativeSurfaceError": maximum / scale,
            "silhouetteResolution": SILHOUETTE_RESOLUTION, "silhouetteViews": views,
            "minimumSilhouetteIoU": minimum_iou, "thinFeatures": thin, "limits": limits,
            "method": "deterministic bidirectional surface samples plus native BVH orthographic silhouettes",
            "certifiesWatertightness": False, "certifiesUnseenGeometry": False}


def atlas(obj, resolution):
    """Rasterized surface union/strict-interior overlaps and actual texel density.

    Common triangle edges are excluded from overlap counting. Baking coverage
    is measured separately; dilated padding cannot inflate UV surface usage.
    """
    obj.data.calc_loop_triangles()
    layer = obj.data.uv_layers.active
    if layer is None:
        raise ValueError("Atlas measurement requires a real UV layer")
    mask = np.zeros((resolution, resolution), dtype=bool)
    counts = np.zeros((resolution, resolution), dtype=np.uint16)
    density = []
    uv_area = 0.0
    for tri in obj.data.loop_triangles:
        points = np.asarray([list(layer.data[i].uv) for i in tri.loops], dtype=np.float64)
        a, b, c = points
        area = abs(float(np.cross(b-a, c-a))) / 2
        uv_area += area
        world = np.asarray([list(obj.matrix_world @ obj.data.vertices[i].co) for i in tri.vertices])
        physical = float(np.linalg.norm(np.cross(world[1]-world[0], world[2]-world[0]))) / 2
        if physical > 1e-20 and area > 0:
            density.append(math.sqrt(area * resolution * resolution / physical))
        pixels = points * resolution
        low = np.maximum(0, np.floor(pixels.min(axis=0)).astype(int))
        high = np.minimum(resolution, np.ceil(pixels.max(axis=0)).astype(int))
        if np.any(high <= low):
            continue
        x, y = np.meshgrid(np.arange(low[0], high[0]) + 0.5, np.arange(low[1], high[1]) + 0.5)
        edges = [(q[0]-p[0])*(y-p[1])-(q[1]-p[1])*(x-p[0])
                 for p, q in zip(pixels, np.roll(pixels, -1, axis=0))]
        inside = np.logical_and.reduce([v >= -1e-8 for v in edges]) | np.logical_and.reduce([v <= 1e-8 for v in edges])
        strict = np.logical_and.reduce([v > 1e-8 for v in edges]) | np.logical_and.reduce([v < -1e-8 for v in edges])
        mask[low[1]:high[1], low[0]:high[0]] |= inside
        patch = counts[low[1]:high[1], low[0]:high[0]]
        np.add(patch, strict, out=patch, where=patch < 65535)
    covered = int(mask.sum())
    overlapping = int((counts > 1).sum())
    core = np.zeros_like(mask)
    core[1:-1, 1:-1] = mask[1:-1, 1:-1] & mask[:-2, 1:-1] & mask[2:, 1:-1] & mask[1:-1, :-2] & mask[1:-1, 2:]
    if not density or not covered:
        raise ValueError("Atlas has no measurable surface texels")
    quantiles = np.quantile(density, [0.10, 0.50, 0.90])
    measured = {"resolution": resolution, "surfaceTexels": covered,
                "surfaceUsageFraction": covered / (resolution * resolution),
                "overlappingInteriorTexels": overlapping,
                "interiorOverlapFraction": overlapping / max(1, covered),
                "continuousUVTriangleArea": uv_area,
                "texelDensityPixelsPerMeter": {k: float(v) for k, v in zip(("p10", "median", "p90"), quantiles)},
                "densityRatioP90P10": float(quantiles[2] / max(quantiles[0], 1e-12)),
                "densityMethod": "square root of UV pixel area / actual world-space triangle area",
                "overlapMethod": "strict triangle-interior pixel centers; shared edges excluded",
                "paddingIncludedInUsage": False,
                "subpixelOverlapCertified": False}
    return measured, mask.ravel(), core.ravel()


def shading_error(reference, derived):
    """Actual corner-normal deviation; does not evaluate baked normal textures."""
    rv, rf, tree = geometry(reference)
    geometry(derived)
    source_triangles = list(reference.data.loop_triangles)
    derived_triangles = list(derived.data.loop_triangles)
    chosen = np.linspace(0, len(derived_triangles) - 1, min(SURFACE_SAMPLES, len(derived_triangles)), dtype=int)
    angles = []
    rn = reference.matrix_world.to_3x3().inverted().transposed()
    dn = derived.matrix_world.to_3x3().inverted().transposed()
    for index in chosen:
        tri = derived_triangles[index]
        center = sum((derived.matrix_world @ derived.data.vertices[v].co for v in tri.vertices), Vector()) / 3
        point, _, source_index, _ = tree.find_nearest(center)
        if point is None or source_index is None:
            continue
        source_tri = source_triangles[source_index]
        positions = [Vector(rv[v]) for v in source_tri.vertices]
        normals = [rn @ reference.data.corner_normals[loop].vector for loop in source_tri.loops]
        source_normal = barycentric_transform(point, *positions, *normals)
        low_normal = sum((dn @ derived.data.corner_normals[loop].vector for loop in tri.loops), Vector())
        if source_normal.length > 1e-8 and low_normal.length > 1e-8:
            cosine = max(-1.0, min(1.0, source_normal.normalized().dot(low_normal.normalized())))
            angles.append(math.degrees(math.acos(cosine)))
    if not angles:
        raise ValueError("LOD shading comparison produced no finite normal samples")
    return {"samples": len(angles), "p95NormalDeviationDegrees": float(np.quantile(angles, 0.95)),
            "maximumNormalDeviationDegrees": max(angles),
            "opposedNormalSampleFraction": sum(angle > 90 for angle in angles) / len(angles),
            "method": "derived triangle-center corner normals versus barycentric source corner normals",
            "includesNormalTexture": False}
