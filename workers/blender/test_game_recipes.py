# SPDX-License-Identifier: GPL-3.0-or-later
"""Trusted Blender tests for fixed recipe geometry and data-only input limits."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

import bpy


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    args.output_dir.mkdir(parents=True, exist_ok=False)
    spec = importlib.util.spec_from_file_location("trusted_worker", Path(__file__).with_name("worker.py"))
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    fixture = {"template": "sword", "name": "Fixed recipe QA", "width": 1.2, "depth": .8,
               "height": .9, "color": "#799993", "bevel": .01}
    shapes = {}
    checks = []
    features = {"sword": ("blade", "crossguard", "hilt"), "rifle": ("receiver", "grip", "barrel"),
                "spaceship": ("hull", "wing", "engine"), "barrel": ("body", "band", "lid"),
                "rock": ("faceted",), "tree": ("trunk", "crown")}
    variants = (("regular", (1.2, .8, .9), .01), ("zero-bevel", (.03, .03, .03), 0),
                ("maximum-bevel", (.03, .03, .03), .0075),
                ("wide-thin", (100, .03, .03), .0075),
                ("deep-thin", (.03, 100, .03), 0), ("tall-thin", (.03, .03, 100), .0075),
                ("maximum-size", (100, 100, 100), 25))
    for template in sorted(worker.TEMPLATES):
        for label, dimensions, bevel in variants:
            # Extreme bevel/aspect tests are required for the new silhouettes.
            if template not in features and label != "regular":
                continue
            parameters = {**fixture, "template": template, "width": dimensions[0], "depth": dimensions[1],
                          "height": dimensions[2], "bevel": bevel}
            path = args.output_dir / f"{template}-{label}.json"
            path.write_text(json.dumps(parameters), encoding="utf-8")
            parameters = worker.read_parameters(path)
            model, components = worker.build_model(parameters)
            inspected = worker.inspect_model(model)
            tolerance = max(dimensions) * 1e-5
            require(0 < inspected["triangles"] <= 10000 and inspected["vertices"] > 0, "Nonempty bounded mesh")
            require(inspected["openEdges"] == 0, f"Closed components: {template}/{label}")
            require(inspected["finiteNormals"] and inspected["uvLayers"] == 1, "Finite normals and baked UVs")
            require(all(abs(a - b) <= tolerance for a, b in zip(inspected["sourceDimensions"], dimensions)),
                    f"Canonical dimensions: {template}/{label}")
            require(all(abs(v) <= tolerance for v in inspected["origin"]), "Bottom-center origin")
            require(abs(inspected["boundsMin"][2]) <= tolerance, "Bottom is Z zero")
            require(all(abs(inspected["boundsMin"][i] + inspected["boundsMax"][i]) <= tolerance for i in (0, 1)),
                    "Centered horizontal bounds")
            require(not model.modifiers and len(model.data.materials) == 3, "Baked geometry and three palette materials")
            if template in features:
                names = " ".join(json.loads(model["assetStudioFeatures"])).lower()
                require(all(word in names for word in features[template]), "Named semantic recipe features")
                require(model["assetStudioRecipe"] == "fixed-game-geometry-v1", "Fixed recipe provenance")
                # An independent area check catches collapsed apex/cap faces.
                zero_area = 0
                for triangle in model.data.loop_triangles:
                    a, b, c = (model.data.vertices[i].co for i in triangle.vertices)
                    if (b - a).cross(c - a).length == 0:
                        zero_area += 1
                require(not zero_area, f"No collapsed faces: {template}/{label}")
                if label == "regular":
                    points = [tuple(round(c, 7) for c in vertex.co) for vertex in model.data.vertices]
                    shapes[template] = hashlib.sha256(json.dumps(points).encode()).hexdigest()
            elif label == "regular":
                require(inspected["triangles"] == {"crate": 1620, "table": 972, "shelf": 756}[template],
                        "Preserved existing template geometry")
            checks.append({"template": template, "variant": label, "valid": True, "components": components,
                           "inspection": inspected})
            print(json.dumps({"type": "geometry-check", "template": template, "variant": label,
                              "triangles": inspected["triangles"]}), flush=True)
    require(len(set(shapes.values())) == 6, "Six distinct recipe geometries")
    invalid = {"unknown-template": {"template": "arbitrary-code"}, "template-object": {"template": {"script": "never run"}},
               "script-field": {"script": "raise RuntimeError('never run')"}, "path-name": {"name": "../original"},
               "boolean-width": {"width": True}, "nonfinite-bevel": {"bevel": float("nan")},
               "invalid-color": {"color": "green"}}
    rejections = []
    for label, updates in invalid.items():
        path = args.output_dir / f"invalid-{label}.json"
        path.write_text(json.dumps({**fixture, **updates}), encoding="utf-8")
        try:
            worker.read_parameters(path)
        except ValueError as exc:
            rejections.append({"case": label, "rejected": True, "error": str(exc)})
        else:
            raise AssertionError("Invalid data accepted: " + label)
    require(not bpy.context.preferences.filepaths.use_scripts_auto_execute, "Blender script auto-execution disabled")
    result = {"valid": True, "blenderVersion": bpy.app.version_string, "geometryChecks": len(checks),
              "checks": checks, "distinctGeometryHashes": shapes, "rejections": rejections,
              "scriptAutoExecution": False}
    (args.output_dir / "summary.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"type": "geometry-completed", "checks": len(checks), "rejected": len(rejections)}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"type": "game-recipe-test-failed", "error": str(exc)}), flush=True)
        raise SystemExit(1) from exc
