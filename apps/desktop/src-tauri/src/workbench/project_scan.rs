//! Local, read-only project discovery. No source is evaluated or returned.
//! Paths in inventories are relative, UTF-8, and use `/` separators. An unknown
//! Unity GUID is represented as `guid:<32 lowercase hex digits>`; it is only
//! reported when the local GUID map is complete and no external packages are
//! declared. Fingerprints exclude access times, secrets, and generated output.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, Metadata, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

const MAX_FILES: usize = 20_000;
const MAX_INVENTORY: usize = 2_000;
const MAX_READ_BYTES: usize = 256 * 1024;
const MAX_TOTAL_READ_BYTES: usize = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
const MAX_DIRECTORY_ENTRIES: usize = 40_000;
const MAX_DIRECTORIES: usize = 10_000;
const MAX_DEPTH: usize = 64;
const MAX_REFERENCES: usize = 20_000;

struct ScannedFile {
    relative: PathBuf,
    path: String,
    metadata: Metadata,
    content: Option<(usize, [u8; 32])>,
}

struct Scanner {
    root: PathBuf,
    files: Vec<ScannedFile>,
    root_directories: BTreeSet<String>,
    warnings: BTreeSet<&'static str>,
    traversal_complete: bool,
    remaining_bytes: usize,
    remaining_references: usize,
    missing: BTreeSet<(String, String)>,
}

struct TextPrefix {
    text: String,
    complete: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Presence {
    Present,
    Missing,
    Unverifiable,
}

/// Scan an existing directory without creating locks, caches, or output files.
/// Link checks include root ancestors and Windows reparse points. Checks around
/// directory enumeration are best effort against concurrent path replacement;
/// this is not an OS sandbox for an adversarially changing directory tree.
pub(super) fn scan(root: &Path) -> Result<Value> {
    let root = checked_root(root)?;
    let mut scanner = Scanner {
        root,
        files: Vec::new(),
        root_directories: BTreeSet::new(),
        warnings: BTreeSet::new(),
        traversal_complete: true,
        remaining_bytes: MAX_TOTAL_READ_BYTES,
        remaining_references: MAX_REFERENCES,
        missing: BTreeSet::new(),
    };
    scanner.walk();
    scanner.files.sort_by(|a, b| a.path.cmp(&b.path));
    let engine = scanner.engine();
    match engine {
        "godot" => scanner.godot_references(),
        "unity" => scanner.unity_references(),
        "unreal" => {
            scanner.warnings.insert(
                "Unreal binary assets and maps cannot be inspected for missing references.",
            );
            // The project descriptor is an engine manifest, not executable code.
            for index in 0..scanner.files.len() {
                if scanner.files[index].relative.components().count() == 1
                    && extension(&scanner.files[index].relative) == "uproject"
                {
                    scanner.read_text(index);
                }
            }
        }
        _ => {}
    }
    let mut asset_count = 0usize;
    let mut assets = Vec::new();
    for file in &scanner.files {
        if let Some(kind) = asset_kind(&file.relative) {
            asset_count += 1;
            if assets.len() < MAX_INVENTORY {
                assets.push(json!({"path": file.path, "kind": kind}));
            }
        }
    }
    if asset_count > MAX_INVENTORY {
        scanner.warnings.insert(
            "Asset inventory truncated at 2000 entries; assetCount includes all scanned assets.",
        );
    }
    let fingerprint = scanner.fingerprint(engine);
    let project_name = scanner
        .root
        .file_name()
        .and_then(|name| name.to_str())
        .map(sanitized_label)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Project".to_owned());
    Ok(json!({
        "root": sanitized_label(&scanner.root.to_string_lossy()),
        "engine": engine,
        // A filesystem label avoids exporting arbitrary strings from manifests.
        "projectName": project_name,
        "scannedFiles": scanner.files.len(),
        "assetCount": asset_count,
        "assets": assets,
        "missingReferences": scanner.missing.iter().map(|(path, by)| {
            json!({"path": path, "referencedBy": by})
        }).collect::<Vec<_>>(),
        "warnings": scanner.warnings.into_iter().collect::<Vec<_>>(),
        "fingerprint": fingerprint,
    }))
}

impl Scanner {
    fn truncated(&mut self, warning: &'static str) {
        self.traversal_complete = false;
        self.warnings.insert(warning);
    }

    fn walk(&mut self) {
        let mut pending = vec![(PathBuf::new(), 0usize)];
        let mut directories = 0usize;
        let mut entries_seen = 0usize;
        while let Some((relative, depth)) = pending.pop() {
            if directories == MAX_DIRECTORIES {
                self.truncated("Traversal truncated at the 10000-directory limit.");
                break;
            }
            directories += 1;
            let directory = self.root.join(&relative);
            if reject_links(&directory).is_err() {
                self.truncated("Linked, replaced, or inaccessible directories were skipped.");
                continue;
            }
            let before = match fs::symlink_metadata(&directory) {
                Ok(metadata) if metadata.is_dir() && !is_link(&metadata) => metadata,
                _ => {
                    self.truncated("Linked, replaced, or inaccessible directories were skipped.");
                    continue;
                }
            };
            let listing = match fs::read_dir(&directory) {
                Ok(listing) => listing,
                Err(_) => {
                    self.truncated(
                        "Some directories could not be enumerated; the scan is incomplete.",
                    );
                    continue;
                }
            };
            let mut names = Vec::new();
            let mut oversized = false;
            for entry in listing {
                if entries_seen == MAX_ENTRIES {
                    self.truncated("Traversal truncated at the 100000-entry work limit.");
                    oversized = true;
                    break;
                }
                entries_seen += 1;
                if names.len() == MAX_DIRECTORY_ENTRIES {
                    self.truncated("Directory enumeration truncated at 40000 entries; that directory was omitted.");
                    oversized = true;
                    break;
                }
                match entry {
                    Ok(entry) => names.push(entry.file_name()),
                    Err(_) => self.truncated(
                        "Some directory entries were unreadable; the scan is incomplete.",
                    ),
                }
            }
            // Keeping an arbitrary readdir prefix would make truncation depend
            // on filesystem enumeration order. Omit oversized listings instead.
            if oversized {
                if entries_seen == MAX_ENTRIES {
                    break;
                }
                continue;
            }
            if reject_links(&directory).is_err()
                || !fs::symlink_metadata(&directory)
                    .is_ok_and(|after| same_identity(&before, &after))
            {
                self.truncated("Directories changed during scanning; their entries were omitted.");
                continue;
            }
            names.sort();
            let mut children = Vec::new();
            for name in names {
                let Some(name_text) = name.to_str() else {
                    self.truncated("Non-UTF-8 or unsafe paths were omitted.");
                    continue;
                };
                if excluded_component(name_text) || sensitive_component(name_text) {
                    continue;
                }
                if !safe_component(name_text) {
                    self.truncated("Non-UTF-8 or unsafe paths were omitted.");
                    continue;
                }
                let child = relative.join(&name);
                let Some(public_path) = relative_path(&child) else {
                    self.truncated("Non-UTF-8 or unsafe paths were omitted.");
                    continue;
                };
                let metadata = match fs::symlink_metadata(self.root.join(&child)) {
                    Ok(metadata) => metadata,
                    Err(_) => {
                        self.truncated(
                            "Some file metadata was inaccessible; the scan is incomplete.",
                        );
                        continue;
                    }
                };
                if is_link(&metadata) {
                    self.truncated("Symlinks and reparse points were skipped.");
                    continue;
                }
                if metadata.is_dir() {
                    if depth == 0 {
                        self.root_directories.insert(name_text.to_ascii_lowercase());
                    }
                    if depth == MAX_DEPTH {
                        self.truncated("Traversal truncated at the 64-level depth limit.");
                    } else if pending.len() + children.len() >= MAX_DIRECTORIES {
                        self.truncated("Traversal truncated at the 10000-pending-directory limit.");
                    } else {
                        children.push((child, depth + 1));
                    }
                } else if metadata.is_file() {
                    if self.files.len() == MAX_FILES {
                        self.truncated("File scan truncated at 20000 files; counts and reference checks are partial.");
                        return;
                    }
                    self.files.push(ScannedFile {
                        relative: child,
                        path: public_path,
                        metadata,
                        content: None,
                    });
                } else {
                    self.warnings
                        .insert("Special filesystem entries were skipped.");
                }
            }
            pending.extend(children.into_iter().rev());
        }
    }

