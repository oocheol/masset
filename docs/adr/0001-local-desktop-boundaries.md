# ADR 0001: local desktop and data-only workers

Status: accepted for the MVP, 2026-10-02.

The requested product must create actual local artifacts without a required paid server or GPU. Keep Tauri 2/Rust/React/Vite/SQLite. Three.js loads exported GLB in the workstation. Deterministic image processing stays in Rust. Blender runs as an optional child process using an audited parameterized template with script auto-execution disabled.

This boundary permits independent image/model jobs and ordinary local storage while preserving original assets. It adds an explicit Blender installation prerequisite for 3D work. It is not an OS sandbox and does not remove licensing responsibilities. No alternative stack or cloud migration is introduced.
