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
    "architecture": "arm64",
    "label": "Apple Silicon",
    "filename": "AssetStudio_0.1.3_macos-arm64.dmg",
    "downloadUrl": "https://github.com/oocheol/masset/releases/download/v0.1.3/AssetStudio_0.1.3_macos-arm64.dmg",
    "bytes": 16759756,
    "sha256": "8f11741d57a73886d3520716bdcd63ac83748271695e8841b5a207975fc86d68"
  }
];
