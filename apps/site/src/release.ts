export const release = {
  "version": "0.1.9",
  "filename": "AssetStudio_0.1.9_x64-setup.exe",
  "executable": "asset-desktop.exe",
  "bytes": 11044738,
  "sha256": "952241c2ca8b2417b769aee94b9d9bbb1ada8c02d843577bedebbb8a0511d373",
  "portableFilename": "AssetStudio-windows-x64-portable.zip",
  "portableBytes": 10772211,
  "portableSha256": "35a07370ce729d33e8c3122933414fef4d2e93d70e345a744968a0f77d67970d"
} as const;

export type MacRelease = {
  version: string;
  architecture: 'arm64';
  label: string;
  filename: string;
  downloadUrl: string;
  bytes: number;
  sha256: string;
};

// Only actual native packages whose anonymous downloads matched are listed.
export const macReleases: MacRelease[] = [
  {
    "version": "0.1.8",
    "architecture": "arm64",
    "label": "Apple Silicon",
    "filename": "AssetStudio_0.1.8_macos-arm64.dmg",
    "downloadUrl": "https://github.com/oocheol/masset/releases/download/v0.1.8/AssetStudio_0.1.8_macos-arm64.dmg",
    "bytes": 34515783,
    "sha256": "f0b15569c67aaf41f4a31b262a31fccc1a6b3f7f26257ac3565864ad8d2ad176"
  }
];

// The script itself is verified before it runs; its DMG checks are additional.
export const macInstallerSha256 = 'd4c56620274ce0a6238027883e42a46f6f3192d6e452958707f2936c886f4696';
export const macInstallCommand = `(
  set -eu
  install_tmp="$(mktemp -d)"
  trap 'rm -rf "$install_tmp"' EXIT
  curl -fsSL https://github.com/oocheol/masset/releases/download/v0.1.8/install-macos.sh -o "$install_tmp/install-macos.sh"
  printf '%s  %s\\n' '${macInstallerSha256}' "$install_tmp/install-macos.sh" | shasum -a 256 -c -
  bash "$install_tmp/install-macos.sh"
)`;
