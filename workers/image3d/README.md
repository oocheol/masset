# Local TripoSR CPU worker

This worker reconstructs **one existing transparent object image** with the older
TripoSR single-image model. It runs locally on CPU and exports actual vertex-colored
geometry. Modern Tripo Studio quality, UV textures, rigging and measured physical
scale are not claimed. This release is verified on Apple M4 Pro, 24 GiB RAM,
macOS arm64 and **system CPython 3.9.6**. Setup accepts Mac arm64 CPython 3.9 only;
Python 3.10–3.12 and Windows are unverified and rejected by this release.

## CLI

The desktop coordinator supplies its absolute data directory as the runtime root,
normally `data/image3d/triposr-cpu-v1`. These scripts accept any dedicated absolute
runtime path; venvs contain absolute interpreter paths and must not be relocated.
Worker and status resolve an existing coordinator-owned runtime symlink to its
real path, so `interpreterPath` remains verifiable. Setup requires the real root.

```sh
/usr/bin/python3 workers/image3d/setup.py \
  --runtime-root /absolute/data/image3d/triposr-cpu-v1 \
  --python-executable /usr/bin/python3

/usr/bin/python3 workers/image3d/status.py \
  --runtime-root /absolute/data/image3d/triposr-cpu-v1

/usr/bin/python3 workers/image3d/worker.py \
  --runtime-root /absolute/data/image3d/triposr-cpu-v1 \
  --input /absolute/job.json \
  --output-dir /absolute/new-output-directory
```

Setup uses Python's standard `venv`/`ensurepip`, verified public HTTPS downloads
and a local wheelhouse. It needs no uv, Codex runtime, Git, CUDA compiler, paid API
or credentials. All dependencies and compatible Mac CP39 wheels are fixed in
`runtime-lock.json`. ANTLR 4.9.3 is the sole source dependency: its pinned official
117,034-byte pure-Python archive is built offline with pinned setuptools/wheel.
Nothing compiles native extensions locally. Public Python/Hugging Face downloads
happen only during setup, with no inherited proxies or credential files.

Setup refuses populated unmanaged directories. Owned incomplete installations can
be retried; partial downloads are retained and not treated as usable models. An
active `.setup-lock` prevents competing installers. If setup was forcibly killed,
the coordinator must confirm that process has ended before removing its owned lock.
No user original is overwritten or deleted.

Job JSON has exactly these keys:

```json
{
  "name": "One object",
  "sourcePath": "/absolute/transparent-object.png",
  "sourceSha256": "64 hexadecimal SHA-256 characters",
  "quality": "standard",
  "cpuThreads": 4
}
```

`name` is 1–80 safe characters. `sourcePath` is an absolute PNG, JPEG or WebP
regular file; the actual decoded format is checked. Input must be one frame,
16–8192 pixels per dimension, at most 16 megapixels and 64 MiB. Existing meaningful
alpha and predominantly clear borders are required. Fully opaque inputs, including
JPEG, fail with `unsupported_background` until explicit preprocessing exists.
Empty alpha and multiple substantial disconnected foreground objects are rejected.
The alpha check is a connected-component heuristic, not semantic object detection.
Raw source bytes are read once and hashed, never rewritten. Python, Blender,
generated source, URLs and executable asset inputs are never accepted or executed.

Quality controls extraction grid resolution: draft 64, standard 128, high 192.
All use the same float32 checkpoint and 512-pixel conditioning image, density
threshold 25, foreground ratio 0.85 and 8,192-point decoder chunks. CPU threads
must be integer 1–4; PyTorch interop threads are fixed at one. Parent scheduling
reserves 8 GiB per job; measured native peaks were below 3.7 GB. Parent handles
cancellation, elapsed-time limits and the minimum host RAM policy.

## Output and events

Output can be a missing directory or a fresh existing empty directory. Populated
or symlinked output directories are rejected, with original contents preserved.
An exclusive `.image3d-running` reservation is removed only after success. Failed
jobs retain partial new artifacts for inspection and require a different empty
directory for a retry.

