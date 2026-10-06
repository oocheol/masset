export const release = {
  "filename": "AssetStudio_0.1.12_x64-setup.exe",
  "portableFilename": "AssetStudio-windows-x64-portable.zip",
  "portableSha256": "817ce8a9fa8322fdcaefb1d0338155b88e58f9ccd58c1b4958eb612642648e54",
  "bytes": 11323573,
  "sha256": "58c7d4d9a7ae744a6e838a0030cadf341bf5309eff70e49ba8eb4f5784c0a939",
  "executable": "asset-desktop.exe",
  "portableBytes": 16975175,
  "version": "0.1.12"
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
