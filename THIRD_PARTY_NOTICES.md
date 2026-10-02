# Third-party notices and redistribution boundaries

Core application source is Apache-2.0; see [LICENSE](LICENSE). The resolved Windows and frontend dependency inventory, exact license/copyright texts, supplemental vendor notices and matching unmodified MPL source archives are provided in [docs/licenses](docs/licenses/README.md). These upstream licenses remain applicable to their components. Regenerate and review the inventory after changing either lockfile.

| Component | Purpose | License / source |
| --- | --- | --- |
| Tauri 2, tauri-build, tauri-plugin-dialog | Native shell/build/dialogs | MIT OR Apache-2.0; https://github.com/tauri-apps/tauri |
| Tauri CLI 2.12.1 | Installed developer packaging tool | MIT OR Apache-2.0; https://github.com/tauri-apps/tauri/tree/tauri-cli-v2.12.1 |
| Microsoft Edge WebView2 SDK loader 1.0.3800.47 | Native WebView loader linked by webview2-com-sys | Microsoft SDK/vendor terms, distinct from the Rust wrapper license; exact upstream notice and terms in `docs/licenses/` |
| NSIS 3.11 (not downloaded yet) | Optional Windows installer compiler | zlib/libpng core, bzip2 module, LZMA CPL-1.0; https://github.com/kichik/nsis/blob/v311/COPYING |
| nsis_tauri_utils 0.5.3 (not downloaded yet) | Optional Tauri NSIS installer plugin | MIT OR Apache-2.0; https://github.com/tauri-apps/nsis-tauri-utils/tree/nsis_tauri_utils-v0.5.3 |
| React, React DOM | Workstation UI | MIT; https://github.com/facebook/react |
| TypeScript | Compile-time tooling | Apache-2.0; https://github.com/microsoft/TypeScript |
| Vite | Frontend development/build | MIT; https://github.com/vitejs/vite |
| Three.js | 3D viewport and independent GLB loader | MIT; https://github.com/mrdoob/three.js |
| Lucide | UI icons | ISC; https://github.com/lucide-icons/lucide |
| JSZip | Browser fixture export tooling | MIT OR GPL-3.0-or-later (MIT option); https://github.com/Stuk/jszip |
| image | Local raster codecs/transforms | MIT OR Apache-2.0; https://github.com/image-rs/image |
| rusqlite / SQLite | Local storage | MIT / SQLite public domain; https://github.com/rusqlite/rusqlite, https://sqlite.org/copyright.html |
| serde / serde_json | Data contracts | MIT OR Apache-2.0; https://github.com/serde-rs |
| sha2 | Artifact digests | MIT OR Apache-2.0; https://github.com/RustCrypto/hashes |
| pngjs | Independent PNG decoder (development QA) | MIT; https://github.com/pngjs/pngjs |
| resvg-js 2.6.2 | Local fixture rasterization (development tooling only) | MPL-2.0, verified from the installed package/lockfile; https://github.com/yisibl/resvg-js |
| Vitest / Playwright | Local fixture/browser tests | MIT / Apache-2.0; https://github.com/vitest-dev/vitest, https://github.com/microsoft/playwright |
| Blender 5.2.1 LTS | Optional local procedural modeling/rendering executable | GPL-3.0-or-later; https://www.blender.org/about/license/ |
| OpenAI Codex planner catalog | Pinned public planner metadata for the official runtime | Apache-2.0; commit `b1e72963c3b71a9265a551e54beff078384efed9`, https://github.com/openai/codex/blob/b1e72963c3b71a9265a551e54beff078384efed9/codex-rs/models-manager/models.json ; full license/notice in `crates/providers/assets/` |

Blender itself is not bundled. The Python worker imports Blender APIs and is separately licensed GPL-3.0-or-later; its source and license must accompany worker redistribution. See `workers/blender/LICENSE`. Do not assume that separate processes remove GPL duties. Core and worker modules preserve their own licenses.

Microsoft Windows SDK, WebView2 and Visual C++ runtime files have Microsoft license terms separate from the application's Apache license. The SDK is a development prerequisite and is not bundled. WebView2 is an OS runtime prerequisite. Only audited files from an already installed redistributable CRT directory may be copied into a portable artifact; preserve applicable Microsoft redistribution notices and do not infer clean-machine support from the development host. Exact optional NSIS source/version/size/checksum and download consent boundaries are in [platform-support](docs/platform-support.md).

The existing licensed system Blender executable is discovered locally. No image-to-3D weights, third-party asset pack or non-commercial-only model is installed as a default dependency. Future weight adapters must record code and weights licenses separately, plus commercial use/redistribution rights, exact version, source, bytes and SHA-256, and require consent before downloads. The MPL-2.0 resvg dependency runs only as local fixture-generation tooling and is not an application runtime dependency; redistributing that tool still requires its own notices and source obligations.

Local demo icon fixtures are generated from repository-owned geometric definitions. They are labeled `fixture`; no provider generation is claimed. User images, prompts, reference assets and produced outputs retain their own rights/provenance. The Apache/GPL source licenses do not guarantee every imported/generated asset is clear for commercial use.

The external Codex/ChatGPT service is not part of the application's open-source license. Subscription eligibility, model availability and generated-output terms remain provider-controlled. Cookies/tokens/runtime auth files are neither dependencies to redistribute nor exportable project data.

The portable distribution includes `docs/licenses/THIRD_PARTY_LICENSES.txt`, the dependency inventory, exact upstream text files and the matching MPL source archives. The website includes frontend dependency notices at `/third-party-notices.txt`. `scripts/collect-third-party-notices.mjs` records source/version/SHA-256 and fails strict collection when required package texts are missing. Collection does not certify platform compatibility or grant rights beyond the upstream terms. OS runtimes and separately installed Blender/Codex remain separate requirements.
