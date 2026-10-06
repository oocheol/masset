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
    "version": "0.1.13",
    "architecture": "arm64",
    "label": "Apple Silicon",
    "filename": "AssetStudio_0.1.13_macos-arm64.dmg",
    "downloadUrl": "https://github.com/oocheol/masset/releases/download/v0.1.13/AssetStudio_0.1.13_macos-arm64.dmg",
    "bytes": 19522907,
    "sha256": "b18e9de1549655692c21d013f1a9cf6004ba984014d79e95001b6c0ac79dc77d"
  }
];

// The script itself is verified before it runs; its DMG checks are additional.
export const macInstallerSha256 = 'bb71a4c54d8db7ccf457ebb530af158d267336be8b4d0657820f02f0583c3149';
export const macInstallCommand = `(
  set -eu
  install_tmp="$(mktemp -d)"
  trap 'rm -rf "$install_tmp"' EXIT
  curl -fsSL https://github.com/oocheol/masset/releases/download/v0.1.13/install-macos.sh -o "$install_tmp/install-macos.sh"
  printf '%s  %s\\n' '${macInstallerSha256}' "$install_tmp/install-macos.sh" | shasum -a 256 -c -
  bash "$install_tmp/install-macos.sh"
)`;
