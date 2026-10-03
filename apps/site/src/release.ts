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
export const macReleases: MacRelease[] = [];
