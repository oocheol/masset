# Shared contract and ownership

`packages/contracts/src/index.ts` defines schema version 1. Rust model types in `asset_core::models` use camelCase JSON. Input project data, job data and style guides never contain runtime credentials. The UI owns transient selection, zoom and tabs; SQLite/project directories own production data.

One Tauri command `workspace_command({request})` takes a discriminated JSON action. Results:

| Action | Request | Result |
|---|---|---|
| environment | none | EnvironmentInfo |
| bootstrap | none | ProjectSnapshot |
| create | root, name | ProjectSnapshot |
| open | root | ProjectSnapshot |
| snapshot | none | ProjectSnapshot |
| update | spec?, styleGuide?, assetId?, name?, tags? | ProjectSnapshot |
| import | paths[] | ProjectSnapshot |
| process | assetId, operation | ProjectSnapshot (queued job) |
| atlas | assetIds[], options{width,height,padding}, frameRate?(1..240) | ProjectSnapshot |
| material | assetId, strength(0..16), directX:boolean | ProjectSnapshot (heuristic normal map, linear data) |
| split | assetId, frameWidth, frameHeight, frameRate?(1..240) | ProjectSnapshot |
| model | models: ModelParameters[] | ProjectSnapshot (queued jobs) |
| fixture | count? | ProjectSnapshot (local example originals) |
| export | destination, assetIds[], preset?, format? | {path:string} |
| cancel | jobId | ProjectSnapshot |
| rerun | jobId | ProjectSnapshot |
| reuse | jobId (succeeded with cacheKey) | ProjectSnapshot (verified stored result activated, no worker call) |
| provider_status / provider_login | none | ProviderConnection without auth URLs or credentials |
| generate | requestId UUID, prompt, name?, count 1..20 | ProjectSnapshot with explicit subscription jobs |
| job_events | cursor?, limit 1..256 | Durable small event page |

The frontend polls `snapshot` while jobs are active. Image transforms, sprite processing, normal-map calculation and Blender invocation use the Rust resource queue; independent local CPU tasks can overlap. Explicit GPT Image 2 requests require official runtime/auth/tool restrictions; live file proof is a separate capability status.

The backend acquires an OS file lease before recovery. Another backend cannot recover a live backend's jobs. Reopening the selected project skips recovery. Shutdown stops admission; the lease is released only after registered workers exit. The empty `.workbench.lock` marker stays, while a crash releases the actual OS lock. Windows native tests verified competing-open rejection and reopen.

Local jobs record cache identities from the prompt, ordered input SHA-256 values, canonical options, provider version and tool fingerprint. Raster fingerprints include compiled source; Blender fingerprints include the installed version and worker hash. Explicit `reuse` verifies stored output digests; `rerun` executes again into new versions. Windows native integration verified explicit reuse without another worker call.

Sprite jobs pin the normalized project pivot and requested frame rate (default 12fps) at enqueue time. Atlas coordinates preserve the input order; sheet splitting is row-major. Later specification edits do not change already-queued metadata.

Queue RAM reservations estimate simultaneous buffers from input/output dimensions. They are admission estimates, not OS allocation ceilings. Jobs exceeding the default 2GiB budget visibly block. The scheduler hash-fixture benchmark records actual overlap/memory/timing, separately from full-app workloads. Import/export are serialized foreground commands admitted only while workers are idle; queued export and OS memory enforcement remain further work.

Ownership: coordinator owns shared contracts/root config/native glue. `core` agent owns persistence; `scheduler` owns queue; `image` owns deterministic raster processing; `blender` owns fixed Python templates; `provider` owns feasibility/capabilities; `ui` owns desktop frontend. QA owns test harnesses/release documentation, but cannot claim macOS verification on a Windows host.
