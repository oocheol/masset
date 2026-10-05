export const release = {
  "version": "0.1.8",
  "filename": "AssetStudio_0.1.8_x64-setup.exe",
  "executable": "asset-desktop.exe",
  "bytes": 22499602,
  "sha256": "5d0d974abf1991f645a6cbd960c3929b93d4043694e8e7ad5794254e7fd74214",
  "portableFilename": "AssetStudio-windows-x64-portable.zip",
  "portableBytes": 10642426,
  "portableSha256": "11072a007c0a244ab1027ab298479f6470b22307d71f0290dfb2d567588de4a0"
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
