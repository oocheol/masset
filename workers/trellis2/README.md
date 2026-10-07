# TRELLIS.2 local experimental worker

This worker uses Microsoft's reviewed TRELLIS.2 source and local safetensors. It never downloads runtimes/models, uploads images, authenticates with a provider, starts a paid fallback, or calls an online background-removal service. The current Windows machine has a 4 GiB GTX 1650 and is blocked before WSL or model loading. Actual TRELLIS.2 inference and the WSL2 CUDA path have **not** been verified on this machine.

Microsoft documents Linux and an NVIDIA GPU with at least 24 GB. This app conservatively requires **24 GiB (24,576 MiB)** reported GPU memory. Windows connects through an experimental WSL2 wrapper; native Windows, CPU and macOS Metal inference/export are unsupported. `low_vram=True` offloads stages but does not establish 4 GiB support.

The app's WSL wrapper additionally requires 32 GiB of physical system RAM and reserves 16 GiB in its job budget; this is an application scheduling policy, not an official TRELLIS.2 RAM requirement or a measured peak-memory claim.

## Prepared runtime layout

The user must separately prepare and accept a Linux CUDA environment. There is no setup/download command in this worker. Configure only its absolute Linux root and a WSL distribution name (for example `/home/user/trellis2-runtime`, `Ubuntu`). The interpreter path is derived, never supplied by an image job:

```text
<runtimeRoot>/
  runtime-manifest.json
  venv/
    bin/python
    lib/python3.<minor>/site-packages/
  source/
    trellis2/                         # exact pinned official Python files
    o-voxel/o_voxel/                  # exact pinned official Python files
  models/
    trellis2/
      pipeline.json
      ckpts/<seven inference prefixes>.json
      ckpts/<seven inference prefixes>.safetensors
    sparse-structure/
      ckpts/ss_dec_conv3d_16l8_fp16.json
      ckpts/ss_dec_conv3d_16l8_fp16.safetensors
    dinov3/
      config.json
      model.safetensors
```

`runtime-lock.json` records exact required filenames, sizes and digests from immutable official repository metadata. Git blob SHA-1 identifies small pinned source/config files; Hugging Face LFS SHA-256 identifies every model tensor file. The nine required safetensors files total **16,180,022,310 bytes (about 15.1 GiB)**, excluding Python, CUDA/native libraries, configs, build caches and outputs. No BRIA/RMBG files are required or loaded. Both 512 and 1024 flow models are required by this first worker implementation, even for a draft job.

Pinned revisions are:

| Source | Revision |
| --- | --- |
| Microsoft TRELLIS.2 code | `75fbf0183001ed9876c8dbb35de6b68552ee08bd` |
| Microsoft TRELLIS.2-4B | `af44b45f2e35a493886929c6d786e563ec68364d` |
| Microsoft TRELLIS-image-large sparse decoder | `25e0d31ffbebe4b5a97464dd851910efc3002d96` |
| Meta DINOv3 ViT-L/16 | `ea8dc2863c51be0a264bab82070e3e8836b02d51` |

## Accepted local manifest

`runtime-manifest.json` is a record of an explicitly accepted prepared environment. It is not an authorization to download or execute code contained in an asset. Supply the exact dependency versions actually installed and every native `.so` file under `source/` and the venv site-packages tree. Native libraries built locally have no invented official binary hash: the user accepts these local files and their measured SHA-256 values. Model hashes still come from the worker's immutable official lock, not user-proposed weight hashes.

```json
{
  "schemaVersion": 1,
  "pins": {
    "codeRevision": "75fbf0183001ed9876c8dbb35de6b68552ee08bd",
    "modelRevision": "af44b45f2e35a493886929c6d786e563ec68364d",
    "sparseRevision": "25e0d31ffbebe4b5a97464dd851910efc3002d96",
    "dinoRevision": "ea8dc2863c51be0a264bab82070e3e8836b02d51"
  },
  "acceptedSources": true,
  "acceptedDependencyLicenses": true,
  "dependencyVersions": {
    "torch": "<installed version>",
    "torchvision": "<installed version>",
    "transformers": "<installed version with DINOv3ViTModel>",
    "safetensors": "<installed version>",
    "Pillow": "<installed version>",
    "numpy": "<installed version>",
    "trimesh": "<installed version>",
    "cumesh": "<installed version>",
    "flex-gemm": "<installed version>",
    "nvdiffrast": "<installed version>",
    "flash-attn": "<installed version>"
  },
  "nativeFiles": [
    {
      "path": "venv/lib/python3.<minor>/site-packages/<actual library>.so",
      "bytes": 123456,
      "sha256": "<actual 64-character SHA-256>"
    }
  ]
}
```

