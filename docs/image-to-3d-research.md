# Image-to-3D provider research

Checked official sources on **2026-10-02**. Status: **researched / planned, not integrated or hardware-verified**. Image-to-3D is separate from the tested procedural Blender worker. No weights were downloaded and no inference was executed; CUDA, Apple Metal/MPS, output quality, memory usage and native platform compatibility have not been proven on this machine. No paid API fallback is configured.

| Candidate | Code license | Weight license | Official execution evidence | Product decision |
| --- | --- | --- | --- | --- |
| TripoSR | MIT, official repository `LICENSE` | MIT, separate official Hugging Face model card | Repository requires Python ≥3.8, PyTorch, `torchmcubes`; default CUDA path states ~6 GB VRAM. Official `run.py` contains CPU fallback when CUDA is absent. Native Windows/macOS and CPU inference have not been run here. | First candidate for a future isolated local provider after pinned-dependency/device testing; currently disabled |
| TRELLIS image-large | Main repository MIT; dependencies have separate licenses | MIT, separate official model card | Official README says code tested only on Linux, Windows instructions are not fully tested; NVIDIA GPU ≥16 GB VRAM required, verified upstream on A100/A6000. CUDA toolkit 11.8/12.2 listed. No macOS execution path established. | Excluded from default MVP integration because required native platforms and dependency rights have not been cleared |

TripoSR's MIT code and MIT model card do not prove that all dependencies, training data, input images or generated outputs have identical rights. The official requirements include native `torchmcubes`, `xatlas` and `moderngl` components. Pin and audit the exact dependency graph before packaging. The upstream command is `python run.py image.png --output-dir output`; an Asset Studio adapter would call an isolated, versioned environment with explicit device/limits and return actual model files to the existing Blender validation/export boundary. The upstream CPU fallback is source evidence only: performance, memory and macOS support remain unverified, and the current code forces CPU if CUDA is unavailable rather than proving a Metal route.

TRELLIS's README names `diffoctreerast` as an exception to the main MIT code license. Its [actual license](https://github.com/JeffreyXiang/diffoctreerast/blob/master/LICENSE) permits research/evaluation only and prohibits commercial exploitation/distribution without explicit consent. It must not be silently bundled into an industry asset application under an all-MIT label. The cited [FlexiCubes license](https://github.com/nv-tlabs/FlexiCubes/blob/main/LICENSE.txt) is Apache-2.0 as inspected; the precise modified submodule/revision still needs its own audit. TRELLIS core/weights being MIT does not resolve these dependency constraints.

Before enabling any candidate: pin code and weight revisions with hashes, record model identity and separate licenses, verify all dependencies and native device routes, run inference on each advertised Windows/macOS architecture, enforce memory/device ceilings and cancellation, generate a non-planar actual mesh, import the GLB in an independent tool, and preserve source image/model provenance. A failure or absent GPU must leave the provider disabled with an actionable reason; basic 2D and CPU procedural 3D remain usable.

Official sources inspected (not external community installers):

- [TripoSR repository](https://github.com/VAST-AI-Research/TripoSR), [code license](https://github.com/VAST-AI-Research/TripoSR/blob/main/LICENSE), [requirements](https://github.com/VAST-AI-Research/TripoSR/blob/main/requirements.txt), [actual inference CLI](https://github.com/VAST-AI-Research/TripoSR/blob/main/run.py).
- [TripoSR weight model card](https://huggingface.co/stabilityai/TripoSR/blob/main/README.md).
- [Microsoft TRELLIS repository and hardware/platform instructions](https://github.com/microsoft/TRELLIS), [code license](https://github.com/microsoft/TRELLIS/blob/main/LICENSE).
- [TRELLIS-image-large weight model card](https://huggingface.co/microsoft/TRELLIS-image-large/blob/main/README.md).
- [diffoctreerast license](https://github.com/JeffreyXiang/diffoctreerast/blob/master/LICENSE), [FlexiCubes license](https://github.com/nv-tlabs/FlexiCubes/blob/main/LICENSE.txt).

Upstream revisions resolved through the official GitHub/Hugging Face APIs during this review:

| Source | Resolved revision |
| --- | --- |
| TripoSR code `main` | `107cefdc244c39106fa830359024f6a2f1c78871` |
| TripoSR weight repository | `5b521936b01fbe1890f6f9baed0254ab6351c04a` |
| TRELLIS code `main` | `442aa1e1afb9014e80681d3bf604e8d728a86ee7` |
| TRELLIS-image-large weight repository | `25e0d31ffbebe4b5a97464dd851910efc3002d96` |

These repository-main documents can change. No compatibility claim is inferred from license availability, screenshots, a remote demo, or the existence of a model card.
