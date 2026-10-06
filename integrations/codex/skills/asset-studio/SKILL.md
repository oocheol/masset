---
name: asset-studio
description: Build or improve a playable game in Codex with automatically prepared local Asset Studio CLI tools for individual 2D and static 3D assets, engine integration and verification. No separate GUI app is required.
---

Use Asset Studio as the asset producer within the user's game-development task. Keep implementing the game after assets arrive; the asset list or a folder of renders alone is not a completed game.

The standalone 0.1.11 runtime is released for Windows x64 and Apple Silicon Mac, with both immutable package inventories pinned in the common skill ZIP. Mac app/loader execution validation was skipped because the Mac was locked; do not claim that build success establishes native execution support. No MCP server or API key is needed.

## Prepare automatically on first use

The skill includes instructions, loaders and a pinned package manifest, not the native executable or model weights. Start with the appropriate loader beside this file. It installs the versioned CLI and resources in a private user directory and verifies them again before execution. Python, Node, Rust and the Asset Studio GUI are not required to bootstrap.

- Windows: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "ABSOLUTE_SKILL_DIR/scripts/bootstrap.ps1" -ConsentDownloads`.
- Apple Silicon Mac: `bash "ABSOLUTE_SKILL_DIR/scripts/bootstrap.sh" --consent-downloads` only when the fixed manifest includes a released Mac package. Do not build, download another platform or substitute an app automatically when it is unavailable.
- An existing Python 3.9+ installation can optionally run `python "ABSOLUTE_SKILL_DIR/scripts/bootstrap.py" ensure --consent-downloads`.

Use absolute, shell-quoted paths. Add `-Needs3d` on Windows or `--needs-3d` on Mac/Python only for model work. Do not install Blender or model weights for a 2D-only task. The loaders print JSON Lines with `runtime_ready`, `cliPath` and `resourcePath`; use those exact verified paths for later CLI calls, passing `--resources resourcePath`. Never execute a CLI path merely because an editable `installation.json` beside the skill claims it is trusted. Do not override the release manifest or download arbitrary executables.

Downloads require authorization. Show source, fixed version, byte size, SHA-256 and license from [the native manifest](references/native-runtime.json) and the CLI's preparation events. If the user already authorized installing missing dependencies, proceed with the consent flag without asking again. Otherwise omit the flag and report `needs_consent` before downloading. Do not change the system execution policy or require administrator rights. An edited installation is preserved and reported for attention.

Preparation reuses the caller's existing official Codex ChatGPT login and `CODEX_HOME`; it does not copy or print tokens. Only a missing or expired login needs the official browser flow: add `-LoginIfNeeded` / `--login-if-needed` when the user's connection request authorizes it, then wait for the human to complete authentication. Provider availability is separate from CLI installation and local model readiness. Never silently switch to a paid API, proxy or another image model. Windows image-to-3D also requires the Microsoft Visual C++ x64 runtime; a missing system prerequisite is reported explicitly.

Read [CLI reference](references/cli.md) for commands, preparation and recovery.

## Produce and integrate

1. Inspect the existing game and engine before choosing assets. Reuse suitable assets. Define a coherent art direction, scale, camera and purpose. Create the actual project before scanning it. Continue building gameplay with the engine's available tools.
2. Prepare the CLI and any prerequisites as above. Run `doctor --check-gpt` to check the official subscription without generating images. A preparation error or unavailable subscription is a real blocker for that stage; report it honestly. Rigging, animation, audio and game code are separate work.
3. Write a bounded JSON manifest, following [the example](references/manifest.json). Use one named asset per item. Five weapons means five distinct items and five separate files, never five copies of a group illustration. Use `model` for one rigid static object, `sprite` for transparent sprites/icons, `texture` for surfaces, `image` for other art. Keep related batches small enough to inspect and correct before expanding them. Optional `referencePaths` contains up to five absolute paths to user-selected PNG/JPEG/WebP/GLB references.
4. Use `produce` with the real game root, manifest and a new request UUID. Keep the UUID with that exact manifest for recovery. `--allow-gpt` transmits the brief and selected references through the existing official subscription path: use it within the user's authorized generation scope. Do not transmit credentials, unrelated files or game source code. The CLI creates a separate workspace, limits local workers, waits for actual files and returns each item's `outputPath`.
5. Inspect received images/models, dimensions, counts and manifest hashes. Integrate the validated files into the engine: use its actual import support, assign materials and configure scale, collision, prefabs/scenes and UI. Unity does not inherently establish GLB import support; inspect the installed importer or make a local format conversion with Blender. Never execute generated asset scripts or enable Blender auto-execution. Keep originals and add new versions.
6. Build and play the game with available native engine tools. Verify the assets are used in the running scene and test the requested gameplay. Fix discovered import or gameplay problems. Report actual execution evidence and any unverified engine/device scope. File verification alone does not prove a playable game.

For `external_unknown` or a lost remote response, inspect the saved status and stop remote retries until the result is resolved or the user explicitly authorizes a new submission. Reusing a request UUID resumes its existing DAG; it does not resend unknown/completed GPT requests. A local 3D/export failure can reuse a received concept image. Change the manifest only under a new UUID. Preserve successful assets while addressing individual failures.