The placeholders above are documentation, not a working manifest. The default upstream install script has unpinned dependencies/native Git sources; this project does not claim a fully reproduced compatible binary distribution. Preparation must retain dependency provenance and review the actual environment. Core/model MIT licenses do not establish clearance for the whole stack: DINOv3 has custom terms and a manual gate, and reviewed CUDA-export libraries have NVIDIA license conditions. `licensingStatus` remains `dependencies_require_review`; no generic commercial-game clearance is asserted.

## Probe, run and receipts

The coordinator invokes the fixed Windows WSL executable with direct arguments, derived `<runtimeRoot>/venv/bin/python`, and `-I -S`. The worker adds only the acknowledged venv site-packages and digest-checked model source. `.pth` startup files are not executed, model source is compiled directly without trusting cached `.pyc`, and unexpected model Python files are rejected.

`--probe` checks local source/config hashes, tensor/native file sizes, dependency metadata and CUDA imports. It does not load model weights, send an image, or establish inference support. A candidate result has `status=preparedUnverified`, `ready=false`, `available=true`, `hashesVerified=false`, and `inferenceVerified=false`. Full tensor/native SHA-256 checks occur before every run, because hashing more than 15 GiB cannot reliably fit a short startup probe.

The run interface is `--runtime-root ROOT --input JOB_JSON --output-dir NEW_DIRECTORY`. `JOB_JSON` contains only `name`, `sourcePath`, `sourceSha256`, `quality` (`draft`, `standard`, `high`), `seed`, `textureResolution`, and `maxTriangles`. Only one static local PNG/WebP with a real RGBA foreground mask is accepted, bounded to 64 MiB, 16 Mipixels and 4096 pixels per side. The image is validated before full tensor hashing. Quality selects 512, 1024 cascade or 1536 cascade; it does not guarantee a particular measured topology. A requested 512 texture is exported at 1024 for the later game finisher to reduce. The GLB is bounded to 64 MiB, matching the desktop inspector.

Preprocessing reproduces the reviewed alpha-threshold square crop and black composite locally. Transparent hidden RGB is removed. The pipeline is built manually from checked local safetensors, fixed reviewed constructors/samplers and a local-only DINOv3 model. The online pipeline constructor and background-removal constructor are never called. `torch.load`, TorchScript loads and accidental Hub bootstrap calls are blocked. Python socket/DNS calls and Hugging Face/Transformers online modes are disabled; this is a worker guard, not a claimed OS-level network sandbox.

JSONL progress appears on stdout. A successful new output directory includes:

- `mesh.glb`: reopened geometry with embedded base-color and metallic/roughness PNG/JPEG textures; no external URI or required WebP.
- `prepared-input.png`: exact local RGB conditioning input, preserving the original image.
- `generation.json`: actual source/output hashes, checked runtime digests, parameters, CUDA hardware, timings and limitations.

The official exporter already converts source Z-up to GLB Y-up; this worker adds no unsupported 180-degree orientation flip. Geometry is exported without remeshing by default, preserving open/thin structures for later game preparation. Alpha is still opaque by the upstream exporter default. Generated normal, AO, emissive maps, rigs, hidden-surface truth and physical dimensions are not claimed.

## WSL cancellation

Windows `wsl.exe` termination alone has not been verified to terminate a Linux CUDA worker. A separate trusted stdlib-only Linux watchdog observes `worker-pid.json`, a UUID nonce, `/proc` process start ticks and the exact worker/output command line. The coordinator atomically stages a complete sibling cancellation request before terminating its Windows process, including before the PID record exists. The watchdog requests SIGTERM and, if the same process identity remains after two seconds, SIGKILL. A 20-minute worker deadline bounds an orphaned job; a completed worker that has not exited after 30 seconds is also stopped. PID reuse never authorizes signalling a different process.

A shared `.asset-studio-trellis2.lock.json` lease inside the prepared runtime prevents another app job from loading CUDA/models while an earlier Linux worker may still exist. Its PID/start-ticks/nonce is published atomically under a persistent `fcntl` guard before CUDA import. Only proven PID absence or different `/proc` start ticks permits stale cleanup; permission or parsing errors remain blocked. The watchdog removes its own matching nonce lease only after Linux process exit evidence. A Windows scheduler releasing a slot or receiving a success event does not remove the Linux lease.

`worker-cancellation.json` records a requested signal, not falsely verified termination. This cancellation design and actual CUDA inference require validation on a prepared WSL2/NVIDIA host. Unit tests establish protocol, path, mask, file-integrity and local cancellation-identity boundaries only.
