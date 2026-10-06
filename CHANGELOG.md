# Changelog

## 0.1.13 — Windows production performance and 3D fidelity (2026-10-06)

- Reuse a bounded Codex generation session while creating a fresh isolated thread per image. Invalidate it on runtime/configuration, login, cancellation, failure and project shutdown.
- Retain the scheduler connection, inspect only active dependencies and release CPU/disk reservations while waiting for the remote image. Reacquire local resources before decoding and saving.
- Cache hash-verified raw TripoSR output by input, model/runtime, preprocessing and quality identity. Reopen cached GLB files, quarantine corrupt entries and preserve inference provenance on reuse.
- Improve UV spacing and small-mesh projection. Check sampled distance, silhouette and thin-feature loss before accepting game/LOD meshes; retain the original triangle count if safe LOD reduction is impossible.
- Save core model outputs before optional, separately bounded previews. Protect preview recovery and metadata from stale executions; keep successful model exports available while previews run.
- Preserve approved palette/detail instructions and use aspect-preserving image output framing with texture-specific cover mode.
- Preserve Windows CPU identity in both isolated Python process environments, including CPython's fallback when WMI is unavailable; unsupported architectures remain rejected.
- Give Windows browser test cleanup a finite process-exit budget so successful parallel assertions do not fail at the default 10-second teardown limit.
- Publish Windows app/CLI and the common npm skill as 0.1.13. Retain Mac GUI 0.1.12, Mac CLI 0.1.11 and the existing Mac updater channel; no new Mac build.
- Verified a real Windows CLI cold/cache pair, separate-process artifact reopen/export, independent Blender reopens and actual preview pixels. Timings and limits are in the Windows release record; no new live GPT benchmark is claimed.

## 0.1.11 — Mac app and standalone Codex skill (2026-10-06)

- Built the latest master for Apple Silicon, including the standalone asset CLI and consented preparation of missing local tools.
- Added a Mac DMG, a signed updater, a standalone CLI ZIP and a common Windows/Mac skill ZIP with pinned platform inventories.
- Preserved the published Windows 0.1.11 native artifacts and update channel.
- Skipped Mac execution, loader installation and updater replacement validation at the user's request because the Mac was locked.

## 0.1.10 — Mac Codex asset workflow (2026-10-06)

- Added a bundled native CLI and installable Codex skill for individual assets during game development, with a portable skill/plugin ZIP.
- Added manifest-driven production, request-ID resume, JSONL progress and delivery hashes using the existing subscription and local 3D paths.
- Improved long production-plan waiting, held queue recovery and local-stage retry without regenerating completed reference images.
- Repaired bounded UV defects and stopped Blender Python bytecode writes inside the signed app.
- Published a Mac DMG and separately signed updater. Preserved Windows 0.1.9 downloads and its signed channel.
- Final package installation, UI and updater lifecycle tests were skipped at the user's explicit request; earlier development evidence is recorded separately.

## 0.1.9 — Windows local image-to-3D (2026-10-06)

- Enabled Windows x64 reconstruction in the production screen and 3D workbench, retaining the Apple Silicon path.
- Added app-managed official CPython3.12.10 and a separate hash-pinned CPU dependency lock; Python and CUDA installation are unnecessary for Windows users.
- Added native Windows RAM admission, bounded process-tree execution, peak-RSS reporting and a backend inference/reopen/export proof harness.
- Improved local model preparation guidance and 3D panel readability. Model preparation requires explicit download consent; weights are not included in the installer.
- Preserved exact generated floating-point metadata through project persistence and recovery. Source GLB validation now checks receipt-bound vertex colors without requiring game-only UVs or authored materials; game and LOD requirements remain strict.
- Mac 0.1.8 remains available through its separate signed update channel. Actual native evidence and Windows 0.1.9 packages are recorded in the release record.

## 0.1.0 — Windows portable (2026-10-02)

- Added Tauri 2/Rust desktop boundaries, Korean React workstation and shared contracts.
- Added local project/version storage, bounded persistent jobs and deterministic image processing.
- Added parameterized Blender crate/table/shelf workers producing actual GLB meshes and editable sources.
- Added standalone exports and independent PNG/GLB artifact verification, fixture tests and platform CI configuration.
- Verified the actual Windows portable window, native image processing, Blender GLB rendering and model reopen checks on the development host.
- Added a Korean feature website, public source repository and downloadable Windows portable release.
- Kept GPT Image 2 subscription generation marked incomplete: authentication works, but no actual image file was received.
- macOS builds/install/launch, release signing/notarization and clean-machine installer lifecycle remain unverified. See the dated [verification record](docs/verification.md).

The portable executable is unsigned. The site and release expose the verification boundaries; there is no paid API fallback or model-weight download.
