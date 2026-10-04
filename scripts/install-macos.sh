#!/bin/bash
# Installs a pinned GitHub trial release into a NEW user-owned app directory.
# Does not need an Apple account, sudo, or a change to system Gatekeeper policy.
set -euo pipefail

version='0.1.5'
filename="AssetStudio_${version}_macos-arm64.dmg"
download_url="https://github.com/oocheol/masset/releases/download/v${version}/${filename}"
expected_bytes='27171608'
expected_sha256='bcdf15364201fdfa78146e93a32a0728b2416b64e67e1d5bb2c274ab22945ea2'
install_root="${HOME}/Applications/Asset Studio 0.1.5"
local_dmg=''
assume_yes=false
launch_app=true
check_only=false

usage() {
  cat <<'HELP'
Install Asset Studio 0.1.5 for Apple Silicon from its verified GitHub release.
Usage: bash install-macos.sh [--yes] [--no-launch] [--check-only]
                             [--destination <absolute-directory>] [--dmg <existing-file>]
Default destination: ~/Applications/Asset Studio 0.1.5/Asset Studio.app (existing apps are never replaced).
This is an Apple-unnotarized trial. The installer verifies the pinned SHA-256 and
app signature, then copies only the new app without browser quarantine metadata.
System Gatekeeper policy and existing downloads, apps and projects are unchanged.
HELP
}
fail() { printf '%s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --yes) assume_yes=true; shift ;;
    --no-launch) launch_app=false; shift ;;
    --check-only) check_only=true; shift ;;
    --destination|--dmg)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail "Missing value for $1"
      if [[ "$1" == --destination ]]; then install_root="$2"; else local_dmg="$2"; fi
      shift 2 ;;
    *) usage >&2; fail "Unknown option: $1" ;;
  esac
done

[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || fail 'Apple Silicon macOS is required. Run Terminal natively, without Rosetta.'
[[ "$install_root" == /* && "$install_root" != / && ! -L "$install_root" ]] || fail 'Destination must be an absolute directory, not / or a symlink.'
installed_app="${install_root}/Asset Studio.app"
[[ ! -e "$installed_app" && ! -L "$installed_app" ]] || fail "Existing app preserved: ${installed_app}. Choose another --destination to install a separate copy."
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/assetstudio-install.XXXXXX")"
mount_point="${work_dir}/mount"
mounted=false
created_app=false
completed=false

cleanup() {
  local status=$?
  if [[ "$mounted" == true ]]; then /usr/bin/hdiutil detach "$mount_point" >/dev/null || printf '%s\n' "Detach this installer mount manually: ${mount_point}" >&2; fi
  if [[ "$created_app" == true && "$completed" != true ]]; then /bin/rm -rf -- "$installed_app"; fi
  if [[ "$mounted" != true || ! -d "${mount_point}/Asset Studio.app" ]]; then /bin/rm -rf -- "$work_dir"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -n "$local_dmg" ]]; then
  [[ -f "$local_dmg" && ! -L "$local_dmg" ]] || fail 'The supplied DMG must be an existing regular file.'
  # Hash and mount the same private copy; a local source path may change.
  dmg_path="${work_dir}/${filename}"
  /bin/cp -- "$local_dmg" "$dmg_path"
else
  dmg_path="${work_dir}/${filename}"
  printf 'Downloading the official GitHub release %s…\n' "$version"
  /usr/bin/curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --retry 3 --max-time 600 --max-filesize "$expected_bytes" "$download_url" --output "$dmg_path"
fi
actual_bytes="$(/usr/bin/stat -f %z "$dmg_path")"
actual_sha256="$(/usr/bin/shasum -a 256 "$dmg_path")"
actual_sha256="${actual_sha256%% *}"
[[ "$actual_bytes" == "$expected_bytes" && "$actual_sha256" == "$expected_sha256" ]] || fail 'Release size or SHA-256 mismatch. Nothing was installed.'
printf 'SHA-256 verified: %s\n' "$actual_sha256"
/usr/bin/hdiutil verify "$dmg_path" >/dev/null
/bin/mkdir "$mount_point"
mounted=true
/usr/bin/hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mount_point" "$dmg_path" >/dev/null
source_app="${mount_point}/Asset Studio.app"
[[ -d "$source_app" && ! -L "$source_app" ]] || fail 'The expected Asset Studio app is missing from the verified DMG.'
plist="${source_app}/Contents/Info.plist"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")" == org.localassets.workbench ]] || fail 'Unexpected application identifier.'
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")" == "$version" ]] || fail 'Unexpected application version.'
executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")"
[[ -n "$executable" && "$executable" != */* && "$executable" != *\\* && "$executable" != . && "$executable" != .. ]] || fail 'Unsafe application executable name.'
[[ "$(/usr/bin/lipo -archs "${source_app}/Contents/MacOS/${executable}")" == arm64 ]] || fail 'The app is not the expected native Apple Silicon build.'
/usr/bin/codesign --verify --deep --strict "$source_app"
printf 'Asset Studio %s: native arm64 bundle and ad-hoc seal verified. Apple notarization is absent.\n' "$version"
if [[ "$check_only" == true ]]; then exit 0; fi

printf 'Install the verified, Apple-unnotarized trial to %s?\n' "$installed_app"
printf '%s\n' 'Only this new app copy will omit browser quarantine metadata. Existing apps and system security settings are preserved.'
if [[ "$assume_yes" != true ]]; then
  [[ -r /dev/tty ]] || fail 'An interactive terminal is required. Use --yes only after reviewing the installation notice.'
  printf 'Continue [y/N]: ' >/dev/tty
  answer=''
  read -r answer </dev/tty || fail 'Installation cancelled.'
  [[ "$answer" == y || "$answer" == Y || "$answer" == yes ]] || fail 'Installation cancelled.'
fi
/bin/mkdir -p "$install_root"
# mkdir reserves a fresh destination atomically and refuses an existing app.
/bin/mkdir "$installed_app"
created_app=true
/usr/bin/ditto --noqtn "$source_app" "$installed_app"
/usr/bin/codesign --verify --deep --strict "$installed_app"
/usr/bin/xattr -lr "$installed_app" >"${work_dir}/copied-attributes.txt"
if /usr/bin/grep -q 'com.apple.quarantine:' "${work_dir}/copied-attributes.txt"; then fail 'The new app still has quarantine metadata. Nothing was approved for launch.'; fi
completed=true
printf 'Installed: %s\n' "$installed_app"
if [[ "$launch_app" == true ]]; then /usr/bin/open "$installed_app"; fi