Success writes exactly:

* `mesh.glb`: GLB 2.0 with real nonplanar triangles and linear float32 `COLOR_0` vertex colors.
* `prepared-input.png`: 512 × 512 RGB input, composited over neutral gray from
  the source's existing alpha. No rembg import or background model download.
* `generation.json`: source hash, pinned revisions, offline/device/runtime
  metadata, preprocessing, stage durations, peak RSS, geometry and artifact hashes.

TripoSR uses a right-handed Z-up model space. The raw mesh is rotated by
`(x, y, z) -> (x, z, -y)` into **glTF Y-up**, scaled to exactly **one metre high**,
centered on X/Z and placed on Y=0. These are normalized asset units; the image
does not establish physical size. `geometry` records the full rotation, scale,
translation, `upAxis`, `units`, bounds, vertex and triangle counts. Blender's
separate finisher may rescale it; `mesh.glb` is the only primary GLB here.

TripoSR's official PNG renderer displays decoder RGB directly as image bytes.
The worker treats those values as sRGB, re-queries them at original model-space
mesh vertices without trimesh's uint8 quantization, and applies the inverse sRGB
transfer function before exporting **linear float32 RGBA** `COLOR_0`. glTF vertex
colors are linear multipliers; storing the displayed RGB directly made colors
too bright in conforming viewers. `colorEncoding` records the transfer, precision,
means and numerical round-trip error. `glb_color.py` appends an audited color
buffer/accessor while preserving all geometry bytes. Source image perspective
is not calibrated; `cameraConvention` records the upstream +X viewing / +Y image
right / +Z up convention and its Y-up export transform for later projection work.

Before color sampling, numerical marching-cubes faces at or below `1e-12` square
metres relative to the normalized one-metre height are removed. Cleanup fails if
it would remove over 1% of faces or `1e-8` of total surface area. It never merges
vertices, reorients faces, or fills holes. `meshCleanup` records exact counts, area
fraction, winding and watertightness before/after; the exported mesh retains the
strict minimum triangle-area check. Removing a sliver may leave a microscopic
boundary, so watertightness is reported rather than promised.

Stdout contains JSON lines with `type` equal to `stage`, `artifact`, `completed`
or `failed`. Artifact events and completion list fixed basenames, SHA-256 and
bytes. Completion includes `elapsedSeconds`, `model`/`modelId`, `modelRevision`,
`codeRevision`, `device`, `quality`, `cpuThreads`, `geometry.vertexCount`,
`geometry.triangleCount` and `peakRssBytes`. Errors use stable `code` and useful
`message` fields. Diagnostic tracebacks/warnings use stderr. The actual exported
GLB is reopened to verify counts, bounds and colors before completion.

## Runtime verification and provenance

`ready.json` exposes the parent API fields `state: "ready"`, `interpreterPath`
(absolute venv interpreter), `pythonVersion`, `modelId`, `modelRevision`,
`codeRevision`, `modelSha256` and `cpuThreads`. `installVerified: true` means
versioned dependencies, native CPU tensor operations, scikit-image extraction and
audited model imports passed. Setup sets `inferenceVerified: false`; only a worker
that actually exports and reopens its mesh changes it to true and adds an
artifact-backed `inferenceProof`. No model inference is inferred from installation.

`status.py` always returns one sanitized object with `state: "ready" | "missing" |
"error"`, `message` and `installed`. Ready status checks pinned model/config/code
bytes and installed dependency versions with the recorded venv interpreter.
Neither it nor runtime JSON includes inherited environment variables or tokens.

Inference verifies all code and model hashes before importing upstream classes or
loading weights. It launches the isolated venv with `-I -B`, a small allowlisted
environment, empty private HOME and private caches. Socket connections are denied.
Both Hugging Face and Transformers are forced offline; the image tokenizer reads
its cached pinned JSON directly. The checkpoint uses
`torch.load(..., map_location="cpu", weights_only=True)` and strict state loading.
Only the exact trusted official checkpoint can reach this loader. CPU is selected
explicitly; no MPS/native GPU support is claimed.

