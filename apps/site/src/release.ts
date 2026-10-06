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
    "version": "0.1.12",
    "architecture": "arm64",
    "label": "Apple Silicon",
    "filename": "AssetStudio_0.1.12_macos-arm64.dmg",
    "downloadUrl": "https://github.com/oocheol/masset/releases/download/v0.1.12/AssetStudio_0.1.12_macos-arm64.dmg",
    "bytes": 19259262,
    "sha256": "7ca56c53f6b469c4f8ee4df3f4bea1457a83c7aabbd1960bd5c6145587777f27"
  }
];

// The script itself is verified before it runs; its DMG checks are additional.
export const macInstallerSha256 = '62048d7f4fe46ad14eca27eb3a2c9299e0e6f0ecaa8cd4aad73a2f31e19e2a62';
export const macInstallCommand = `(
  set -eu
  install_tmp="$(mktemp -d)"
  trap 'rm -rf "$install_tmp"' EXIT
  curl -fsSL https://github.com/oocheol/masset/releases/download/v0.1.12/install-macos.sh -o "$install_tmp/install-macos.sh"
  printf '%s  %s\\n' '${macInstallerSha256}' "$install_tmp/install-macos.sh" | shasum -a 256 -c -
  bash "$install_tmp/install-macos.sh"
)`;
