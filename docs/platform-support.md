# Platform support and packaging

Checked on 2026-10-02 (Asia/Seoul). A build command or CI configuration is not evidence that a package ran on that OS.

| Platform | Declared minimum | Source/build tooling | Native build | Installation and launch |
| --- | --- | --- | --- | --- |
| Windows x64 | Windows 10 1809+, WebView2 required | Node 24.15.0, Rust 1.99.0 MSVC, VS 18 C++; SDK 10.0.28000.2957 installed after consent | Release portable built; Rust 110 passed / 4 fixture helpers ignored; final release backend and copied GUI/3D passed | 12 native images + IPC, actual Blender GLB/WebGL and 33-file backend export verified on this host; unsigned; clean-machine checks pending; NSIS download not approved |
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

## Optional NSIS packaging tools

NSIS is not yet approved or downloaded in this session. The installed npm Tauri CLI is 2.12.1 (MIT OR Apache-2.0). Its [exact version's bundler source](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.1/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs) pins these two build-time downloads. The sizes and SHA-256 values below come from official release metadata; they are expected values, not successful local download checks.

| Download | Version / bytes | Expected SHA-256 | License |
| --- | --- | --- | --- |
| [NSIS ZIP](https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip) | 3.11 / 2,361,546 bytes | `c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1` | [Upstream COPYING](https://github.com/kichik/nsis/blob/v311/COPYING): zlib/libpng core; bzip2 module; LZMA CPL-1.0 |
| [Tauri NSIS plugin DLL](https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll) | 0.5.3 / 34,304 bytes | `5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709` | [MIT OR Apache-2.0](https://github.com/tauri-apps/nsis-tauri-utils/tree/nsis_tauri_utils-v0.5.3) |

Obtain consent for those files before building with `-Distribution Nsis -AllowBundlerDownload`. Prefer downloading and comparing their measured bytes/SHA-256 before extraction or execution, and record actual executable/DLL Authenticode results rather than assuming a signature. Tauri independently pins SHA-1 `EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D` for the ZIP and `75197FEE3C6A814FE035788D1C34EAD39349B860` for the plugin. Its default Windows cache is `%LOCALAPPDATA%/tauri/NSIS`; it may recreate an incomplete tool cache. The build script prevents uncached downloads unless explicitly allowed and verifies the known cached plugin hash. Do not reuse this inventory after changing the CLI version without checking its new source.

The current NSIS WebView mode embeds download instructions rather than a full runtime: at installation time, a missing runtime triggers the [official Microsoft bootstrapper](https://go.microsoft.com/fwlink/p/?LinkId=2124703). The existing development runtime needs no additional download. A clean-machine runtime download, version/size/digest/signature and install behavior need a separate record. WiX/VBScript and offline WebView packages are unnecessary for the current portable/NSIS paths.

After a successful native build, run backend smoke and independently decode its export, run the actual WebView smoke, audit PE imports and required copied DLLs/resources, launch the portable copy, and only then test an approved NSIS package on installation/upgrade/uninstall. A successful package hash alone does not pass that sequence.

## macOS

Run on a Mac with Xcode Command Line Tools:

```sh
npm ci
rustup target add aarch64-apple-darwin
cargo test --workspace --target aarch64-apple-darwin
npm run desktop:build -- --target aarch64-apple-darwin --bundles app,dmg
```

On Intel macOS, replace the target with `x86_64-apple-darwin`. Test each architecture on matching hardware. Rosetta execution and cross-compilation do not replace native arm64/x64 validation. Unsigned developer packages may be rejected by Gatekeeper; no signing or notarization is performed without credentials and authorization.

GitHub Actions automatically checks Windows and builds a portable distribution on `windows-latest`. Actual Windows WebView startup is an explicit `native_window_smoke` manual input. macOS builds on `macos-15` (arm64) and `macos-15-intel` (x64) require the `macos_checks` manual input; push/PR never schedules them. Runner names were checked against [official runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). These workflow definitions have not been dispatched during this local session. They upload evidence/artifacts and never publish a release automatically.

Before claiming platform support, record package creation, digest, signature/notarization status, install location, actual window launch, 2D import/export, project reopen, optional Blender workflow, update and uninstall. Preserve user projects throughout the lifecycle.