    fn engine(&mut self) -> &'static str {
        let godot = self
            .files
            .iter()
            .any(|file| file.path.eq_ignore_ascii_case("project.godot"));
        let unity_manifest = self.files.iter().any(|file| {
            file.path
                .eq_ignore_ascii_case("ProjectSettings/ProjectVersion.txt")
        });
        let unreal_manifest = self.files.iter().any(|file| {
            file.relative.components().count() == 1 && extension(&file.relative) == "uproject"
        });
        let configured = godot || unity_manifest || unreal_manifest;
        let unity = unity_manifest
            || (!configured
                && self.root_directories.contains("assets")
                && self.root_directories.contains("projectsettings"));
        let unreal = unreal_manifest
            || (!configured
                && self.root_directories.contains("content")
                && self.root_directories.contains("config"));
        match (godot, unity, unreal) {
            (true, false, false) => "godot",
            (false, true, false) => "unity",
            (false, false, true) => "unreal",
            (false, false, false) => "unknown",
            _ => {
                self.warnings.insert(
                    "Multiple engine configurations were found; engine detection is ambiguous.",
                );
                "unknown"
            }
        }
    }

    fn read_text(&mut self, index: usize) -> Option<TextPrefix> {
        if self.remaining_bytes == 0 {
            self.warnings
                .insert("Manifest/scene reads truncated at the 16 MiB total byte limit.");
            return None;
        }
        let path = self.root.join(&self.files[index].relative);
        if reject_links(&path).is_err() {
            self.warnings
                .insert("Linked, replaced, or inaccessible manifests/scenes were not read.");
            return None;
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // NONBLOCK also avoids blocking if a regular file becomes a FIFO.
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
            options.share_mode(0x0000_0001); // FILE_SHARE_READ
        }
        let file = match options.open(&path) {
            Ok(file) => file,
            Err(_) => {
                self.warnings.insert(
                    "Some manifests/scenes could not be read; reference checks are incomplete.",
                );
                return None;
            }
        };
        let before = match file.metadata() {
            Ok(metadata)
                if metadata.is_file()
                    && !is_link(&metadata)
                    && same_metadata(&self.files[index].metadata, &metadata) =>
            {
                metadata
            }
            _ => {
                self.warnings
                    .insert("Files changed during scanning; reference checks are incomplete.");
                return None;
            }
        };
        if reject_links(&path).is_err() {
            self.warnings
                .insert("Linked, replaced, or inaccessible manifests/scenes were not read.");
            return None;
        }
        let limit = MAX_READ_BYTES.min(self.remaining_bytes);
        let mut bytes = Vec::new();
        let mut limited = file.take(limit as u64);
        if limited.read_to_end(&mut bytes).is_err() {
            self.remaining_bytes = self.remaining_bytes.saturating_sub(bytes.len());
            self.warnings.insert(
                "Some manifests/scenes could not be read; reference checks are incomplete.",
            );
            return None;
        }
        self.remaining_bytes -= bytes.len();
        if reject_links(&path).is_err()
            || !limited
                .get_ref()
                .metadata()
                .is_ok_and(|after| same_metadata(&before, &after))
            || !fs::symlink_metadata(&path).is_ok_and(|after| same_metadata(&before, &after))
        {
            self.warnings
                .insert("Files changed during scanning; reference checks are incomplete.");
            return None;
        }
        self.files[index].content = Some((bytes.len(), Sha256::digest(&bytes).into()));
        let complete = before.len() <= bytes.len() as u64;
        if !complete {
            self.warnings.insert("Manifest/scene content truncated at 256 KiB per file or the remaining byte budget.");
        }
        // A cut in a UTF-8 code point is harmless: only complete tokens in the
        // valid prefix can be inspected. Invalid bytes elsewhere are not text.
        let text = match std::str::from_utf8(&bytes) {
            Ok(text) => text.to_owned(),
            Err(error) if !complete && error.error_len().is_none() => {
                String::from_utf8_lossy(&bytes[..error.valid_up_to()]).into_owned()
            }
            Err(_) => {
                self.warnings.insert("Binary or invalid UTF-8 manifests/scenes could not be inspected for references.");
                return None;
            }
        };
        if text.contains('\0') {
            self.warnings
                .insert("Binary manifests/scenes could not be inspected for references.");
            return None;
        }
        Some(TextPrefix { text, complete })
    }

    fn godot_references(&mut self) {
        let manifest = self
            .files
            .iter()
            .position(|file| file.path.eq_ignore_ascii_case("project.godot"));
        // Reserve the project descriptor's bounded content before scene reads.
        for index in manifest
            .into_iter()
            .chain((0..self.files.len()).filter(|index| Some(*index) != manifest))
        {
            let relative = &self.files[index].relative;
            if !self.files[index].path.eq_ignore_ascii_case("project.godot")
                && !matches!(extension(relative).as_str(), "tscn" | "tres")
            {
                continue;
            }
            let Some(prefix) = self.read_text(index) else {
                continue;
            };
            let by = self.files[index].path.clone();
            for resource in godot_paths(&prefix.text) {
                let Some((relative, public_path)) = resource_path(&resource) else {
                    // Never echo a rejected string from an input manifest.
                    self.warnings
                        .insert("Excluded or unsafe resource references were omitted.");
                    continue;
                };
                if !self.reference_budget() {
                    return;
                }
                match self.presence(&relative) {
                    Presence::Missing => self.add_missing(public_path, by.clone()),
                    Presence::Unverifiable => {
                        self.warnings.insert("Some resource targets were linked or inaccessible and could not be verified.");
                    }
                    Presence::Present => {}
                }
            }
        }
    }

