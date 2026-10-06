export const release = {
  "filename": "AssetStudio_0.1.11_x64-setup.exe",
  "portableFilename": "AssetStudio-windows-x64-portable.zip",
  "portableSha256": "6fdde0ad9bf4a98b5e3eba2377556eeab869cbfb4c045bad6fe63071f8a1c328",
  "bytes": 11321763,
  "sha256": "b542cdd1580157ca6a11426eb6db93bc88dbd300e4014f615b80a9a017cfe6ef",
  "executable": "asset-desktop.exe",
  "portableBytes": 16949834,
  "version": "0.1.11"
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

// Native package metadata comes from the shipping bytes; QA scope is in the release record.
export const macReleases: MacRelease[] = [
  {
    "version": "0.1.10",
    "architecture": "arm64",
    "label": "Apple Silicon",
    "filename": "AssetStudio_0.1.10_macos-arm64.dmg",
    "downloadUrl": "https://github.com/oocheol/masset/releases/download/v0.1.10/AssetStudio_0.1.10_macos-arm64.dmg",
    "bytes": 15111194,
    "sha256": "e47fe42b39539f0d883251c1b6a5e944aa2c92f790f37eb3ba34d6e5ce778974"
  }
];

// The script itself is verified before it runs; its DMG checks are additional.
export const macInstallerSha256 = '02bb8da6d5405ac0fc66bf8d0c96f240495bcd195fdd59b915b4d043ce659572';
export const macInstallCommand = `(
  set -eu
  install_tmp="$(mktemp -d)"
  trap 'rm -rf "$install_tmp"' EXIT
  curl -fsSL https://github.com/oocheol/masset/releases/download/v0.1.10/install-macos.sh -o "$install_tmp/install-macos.sh"
  printf '%s  %s\\n' '${macInstallerSha256}' "$install_tmp/install-macos.sh" | shasum -a 256 -c -
  bash "$install_tmp/install-macos.sh"
)`;
