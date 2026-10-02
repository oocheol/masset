# Procedural Blender worker

Status: implemented; native Windows x64 execution and GLB/.blend reopening verified on 2026-10-02 with Blender **5.2.1 LTS**, build `9e2066aef7ef`. macOS arm64/x64 execution is unverified. The worker requires a user-installed Blender; no binary download, GPU model, paid API, HTTP service or Docker is required.

## Run

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' `
  --background --factory-startup --disable-autoexec --threads 2 `
  --python workers/blender/worker.py -- `
  --input tests/blender/crate.json --output-dir 'C:\AssetProjects\crate-v1'
```

Input is the shared `ModelParameters` JSON object, with exactly `template`, `name`, `width`, `depth`, `height`, `color`, `bevel`. Templates are `crate`, `table`, `shelf`. Dimensions are meters, finite values from **0.03 through 100**. Bevel is nonnegative and at most one quarter of the smallest requested dimension; thin components clamp their own bevel to preserve proportions. Hex color is `#RRGGBB` interpreted as sRGB and converted to linear shader inputs. Names support Korean and spaces, have 1–80 visible characters, and cannot contain path/control syntax. The name is object metadata, never an output path.

Input is limited to 16 KiB. Unknown/duplicate keys, script or path fields, NaN/Infinity, boolean dimensions, unsupported templates, invalid colors and out-of-range values fail before an output directory is created. The worker executes only its trusted procedural functions. It does not load user `.blend` files, execute generated scripts, import remote assets, read authentication state or make network requests.

### Approved bundle style forwarding

The original CLI and exact seven-key model JSON remain valid. Optionally pass `--style-file tests/blender/style.json` after `--` to provide a **separate** shared `StyleGuide` JSON. It must contain exactly its ten contract fields and `approved: true`. IDs/reference IDs are opaque bounded identifiers; file paths and URLs are rejected, and references are recorded as provenance without opening them. Palette is 1–16 `#RRGGBB` colors; line weight is 0–24 and margin 0–128, finite numeric values. Name/detail are bounded plain text. Unknown or duplicate fields and unapproved styles fail before writing artifacts.

Supported camera presets/aliases: `orthographic 3/4` (`orthographic three-quarter`, `직교 3/4`), `orthographic front` (`직교 정면`), `orthographic top` (`직교 상단`). Supported lighting: `soft studio` (`studio soft`, `스튜디오 소프트`). Unknown camera/light instructions are rejected instead of being silently ignored. The selected camera affects the actual thumbnail render and saved scene; the four turntable viewpoints remain fixed and are recorded separately. Soft studio creates three area lights and an actual world shader; report values come from the constructed Blender scene.

The required `ModelParameters.color` explicitly overrides the **primary** material color. Palette index 1 (or the sole index 0) supplies detail materials; index 2 (or last available) supplies accent materials. The GLB contains those actual shader color factors. `validation.json.styleGuide` records requested style, actual camera/light settings and material choices, reference provenance and `identityGuarantee: false`. Line weight, semantic detail and exact pixel margin are recorded under `notApplied`; this renderer does not claim to interpret them. Style forwarding changes materials/preview setup, never the requested geometry.

Run only the newly added style scenario without rerunning the geometry suite:

```powershell
powershell -NoProfile -File tests/blender/run-tests.ps1 -StyleOnly
```

It produces a real style-front crate, independently reopens GLB and `.blend`, then inspects actual source-camera orientation/position, area-light type/energy, primary color override and palette colors in both source nodes and GLB PBR factors. Additional data-only adversarial schema tests in `tests/blender/test_style_schema.py` rejected twelve invalid/unapproved/path/script/unsupported-input cases; evidence is in `tests/blender/artifacts/style-schema-01/summary.json`.

Executed style-only evidence: `tests/blender/artifacts/run-20261002-150044-4d5a00bc/summary.json`, passed in 26.491 seconds. `approved-style/style-verification.json` contains independent actual scene/material checks; GLB and `.blend` fresh-process reports are adjacent. The real front thumbnail was visually inspected. Core native-app forwarding requires separate desktop integration verification and has not been executed on this host; this result proves the worker CLI and artifacts only.

The final style fixture deliberately uses a first palette color (`#c78272`) different from the model's primary color (`#799993`). A style-only rerun passed in 23.093 seconds at `tests/blender/artifacts/run-20261002-150220-b4088e43/summary.json`, proving the primary override from actual source and GLB factors rather than matching input colors by coincidence. The prior evidence directories remain preserved.

The scheduler reserves a unique output directory and passes the input file as an argument array to Blender. The directory may already exist if empty. A populated directory is rejected, including artifacts from a failed run. The worker never deletes or overwrites user originals. Final files are promoted from `.partial` files with `os.replace` only inside that fresh directory. A crash can leave partial files; preserve that job directory and start a new version rather than reusing it.

## Actual geometry and files

| File | Contents |
| --- | --- |
| `model.glb` | Actual indexed mesh, UVs, normals, Principled PBR materials and source metadata; no camera, studio floor or light exported |
| `source.blend` | Editable mesh plus studio camera, floor and lighting; no embedded text/script blocks |
| `thumbnail.png` | Actual CPU Cycles render, 512 × 512 RGBA |
| `turntable-00.png` … `turntable-03.png` | Actual CPU renders at four 90° viewpoints, 256 × 256 RGBA |
| `validation.json` | Parameters, native tool version, mesh measurements, validation checks, generation duration and separate round-trip status |

