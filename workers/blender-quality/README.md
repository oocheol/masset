# Blender mesh-quality finishing worker

This independent worker is **GPL-3.0-or-later**, with the same Blender process
boundary as `workers/blender`. See [LICENSE](LICENSE). It uses native Blender
and its bundled Python/NumPy; no network, paid services or Python installation.

```sh
/Applications/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup --disable-autoexec --threads 2 \
  --python workers/blender-quality/worker.py -- \
  --input /absolute/job.json --output-dir /absolute/new-or-empty-directory
```

The job is UTF-8 JSON, at most 16 KiB, containing **exactly**:

```json
{
  "sourcePath": "/absolute/self-contained.glb",
  "sourceSha256": "64 hexadecimal characters",
  "name": "Safe name, 1 to 80 characters",
  "heightMeters": 1.8,
  "maxTriangles": 10000,
  "textureResolution": 1024,
  "sourceKind": "image3d",
  "preserveMaterials": true
}
```

`heightMeters` is finite, 0.03–100. `maxTriangles` is an integer, 1000–100000.
`textureResolution` is exactly 512, 1024 or 2048. `sourceKind` is `image3d` or
`model`. `preserveMaterials` is a boolean. Duplicate, missing and unknown keys,
NaN/Infinity, unsafe names, relative source paths and .blend inputs are rejected.

The source is a complete GLB 2.0, at most 64 MiB, with one embedded BIN buffer,
static triangle meshes, and PNG/JPEG images in embedded bufferViews. **All URI
fields, including data URIs, and required extensions are rejected.** Static
finishing rejects animation, skin, morph, sparse and compressed accessors rather
than flattening them silently. Binary accessor ranges, indices, finite values,
node graphs, decoded image dimensions and geometry counts are bounded before
import. No input code, script paths or asset scripts are executed. The verified
bytes are imported from a private snapshot, closing the hash-to-import race.
Original inputs are never written. Outputs must be a new or existing empty
directory; a populated directory is rejected, even after a previous failure.

The pipeline preserves normalized original geometry and material graphs, makes
a game copy that welds coincident importer seam vertices at a scale-relative
1e-7 tolerance, removes loose geometry, applies budgeted collapse decimation,
recomputes game shading with sharp edges, centers the derived mesh at its
bottom-center pivot, smart-projects a new atlas UV, and performs
CPU Cycles emission bakes of **actual source base-color/vertex-color graphs**.
With material preservation enabled it bakes source roughness/metallic into
`orm.png` (R=1 is neutral, not invented AO), and source emission when present.
Alpha is baked from the source when needed. A selected high-to-low tangent
normal bake is included only when sampled projection and variation checks pass.
It is labeled **mesh-derived normal**, never PBR inferred from a color image.
If projection fails, base/PBR colors are baked from the decimated mesh's
interpolated original attributes, explicitly reported; normal output is omitted.
LOD1 uses fewer triangles and inherits the game atlas; it has no separate normal
rebake. Collapse decimation is not retopology. Source holes/overlaps are retained.
Watertight volume, CAD, rigs and unseen geometry quality are not certified.

## Data and artifact contract

Fixed artifact basenames:

- `high-detail.glb`: original triangle geometry, normalized height, source colors
  and materials. Raw source remains in its parent project.
- `game-ready.model.glb`: actual budgeted mesh, UVs, normals, embedded PBR base
  color; includes meaningful normal and source core PBR textures when available.
- `lod1.glb`: actual mesh under half the game triangle budget/count.
- `source.blend`: editable high-detail, game and LOD meshes, packed images,
  CPU render studio, four camera keyframes; no text blocks or drivers.
- `basecolor.png`, optional `normal.png`, `orm.png`, `emission.png`.
- `thumbnail.png` at 1024×1024, `turntable-00.png` through `turntable-03.png`
  at 512×512 from four distinct 90-degree camera positions.
- `validation.json`: measured source/high/game/LOD counts, texture statistics,
  UVs/normals/budgets, source preservation, caveats, binary export inspection.

Stdout interleaves Blender logs and JSON records. Parse **only valid JSON lines**:

- `{"type":"stage","stage":"bake-basecolor",...}` with named stages.
- `{"type":"artifact","path":"basecolor.png","format":"png","role":"texture",
  "bytes":123,"sha256":"..."}`: fixed basename, actual bytes and hash.
- `{"type":"completed","artifacts":[...],"mesh":{...},"validation":{...}}`.
- `{"type":"failed","stage":"...","error":"...","errorType":"..."}` on failure.

