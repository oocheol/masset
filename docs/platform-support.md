# Platform support and packaging

0.1.2 packaging configuration updated on 2026-10-03 (Asia/Seoul). Per-version execution evidence is in [verification.md](verification.md) and [release metadata](https://github.com/oocheol/masset/blob/master/docs/releases/v0.1.2.json). The table and native execution history below describe 0.1.0; current installer evidence is recorded separately. A build command or CI configuration is not evidence that a package ran on that OS.

| Platform | Declared minimum | Source/build tooling | Native build | Installation and launch |
| --- | --- | --- | --- | --- |
| Windows x64 | Windows 10 1809+, WebView2 required | Node 24.15.0, Rust 1.99.0 MSVC, VS 18 C++; SDK 10.0.28000.2957 installed after consent | 0.1.0 release portable built; Rust 110 passed / 4 fixture helpers ignored; copied GUI/3D passed | 0.1.0: 12 native images + IPC, actual Blender GLB/WebGL and 33-file backend export verified on this host; unsigned; clean-machine checks pending |
| macOS arm64 | macOS 12.0 configured | Node 24, Rust aarch64-apple-darwin, Xcode CLI tools | Automatic CI held; manual opt-in prepared, not run | Unverified; no signing/notarization credentials |
| macOS x64 | macOS 12.0 configured | Node 24, Rust x86_64-apple-darwin, Xcode CLI tools | Automatic CI held; manual opt-in prepared, not run | Unverified; no signing/notarization credentials |

Windows 10 1809 is the Tauri 2/WebView2 baseline, not a successfully tested clean-machine minimum for this application. macOS 12.0 is the Tauri configuration value, not a verified minimum for every optional dependency. The recorded runtime is the development host only. Linux, mobile and web SaaS are outside this product's initial scope.

The default 2D pipeline has no dedicated GPU requirement. Procedural Blender templates render on CPU. Blender 5.2.1 LTS on Windows was discovered locally; macOS Blender execution has not been tested. No CUDA-only or image-to-3D weight package is installed or claimed supported.

## Windows

```powershell
npm ci
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
. .\scripts\with-native-env.ps1
cargo test --workspace
.\scripts\build-windows.ps1 -SkipInstall -SkipChecks
.\scripts\native-smoke.ps1
# Separate actual native WebView DOM/asset-protocol/IPC self-test:
.\scripts\native-smoke.ps1 -NativeWindow
```

`scripts/build-windows.ps1` defaults to Tauri `--no-bundle`, requiring no NSIS tool download. It writes a fresh `output/release/<run-id>/AssetStudio-windows-x64` folder and portable ZIP with `asset-desktop.exe`, `examples/`, the Blender worker/source license and application notices. It also copies `CODEX-CATALOG-NOTICE.txt`, `CODEX-UPSTREAM-NOTICE.txt` and `CODEX-CATALOG-LICENSE.txt` for the bundled official model-catalog text; this is not an executable or model-weight download. It checks actual app AMD64 PE headers, hashes and Authenticode status, with an immutable per-run JSON report plus a latest-report pointer. Previous NSIS EXEs cannot certify a new build. `-VcRuntimeDirectory <existing-installed-x64-CRT-directory>` optionally includes audited runtime DLLs without downloading them; clean-machine dependency testing remains required.

The native app binary is normally `target/release/asset-desktop.exe`. `asset-cli.exe --smoke <fresh-output-directory> [--with-blender]` uses the exact Rust backend, records `nativeWindow: false`, and checks native backend artifacts. The CLI still uses developer source paths and is not included in the portable application. `scripts/native-smoke.ps1` retains process stdout/stderr, the producer report, independent export verification and a separate `.qa.json` outcome. It checks the report's fresh export path and same-process ownership scope; it does not infer a window from successful backend work.

`asset-desktop.exe --ui-smoke <fresh-output-directory>` separately starts the actual Tauri WebView, waits for workstation DOM, decodes at least eight images through the native asset protocol and invokes native environment IPC, then writes `native-window.json` and exits. `scripts/native-smoke.ps1 -NativeWindow` validates those measured fields, the launched PID and Windows platform. The first actual debug run produced 0 decoded images and exited 1; that failure is retained. The corrected debug run at `output/native-smoke/20261002-074931-424d8b9d` passed DOM, all 12 native images and real native environment IPC. Neither it nor backend smoke certifies installation, upgrade or uninstall. Run it again with `-Executable <portable-folder>/asset-desktop.exe` to validate the copied distribution.

The actual native backend run at `output/native-smoke/20261002-075327-97aa7b02` exited 0 with eight successful jobs and a reopened project. Independent QA decoded and hashed its 33 exported files, checked both atlas source frames and reopened the crate/table GLB and `.blend` copies in four fresh Blender processes. Its original PowerShell outcome failed a verbatim Windows path comparison; that outcome remains preserved beside the producer result. `output/qa/native-cli-independent-58cddf96-1a52-45a3-a765-615a589ed3f3` records the successful independent artifact checks. A backend result remains distinct from the actual WebView result and final portable launch.

The first portable candidate `20261002-081005-b8d594c4` passed static and copied-window checks but failed image-processing commit checks before Blender work. Those artifacts remain preserved. The corrected release `20261002-083918-fc51e5af` passed the exact release CLI's eight jobs and 33-file independent export, four fresh Blender source/GLB reopens, copied basic WebView and actual one-meter Blender crate creation→native asset GLB fetch→WebGL drawing/pixel readback. The copied app's working directory was its portable folder, with Vite stopped. Its desktop hash is `53575158cc127d6a217d4b81ac230445cd3c2c148d508cde0b0b99b9871b8279`; its CLI hash is `525e644df292f850233cd529306d5e83a5d12e969b10bf5d645d28fd968d5e72`. Both are unsigned AMD64 PE32+ and have no VC145 CRT static imports.

The verified binaries are copied with current documentation into a new folder/ZIP without recompiling. `output/release/windows-x64-final.json` is the final distribution pointer with actual file/ZIP hashes and matching basic GUI, native 3D and backend execution evidence. The candidate and earlier failures remain immutable. The six included documentation files keep local links within `docs/`.

Packaged 2D use does not need Node, Rust or Visual Studio. The development host already has WebView2 154.0.4258.48 with a valid Microsoft signature. Its installed VC145 CRT DLLs can mask absent app-local runtime dependencies, so launch on this host alone does not prove a clean machine. Blender is not bundled and must be installed separately with explicit consent. No image-to-3D weights are downloaded.

The previously absent Windows SDK was installed from [Microsoft's Windows SDK downloads](https://learn.microsoft.com/en-us/windows/apps/windows-sdk/downloads), version 10.0.28000.2957, under the Microsoft Windows SDK license. Its signed installer and installation exit 0 are recorded in `output/native/sdk-installation.json`. Authenticode was verified as valid Microsoft Corporation; the recorded SHA-256 is locally measured, not compared with a separately published Microsoft digest. The installed x64 C++ headers/libraries and resource compiler are checked before building. No full Visual Studio reinstall is required.

## Optional managed Codex preparation

The Windows x64 app offers Codex preparation → official account login → connection check. It reads the pinned package manifest without downloading; a user must approve the displayed version/hash/license before preparation starts. Existing verified runtimes are reused. App-owned UUID installation directories and a final receipt are used; no PATH or existing Codex installation changes are made.

Source: [official rust-v0.160.0 release](https://github.com/openai/codex/releases/tag/rust-v0.160.0), package `codex-package-x86_64-pc-windows-msvc.tar.gz`, 157,444,460 bytes (150.15 MiB), SHA-256 `7f7fbbc8d6fd4ea2f3b13855ef47ea59663ba7e61fb2e9821df37163b8030891`. License: [Apache-2.0](https://github.com/openai/codex/blob/rust-v0.160.0/LICENSE) and included third-party notices. Archive size/hash/path/link/expansion checks precede extraction and OpenAI Authenticode/version verification precedes registration. HTTPS redirect hosts are fixed. This metadata is confirmed from the official release; execution proof is recorded separately in [verification.md](verification.md).

## Optional NSIS packaging tools

The user approved both NSIS tool downloads. The installed npm Tauri CLI is 2.12.1 (MIT OR Apache-2.0). Its [exact version's bundler source](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.1/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs) pins these two build-time downloads. Both downloaded files matched the exact bytes and SHA-256 below before extraction/use; the DLL and compiler are Authenticode `NotSigned`, rather than validly code-signed. The verified cache is `%LOCALAPPDATA%/tauri/NSIS`. Full NSIS/plugin terms and original source links accompany the installer.

| Download | Version / bytes | Expected SHA-256 | License |
| --- | --- | --- | --- |
| [NSIS ZIP](https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip) | 3.11 / 2,361,546 bytes | `c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1` | [Upstream COPYING](https://github.com/kichik/nsis/blob/v311/COPYING): zlib/libpng core; bzip2 module; LZMA CPL-1.0 |
| [Tauri NSIS plugin DLL](https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll) | 0.5.3 / 34,304 bytes | `5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709` | [MIT OR Apache-2.0](https://github.com/tauri-apps/nsis-tauri-utils/tree/nsis_tauri_utils-v0.5.3) |

Obtain consent for those files before building with `-Distribution Nsis -AllowBundlerDownload`. Prefer downloading and comparing their measured bytes/SHA-256 before extraction or execution, and record actual executable/DLL Authenticode results rather than assuming a signature. Tauri independently pins SHA-1 `EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D` for the ZIP and `75197FEE3C6A814FE035788D1C34EAD39349B860` for the plugin. Its default Windows cache is `%LOCALAPPDATA%/tauri/NSIS`; it may recreate an incomplete tool cache. The build script prevents uncached downloads unless explicitly allowed and verifies the known cached plugin hash. Do not reuse this inventory after changing the CLI version without checking its new source.

The 0.1.1 and 0.1.2 NSIS configurations use `webviewInstallMode: skip` and download no Microsoft bootstrapper. WebView2 must already be installed or separately obtained from Microsoft. The development runtime needs no additional download. A clean-machine runtime installation and its version/size/digest/signature need a separate record. WiX/VBScript and offline WebView packages are unnecessary for these portable/NSIS paths.

After a successful native build, run backend smoke and independently decode its export, run the actual WebView smoke, audit PE imports and required copied DLLs/resources, launch the portable copy, and only then test an approved NSIS package on installation/upgrade/uninstall. A successful package hash alone does not pass that sequence.

## macOS

Historical 0.1.2 has [Apple Silicon and Intel trial DMGs](https://github.com/oocheol/masset/releases/tag/v0.1.2), built and executed on matching native macOS 15.7.9 runners. [The successful workflow](https://github.com/oocheol/masset/actions/runs/37113522134) records 138 Rust checks per architecture, actual DMG mount/copy, local ad-hoc bundle seal, copied-app WebView/IPC/readability and separate CLI 2D output checks. Anonymous public downloads matched both native package hashes. Exact bytes, source commit and boundaries are in [Mac release metadata](https://github.com/oocheol/masset/blob/master/docs/releases/v0.1.2-macos.json); the table above remains the original 0.1.0 history.

The Mac trial supports local 2D use. Subscription generation, managed Codex and in-app updates are unsupported until official runtime trust/layout and update installation are verified on Mac. Blender 3D, Gatekeeper first-download quarantine, clean hardware, minimum macOS 12, replacement and uninstall remain unverified. The local ad-hoc seal verifies bundle contents; no Apple Developer ID identity or notarization is provided. Follow [Mac installation guidance](macos-quickstart.md).

Run on a Mac with Xcode Command Line Tools:

```sh
npm ci
rustup target add aarch64-apple-darwin
cargo test --workspace --target aarch64-apple-darwin
node scripts/collect-third-party-notices.mjs --target aarch64-apple-darwin --out docs/licenses --strict
npm run desktop:build -- --target aarch64-apple-darwin --config "$PWD/apps/desktop/src-tauri/tauri.macos.conf.json" --bundles app,dmg
```

Current published Mac builds target Apple Silicon only. Intel packaging was removed at the user's request. Rosetta execution and cross-compilation do not replace native arm64/x64 validation. Unsigned developer packages may be rejected by Gatekeeper; no signing or notarization is performed without credentials and authorization.

GitHub Actions automatically checks Windows and builds a portable distribution on `windows-latest`. Actual Windows WebView startup is an explicit `native_window_smoke` manual input. The historical combined workflow's Mac checks require `macos_checks`; the dedicated **Verified macOS packages** workflow now builds only on `macos-15` (arm64) by manual dispatch. Push/PR never schedules Mac builds. Runner names were checked against [official runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). The final 0.1.2 dedicated run was dispatched and passed; earlier failures are retained in [verification.md](verification.md). Workflows upload evidence/artifacts and never publish a release automatically.

Before claiming platform support, record package creation, digest, signature/notarization status, install location, actual window launch, 2D import/export, project reopen, optional Blender workflow, update and uninstall. Preserve user projects throughout the lifecycle.

## 0.1.3 design release

Windows and Apple Silicon packages use the new production-workbench visual system. Exact native/package/public-download checks are recorded in [0.1.3 release metadata](releases/v0.1.3.md). The Apple Silicon job in run 37133673261 succeeded; its Intel sibling was cancelled at the user's explicit request, and that run's overall conclusion is cancelled. The selected native ARM64 evidence and public DMG digest were independently checked. Current CI and download choices exclude Intel Mac. Historical 0.1.2 artifacts and records are preserved. Native sources use commit ff6cef843d4bceaf7116cee9fa227e358f54eedd; bundled 0.1.2 quickstart documents remain historical instructions, while the current repository guide describes Apple Silicon-only distribution.
