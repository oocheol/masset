# Engineering boundaries

Use the user's pasted Asset Studio requirements as the product brief. Core code is local-first, Windows/macOS only, Tauri 2 + Rust + React/TypeScript/Vite. No paid API fallback. Never expose credentials or claim unverified provider/model/native platform support.

The coordinator owns root configuration, shared contracts, desktop command bridge and integration. Assigned agents own their module directories. Contract changes go through the coordinator; do not edit another agent's files. User explicitly authorizes parallel agent development in section 9.

Native output and actual artifact verification are required. Browser UI tests do not establish native desktop support. Preserve original inputs and write new versions; no overwrite/delete of user originals. Blender must disable script auto-execution. Generated code is never executed as an asset input.

