#!/bin/bash
# No builds, installs, downloads, signing, or changes to existing app data.
set -euo pipefail
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [[ "${1:-}" != "--help" && "${1:-}" != "-h" && "$(uname -s)" != "Darwin" ]]; then
  printf '%s\n' 'macOS runtime verification requires a native macOS runner.' >&2
  exit 2
fi
exec node "$script_dir/verify-macos.mjs" "$@"
