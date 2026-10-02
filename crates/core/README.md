# asset-core

Local-first project persistence for Asset Studio. The public wire models mirror
`packages/contracts/src/index.ts`; Rust field names use snake_case and JSON uses
camelCase. Optional provider/model evidence stays null until verified.

`Repository::create`, `open`, `project`, `save_project`, `copy_in`, `add_asset`,
`add_version`, `upsert_job`, and `export_bundle` are the integration API.
`artifact_path` safely resolves a file, `verify_artifact` checks its bytes, and
`sha256_file` returns SHA-256 and actual byte count.

The SQLite `project.sqlite` database is authoritative. It uses WAL, full
synchronization, a five-second busy timeout, and versioned migrations.
`project.json` is written through a synced temporary file and atomic replacement
and repaired from SQLite on reopen if interrupted. Database versions newer than
this binary are rejected without a downgrade.
Concurrent connections reject stale snapshots rather than silently losing
another connection's changes. Reload the project before retrying a rejected save.

Copies have paths such as `sources/<uuid>/서울 원본.PNG`. Every copy reserves a
new directory and file, so identical names and case variants remain distinct.
The caller validates import format/size. This module copies bytes and never
decodes or executes asset inputs. Source files are not modified. Traversal,
absolute artifact paths, nonportable Windows names, symlinks, and Windows
reparse points are rejected.
On macOS only, the OS aliases `/var`, `/tmp`, and `/etc` are accepted after
checking their exact `/private` link targets and canonical paths. User-created
file and directory symlinks remain rejected.

Export returns a new `asset-studio-export-<uuid>` directory under the selected
destination. An empty asset selection exports all assets; a nonempty selection
must contain known IDs. Every selected asset version is included. `manifest.json`
contains specs, style, version settings, requested and confirmed model evidence,
validation reports, and relative paths/hash/size for all actual files. Hashes are
checked before and after copying. Export inside the source project is rejected.
Job payloads and SQLite are not included in the portable export.

Run `cargo test -p asset-core --test repository` from the workspace. These tests
check database reopen, Korean/space/case filenames, atomic snapshot repair,
original hashes, independent export reading after moving the source project,
tamper rejection, path boundaries, and native Windows junction handling.
Long Korean/space paths exceed 260 UTF-16 units on Windows. Run the tests with
`-- --nocapture` to retain either `LONG_PATH_VERIFIED` or an explicit `SKIPPED`
message if the Windows environment reports filename-range error 206. A skip is
not evidence of long-path support. macOS-specific checks require a native macOS
test run before support can be reported as verified.

To retain inspectable native fixture outputs, run
`cargo run -p asset-core --example bundle_smoke -- <proof directory>`. It creates
a fresh UUID directory containing original PNG input, SQLite project, all
versions, portable bundle, and a report with reread file hashes. This verifies
the native Rust storage/export path; it does not assert desktop UI or external
provider support.