    fn unity_references(&mut self) {
        let mut guid_map = BTreeMap::<String, (String, Presence)>::new();
        let mut references = BTreeSet::<(String, String)>::new();
        let mut complete = self.traversal_complete;
        for index in 0..self.files.len() {
            if extension(&self.files[index].relative) != "meta" {
                continue;
            }
            let Some(prefix) = self.read_text(index) else {
                complete = false;
                continue;
            };
            let text = complete_unity_lines(&prefix);
            let Some(guid) = meta_guid(text) else {
                complete = false;
                self.warnings
                    .insert("Some Unity metadata GUIDs were invalid or unreadable.");
                continue;
            };
            let by = self.files[index].path.clone();
            let Some(owner) = by.strip_suffix(".meta").or_else(|| {
                // Unity extension checks are case-insensitive, including .META.
                by.get(..by.len().saturating_sub(5))
            }) else {
                continue;
            };
            let Some((owner_relative, owner_path)) = resource_path(owner) else {
                complete = false;
                continue;
            };
            let presence = self.presence(&owner_relative);
            if presence == Presence::Unverifiable {
                complete = false;
            }
            if let Some(existing) = guid_map.get_mut(&guid) {
                existing.1 = Presence::Unverifiable;
                complete = false;
                self.warnings
                    .insert("Duplicate Unity metadata GUIDs make some references ambiguous.");
            } else {
                guid_map.insert(guid.clone(), (owner_path, presence));
            }
            self.collect_guids(text, &by, &mut references, Some(&guid));
        }
        // Package assets can live in Library/PackageCache or outside the root.
        // An absent local GUID alone cannot prove that such an asset is missing.
        for index in 0..self.files.len() {
            let path = self.files[index].path.to_ascii_lowercase();
            if path == "packages/manifest.json" {
                match self.read_text(index) {
                    Some(prefix) if prefix.complete => {
                        match serde_json::from_str::<Value>(&prefix.text) {
                            Ok(value)
                                if value
                                    .get("dependencies")
                                    .and_then(Value::as_object)
                                    .is_some_and(|dependencies| !dependencies.is_empty()) =>
                            {
                                complete = false;
                                self.warnings.insert("Unity package GUIDs outside this root cannot be verified; unresolved GUIDs were omitted.");
                            }
                            Ok(value) if value.is_object() => {}
                            _ => complete = false,
                        }
                    }
                    _ => complete = false,
                }
            } else if path == "packages/packages-lock.json"
                || path == "projectsettings/projectversion.txt"
            {
                self.read_text(index);
            }
        }
        for index in 0..self.files.len() {
            if !unity_serialized(&self.files[index].relative) {
                continue;
            }
            if let Some(prefix) = self.read_text(index) {
                let by = self.files[index].path.clone();
                self.collect_guids(complete_unity_lines(&prefix), &by, &mut references, None);
            }
        }
        for (guid, by) in references {
            if unity_builtin(&guid) {
                continue;
            }
            match guid_map.get(&guid) {
                Some((path, Presence::Missing)) => self.add_missing(path.clone(), by),
                Some((_, Presence::Unverifiable)) => {
                    self.warnings.insert("Some Unity GUID targets were linked or inaccessible and could not be verified.");
                }
                None if complete => self.add_missing(format!("guid:{guid}"), by),
                _ => {}
            }
        }
        if !complete {
            self.warnings.insert(
                "Unity GUID lookup is incomplete; unresolved GUIDs were not reported as missing.",
            );
        }
    }

    fn collect_guids(
        &mut self,
        text: &str,
        by: &str,
        references: &mut BTreeSet<(String, String)>,
        own_guid: Option<&str>,
    ) {
        for guid in unity_guids(text) {
            if own_guid == Some(guid.as_str()) || unity_builtin(&guid) {
                continue;
            }
            if !self.reference_budget() {
                break;
            }
            references.insert((guid, by.to_owned()));
        }
    }

    fn reference_budget(&mut self) -> bool {
        if self.remaining_references == 0 {
            self.warnings
                .insert("Reference checks truncated at 20000 references.");
            false
        } else {
            self.remaining_references -= 1;
            true
        }
    }

    fn add_missing(&mut self, path: String, by: String) {
        if self.missing.len() < MAX_INVENTORY {
            self.missing.insert((path, by));
        } else if !self.missing.contains(&(path, by)) {
            self.warnings
                .insert("Missing-reference inventory truncated at 2000 entries.");
        }
    }

    fn presence(&self, relative: &Path) -> Presence {
        if reject_links(&self.root).is_err() {
            return Presence::Unverifiable;
        }
        let mut current = self.root.clone();
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Presence::Unverifiable;
            };
            current.push(name);
            match fs::symlink_metadata(&current) {
                Ok(metadata) if is_link(&metadata) => return Presence::Unverifiable,
                Ok(metadata) if metadata.is_file() || metadata.is_dir() => {}
                Ok(_) => return Presence::Unverifiable,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return if current
                        .parent()
                        .is_some_and(|parent| reject_links(parent).is_ok())
                    {
                        Presence::Missing
                    } else {
                        Presence::Unverifiable
                    };
                }
                Err(_) => return Presence::Unverifiable,
            }
        }
        // Recheck ancestors to reject a link inserted during the component walk.
        if reject_links(&current).is_ok() {
            Presence::Present
        } else {
            Presence::Unverifiable
        }
    }

    fn fingerprint(&self, engine: &str) -> String {
        let mut hash = Sha256::new();
        hash.update(b"asset-studio/project-scan/v1\0");
        hash_field(&mut hash, engine.as_bytes());
        for file in &self.files {
            hash_field(&mut hash, file.path.as_bytes());
            hash.update(file.metadata.len().to_le_bytes());
            hash.update([u8::from(file.metadata.permissions().readonly())]);
            match file.metadata.modified() {
                Ok(time) => {
                    let (before_epoch, duration) = match time.duration_since(UNIX_EPOCH) {
                        Ok(duration) => (false, duration),
                        Err(error) => (true, error.duration()),
                    };
                    hash.update([1, u8::from(before_epoch)]);
                    hash.update(duration.as_secs().to_le_bytes());
                    hash.update(duration.subsec_nanos().to_le_bytes());
                }
                Err(_) => hash.update([0]),
            }
            match file.content {
                Some((length, digest)) => {
                    hash.update([1]);
                    hash.update((length as u64).to_le_bytes());
                    hash.update(digest);
                }
                None => hash.update([0]),
            }
        }
        for warning in &self.warnings {
            hash_field(&mut hash, warning.as_bytes());
        }
        format!("{:x}", hash.finalize())
    }
}

