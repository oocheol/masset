# TRELLIS.2 integration analysis

Research date: 2026-10-07. This document records a read-only review of Microsoft's official code, model card, public Space metadata and Gradio protocol. No model weights, native dependencies or external images were downloaded or uploaded during this review. No inference result was produced by this research.

## Decision

The user selected **local only** after the initial research. External image transfer is excluded from the active implementation scope. The Space protocol below is retained as research evidence and comparison; it is not an enabled or approved generation route.

TRELLIS.2 is a useful optional image-to-3D engine for detailed geometry and PBR surface attributes. It cannot replace the existing local engine on this Windows machine: Microsoft documents Linux and an NVIDIA GPU with at least 24 GB of memory; the coordinator's host preflight reports a GTX 1650 with 4 GiB. The official `low_vram` option offloads stages to CPU but does not establish support for a 4 GiB GPU, Windows native execution or Apple Silicon.

A separate, explicitly selected experimental route to the official free Hugging Face Space is technically possible without installing model weights. It requires per-job external-upload consent, a genuinely masked RGBA input, anonymous requests, quota handling and actual GLB validation. It must not silently replace local generation or use a paid token/fallback. Commercial-use clearance for the full inference/export stack is unresolved; this route must not be presented as generally cleared for commercial game production.

Local mesh validation, PBR-preserving import, texture handling, bounded simplification, collision/LOD preparation and input framing can improve independently of installing or calling TRELLIS.2.

## Pinned sources and evidence limits