The `.blend` scene uses metric units and **Z-up** coordinates. The GLB exporter converts to glTF **Y-up** coordinates and meters. Both have a bottom-center object origin. Shared report `mesh.dimensions` is `[width, height, depth]` in GLB coordinates; `sourceInspection.sourceDimensions` is `[width, depth, height]` in Blender coordinates. UV/normal seams split exported vertices; report `mesh.vertices` counts GLB POSITION accessors, while `sourceInspection.vertices` counts editable Blender vertices. A fixed 10,000-triangle ceiling is enforced; the desktop bridge must also enforce a project budget if it is lower.

Each solid component has outward normals and closed manifold edges. Joined furniture/crate pieces can intersect. This is a visualization assembly with closed components, **not** a boolean-unioned CAD solid or verified manufacturing design. The report explicitly records that distinction. Bevel modifiers are baked; UVs are generated on the actual mesh. No physical material measurement, normal/AO texture synthesis or material scan is claimed.

Standard-output lines contain JSON `stage`, `artifact`, `completed`, or `failed` events. Blender/exporter logs are also present: the bridge should parse only valid JSON event lines. `artifact.path` is an output-directory-relative basename, with SHA-256 and byte length. `completed` provides `mesh`, `validation`, and `artifacts`. The worker emits named steps without guessed percentage progress. The caller owns cancellation by terminating the entire local process tree and marking its job cancelled; already promoted output files remain available.

## Verification

```powershell
powershell -NoProfile -File tests/blender/run-tests.ps1
```

The runner creates a new UUID run directory under `tests/blender/artifacts`, including Korean/spaced path components. For every template it launches the real worker, then **separate factory-startup Blender processes** that import GLB and reopen `.blend` with script execution disabled. An independent binary GLB parser checks container/accessor bounds, actual vertex values, triangle indices, unit normals, UV range, material references, Y-up dimensions and absence of external texture/buffer URIs. The reopened scenes verify source dimensions, pivot, mesh existence, triangle count, UV and material assignment. The renderer must produce real PNG signatures; representative PNGs are additionally visually inspected.

The runner also rejects script fields, path traversal names, nonfinite values, booleans, duplicate JSON fields, excessive dimensions/bevel and attempts to overwrite completed artifacts; the original GLB hash must remain unchanged. Worker validation alone reports `roundTrip.status = not-run-in-worker`; passing runtime generation does not imply a fresh-process round-trip was performed. Test evidence is saved in separate `roundtrip-glb.json`, `roundtrip-blend.json` and run `summary.json` files.

The initial independently verified crate is under `tests/blender/artifacts/crate-smoke-01`: 840 editable vertices, 3,240 exported vertices, 1,620 triangles, 3 material primitives, meter bounds 1.2 × 0.8 × 0.9. Its initial preview took 38.888 seconds including four full-size turntable frames; the worker now renders turntable frames at 256px and avoids coplanar crate corner overlap. This is a measured single-machine result, not a general performance promise. The test suite records the current worker timings separately.

Current native suite evidence: `tests/blender/artifacts/run-20261002-144153-2bea8148/summary.json`, **11 scenarios passed** in 79.756 seconds, including 3 generated templates (each with independent GLB and `.blend` round-trips), 7 invalid input cases and original-preservation verification. Crate/table/shelf contain 1,620 / 972 / 756 triangles; generation durations were 15.007 / 11.335 / 12.706 seconds with two CPU threads. Rendered previews were visually inspected. No macOS test is included in this result.

The latest crate fixture `tests/blender/artifacts/crate-current-02` additionally verifies the final metadata change: `mesh.vertices = 3240` matches actual exported accessor counts and the independent importer, with 840 editable source vertices. Its GLB and `.blend` passed separate fresh-process checks; the original smoke/version folders were preserved.

Final repository examples are under `examples/procedural/run-8fa3777b7c994505ba1c5592453a8543`. Each of `crate`, `table`, `shelf` was generated from current worker code with the same approved default style file, sequentially with two CPU threads, and passed fresh GLB and `.blend` reopening. `verification.json` records exact parameters, exported/source vertex counts, actual style settings, SHA-256 hashes and process policy. Exported counts are 3,240 / 1,944 / 1,512 vertices and 1,620 / 972 / 756 triangles. The previews were visually inspected. These are direct worker examples; `nativeAppIntegrationVerified` is explicitly false and they do not establish a Tauri app build or desktop integration run.

## Licensing and packaging

`workers/blender` Python code is **GPL-3.0-or-later** with SPDX headers; the full GNU GPL v3 text is in `workers/blender/LICENSE`. License notices and corresponding source must accompany distributions as applicable. Running Blender as a separate process is an engineering boundary, not a declaration that Blender's GPL obligations disappear. Blender is currently an external installation and is not bundled by this project.

[Blender's official license page](https://www.blender.org/about/license/) explains Blender's GPL licensing and the separate ownership of work produced with it. Asset rights also depend on any user-supplied reference/content licenses; this worker uses procedural geometry and solid materials only. A future installer that bundles Blender must include its license, source obligations, version and third-party notices. The desktop core's own license is recorded separately by the coordinator.