fn checked_root(root: &Path) -> Result<PathBuf> {
    let absolute = if root.is_absolute() {
        root.to_owned()
    } else {
        std::env::current_dir()
            .context("Cannot resolve the project root")?
            .join(root)
    };
    // Inspect the original path before canonicalizing, including link/../root.
    reject_links(&absolute).context("Project root or a parent is linked or inaccessible")?;
    let metadata = fs::symlink_metadata(&absolute).context("Cannot inspect the project root")?;
    if !metadata.is_dir() {
        bail!("Project root must be an existing directory");
    }
    let canonical = absolute
        .canonicalize()
        .context("Cannot resolve the project root")?;
    reject_links(&canonical).context("Project root or a parent is linked or inaccessible")?;
    if canonical
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| sensitive_component(name) || excluded_component(name))
    {
        bail!("Project root is an excluded directory");
    }
    Ok(canonical)
}

fn reject_links(path: &Path) -> std::io::Result<()> {
    let mut prefix = PathBuf::new();
    // Component checks catch link/. as well as link/../root before lexical
    // normalization can hide the linked component. Skip a bare Windows drive
    // prefix until its root separator is appended.
    for component in path.components() {
        prefix.push(component.as_os_str());
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        if is_link(&fs::symlink_metadata(&prefix)?) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Symlinks and reparse points are not permitted",
            ));
        }
    }
    Ok(())
}

fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x0000_0400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn same_identity(a: &Metadata, b: &Metadata) -> bool {
    if is_link(b) || a.is_file() != b.is_file() || a.is_dir() != b.is_dir() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev() && a.ino() == b.ino()
    }
    #[cfg(not(unix))]
    {
        a.created().ok() == b.created().ok()
    }
}

fn same_metadata(a: &Metadata, b: &Metadata) -> bool {
    same_identity(a, b)
        && a.len() == b.len()
        && a.modified().ok() == b.modified().ok()
        && a.permissions().readonly() == b.permissions().readonly()
}

fn unsafe_character(character: char) -> bool {
    character.is_control() || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

fn sanitized_label(label: &str) -> String {
    label
        .chars()
        .map(|c| if unsafe_character(c) { '\u{fffd}' } else { c })
        .collect()
}

fn safe_component(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name
            .chars()
            .any(|c| unsafe_character(c) || matches!(c, '/' | '\\' | ':'))
}

fn excluded_component(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git"
            | ".hg"
            | ".svn"
            | "node_modules"
            | "build"
            | "builds"
            | "output"
            | "outputs"
            | "out"
            | "dist"
            | "target"
            | "library"
            | "temp"
            | "tmp"
            | ".tools"
            | ".venv"
            | "venv"
            | "assetstudiogenerated"
            | ".godot"
            | ".import"
            | ".cache"
            | "binaries"
            | "intermediate"
            | "saved"
            | "deriveddatacache"
            | "obj"
            | "bin"
    )
}

fn sensitive_component(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with(".env")
        || lower.ends_with(".env")
        || lower == ".envrc"
        || matches!(
            lower.as_str(),
            ".ssh"
                | ".aws"
                | ".azure"
                | ".gnupg"
                | ".kube"
                | ".npmrc"
                | ".netrc"
                | ".pypirc"
                | ".gitconfig"
                | "auth.json"
                | "oauth.json"
        )
        || ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]
            .iter()
            .any(|name| lower.starts_with(name))
        || lower
            .split(|c: char| !c.is_ascii_alphanumeric())
            .any(|word| {
                matches!(
                    word,
                    "credential"
                        | "credentials"
                        | "secret"
                        | "secrets"
                        | "password"
                        | "passwords"
                        | "env"
                        | "dotenv"
                        | "passwd"
                        | "token"
                        | "tokens"
                        | "apikey"
                        | "key"
                        | "keys"
                        | "keystore"
                        | "serviceaccount"
                        | "pem"
                        | "ppk"
                        | "pub"
                        | "p8"
                        | "p12"
                        | "pfx"
                        | "jks"
                        | "kdb"
                        | "kdbx"
                        | "crt"
                        | "cert"
                        | "cer"
                        | "der"
                )
            })
        || lower.contains("api_key")
        || lower.contains("api-key")
        || lower.contains("privatekey")
        || lower.contains("service-account")
        || lower.contains("service_account")
}

fn relative_path(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        let Component::Normal(name) = component else {
            return None;
        };
        let name = name.to_str()?;
        if !safe_component(name) || excluded_component(name) || sensitive_component(name) {
            return None;
        }
        parts.push(name);
    }
    let public = parts.join("/");
    (!public.is_empty() && public.len() <= 4096).then_some(public)
}

fn resource_path(resource: &str) -> Option<(PathBuf, String)> {
    let resource = resource.strip_prefix("res://").unwrap_or(resource);
    let resource = resource.split("::").next()?;
    if resource.starts_with('/') || resource.contains('\\') {
        return None;
    }
    let mut parts = Vec::new();
    for part in resource.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ if safe_component(part)
                && !excluded_component(part)
                && !sensitive_component(part) =>
            {
                parts.push(part)
            }
            _ => return None,
        }
    }
    let relative: PathBuf = parts.iter().collect();
    let public = relative_path(&relative)?;
    Some((relative, public))
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

// Only recognized game resources count as assets. Source code, .meta files,
// and engine/project bookkeeping still contribute to scannedFiles/fingerprint.
fn asset_kind(path: &Path) -> Option<&'static str> {
    match extension(path).as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "tga" | "tif" | "tiff" | "gif" | "dds"
        | "exr" | "hdr" | "ktx" | "ktx2" | "svg" | "psd" | "ico" | "pvr" | "astc" => Some("image"),
        "glb" | "gltf" | "fbx" | "obj" | "blend" | "dae" | "3ds" | "stl" | "ply" | "usd"
        | "usda" | "usdc" | "usdz" => Some("model"),
        "wav" | "mp3" | "ogg" | "oga" | "flac" | "aac" | "m4a" | "aif" | "aiff" | "wma"
        | "opus" | "mid" | "midi" => Some("audio"),
        "tscn" | "tres" | "res" | "scn" | "unity" | "prefab" | "asset" | "mat" | "anim"
        | "controller" | "overridecontroller" | "rendertexture" | "terrainlayer"
        | "spriteatlas" | "playable" | "uasset" | "umap" | "ttf" | "otf" | "woff" | "woff2"
        | "font" | "mp4" | "mov" | "webm" | "avi" | "ogv" | "shader" | "gdshader"
        | "shadergraph" | "shadersubgraph" | "bin" => Some("other"),
        _ => None,
    }
}