Validation top-level is `{valid,checks,warnings,mesh,...}`. Every check contains
`code`, `status` (`pass`, `warn`, `fail`), `message` and optional numeric/string
`measured`. `mesh` contains exported vertex/triangle counts,
`dimensions:[width,height,depth]`, `unit:"m"`, `axis:"Y-up"`, bottom-center pivot.
Backend integration must independently parse artifact bytes, embedded images,
UVs, normals and triangle budgets; reports are evidence, not authoritative data.

### Neural source orientation (must agree upstream)

**The source GLB must already represent standard glTF Y-up.** Blender's glTF
import converts this to internal Z-up; normalization uses internal vertical Z,
then exports GLB Y-up. `sourceKind` records provenance only and never guesses a
model's coordinate frame. TripoSR/torchmcubes grid-axis permutations do not
establish semantic object-up. If upstream mesh extraction is Z-up, upstream must
rotate `(x,y,z)` to `(x,z,-y)` before GLB serialization. A tagged bounding box or
ellipsoid test verifies axis math but cannot prove semantic up in a neural model.
Template proof demonstrates finishing only; a separately generated neural GLB
is required to demonstrate a new image-derived silhouette. Standard glTF
vertex colors are linear. The finisher never reinterprets their bytes as sRGB.
For an image3d mesh with COLOR_0, no material and no embedded images, high/game
display defaults are explicitly neutral metallic=0 and roughness=0.6. They are
not PBR inferred from the image. Authored materials retain their source values.

## Verification

`tests/test_audit.py` runs without Blender and checks adversarial bounded inputs.
`verify_native.py` is a separate trusted Blender script that independently
reimports each exported GLB and opens the saved .blend with autoexec disabled.
It inspects actual UVs/normals/images, material references, dimensions, budgets,
packed source images, no scripts/drivers, preview dimensions, source hashes, and
artifact hashes. It writes its own evidence **outside** the artifact directory.
The worker correctly reports independent reopen as unperformed; only a separate
successful verifier run establishes that proof. Mac native verification is the
current target; Windows native support is not claimed by this module.

## Native Mac evidence (2026-10-04)

All paths below are relative to output/quality3d. Evidence is local; it does not
establish Windows support or reconstructed geometry matching the photograph.

| Case | High / game / LOD1 triangles | Independent evidence |
| --- | --- | --- |
| Existing native spaceship, corrected seams | 1980 / 980 / 480 | blender-native-final-20261004T110700Z/independent-reopen.json: 71 checks pass |
| Synthetic vertex-color mesh | 5120 / 980 / 480 | blender-vertex-color-20261004T105500Z-reopen.json: native reopen passes |
| Embedded RGB + authored emission, roughness 0.23, metallic 0.65 | 3968 / 980 / 480 | blender-embedded-rgb-emission-20261004T110600Z-reopen.json: 69 checks pass |
| Actual neural gun, neutral defaults | 6828 / 6828 / 3344 | blender-neural-gun-color-20261004T111200Z/independent-reopen.json: 65 checks pass |

The neural gun comparison is
blender-neural-gun-color-20261004T111200Z/comparison/color-fidelity.json.
Across 6369 surface samples, mean absolute RGB errors are
0.000097 / 0.000093 / 0.000138; the 95th-percentile maximum channel error is
0.000446. Raw native import already has metallic 0, roughness 0.5. Recorded
neutral display changes roughness to 0.6. Identical-camera raw-default-material,
raw-neutral-material and finished-game PNGs are in that comparison directory.
Pale colors and the coarse reconstructed shape are already visible in raw data.
Predicted sRGB colors must be converted to glTF linear COLOR_0 by the raw
exporter; the finisher preserves standard GLB color semantics.

Spaceship source/game reference renders are in
blender-native-weld-20261004T104701Z/reference; the final corrected thumbnail is
blender-native-final-20261004T110700Z/artifacts/thumbnail.png. Final game and LOD
have zero loose edges. Texture PNG bytes exactly match embedded material images.
Actual UV pixel centers are rasterized independently; reported surface coverage
excludes padding. A white bake measures interior projection hits. ORM R=1 is
explicit neutral AO, not inferred AO; uniform PBR channels retain source factors.
Normal projections opposed by more than 60 degrees are omitted locally, and
maps with at least two percent unreliable interior texels are rejected.
Eight adversarial boundary tests, including mutation tables, pass.
