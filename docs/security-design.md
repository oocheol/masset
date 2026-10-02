# Security and rights boundaries

The application is local-first. Projects, original assets, output versions and job history stay in the project directory/SQLite. Telemetry and remote error reporting are disabled by default; there is no application server or paid API fallback.

| Input/boundary | Handling | Limits |
| --- | --- | --- |
| Image imports | Local decode with dimension/size limits and new immutable artifact copy | Decoders remain trusted dependencies; corrupt data must fail safely |
| Project and export paths | Validate relative components; canonicalize containment; fresh directories; SHA-256 | Filesystem permissions are not an application sandbox |
| Job parameters | Typed contracts, bounded numbers, audited templates | Generated Python/shell is never treated as an asset input |
| Blender process | Factory startup, script auto-execution disabled, bounded threads, approved worker | Runs with user permissions; process separation is not sandboxing |
| GLB/glTF | Self-contained exports, references checked, independent reopen | External URLs are not fetched by the artifact verifier |
| SVG/archives/arbitrary `.blend` import | Native imports accept raster images; browser development reopening accepts the application's project ZIP format | No generic executable/vector/archive import; do not label raster embeds as editable vectors |
| Provider authentication | Official Codex runtime owns auth lifecycle | No cookies/session extraction/private endpoints/credential export |

Tokens, cookies and raw authentication files must not reach frontend state, project JSON, logs, exports, ZIPs or error reports. The provider inspector reads public runtime capabilities and redacts auth observations; project provenance records provider/tool version and requested/confirmed model only. Credentials are not implemented as project settings. If an adapter later needs its own secrets, use the OS secure store rather than plaintext files.

External generation uses the user-approved GPT Image 2 target through official managed Codex. The explicit generation form sends the entered description and approved style/specification; reference uploads are unsupported. Public runtime configuration pins the official provider and endpoint, excludes user-defined tool integrations, and disables telemetry. Application code does not call private HTTP endpoints. Unknown outcomes remain `external_unknown`; automatic duplicate submissions are not recovery. Codex turn interruption alone does not prove remote image cancellation. Diagnostics persist allowlisted error classes/status and boolean hints, never raw error text.

Imports and previous versions are preserved. Cache cleanup is not original deletion. Temporary output finalization must not overwrite a user's source. Test path traversal, symlink/junction escapes, Unicode/spaces, duplicate names, case collisions and oversized data; the independent verifier applies its own 256 MiB file, 64-megapixel PNG and 16 MiB JSON bounds.

Third-party code, Blender integration, model weights and example assets have separate license records. The core's Apache-2.0 license does not grant rights to arbitrary user inputs or generated outputs. Blender subprocess separation alone does not eliminate GPL obligations; the worker's GPL source/license is included separately and Blender itself is not bundled. No non-commercial model weights are default dependencies.

Visualization outputs are not CAD solids, toleranced drawings, certified engineering designs or manufacturing instructions. Preserve a review status when an asset is used in a context needing rights, safety or engineering assessment. Report vulnerabilities using [SECURITY.md](../SECURITY.md).