fn unity_serialized(path: &Path) -> bool {
    matches!(
        extension(path).as_str(),
        "unity"
            | "prefab"
            | "asset"
            | "mat"
            | "anim"
            | "controller"
            | "overridecontroller"
            | "rendertexture"
            | "terrainlayer"
            | "spriteatlas"
            | "playable"
    )
}

fn complete_unity_lines(prefix: &TextPrefix) -> &str {
    if prefix.complete || prefix.text.ends_with('\n') {
        &prefix.text
    } else {
        &prefix.text[..prefix.text.rfind('\n').map_or(0, |index| index + 1)]
    }
}

fn godot_paths(text: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        if matches!(character, '#' | ';') {
            for character in chars.by_ref() {
                if character == '\n' {
                    break;
                }
            }
        } else if character == '"' {
            let mut string = String::new();
            let mut closed = false;
            let mut valid = true;
            while let Some(character) = chars.next() {
                match character {
                    '"' => {
                        closed = true;
                        break;
                    }
                    '\\' => match chars.next() {
                        Some('n') => string.push('\n'),
                        Some('r') => string.push('\r'),
                        Some('t') => string.push('\t'),
                        Some('"') => string.push('"'),
                        Some('\\') => string.push('\\'),
                        Some('/') => string.push('/'),
                        Some(escape @ ('u' | 'U')) => {
                            let digits: String = chars
                                .by_ref()
                                .take(if escape == 'u' { 4 } else { 6 })
                                .collect();
                            let expected = if escape == 'u' { 4 } else { 6 };
                            match u32::from_str_radix(&digits, 16)
                                .ok()
                                .and_then(char::from_u32)
                            {
                                Some(character) if digits.len() == expected => {
                                    string.push(character)
                                }
                                _ => valid = false,
                            }
                        }
                        Some(_) => valid = false,
                        None => break,
                    },
                    character => string.push(character),
                }
            }
            if closed && valid && string.starts_with("res://") {
                paths.push(string);
            }
        }
    }
    paths
}

fn parse_guid(value: &str) -> Option<String> {
    let value = value.trim_start();
    let digits = value.get(..32)?;
    if !digits.bytes().all(|byte| byte.is_ascii_hexdigit())
        || value
            .as_bytes()
            .get(32)
            .is_some_and(|byte| !byte.is_ascii_whitespace() && !matches!(byte, b',' | b'}' | b'#'))
    {
        return None;
    }
    Some(digits.to_ascii_lowercase())
}

fn meta_guid(text: &str) -> Option<String> {
    text.trim_start_matches('\u{feff}')
        .lines()
        .find_map(|line| line.strip_prefix("guid:").and_then(parse_guid))
}

