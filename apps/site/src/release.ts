export const release = {
  "version": "0.1.2",
  "filename": "AssetStudio_0.1.2_x64-setup.exe",
  "executable": "asset-desktop.exe",
  "bytes": 20412586,
  "sha256": "fe042a70b9ac5dbb3b4a67355d6d6fe9bb9b72ff63e28d7b694f6823a4180a85",
  "portableFilename": "AssetStudio-windows-x64-portable.zip",
  "portableBytes": 9547193,
  "portableSha256": "f56a1013d97b2541897fd3ff6c632e47fd587e1158c29c69b88015873149e505"
} as const;

export type MacRelease = {
  architecture: 'arm64' | 'x64';
  label: string;
  filename: string;
  downloadUrl: string;
  bytes: number;
  sha256: string;
};

// Populated only after the actual macOS package and public download are verified.
export const macReleases: MacRelease[] = [
  {
    "architecture": "arm64",
    "label": "Apple Silicon",
    "filename": "AssetStudio_0.1.2_macos-arm64.dmg",
    "downloadUrl": "https://github.com/oocheol/masset/releases/download/v0.1.2/AssetStudio_0.1.2_macos-arm64.dmg",
    "bytes": 16758899,
    "sha256": "077ab59fac87524cc9a6d71b1102d94a75a19dc45333d3e972ee483d0e18a028"
  },
  {
    "architecture": "x64",
    "label": "Intel",
    "filename": "AssetStudio_0.1.2_macos-x64.dmg",
    "downloadUrl": "https://github.com/oocheol/masset/releases/download/v0.1.2/AssetStudio_0.1.2_macos-x64.dmg",
    "bytes": 17942253,
    "sha256": "831838593432c1b0ed0744b1a7c2348f6f578fe0912b95533c6046c3f4231a40"
  }
];
