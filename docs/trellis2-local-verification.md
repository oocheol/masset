# Local TRELLIS.2 integration and material verification

Checked on Windows x64, 2026-10-07. This is development-source verification; published Windows/npm packages remain 0.1.13. No upstream runtime/model download, image upload or provider-generation request was performed. macOS was not built or tested in this change.

## Implemented boundary

- Optional `trellis2_local` engine alongside the existing TripoSR default. No automatic engine fallback.
- Windows WSL2 wrapper with fixed interpreter argv, local masked PNG/WebP input and offline source/model loading. NVIDIA VRAM >=24 GiB and app physical RAM >=32 GiB are required.
- Immutable official code/model/config records, safetensors-only loading, complete model hashes before inference, output GLB/PNG/receipt bytes checked before recording a confirmed model.
- Atomic cancellation requests and a Linux PID/start-ticks/nonce watchdog. A shared runtime lease blocks another job while the earlier Linux PID remains alive or its state is uncertain.
- PBR finishing retains per-part OPAQUE/MASK/BLEND, MASK cutoff, double-sided state, authored AO/strength and material seams through UV baking and LOD generation. Separate render slots can increase draw calls.

Preparation remains experimental. Microsoft code/model MIT terms do not cover every dependency; DINOv3 and nvdiffrast have separate terms. The wrapper does not claim an OS-level network sandbox or verified commercial use of the entire optional CUDA stack. See [research and exact sources](trellis2-analysis.md) and [prepared runtime instructions](../workers/trellis2/README.md).

## Checks completed

| Check | Actual result |
| --- | --- |
| JavaScript artifact/UI regression | 171 passed, 5 platform-specific checks skipped |
| Windows Rust workspace regression | 260 passed, 5 explicit fixtures/runtime checks ignored |
| TRELLIS worker boundary tests | 13 passed using the existing local Python; CUDA inference was not executed |
| Frontend build/typecheck | Passed |
| Windows CLI + desktop build | Passed, developer build with `tauri/custom-protocol` |
| Native WebView | Actual window, native IPC and 12 asset-protocol images; zero provider calls |
| Native CLI low-VRAM admission | Measured GTX 1650 / 4096 MiB; runtime configuration and generation rejected; originals/assets/jobs unchanged after reopening |
| Native CLI PBR flow | Import -> finishing -> five previews -> reopen -> independent export; 13 artifact hashes/bytes verified; original retained, two versions |
| Independent Blender material verification | Five fixtures, 239 checks, actual fresh GLB/Blend reopening on Blender 5.2.1 LTS |

The native CLI material fixture retained OPAQUE without AO, MASK with cutoff `0.3700000047683716`, double-sided rendering and AO, and BLEND with AO. Its game GLB SHA-256 is `36449d76cfa05d6a210274f34c0b0846efb5702ebbb864e34a7d834011623604`. Native CLI SHA-256 is `f8f71f42a2b94d7bbd7038666c9dd124bd9e2459b5e5cf6a1fd69ed45c2094ea`; desktop SHA-256 is `3613850bb3dab8e6c4237bf100f7bf8e43b01e5e25700b05784d29deb4ec7937`. These unsigned developer binaries are separate from public installers.

Material regression also retained three touching render parts while reducing 2,400 -> 980 -> 480 triangles. Maximum sampled AO error was 0.009851 and alpha error 0.017597. Eight analytical measurement cases, 17 preview receipt cases, six preview security cases and Windows long-path reopening passed. [Hash-bound material proof](../workers/blender-quality/tests/native-proof-materials-windows.json) binds source and actual local evidence files.

Local CLI/window evidence is under `output/trellis2-local-1791356054961/`: `boundary-final/trellis2-boundary-proof.json`, `native-pbr-lf-final/native-cli-proof.json` and `native-window.qa.json`. The final resource copy verified all 400 bundled files, including the LF-normalized runtime lock SHA-256 `ecb05fa723eaa5aba52b814f354858abb3f5ebd54a674272052f7ca38cde80d7`; both CLI checks were repeated against that fresh copy. The first extended CLI verifier incorrectly required AO on every source material; the fixture's opaque material has no AO. Its retained first attempt is `native-pbr/`; the corrected final check compares each source slot's actual settings and passed. Full-repository `cargo fmt --all -- --check` reports existing formatting differences in files outside this change; no broad formatting rewrite was made.

## Remaining native proof

Actual TRELLIS.2 CUDA inference, generated shape/texture comparison with TripoSR, prepared WSL2 runtime compatibility and Linux GPU termination after cancellation require a suitable >=24 GiB GPU host. The current 4 GiB PC cannot establish those results. No rigging, collider, game-engine import/runtime or clean-machine installer lifecycle was tested. Existing model-material fidelity has been verified independently of this hardware limit.
