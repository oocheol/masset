# Installer components

The Windows installer incorporates the unmodified NSIS 3.11 installer stub/compression modules and nsis_tauri_utils 0.5.3. These are separate from the application's Apache-2.0 license. Exact upstream license bytes are in `NSIS-COPYING.txt`, `NSIS-TAURI-UTILS-LICENSE-MIT.txt` and `NSIS-TAURI-UTILS-LICENSE-APACHE.txt`.

Unmodified, version-matched source is publicly available at:

- NSIS: https://github.com/kichik/nsis/tree/v311
- Tauri installer plugin: https://github.com/tauri-apps/nsis-tauri-utils/tree/nsis_tauri_utils-v0.5.3

NSIS compression-module terms include CPL-1.0 and bzip2 alongside the zlib/libpng core terms. Recipients may obtain and modify the original source under those terms. No proprietary change to these components is incorporated.

The approved tool ZIP (2,361,546 bytes) matched SHA-256 `c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1`. The approved plugin DLL (34,304 bytes) matched SHA-256 `5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709`. Both were obtained from the official Tauri GitHub release locations documented in platform-support.md. They were verified before use; this checksum check is distinct from Windows Authenticode.
