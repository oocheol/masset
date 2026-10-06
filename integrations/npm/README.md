# Asset Studio Codex skill

Install the **Asset Studio skill** for Codex on Windows x64 or Apple Silicon Mac. A separate Asset Studio desktop app is optional. Node.js 22.20 or newer is required for this npm installer.

```sh
npx @oocheol/asset-studio@latest install
```

Then start a new Codex task and request `$asset-studio` with your game or asset requirements. The skill reuses your existing official Codex login. Native tools are prepared on first use with consent; 3D tools and model weights are prepared only for 3D work.

Update to the skill bundled in the latest npm release:

```sh
npx @oocheol/asset-studio@latest update
```

For a persistent installer command:

```sh
npm install --global @oocheol/asset-studio
asset-studio-skill install
asset-studio-skill status
```

`npm install --global @oocheol/asset-studio@latest` updates the installer; run `asset-studio-skill update` afterward to update the installed skill. npm installation has no lifecycle hooks and does not automatically change skills, download executables/models or change authentication.

Use `--project /absolute/project/folder` for a single existing project, or `--json` for machine-readable output. The default location is `~/.agents/skills/asset-studio`; a single existing `~/.codex/skills/asset-studio` is reused. If both exist, the installer reports the duplicate without deleting it.

Each npm version carries the exact skill files and a SHA-256 inventory. The npm installer version and pinned Windows/Mac runtime versions are reported separately. Reinstalling an intact version changes nothing. Replacing an older or modified skill preserves the entire previous directory in `.agents/.asset-studio-skill/backups`, outside skill discovery. This backup location is also used when updating a legacy Codex location. Backups are not removed automatically.

Version 0.1.12 prepares Windows CLI 0.1.12 and Apple Silicon Mac CLI 0.1.11. The installer and each native runtime are versioned independently; `status` displays both. Pin the npm version with `npx @oocheol/asset-studio@0.1.12 install`. The [setup guide](https://github.com/oocheol/masset/blob/master/docs/skill-first-setup.md) documents runtime downloads, consent, original preservation and platform verification limits. A manual [skill ZIP](https://github.com/oocheol/masset/releases/download/v0.1.12/AssetStudio_0.1.12_codex-plugin-windows-macos.zip) is also available and does not require Node.js.

Source and issues: [oocheol/masset](https://github.com/oocheol/masset). License: Apache-2.0.