| Component | Revision examined | Source |
| --- | --- | --- |
| Microsoft official code | `75fbf0183001ed9876c8dbb35de6b68552ee08bd` | [Repository](https://github.com/microsoft/TRELLIS.2/tree/75fbf0183001ed9876c8dbb35de6b68552ee08bd) |
| Official TRELLIS.2-4B checkpoint metadata/config | `af44b45f2e35a493886929c6d786e563ec68364d` | [Model card](https://huggingface.co/microsoft/TRELLIS.2-4B/blob/af44b45f2e35a493886929c6d786e563ec68364d/README.md), [pipeline config](https://huggingface.co/microsoft/TRELLIS.2-4B/blob/af44b45f2e35a493886929c6d786e563ec68364d/pipeline.json) |
| Official demo Space code | `ebf60b20fc5a4607f90a1c11c0aab0ceeda5429d` | [Space app.py](https://huggingface.co/spaces/microsoft/TRELLIS.2/blob/ebf60b20fc5a4607f90a1c11c0aab0ceeda5429d/app.py), [Space](https://huggingface.co/spaces/microsoft/TRELLIS.2) |
| Gradio 6.1.0 server/client implementation | `4e2fc5633b248f12f24f29fe80d0066ce2d58ad2` | [routes.py](https://github.com/gradio-app/gradio/blob/4e2fc5633b248f12f24f29fe80d0066ce2d58ad2/gradio/routes.py), [blocks.py](https://github.com/gradio-app/gradio/blob/4e2fc5633b248f12f24f29fe80d0066ce2d58ad2/gradio/blocks.py), [client.py](https://github.com/gradio-app/gradio/blob/4e2fc5633b248f12f24f29fe80d0066ce2d58ad2/client/python/gradio_client/client.py) |
| Meta official DINOv3 source license | `6876159a11b4df116f30f667f8c9888617df0751` | [LICENSE.md](https://github.com/facebookresearch/dinov3/blob/6876159a11b4df116f30f667f8c9888617df0751/LICENSE.md), updated August 19, 2025 |

Read-only live checks returned the official Space as public, ungated and RUNNING, with Gradio 6.1.0 and queue support. Metadata came from [Hub Space API](https://huggingface.co/api/spaces/microsoft/TRELLIS.2), [config](https://microsoft-trellis-2.hf.space/config) and [endpoint info](https://microsoft-trellis-2.hf.space/gradio_api/info). Those facts establish discoverable endpoints, not a successful inference or guaranteed availability.

The supplied `trellis2.com` site is a separate frontend; it is not Microsoft's repository or official hosted endpoint. Use Microsoft's source and model card for technical capability statements. No request to that site's paid service is needed for this integration.

The Space is a mutable hosted service. Its app calls `from_pretrained('microsoft/TRELLIS.2-4B')` without a model revision. A recorded Space code SHA and expected model name therefore do not attest to the weights actually used for a particular output. A receipt should record the Space identity, observed code revision, parameters, input/output hashes and `model_attested: false`; it should not claim that the reviewed checkpoint SHA was remotely executed.

## Platform and dependency constraints

The [official README](https://github.com/microsoft/TRELLIS.2/blob/75fbf0183001ed9876c8dbb35de6b68552ee08bd/README.md#prerequisites) and pinned model card state:

- Tested operating system: Linux only.
- NVIDIA GPU memory: at least 24 GB; verified GPU examples are A100 and H100.
- CUDA Toolkit: recommended 12.4 for building native packages.
- Python: README says 3.8 or newer; the actual default setup creates Python 3.10.

The [setup script](https://github.com/microsoft/TRELLIS.2/blob/75fbf0183001ed9876c8dbb35de6b68552ee08bd/setup.sh) selects PyTorch 2.6.0, torchvision 0.21.0 and CUDA 12.4, flash-attn 2.7.3, Gradio 6.0.1 and nvdiffrast v0.4.0. CuMesh, FlexGEMM and the nvdiffrec renderutils branch are fetched from Git without immutable revision pins. Several basic Python dependencies are also unpinned. The O-Voxel extension compiles CUDA sources; GLB postprocessing explicitly calls CUDA, CuMesh and nvdiffrast. An attention backend switch is not a complete CPU or Metal implementation.

The official Space uses a different stack: Python 3.12, Gradio 6.1.0, PyTorch 2.11.0, torchvision 0.26.0, Triton 3.6.0 and CUDA 13 wheels, including native wheels hosted by separate GitHub publishers. Its hosted environment is not a Windows installer dependency specification.

| Environment | Verified upstream status | Asset Studio implication |
| --- | --- | --- |
| Linux + NVIDIA GPU meeting the documented requirement | Officially documented | Candidate for a separately approved, pinned runtime and actual artifact test |
| Windows native | Not verified by Microsoft in the reviewed README | Do not mark native TRELLIS.2 support as available |
| Windows + WSL2 Ubuntu | A possible Linux wrapper; no upstream WSL2 verification found | WSL2 alone does not resolve the 4 GiB hardware limit |
| Apple Silicon/macOS Metal | No reviewed inference or export path | Retain existing macOS engine; do not claim TRELLIS.2 local support |
| CPU only | No complete reviewed path | Do not silently fall back to CPU TRELLIS.2 |

`low_vram=True` is the default in the image-to-3D pipeline. It moves each conditioning/generation/decoding stage to the selected GPU and back to CPU. This avoids holding all models on the GPU at once; it does not eliminate each stage's weight, activation, attention or CUDA-export requirements. The official Space explicitly sets `low_vram=False`.

Asset Studio's local adapter additionally requires **32 GiB of physical system RAM** and reserves **16 GiB per TRELLIS.2 job**. These are app admission and scheduling conditions, not Microsoft's official RAM requirements or a measured peak-memory guarantee.

## Model footprint and loading safety

The pinned TRELLIS.2-4B repository lists nine safetensors weight files totaling **16,237,464,946 bytes (15.122 GiB)**. The seven files used by the full image-to-3D pipeline, excluding the two encoders, total **14,819,870,530 bytes (13.802 GiB)**. These are model-file sizes, not peak RAM/VRAM or a full installation size.

The default pipeline eagerly loads both 512 and 1024 flow models even when a later job selects 512 resolution. Three additional sources are referenced:

| Additional model | Revision examined | Weight metadata / concern |
| --- | --- | --- |
| `microsoft/TRELLIS-image-large` sparse structure decoder | `25e0d31ffbebe4b5a97464dd851910efc3002d96` | `ss_dec_conv3d_16l8_fp16.safetensors`, 147,591,972 bytes; SHA-256 `1c76d4a40519aa2d711cc263a8404105231ac26db31d946bed48b84fee79009a` |
| `facebook/dinov3-vitl16-pretrain-lvd1689m` | `ea8dc2863c51be0a264bab82070e3e8836b02d51` | `model.safetensors`, 1,212,559,808 bytes; manually gated, custom license |
| `briaai/RMBG-2.0` | `5df4c9c76d8170882c34f6986e848ee07fd0ba43` | `model.safetensors`, 884,878,856 bytes; also publishes pickle `.bin` and remote Python code; noncommercial access conditions |

The selected safetensors above plus the seven main inference files total **17,064,901,166 bytes (about 15.893 GiB)** before configs, source, Python, CUDA libraries, build caches and temporary/output files. Downloading an entire model repository adds unused files and alternative formats; do not use this sum as a complete runtime download estimate.

Main model loading uses `safetensors.torch.load_file`, but this does not make the whole initialization inert. The pipeline reads JSON class names, resolves additional repositories and instantiates the background remover with `trust_remote_code=True`. Even an RGBA input does not prevent that eager local constructor from loading the default background model. A future local runtime needs reviewed source, allowlisted configuration/class names, complete dependency pins, safe formats, explicit user download approval and offline-only paths. Do not call upstream online `from_pretrained` as an unnoticed bootstrap step. The present research downloaded metadata and text only.

## Geometry, PBR and game preparation

O-Voxel is a field-free sparse voxel representation; Microsoft describes it as supporting open surfaces, non-manifold geometry and internal enclosed structures. The pipeline separates sparse structure, shape latent and texture latent generation. Its actual PBR layout contains:

- Base color (RGB).
- Metallic.
- Roughness.
- Alpha/opacity.

The reviewed generation layout does not contain a generated normal-map, ambient-occlusion or emissive channel. Mesh vertex normals are produced by export postprocessing. Do not describe locally baked normals/AO as direct model outputs.

The model card explicitly warns about small holes/topological discontinuities and lack of preference/aesthetic alignment. A single input image also does not provide measured physical dimensions or reliable hidden-surface truth. Preserve user-provided scale, pivot and material settings instead of treating generated geometry as dimensionally accurate.

The official export cleans/remeshes geometry, unwraps UVs, samples material attributes back from the source volume and packs metallic/roughness into blue/green channels of a texture. The default `alphaMode` is **OPAQUE**, even when an alpha channel exists. The example/Space exports using `extension_webp=True`; an engine-compatible workflow should inspect texture extensions and convert embedded WebP to a supported format while retaining PBR connections. Do not assert all game importers support the unmodified export.

The hosted UI requests 100,000-500,000 decimation targets. This is a dense source mesh, not a demonstrated shipping game budget. Source comments vary between a vertex target and a face-count target; the application's quality report should count actual vertices/triangles, not trust the parameter label. Optional remeshing/hole-filling may change open or thin structures. Keep the source GLB and apply game-oriented cleanup as a new artifact, with silhouettes, disconnected parts, UVs, material slots, normals, triangle budgets and LODs verified afterward.

The official README timing table (512 about 3 s, 1024 about 17 s, 1536 about 60 s) was measured on H100. It is not a GTX 1650 or end-to-end desktop benchmark. The Space separately warns GLB extraction may take half a minute or longer.

## Reviewed inference/export interfaces

The pinned image-to-3D pipeline signature is:

```python
Trellis2ImageTo3DPipeline.run(
    image, num_samples=1, seed=42,
    sparse_structure_sampler_params={},
    shape_slat_sampler_params={},
    tex_slat_sampler_params={},
    preprocess_image=True, return_latent=False,
    pipeline_type=None, max_num_tokens=49152,
)
```

Pipeline types are `512`, `1024`, `1024_cascade` and `1536_cascade`; the pretrained default is `1024_cascade`. It returns a list of `MeshWithVoxel`, or that list plus shape/texture latents and actual resolution when `return_latent=True`.

The [O-Voxel GLB function](https://github.com/microsoft/TRELLIS.2/blob/75fbf0183001ed9876c8dbb35de6b68552ee08bd/o-voxel/o_voxel/postprocess.py) accepts vertices, faces, attribute volume, coordinates, attribute layout, AABB and either voxel size or grid size. Defaults are decimation target 1,000,000, texture size 2048, remesh false, remesh band 1 and projection 0.9. It returns a textured `trimesh.Trimesh`; GLB serialization is a separate `mesh.export(...)` call.

The shape-conditioned `Trellis2TexturingPipeline.run(mesh, image, seed=42, tex_slat_sampler_params={}, preprocess_image=True, resolution=1024, texture_size=2048)` is a separate texture-generation pipeline. Its existence is not evidence that the public image-to-3D Space offers a texture-only endpoint.

## Local-only offline construction

A supplied, preprepared environment is required; do not bootstrap/download it as a side effect of a job. The reviewed main source is the Microsoft commit in the source table. The documented environment is Linux + NVIDIA/CUDA; using it through Windows WSL2 is an experimental wrapper, with the same hardware requirement, not a native Windows or macOS implementation.

Avoid `Trellis2ImageTo3DPipeline.from_pretrained(...)` for the worker entry point. Even a local pipeline root eagerly initializes its configured background remover and can fall back to external repository downloads when checkpoint files are missing. Construct the pipeline from explicit, checked local components instead:

1. Verify the source tree, environment versions, pipeline/config files and all selected weight files against an approved local hash manifest before importing or constructing the runtime. Restrict paths to the prepared roots, reject symlink/path escapes and missing entries. A caller-supplied hash file proves consistency with that file, not authenticity by itself; trusted expected hashes/revisions must have a separate reviewed origin.
2. Load local checkpoint JSON and safetensors with fixed model-class mapping. Do not evaluate JSON strings, let arbitrary class names select code, invoke pickle loaders or fall back to a repository name. The reviewed upstream loader uses `safetensors.torch.load_file`, but its online fallback should not be called after an absent-file check.
3. Load DINOv3 explicitly with `transformers.DINOv3ViTModel.from_pretrained(local_dino_root, local_files_only=True, use_safetensors=True, trust_remote_code=False)`. Its original `DinoV3FeatureExtractor` constructor does not expose these flags; use a small reviewed offline wrapper around the loaded model instead of calling that constructor. Do not replace the trained DINOv3 conditioning with DINOv2, whose source also contains a `torch.hub.load` path.
4. Set `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`. Explicit local loading and a worker network-denial boundary are still needed: environment variables alone are not a firewall for every dependency.
5. Instantiate `Trellis2ImageTo3DPipeline` directly with local models, fixed sampler instances, checked normalizations, the offline conditioning wrapper, `rembg_model=None` and `low_vram=True`. Supply locally prepared RGB conditioning and run with `preprocess_image=False`. No background-removal model is required in this path.

The exact checkpoint mapping from the reviewed configs is:

| Pipeline model key | Local checkpoint prefix relative to its snapshot | Expected class |
| --- | --- | --- |
| `sparse_structure_decoder` | TRELLIS v1: `ckpts/ss_dec_conv3d_16l8_fp16` | `SparseStructureDecoder` |
| `sparse_structure_flow_model` | TRELLIS.2: `ckpts/ss_flow_img_dit_1_3B_64_bf16` | `SparseStructureFlowModel` |
| `shape_slat_decoder` | `ckpts/shape_dec_next_dc_f16c32_fp16` | `FlexiDualGridVaeDecoder` |
| `shape_slat_flow_model_512` | `ckpts/slat_flow_img2shape_dit_1_3B_512_bf16` | `SLatFlowModel` |
| `shape_slat_flow_model_1024` | `ckpts/slat_flow_img2shape_dit_1_3B_1024_bf16` | `SLatFlowModel` |
| `tex_slat_decoder` | `ckpts/tex_dec_next_dc_f16c32_fp16` | `SparseUnetVaeDecoder` |
| `tex_slat_flow_model_512` | `ckpts/slat_flow_imgshape2tex_dit_1_3B_512_bf16` | `SLatFlowModel` |
| `tex_slat_flow_model_1024` | `ckpts/slat_flow_imgshape2tex_dit_1_3B_1024_bf16` | `SLatFlowModel` |

Each checkpoint prefix requires both `.json` and `.safetensors`. The 512 path can select six models (three flow models and three decoders), but fewer loaded files do not establish support below the official VRAM requirement. Configs specify BF16 for the flow models and FP16 for the decoders; do not silently quantize or substitute precision/model versions as a claim of official low-memory support.

Direct construction uses these actual constructor arguments, with values obtained only from the reviewed configuration and fixed local paths:

```python
pipeline = Trellis2ImageTo3DPipeline(
    models=checked_local_models,
    sparse_structure_sampler=FlowEulerGuidanceIntervalSampler(sigma_min=1e-5),
    shape_slat_sampler=FlowEulerGuidanceIntervalSampler(sigma_min=1e-5),
    tex_slat_sampler=FlowEulerGuidanceIntervalSampler(sigma_min=1e-5),
    sparse_structure_sampler_params=checked_args['sparse_structure_sampler']['params'],
    shape_slat_sampler_params=checked_args['shape_slat_sampler']['params'],
    tex_slat_sampler_params=checked_args['tex_slat_sampler']['params'],
    shape_slat_normalization=checked_args['shape_slat_normalization'],
    tex_slat_normalization=checked_args['tex_slat_normalization'],
    image_cond_model=offline_dino_conditioner,
    rembg_model=None,
    low_vram=True,
    default_pipeline_type='1024_cascade',
)
pipeline.cuda()
mesh = pipeline.run(prepared_rgb_image, seed=seed,
                    preprocess_image=False, pipeline_type=pipeline_type)[0]
```

The conditioning wrapper must expose mutable `image_size`, `to(device)`, `cpu()` and a callable accepting a list of PIL images. The reviewed DINOv3 feature extractor resizes to that conditioning resolution, converts RGB to floats, normalizes with mean `[0.485,0.456,0.406]` and std `[0.229,0.224,0.225]`, then applies the specific DINOv3 embeddings, RoPE and model layers and returns layer-normalized tokens. Reuse those reviewed feature operations; an arbitrary feature vector is not compatible conditioning.

Default sampler parameters are: sparse structure 12 steps, guidance 7.5, rescale 0.7, interval `[0.6,1.0]`, rescale T 5; shape 12, 7.5, 0.5, `[0.6,1.0]`, 3; material 12, 1.0, 0.0, `[0.6,0.9]`, 3. The 32-channel normalizations are fixed arrays in the pinned pipeline JSON, not tunable values to guess.

A read-only search of all 18 Python files under the pinned `trellis2/models` and `trellis2/pipelines` found no `torch.load` call; main weights use safetensors. Legacy `.pt`, `.pth`, `.bin`, pickle files or an unsafe `weights_only=False` conversion are unnecessary and should be rejected. For the DINOv3 dependency, explicitly requiring safetensors prevents a binary-checkpoint fallback; this is not a claim that all third-party Python packages have been exhaustively audited.

### Exact local RGBA conditioning

Pinned Space `app.py:326` and pipeline `trellis2_image_to_3d.py:127` use the same crop/composite operation for RGBA. Simply uploading or loading a raw masked RGBA image and skipping preprocessing is insufficient: the conditioner later calls `convert('RGB')`, which discards alpha rather than compositing it, allowing hidden RGB in transparent pixels to affect inference.

For an offline implementation:

1. Require RGBA with some alpha below 255 and a valid foreground. Reject empty/degenerate foreground and absurd dimensions before array allocation; check again after resizing.
2. Compute `scale=min(1,1024/max(width,height))`. If smaller than one, resize to `(int(width*scale), int(height*scale))` with PIL Lanczos. The upstream alpha-present check happens before this resize.
3. Find foreground coordinates where alpha is strictly greater than `0.8*255` (204). Take minimum and maximum pixel coordinates without adding one to the maximum.
4. Let center be `(min+max)/2` per axis and size be `int(max(xmax-xmin,ymax-ymin)*1.0)`. Upstream uses `center ± size//2` for a square PIL crop, with PIL's coordinate rounding and transparent padding outside the image. It adds no 1.2 margin and no extra final 512 resize. A robust wrapper should reject a zero-area crop instead of inheriting NumPy/PIL errors.
5. Convert cropped RGBA to float in `[0,1]`, calculate `RGB*alpha`, multiply by 255 and cast to `uint8`, producing an RGB image over a black background. Do not composite alpha twice.
6. Pass that prepared RGB directly to `pipeline.run(..., preprocess_image=False)`. The later DINO conditioning resize to 512/1024 is separate. Preserve the original input; write a prepared image as a new artifact if it helps verification.

With `rembg_model=None` and the explicit false preprocessing flag, this route avoids the BRIA runtime/model entirely. DINOv3 and CUDA/export licensing/environment requirements still apply. No image is transferred externally.

## Excluded hosted route: research protocol

The following comparison is grounded in live configuration and matching Gradio 6.1.0 source. It has not been verified by submitting an image and is excluded by the user's local-only decision. Installing Gradio/Python packages is not required for a hypothetical HTTP transport itself.

Base origin: `https://microsoft-trellis-2.hf.space`. API prefix: `/gradio_api`. Keep a fresh UUID `session_hash` for exactly one generation/extraction transaction. Check Space identity, current source SHA and endpoint signatures before a job; function IDs can change when the Space changes.

| Endpoint name | Observed function ID | Raw input slots | Raw output slots |
| --- | --- | --- | --- |
| `start_session` | 2 | `[]` | `[]` |
| `preprocess_image` | 4 | `[ImageData]` | `[ImageData]` |
| `image_to_3d` | 7 | 15 fields below | `[null, preview HTML]` |
| `extract_glb` | 9 | `[null, decimation_target, texture_size]` | `[FileData, FileData]` |
| `end_session` | 3 | Private unload handler | Do not invoke a private API directly |

Resolve IDs from `/config` dependency `api_name`; use `/info` for documented parameter names and config input component types/order for hidden state. The first `extract_glb` raw slot is a required null placeholder. Gradio clients insert it automatically, but a raw HTTP client must insert it; the server retrieves the real state from the same `session_hash`. The preview response's null slot similarly represents server-side `gr.State`.

Use the canonical queue protocol rather than relying on simple `/call` for this stateful transaction:

1. Hold `GET /gradio_api/heartbeat/{session_hash}` as a separate SSE stream through generation, extraction and file download. Closing it triggers Gradio unload handlers and marks the session closed. Establish the source's `start_session` through the queue with an empty data array.
2. `POST /gradio_api/upload` as multipart form data with field name `files`; one PNG part is enough. Response is an array of server-side paths. Upload only a locally checked, masked RGBA PNG. Input `ImageData` can contain `path`, `orig_name: "input.png"`, `mime_type: "image/png"`, `is_stream: false`, `meta: {"_type": "gradio.FileData"}`. Never send a local Windows path as the remote server path.
3. For a queued call, `POST /gradio_api/queue/join` with `data`, discovered `fn_index`, `session_hash` and `event_data: null`. Read its `event_id`.
4. Consume `GET /gradio_api/queue/data?session_hash={session_hash}` SSE. Each `data:` field contains a JSON message. Match the current `event_id`; a successful result requires `msg: "process_completed"`, `success: true` and expected `output.data`. Estimation, progress, heartbeat, stream closure or HTTP 200 alone are not success. Bound response sizes and stream duration.
5. Complete image generation before GLB extraction. Keep the same session and download the resulting FileData from that exact origin using `/gradio_api/file={server_path}` before ending the session. Preserve the input and write new source/prepared artifacts.
6. For a pending/running call, cancellation uses `POST /gradio_api/cancel` with `session_hash`, the current `fn_index` and `event_id`. Cancel on user request or timeout; acknowledge that cancelling a running remote computation is best effort and may still consume quota. Close streams without automatic resubmission.

The simpler Gradio `/call/{api_name}` POST/GET API exists, but the reviewed Gradio 6.1.0 simple GET selects its queue using `event_id`, while a POST with an explicit session hash queues under that session. The canonical client uses `/queue/join` and `/queue/data`; that route avoids a potential mismatch when preserving hidden state across calls.

### Input values and bounds

Raw `image_to_3d` defaults, in order:

```json
["ImageData", 0, "1024", 7.5, 0.7, 12, 5.0, 7.5, 0.5, 12, 3.0, 1.0, 0.0, 12, 3.0]
```

| Position | Parameter | Default | Reviewed UI range |
| --- | --- | --- | --- |
| 1 | Image | Required | PNG RGBA, real foreground alpha mask |
| 2 | Seed | 0 | Integer 0-2,147,483,647 |
| 3 | Resolution | `"1024"` | `"512"`, `"1024"`, `"1536"` |
| 4-7 | Sparse structure strength / rescale / steps / rescale T | 7.5 / 0.7 / 12 / 5 | 1-10 / 0-1 / integer 1-50 / 1-6 |
| 8-11 | Shape strength / rescale / steps / rescale T | 7.5 / 0.5 / 12 / 3 | Same bounds |
| 12-15 | Material strength / rescale / steps / rescale T | 1 / 0 / 12 / 3 | Same bounds |

Raw extraction input: `[null, 300000, 2048]`. Decimation UI range is 100,000-500,000 in 10,000 increments; texture UI range is 1024-4096 in 1024 increments. The Space maps resolution `"1024"` to the cascade pipeline and `"1536"` to its 1536 cascade. Higher resolution, more steps or larger textures are workload controls, not guarantees of better every-case quality.

Return files are Gradio FileData objects containing a server `path`, optional `url`, original filename, size, MIME type, stream flag and `meta._type`. The same GLB is exposed through both Model3D and DownloadButton outputs. Do not render or execute returned preview HTML in the app; it is unnecessary to prepare the downloaded mesh.

Restrict output URLs to the exact HTTPS Space origin and expected file route. Disable or validate redirects: Gradio's file route can redirect if its path contains an HTTP URL. Bound download sizes and verify GLB magic/version/chunks, geometry and embedded resources before import. External resource references in a downloaded glTF should not cause further unapproved network fetches.

## Privacy, free quotas and authentication

The Space UI states that uploads are temporarily cached on Hugging Face, deleted after a session, and that Microsoft does not access or retain user data. It advises against uploading sensitive/private content. Source uses `gr.Blocks(delete_cache=(600,600))`, a session directory and an unload cleanup handler. These statements/code are not independent proof that a particular remote file was deleted immediately. Describe external transmission plainly; do not promise verified zero retention.

RGB/all-opaque inputs take the Space's `remove_background` branch, which forwards the image to **`briaai/BRIA-RMBG-2.0`**, a second remote Space. The strict integration path should accept only a locally prepared PNG with nontrivial foreground/background alpha, reject an empty mask and use the official preprocessing only after verifying that alpha. A local framing path may instead reproduce its square crop, maximum 1024-pixel dimension and alpha-composite behavior, with no BRIA call. Direct generation has `preprocess_image=False` and therefore expects correctly framed model input.

[HF ZeroGPU docs](https://huggingface.co/docs/hub/spaces-zerogpu) and [Space API docs](https://huggingface.co/docs/hub/spaces-api-endpoints), read on the research date, list:

- Anonymous: 2 included GPU minutes per day, low queue priority/shared pool.
- Free account: 5 included minutes per day, medium priority.
- PRO/Team: 40 minutes; Enterprise: 60 minutes. Paid accounts can automatically consume prepaid credits after the included allowance.
- Included allowance resets 24 hours after first GPU use; quotas are shared with other ZeroGPU calls.

The Space decorates both generation and GLB extraction with `@spaces.GPU(duration=120)`. This is a function runtime limit, not a completion promise or proof that the remaining quota covers both phases. The optional free path should use no token by default, no paid account token, no pay-as-you-go provider and no automatic quota retries. On quota/auth/service errors, retain the local job/input and explain the failure. Metadata reachability does not verify an anonymous user's actual quota or permission to run inference.

## License boundaries

The Microsoft repository and TRELLIS.2-4B card use MIT. Retain Microsoft copyright/license notices when distributing their code or weights. This is not a blanket MIT license for the dependencies, hosted service or all outputs.

| Component | Reviewed source/condition | Integration consequence |
| --- | --- | --- |
| TRELLIS.2 code/weights | MIT repository license and model-card declaration | Preserve notices; separately review dependencies |
| TRELLIS v1 sparse decoder | Upstream model metadata declares MIT | Pin the specific file/revision if used locally |
| DINOv3 | Custom license (`dinov3-license`), manually gated HF model; public official source license read | Source section 1a grants limited use/distribution/modification rights without a blanket noncommercial limitation; section 1b requires agreement/notice and sets use restrictions. The pinned HF license file returned HTTP 401, so its byte identity to the public source was not verified and the gate was not accepted |
| RMBG-2.0 | Model metadata explicitly says noncommercial, linking CC BY-NC 4.0; gated terms | Do not silently bundle/redistribute or claim commercial clearance |
| nvdiffrast v0.4.0 | [Nvidia Source Code License (1-Way Commercial)](https://github.com/NVlabs/nvdiffrast/blob/v0.4.0/LICENSE.txt), section 3.3 | Use by parties other than NVIDIA or its affiliates is limited to research/evaluation, with no direct/indirect monetary gain; this is a company/affiliate exception, not an NVIDIA-GPU hardware exception |
| nvdiffrec renderutils | [NVIDIA Source Code License](https://github.com/JeffreyXiang/nvdiffrec/blob/renderutils/LICENSE.txt), section 3.3 | Use by parties other than NVIDIA or its affiliates is limited to noncommercial research/evaluation; owning an NVIDIA GPU does not supply that exception |
| CuMesh/FlexGEMM/native wheels and remaining runtime | Separate packages/licenses; no complete locked dependency audit performed here | Do not label the runtime fully reviewed or all-MIT |

The Space's metadata `license: mit` describes its code declaration; it does not supply a separately verified commercial-output license. The reviewed model card licenses the model, not an explicit warranty that every generated asset is free of third-party rights. Sending work to the official free demo does not remove dependency/service licensing questions. Label the path experimental/research until relevant commercial permissions or a compatible export/runtime replacement are established. This is a source-license inventory, not a legal opinion about a particular user's generated asset.

The reviewed nvdiffrast section 3.3 says: "The Work and any derivative works thereof only may be used or intended for use non-commercially. The Work or derivative works thereof may be used or intended for use by Nvidia or its affiliates commercially or non-commercially." The exception is not phrased as permission for anyone running on NVIDIA hardware. The nvdiffrec section similarly expressly reserves commercial use to NVIDIA and its affiliates. A future dependency replacement or differently licensed revision needs a separate compatibility and license review; this document does not relabel the Microsoft model itself as noncommercial.

## Quality improvements available locally

These can be implemented and tested with the existing engine/toolchain while external generation remains excluded from the active implementation:

1. Inspect image alpha/framing, reject empty or too-small subjects and preserve high-resolution original inputs; avoid accidental crops of thin geometry.
2. Preserve generated/imported base color, metallic, roughness and alpha textures through GLB import and export. Inspect packed channels and expose explicit opacity/cutout choices rather than guessing transparency from the presence of alpha.
3. Keep a dense source mesh; create a separate game version. Decimate with seams/material boundaries and silhouettes considered, inspect actual triangle counts, and compare before/after renders.
4. Report UV presence, degenerate triangles, invalid normals, disconnected parts, dimensions and material/texture counts. Distinguish open-surface warnings from hard invalid-geometry errors.
5. Add LOD/collision preparation and optional high-to-low normal/AO baking using the existing local Blender worker with script auto-execution disabled. Do not execute code supplied in an asset.
6. Validate the artifact and render it locally. A REST success, process exit or a preview HTML string is insufficient proof of valid game-ready output.

The model-quality hypothesis needs actual fixture results before claims: input and settings fixed, source/prepared input images and raw/finished GLBs retained, topology/PBR report recorded, several views rendered and visual/triangle/UV results compared against the current engine. Until an eligible local GPU produces those artifacts, the integrated local TRELLIS.2 path remains experimental and unproven on this host. Remote generation is excluded from the selected implementation.
