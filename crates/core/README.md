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

On macOS, the bundled `libsqlite3-sys 0.30.1` Unix VFS sets
`MAX_PATHNAME=512` and uses that value as `sqlite3_vfs.mxPathname`.
`sqlite3PagerOpen` rejects a canonical database pathname when its UTF-8 byte
length plus eight bytes for `-journal` exceeds that VFS limit. For this build,
`project.sqlite` therefore needs a canonical absolute pathname of at most
504 UTF-8 bytes. Character count differs from byte count for Korean names;
the initial ARM64 CI fixture had 444 characters but 614 UTF-8 bytes and could
not open SQLite. This is a SQLite VFS limit, separate from filesystem limits.
See the versioned bundled [sqlite3.c](https://docs.rs/crate/libsqlite3-sys/0.30.1/source/sqlite3/sqlite3.c)
(`MAX_PATHNAME`, `UNIXVFS`, `sqlite3PagerOpen`) and
[build.rs](https://docs.rs/crate/libsqlite3-sys/0.30.1/source/build.rs).
The source defines `MAX_PATHNAME` unconditionally; an additional compiler
`-DMAX_PATHNAME=...` does not safely replace it. No SQLite compile flags changed.

The macOS repository checks the actual default VFS limit before reserving a
new database or opening an existing one, and reports an actionable byte-limit
error without replacing existing files. `/var` and `/tmp` normalization to
`/private` is included in the length. The macOS test still requires over
260 characters with Korean names and spaces, and verifies original/copy hashes,
database reopen, and an actual export under a long sibling directory. Its
fixture stays within the VFS byte budget and also allows for the two-byte-longer
`scheduler.sqlite` filename. Applications using that queue must keep its
canonical database pathname within the same 504-byte limit. Windows retains
the original ten-level fixture and its UTF-16 length assertion.
`MACOS_SQLITE_PATH_VERIFIED` records the native byte/character counts with
`-- --nocapture`; the fixture-profile test on Windows is only a construction
check and does not establish macOS I/O support.

To retain inspectable native fixture outputs, run
`cargo run -p asset-core --example bundle_smoke -- <proof directory>`. It creates
a fresh UUID directory containing original PNG input, SQLite project, all
versions, portable bundle, and a report with reread file hashes. This verifies
the native Rust storage/export path; it does not assert desktop UI or external
provider support.
