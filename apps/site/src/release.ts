export const release = {
  "filename": "AssetStudio_0.1.13_x64-setup.exe",
  "portableFilename": "AssetStudio-windows-x64-portable.zip",
  "portableSha256": "e9d7e1b7f822a76d279a2a62c5228f38ae1840a7f58d7337077ebb05f2450553",
  "bytes": 11457090,
  "sha256": "747dc7c26472f10832c4cbe5bada3451178c37441ab014b94418131e6e061d84",
  "executable": "asset-desktop.exe",
  "portableBytes": 17184103,
  "version": "0.1.13"
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
