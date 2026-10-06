# Native CLI

Use the verified absolute `cliPath` and `resourcePath` returned by the skill loader, and quote paths using the host shell. Standalone Windows x64 and Apple Silicon packages contain the native CLI and workers without the GUI app. Pass `--resources /absolute/runtime/resources`. A development binary requires `--resources /absolute/masset`.

## Automatic prerequisites

`prepare --consent-downloads` finds the official Codex runtime and reuses its existing ChatGPT login. It prepares a pinned official runtime only when missing. `--login-if-needed` starts the official browser login only if the current account is not authenticated. It never copies credentials or opens a login flow for an already authenticated account.

Add `--needs-3d` for model work: existing compatible Blender/Python are reused, otherwise fixed, SHA-256-checked user-local packages are installed before TripoSR setup. Windows uses managed CPython 3.12.10; Mac uses CPython 3.9. A missing Microsoft Visual C++ x64 runtime is reported for attention. `--local-only` skips Codex setup and account checks for local editing/model operations. `--data-dir /absolute/path` isolates runtime and session data. No image generation happens during preparation.

Omitting `--consent-downloads` emits metadata and `needs_consent` before a missing package is downloaded. CLI installation, local 3D readiness and provider readiness are separate fields; inspect each one. `doctor` never downloads.

```sh
"/Applications/Asset Studio.app/Contents/MacOS/asset-cli" doctor --check-gpt
"/Applications/Asset Studio.app/Contents/MacOS/asset-cli" produce \
  --game-root /absolute/MyGame --manifest /absolute/assets.json \
  --request-id 5130c051-cd41-4eaa-9f91-caa1e9808131 --allow-gpt
```

Generate a fresh UUID for each new manifest. The command prints JSON Lines: `plan`, `progress`, `result`, `needs_attention` or `error`. Keep its process running while working on game code; poll the execution session. `status --workspace /absolute/workspace` reads the last persisted progress without opening the owned project. The default workspace is outside the game, under Asset Studio's user data `cli/workspaces/`; its path is printed in the output. `--workspace` selects a different exclusive workspace. Do not use the desktop's currently open workspace.

The declarative manifest goes directly to the existing per-item production pipeline. `plannerModel=codex-manifest` records that no separate GPT planner ran. References are new verified copies. GPT generates each 2D image or each model's concept image; local TripoSR and Blender create the model files. This path has no paid API fallback. Model quality and actual image model ID must be assessed from returned evidence, not the requested model name.

Results are new folders under Unity `Assets/AssetStudioGenerated/`, Godot `AssetStudioGenerated/`, Unreal `Content/AssetStudioGenerated/`, or an unknown engine's `AssetStudioGenerated/`. These files have hash manifests; they still require actual engine import and scene integration. Inspect `result.run.items[*].outputPath` rather than guessing file names.

## Existing files and local jobs

Use `init --workspace /absolute/assets-workspace` for an empty project. `command --workspace /absolute/assets-workspace --json /absolute/request.json` exposes the same native command bridge and waits for its queued jobs. The request is JSON data; it cannot execute arbitrary code. Common requests:

```json
{"action":"import","paths":["/absolute/concept.png"]}
```

```json
{"action":"quality3d","assetIds":["ID_FROM_IMPORT"],"name":"QuietPistol","quality":"standard","heightMeters":0.25,"maxTriangles":10000,"textureResolution":1024,"preserveMaterials":true}
```

```json
{"action":"export","destination":"/absolute/MyGame/Assets/AssetStudioGenerated","assetIds":[]}
```

Import accepts validated raster images or self-contained GLB, preserving originals. `quality3d` refines an imported GLB or reconstructs an image if the local model is ready. Snapshot output contains actual assets, versions, artifacts and jobs. `model` accepts trusted procedural recipes, not generated Python. `production_manifest` and `game_connect` are local planning/scan commands. GPT commands additionally require `--allow-gpt`. Use `prepare --needs-3d --consent-downloads` for missing local prerequisites; no app screen is required.

## Recovery

Default wait limit is 24 hours; `--timeout 1..86400` controls the bound. A timeout/failure exits nonzero and preserves the workspace, originals and received outputs. Interruption after remote submission can leave `external_unknown`; it never triggers an automatic repeat. Inspect the JSON error/job status, then reuse the same UUID and unchanged manifest to resume safe pending jobs. New UUIDs mean new remote requests. To explicitly release an unknown capacity reservation, use the app's documented continuation action or a `production_continue` request with `acknowledgeUnconfirmedRequests=true`; this does not resend the unknown request. Local retry uses `production_retry` with the run/item IDs and preserves any succeeded concept image.

`production_retry` reuses a succeeded concept image and only resets the failed local stage. It refuses `external_unknown` without any automatic remote resubmission; do not invent an approval field to bypass this rule.

The CLI produces assets. Codex must still implement, import, run and test the game, and report gaps honestly.
