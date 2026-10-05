# Changelog

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