fn unity_guids(text: &str) -> Vec<String> {
    let mut guids = Vec::new();
    for line in text.lines() {
        let bytes = line.as_bytes();
        let mut quote = None;
        let mut escaped = false;
        let mut flow_depth = 0usize;
        for (index, byte) in bytes.iter().copied().enumerate() {
            if let Some(delimiter) = quote {
                if escaped {
                    escaped = false;
                } else if byte == b'\\' && delimiter == b'"' {
                    escaped = true;
                } else if byte == delimiter {
                    quote = None;
                }
                continue;
            }
            match byte {
                b'#' => break,
                b'"' | b'\'' => {
                    quote = Some(byte);
                }
                b'{' => {
                    flow_depth += 1;
                }
                b'}' => {
                    flow_depth = flow_depth.saturating_sub(1);
                }
                b'g' if bytes[index..].starts_with(b"guid:") => {
                    let prefix = line[..index].trim();
                    if prefix.is_empty()
                        || prefix == "-"
                        || (flow_depth > 0 && (prefix.ends_with('{') || prefix.ends_with(',')))
                    {
                        if let Some(guid) = parse_guid(&line[index + 5..]) {
                            guids.push(guid);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    guids
}

fn unity_builtin(guid: &str) -> bool {
    matches!(
        guid,
        "00000000000000000000000000000000"
            | "0000000000000000d0000000000000000"
            | "0000000000000000e0000000000000000"
            | "0000000000000000f0000000000000000"
    )
}

fn hash_field(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::{File, FileTimes},
        sync::atomic::{AtomicU64, Ordering},
        time::SystemTime,
    };

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            static SERIAL: AtomicU64 = AtomicU64::new(0);
            // /var and /tmp are system aliases on macOS; tests use the real
            // directory so production's strict ancestor rejection is exercised.
            let base = std::env::temp_dir().canonicalize().unwrap();
            let path = base.join(format!(
                "project-scan-test-{}-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn write(&self, relative: &str, bytes: impl AsRef<[u8]>) {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }

        fn unity(&self) {
            fs::create_dir(self.0.join("Assets")).unwrap();
            self.write(
                "ProjectSettings/ProjectVersion.txt",
                "m_EditorVersion: 6000.0.0f1\n",
            );
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn warning_contains(result: &Value, fragment: &str) -> bool {
        result["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning.as_str().unwrap().contains(fragment))
    }

    fn snapshot(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, SystemTime, bool)> {
        let mut result = BTreeMap::new();
        let mut pending = vec![root.to_owned()];
        while let Some(path) = pending.pop() {
            let metadata = fs::symlink_metadata(&path).unwrap();
            assert!(!is_link(&metadata));
            let bytes = if metadata.is_file() {
                fs::read(&path).unwrap()
            } else {
                Vec::new()
            };
            result.insert(
                path.strip_prefix(root).unwrap().to_owned(),
                (
                    bytes,
                    metadata.modified().unwrap(),
                    metadata.permissions().readonly(),
                ),
            );
            if metadata.is_dir() {
                pending.extend(
                    fs::read_dir(path)
                        .unwrap()
                        .map(|entry| entry.unwrap().path()),
                );
            }
        }
        result
    }

    fn rewrite_with_same_metadata(root: &TempRoot, relative: &str, bytes: &[u8]) {
        let path = root.0.join(relative);
        let before = fs::metadata(&path).unwrap();
        assert_eq!(before.len(), bytes.len() as u64);
        fs::write(&path, bytes).unwrap();
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(FileTimes::new().set_modified(before.modified().unwrap()))
            .unwrap();
    }

    #[test]
    fn stable_shape_and_unknown_empty_root() {
        let root = TempRoot::new();
        let result = scan(&root.0).unwrap();
        assert_eq!(result.as_object().unwrap().len(), 9);
        assert_eq!(result["root"], root.0.to_str().unwrap());
        assert_eq!(
            result["projectName"],
            root.0.file_name().unwrap().to_str().unwrap()
        );
        assert_eq!(result["engine"], "unknown");
        assert_eq!(result["scannedFiles"], 0);
        assert_eq!(result["assetCount"], 0);
        assert_eq!(result["assets"], json!([]));
        assert_eq!(result["missingReferences"], json!([]));
        assert_eq!(result["warnings"], json!([]));
        let fingerprint = result["fingerprint"].as_str().unwrap();
        assert_eq!(fingerprint.len(), 64);
        assert!(fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
        assert_eq!(result, scan(&root.0).unwrap());
    }

    #[test]
    fn godot_checks_concrete_paths_without_mutating_or_exporting_contents() {
        let root = TempRoot::new();
        root.write("project.godot", "[application]\nconfig/name=\"manifest-text-must-stay-local\"\nrun/main_scene=\"res://scenes/main.tscn\"\n");
        root.write("textures/ok.PNG", b"image fixture");
        root.write("café.png", b"unicode image fixture");
        root.write("mesh.glb", b"model fixture");
        root.write("sound.WAV", b"audio fixture");
        root.write("script.gd", "assert(false) # source must never execute\n");
        root.write(
            "scenes/main.tscn",
            r#"[gd_scene]
; path="res://comment-missing.png"
# path="res://another-comment.png"
[ext_resource path="res://textures/ok.PNG" type="Texture2D"]
[ext_resource path="res://caf\u00e9.png" type="Texture2D"]
[ext_resource path="res://script.gd" type="Script"]
[ext_resource path="res://textures/../missing image.png" type="Texture2D"]
[ext_resource path="res://missing image.png" type="Texture2D"]
[ext_resource path="res://mesh.glb::Mesh_1" type="Mesh"]
[ext_resource path="res://../outside.png" type="Texture2D"]
[ext_resource path="uid://not-a-concrete-path" type="Texture2D"]
"#,
        );
        root.write("material.tres", "texture=\"res://absent.png\"\n");
        let before = snapshot(&root.0);
        let result = scan(&root.0).unwrap();
        assert_eq!(before, snapshot(&root.0));
        assert_eq!(result["engine"], "godot");
        assert_eq!(result["scannedFiles"], 8);
        assert_eq!(result["assetCount"], 6);
        assert_eq!(
            result["missingReferences"],
            json!([
                {"path": "absent.png", "referencedBy": "material.tres"},
                {"path": "missing image.png", "referencedBy": "scenes/main.tscn"},
            ])
        );
        assert!(warning_contains(&result, "unsafe resource"));
        let serialized = result.to_string();
        assert!(!serialized.contains("manifest-text-must-stay-local"));
        assert!(!serialized.contains("assert(false)"));
        assert!(!serialized.contains("outside.png"));
        assert_eq!(result, scan(&root.0).unwrap());
    }

    #[test]
    fn excluded_output_and_credential_paths_never_enter_any_inventory() {
        let root = TempRoot::new();
        root.write("project.godot", "[application]\n");
        root.write("keep.png", b"safe fixture");
        root.write(
            "scene.tscn",
            r#"path="res://credentials/absent.png"
path="res://AssetStudioGenerated/missing.png"
path="res://nested/api-key.png"
"#,
        );
        for excluded in [
            ".git",
            "node_modules",
            "build",
            "output",
            "Library",
            "Temp",
            ".tools",
            ".venv",
            "AssetStudioGenerated",
            "credentials",
            ".ssh",
            ".aws",
        ] {
            root.write(
                &format!("{excluded}/must-not-appear.png"),
                b"excluded fixture",
            );
        }
        for excluded in [
            ".env",
            ".ENV.production",
            ".env_backup.tscn",
            "id_rsa",
            "private.key",
            "certificate.pem",
            "client_secret.json",
            "nested/api-key.png",
            "nested/service-account.json",
            "nested/credentials.asset.meta",
            "nested/key.pub",
            "nested/session-token.png",
        ] {
            root.write(excluded, b"excluded-fixture-payload");
        }
        let before = snapshot(&root.0);
        let result = scan(&root.0).unwrap();
        assert_eq!(snapshot(&root.0), before);
        assert_eq!(result["scannedFiles"], 3);
        assert_eq!(result["assetCount"], 2);
        assert_eq!(result["missingReferences"], json!([]));
        let serialized = result.to_string();
        assert!(!serialized.contains("must-not-appear"));
        assert!(!serialized.contains("excluded-fixture-payload"));
        assert!(!serialized.contains("api-key.png"));
        root.write(
            "credentials/must-not-appear.png",
            b"changed excluded fixture",
        );
        assert_eq!(result, scan(&root.0).unwrap());
    }

    #[test]
    fn unity_resolves_guid_map_and_reports_only_real_missing_targets() {
        let root = TempRoot::new();
        root.unity();
        root.write("Assets/texture.png", b"image fixture");
        root.write(
            "Assets/texture.png.meta",
            "fileFormatVersion: 2\nguid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        );
        root.write(
            "Assets/orphan.png.meta",
            "fileFormatVersion: 2\nguid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
        );
        root.write("Assets/main.unity", "Object: {fileID: 1, guid: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA, type: 3}\nObject: {fileID: 1, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 3}\nObject: {fileID: 1, guid: cccccccccccccccccccccccccccccccc, type: 3}\nObject: {fileID: 1, guid: 0000000000000000f0000000000000000, type: 3}\nObject: {fileID: 0, guid: 00000000000000000000000000000000}\n# guid: dddddddddddddddddddddddddddddddd\nm_Name: \"hello guid: dddddddddddddddddddddddddddddddd\"\nm_Name: plain guid: dddddddddddddddddddddddddddddddd\nnotguid: dddddddddddddddddddddddddddddddd\n");
        let before = snapshot(&root.0);
        let result = scan(&root.0).unwrap();
        assert_eq!(before, snapshot(&root.0));
        assert_eq!(result["engine"], "unity");
        assert_eq!(result["assetCount"], 2);
        assert_eq!(
            result["missingReferences"],
            json!([
                {"path": "Assets/orphan.png", "referencedBy": "Assets/main.unity"},
                {"path": "guid:cccccccccccccccccccccccccccccccc", "referencedBy": "Assets/main.unity"},
            ])
        );
        assert_eq!(result["warnings"], json!([]));
    }

    #[test]
    fn unity_orphan_metadata_identity_is_not_itself_a_reference() {
        let root = TempRoot::new();
        root.unity();
        root.write(
            "Assets/orphan.png.meta",
            "guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        );
        assert_eq!(scan(&root.0).unwrap()["missingReferences"], json!([]));
    }

    #[test]
    fn unity_duplicate_guids_do_not_claim_a_target_is_missing() {
        let root = TempRoot::new();
        root.unity();
        root.write("Assets/a.png", b"present");
        root.write(
            "Assets/a.png.meta",
            "guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        );
        root.write(
            "Assets/z.png.meta",
            "guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        );
        root.write(
            "Assets/main.prefab",
            "target: {guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}\n",
        );
        let result = scan(&root.0).unwrap();
        assert_eq!(result["missingReferences"], json!([]));
        assert!(warning_contains(&result, "Duplicate Unity"));
        assert!(warning_contains(&result, "GUID lookup is incomplete"));
    }

    #[test]
    fn unity_incomplete_metadata_and_packages_do_not_fabricate_missing_guids() {
        let root = TempRoot::new();
        root.unity();
        root.write(
            "Assets/main.unity",
            "target: {guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}\n",
        );
        root.write("Assets/broken.png.meta", b"\xff\x00binary metadata");
        let invalid = scan(&root.0).unwrap();
        assert_eq!(invalid["missingReferences"], json!([]));
        assert!(warning_contains(&invalid, "GUID lookup is incomplete"));
        fs::remove_file(root.0.join("Assets/broken.png.meta")).unwrap();
        root.write(
            "Packages/manifest.json",
            r#"{"dependencies":{"com.example.package":"file:../external"}}"#,
        );
        let packages = scan(&root.0).unwrap();
        assert_eq!(packages["missingReferences"], json!([]));
        assert!(warning_contains(&packages, "package GUIDs outside"));
    }

    #[test]
    fn unreal_and_conflicting_engine_evidence_are_explicit() {
        let root = TempRoot::new();
        root.write("Game.uproject", "{\"FileVersion\":3}\n");
        root.write("Content/level.umap", b"\x00unreal binary fixture");
        let unreal = scan(&root.0).unwrap();
        assert_eq!(unreal["engine"], "unreal");
        assert_eq!(unreal["assetCount"], 1);
        assert!(warning_contains(&unreal, "Unreal binary"));
        assert_eq!(unreal["missingReferences"], json!([]));
        root.write("project.godot", "path=\"res://absent.png\"\n");
        let ambiguous = scan(&root.0).unwrap();
        assert_eq!(ambiguous["engine"], "unknown");
        assert!(warning_contains(&ambiguous, "ambiguous"));
        assert_eq!(ambiguous["missingReferences"], json!([]));
    }

    #[test]
    fn engine_directory_evidence_and_nested_configs() {
        let root = TempRoot::new();
        fs::create_dir(root.0.join("Content")).unwrap();
        fs::create_dir(root.0.join("Config")).unwrap();
        assert_eq!(scan(&root.0).unwrap()["engine"], "unreal");
        root.write("project.godot", "[application]\n");
        assert_eq!(scan(&root.0).unwrap()["engine"], "godot");
        let unity = TempRoot::new();
        fs::create_dir(unity.0.join("Assets")).unwrap();
        fs::create_dir(unity.0.join("ProjectSettings")).unwrap();
        assert_eq!(scan(&unity.0).unwrap()["engine"], "unity");
        let unknown = TempRoot::new();
        unknown.write("fixtures/project.godot", "path=\"res://absent.png\"\n");
        unknown.write("example.tscn", "path=\"res://absent.png\"\n");
        let result = scan(&unknown.0).unwrap();
        assert_eq!(result["engine"], "unknown");
        assert_eq!(result["missingReferences"], json!([]));
    }

    #[test]
    fn fingerprint_includes_bounded_manifest_content_but_never_source_content() {
        let root = TempRoot::new();
        root.write("project.godot", "[application]\n");
        root.write("a.png", b"a");
        root.write("b.png", b"b");
        root.write("scene.tscn", "path=\"res://a.png\"\n");
        root.write("script.gd", "print('before')\n");
        let initial = scan(&root.0).unwrap();
        rewrite_with_same_metadata(&root, "script.gd", b"print('after!')\n");
        assert_eq!(
            initial["fingerprint"],
            scan(&root.0).unwrap()["fingerprint"]
        );
        rewrite_with_same_metadata(&root, "scene.tscn", b"path=\"res://b.png\"\n");
        let changed = scan(&root.0).unwrap();
        assert_ne!(initial["fingerprint"], changed["fingerprint"]);
        assert_eq!(initial["missingReferences"], changed["missingReferences"]);
        root.write("a.png", b"changed size");
        assert_ne!(
            changed["fingerprint"],
            scan(&root.0).unwrap()["fingerprint"]
        );
    }

    #[test]
    fn reads_and_fingerprints_stop_at_256_kib() {
        let root = TempRoot::new();
        root.write("project.godot", "[application]\n");
        let mut scene = b"path=\"res://prefix-missing.png\"\n".to_vec();
        scene.resize(MAX_READ_BYTES, b' ');
        scene.extend_from_slice(b"path=\"res://suffix-missing.png\"\n");
        root.write("scene.tscn", &scene);
        let result = scan(&root.0).unwrap();
        assert_eq!(
            result["missingReferences"],
            json!([
                {"path": "prefix-missing.png", "referencedBy": "scene.tscn"}
            ])
        );
        assert!(warning_contains(&result, "256 KiB"));
        *scene.last_mut().unwrap() = b' ';
        rewrite_with_same_metadata(&root, "scene.tscn", &scene);
        assert_eq!(result["fingerprint"], scan(&root.0).unwrap()["fingerprint"]);
    }

    #[test]
    fn aggregate_content_reads_are_bounded_and_warn_when_exhausted() {
        let root = TempRoot::new();
        root.write("project.godot", "[application]\n");
        let mut content = vec![b' '; MAX_READ_BYTES];
        let reference = b"path=\"res://prefix-missing.png\"\n";
        content[..reference.len()].copy_from_slice(reference);
        root.write("000.tres", &content);
        content.fill(b' ');
        for index in 1..MAX_TOTAL_READ_BYTES / MAX_READ_BYTES {
            root.write(&format!("{index:03}.tres"), &content);
        }
        root.write("999.tres", "path=\"res://unread-missing.png\"\n");
        let result = scan(&root.0).unwrap();
        assert_eq!(
            result["missingReferences"],
            json!([
                {"path": "prefix-missing.png", "referencedBy": "000.tres"}
            ])
        );
        assert!(warning_contains(&result, "16 MiB total byte limit"));
    }

    #[test]
    fn unity_guid_at_a_truncated_line_boundary_is_not_treated_as_complete() {
        let root = TempRoot::new();
        root.unity();
        root.write("Assets/texture.png", b"fixture");
        let mut metadata = b"fileFormatVersion: 2\n#".to_vec();
        metadata.resize(MAX_READ_BYTES - 38, b' ');
        metadata.push(b'\n');
        metadata.extend_from_slice(b"guid:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(metadata.len(), MAX_READ_BYTES);
        // The real value is longer than 32 hex digits; its bounded prefix must
        // not be accepted as a complete identity and certify the map complete.
        metadata.extend_from_slice(b"a\n");
        root.write("Assets/texture.png.meta", metadata);
        root.write(
            "Assets/main.unity",
            "target: {guid: cccccccccccccccccccccccccccccccc}\n",
        );
        let result = scan(&root.0).unwrap();
        assert_eq!(result["missingReferences"], json!([]));
        assert!(warning_contains(&result, "256 KiB"));
        assert!(warning_contains(&result, "GUID lookup is incomplete"));
    }

    #[test]
    fn file_and_inventory_truncation_are_bounded_and_deterministic() {
        let root = TempRoot::new();
        // Reverse creation order verifies sorting rather than readdir order.
        for index in (0..=MAX_FILES).rev() {
            root.write(&format!("{index:05}.png"), b"");
        }
        let result = scan(&root.0).unwrap();
        assert_eq!(result["scannedFiles"], MAX_FILES);
        assert_eq!(result["assetCount"], MAX_FILES);
        assert_eq!(result["assets"].as_array().unwrap().len(), MAX_INVENTORY);
        assert_eq!(result["assets"][0]["path"], "00000.png");
        assert_eq!(result["assets"][MAX_INVENTORY - 1]["path"], "01999.png");
        assert!(warning_contains(&result, "File scan truncated at 20000"));
        assert!(warning_contains(
            &result,
            "Asset inventory truncated at 2000"
        ));
        assert_eq!(result, scan(&root.0).unwrap());
    }

    #[test]
    fn missing_reference_inventory_and_reference_work_have_separate_caps() {
        let root = TempRoot::new();
        root.write("project.godot", "[application]\n");
        let scene = (0..=MAX_INVENTORY)
            .map(|index| format!("path=\"res://missing-{index:04}.png\"\n"))
            .collect::<String>();
        root.write("scene.tscn", scene);
        let result = scan(&root.0).unwrap();
        assert_eq!(
            result["missingReferences"].as_array().unwrap().len(),
            MAX_INVENTORY
        );
        assert!(warning_contains(
            &result,
            "Missing-reference inventory truncated"
        ));
        root.write("scene.tscn", "\"res://x\" ".repeat(MAX_REFERENCES + 1));
        let repeated = scan(&root.0).unwrap();
        assert_eq!(repeated["missingReferences"].as_array().unwrap().len(), 1);
        assert!(warning_contains(
            &repeated,
            "Reference checks truncated at 20000"
        ));
    }

    #[test]
    fn traversal_depth_is_bounded() {
        let root = TempRoot::new();
        let mut path = root.0.clone();
        for _ in 0..=MAX_DEPTH {
            path.push("d");
            fs::create_dir(&path).unwrap();
        }
        fs::write(path.join("unreachable.png"), b"").unwrap();
        let result = scan(&root.0).unwrap();
        assert_eq!(result["scannedFiles"], 0);
        assert!(warning_contains(&result, "64-level depth limit"));
    }

    #[test]
    fn rejects_nonexistent_file_and_excluded_roots() {
        let root = TempRoot::new();
        assert!(scan(&root.0.join("absent")).is_err());
        root.write("file.png", b"fixture");
        assert!(scan(&root.0.join("file.png")).is_err());
        fs::create_dir(root.0.join("credentials")).unwrap();
        assert!(scan(&root.0.join("credentials")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_files_directories_roots_and_parent_components_are_rejected() {
        use std::os::unix::fs::symlink;
        let root = TempRoot::new();
        let external = TempRoot::new();
        external.write("outside.png", b"external original fixture");
        root.write("project.godot", "[application]\n");
        root.write("scene.tscn", "path=\"res://link.png\"\npath=\"res://linked/outside.png\"\npath=\"res://broken.png\"\n");
        symlink(external.0.join("outside.png"), root.0.join("link.png")).unwrap();
        symlink(&external.0, root.0.join("linked")).unwrap();
        symlink(external.0.join("absent.png"), root.0.join("broken.png")).unwrap();
        symlink(&root.0, root.0.join("cycle")).unwrap();
        let before = snapshot(&external.0);
        let result = scan(&root.0).unwrap();
        assert_eq!(result["scannedFiles"], 2);
        assert_eq!(result["missingReferences"], json!([]));
        assert!(warning_contains(&result, "Symlinks"));
        assert_eq!(before, snapshot(&external.0));
        symlink(&root.0, external.0.join("root-link")).unwrap();
        assert!(scan(&external.0.join("root-link")).is_err());
        assert!(scan(&external.0.join("root-link/.")).is_err());
        fs::create_dir(root.0.join("child")).unwrap();
        assert!(scan(&external.0.join("root-link/child")).is_err());
        assert!(scan(&external.0.join("root-link/../root-link")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn special_and_non_utf8_entries_are_never_opened_or_exported() {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt};
        let root = TempRoot::new();
        root.write("project.godot", "[application]\n");
        root.write("invalid.tscn", b"\xff\x00invalid scene fixture");
        let invalid_path = PathBuf::from(OsString::from_vec(b"bad-\xff.png".to_vec()));
        assert!(relative_path(&invalid_path).is_none());
        match fs::write(root.0.join(&invalid_path), b"") {
            Ok(()) => {}
            // APFS rejects invalid UTF-8 names at creation; pure path validation
            // above still verifies this case without relying on filesystem support.
            Err(error) if error.raw_os_error() == Some(libc::EILSEQ) => {}
            Err(error) => panic!("Cannot create an isolated test filename: {error}"),
        }
        root.write("unsafe-\n.png", b"");
        let fifo = std::ffi::CString::new(root.0.join("pipe.tscn").as_os_str().as_encoded_bytes())
            .unwrap();
        // Fixture only: the scanner itself never creates or opens this FIFO.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let result = scan(&root.0).unwrap();
        assert_eq!(result["scannedFiles"], 2);
        assert_eq!(result["missingReferences"], json!([]));
        assert!(warning_contains(&result, "Non-UTF-8"));
        assert!(warning_contains(&result, "Special filesystem"));
        assert!(warning_contains(&result, "invalid UTF-8"));
        assert!(!result.to_string().contains("bad-"));
        assert!(!result.to_string().contains("pipe.tscn"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_links_are_rejected_when_symlink_creation_is_available() {
        use std::os::windows::fs::{symlink_dir, symlink_file};
        let root = TempRoot::new();
        let external = TempRoot::new();
        external.write("original.png", b"external fixture");
        match symlink_file(external.0.join("original.png"), root.0.join("link.png")) {
            Ok(()) => {}
            Err(error)
                if error.kind() == std::io::ErrorKind::PermissionDenied
                    || error.raw_os_error() == Some(1314) =>
            {
                return
            }
            Err(error) => panic!("Cannot create an isolated test link: {error}"),
        }
        assert_eq!(scan(&root.0).unwrap()["scannedFiles"], 0);
        symlink_dir(&root.0, external.0.join("root-link")).unwrap();
        assert!(scan(&external.0.join("root-link")).is_err());
        fs::create_dir(root.0.join("child")).unwrap();
        assert!(scan(&external.0.join("root-link/child")).is_err());
    }
}
