# Native CLI

Use the absolute executable path from `installation.json` and quote paths using the host shell. The CLI is bundled with the Mac app. A development binary requires `--resources /absolute/masset`. Windows code is included; the new agent workflow is only verified on Apple Silicon Mac.

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

Import accepts validated raster images or self-contained GLB, preserving originals. `quality3d` refines an imported GLB or reconstructs an image if the local model is ready. Snapshot output contains actual assets, versions, artifacts and jobs. `model` accepts the trusted procedural recipes described by Asset Studio, not generated Python. `production_manifest` and `game_connect` are local planning/scan commands. GPT commands additionally require `--allow-gpt`. `doctor` does not download runtimes; use the app's existing preparation UI once if prerequisites are missing.

## Recovery

Default wait limit is 24 hours; `--timeout 1..86400` controls the bound. A timeout/failure exits nonzero and preserves the workspace, originals and received outputs. Interruption after remote submission can leave `external_unknown`; it never triggers an automatic repeat. Inspect the JSON error/job status, then reuse the same UUID and unchanged manifest to resume safe pending jobs. New UUIDs mean new remote requests. To explicitly release an unknown capacity reservation, use the app's documented continuation action or a `production_continue` request with `acknowledgeUnconfirmedRequests=true`; this does not resend the unknown request. Local retry uses `production_retry` with the run/item IDs and preserves any succeeded concept image.

`production_retry` reuses a succeeded concept image and only resets the failed local stage. It refuses `external_unknown` without any automatic remote resubmission; do not invent an approval field to bypass this rule.

The CLI produces assets. Codex must still implement, import, run and test the game, and report gaps honestly.
