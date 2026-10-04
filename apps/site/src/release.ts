export const release = {
  "version": "0.1.3",
  "filename": "AssetStudio_0.1.3_x64-setup.exe",
  "executable": "asset-desktop.exe",
  "bytes": 20417597,
  "sha256": "09bea559a57b4128174282687c60ee77d1da2eaba232d3c3733774b9db6a6241",
  "portableFilename": "AssetStudio-windows-x64-portable.zip",
  "portableBytes": 9563536,
  "portableSha256": "1599f9194f2928808031e38e8ba9826d23967ce49445336e7a4b101bb08531f5"
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
    "version": "0.1.4",
    "architecture": "arm64",
    "label": "Apple Silicon",
    "filename": "AssetStudio_0.1.4_macos-arm64.dmg",
    "downloadUrl": "https://github.com/oocheol/masset/releases/download/v0.1.4/AssetStudio_0.1.4_macos-arm64.dmg",
    "bytes": 21508942,
    "sha256": "20a558483e5585a79fbdfda6e5848cbcc23f355b27e2a5bff882b19a051c905e"
  }
];

// The script itself is verified before it runs; its DMG checks are additional.
export const macInstallerSha256 = 'a5890b72117613d686dcf26e98dd1515b665e589a998ada4613d7be2b002a2be';
export const macInstallCommand = `(
  set -eu
  install_tmp="$(mktemp -d)"
  trap 'rm -rf "$install_tmp"' EXIT
  curl -fsSL https://github.com/oocheol/masset/releases/download/v0.1.4/install-macos.sh -o "$install_tmp/install-macos.sh"
  printf '%s  %s\\n' '${macInstallerSha256}' "$install_tmp/install-macos.sh" | shasum -a 256 -c -
  bash "$install_tmp/install-macos.sh"
)`;