Pinned sources:

* [TripoSR code](https://github.com/VAST-AI-Research/TripoSR/tree/107cefdc244c39106fa830359024f6a2f1c78871),
  archive SHA-256 `bcb414550dcfcb9f5ea6a7b9c12f2bbff889f5b4a564a493178393360d9034ec`.
* [Official weights](https://huggingface.co/stabilityai/TripoSR/tree/5b521936b01fbe1890f6f9baed0254ab6351c04a),
  1,677,246,742 bytes, SHA-256
  `429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee`.
* [DINO image tokenizer configuration](https://huggingface.co/facebook/dino-vitb16/tree/f205d5d8e640a89a2b8ef0369670dfc37cc07fc2).
  DINO weights are already inside the TripoSR checkpoint; no separate DINO model
  or textual tokenizer is required. Configuration, preprocessor metadata and
  model cards are cached during setup.

`upstream_patch.py` makes four exact, locked edits: local-only checkpoint loading
with `weights_only=True`, local DINO configuration, removal of rembg import/use,
and the small audited CPU `image3d_adapter.py`. The adapter corrects coordinate
order and winding for upstream's grid; an asymmetric ellipsoid test verifies it.
Original code archive and weight bytes remain preserved. Texture-baking code and
its unused xatlas/moderngl dependencies are omitted from the inference snapshot.

## Licenses and native proof

Worker code is MIT; the owned sphere fixture/generator is CC0-1.0. The pinned
TripoSR code license and model card state MIT. Three upstream transformer files
retain Hugging Face Apache-2.0 headers as well as TripoSR's modifications notice.
DINO's card states Apache-2.0. Full relevant texts and immutable source references
are in `licenses/`. Runtime `licenses/distributions/` retains wheel license/notice
texts and full package metadata, including NumPy/SciPy/PyTorch bundled library
notices. Supplementary pinned ANTLR/tokenizers/safetensors texts cover packages
whose wheels omit them. The full runtime provenance records archive hashes,
installed dependencies and these sources.

`tests/native-proof.json` records actual Mac results and compact artifact paths.
Tests do not assert browser or untested native platform support:

```sh
/absolute/runtime/venv/bin/python -I -B workers/image3d/tests/test_worker.py
/absolute/runtime/venv/bin/python -I -B workers/image3d/tests/verify_artifacts.py \
  --output-dir workers/image3d/output/native-game-high-linear-final \
  --events workers/image3d/output/native-game-high-linear-final-events.jsonl
```

The native test artifacts were generated directly by system-Python-created
environments on this Mac. Initial draft/high fixtures and the preserved generated
weapon established CPU inference. Final **standard and high both use the same
weapon PNG** from `output/game-bundle/native-mixed-live-20261004T043300Z`; its
original SHA-256 is verified again after inference. On this Apple M4 Pro, 24 GiB
Mac, final standard produced 6,828 triangles in 6.953 seconds at 3.619 GB peak RSS;
high produced 15,943 triangles in 9.189 seconds at 3.621 GB. Both remain below the
8 GiB reservation. These are measured worker durations, not complete Blender jobs.

All 24 native tests pass, including inverse-sRGB reference values, float32 GLB
color/geometry round trips, invalid-color rejection, scale-invariant cleanup and
retention of strict geometry validation. Independent artifact checks and equal
camera Blender 5.2.1 CPU renders are recorded under `output/`. Render tests use
factory startup with script auto-execution disabled. Final color-corrected raw
GLBs are `output/native-game-standard-linear-final/mesh.glb` and
`output/native-game-high-linear-final/mesh.glb`. Earlier direct-uint8 color proof
artifacts are preserved as historical runtime evidence and are superseded.

The corrected gun renders darker with stronger navy/cyan separation. High adds
surface samples but retains TripoSR's soft neural geometry: straight edges,
small openings and mechanical details are not reliably reconstructed. The color
fix does not establish sharp weapon quality or modern Tripo Studio parity.
