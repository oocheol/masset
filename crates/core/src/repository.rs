use crate::models::*;
use anyhow::{anyhow, ensure, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::ffi::OsString;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tempfile::{Builder, NamedTempFile};
use uuid::Uuid;

const DATABASE_NAME: &str = "project.sqlite";
const SNAPSHOT_NAME: &str = "project.json";
const DATABASE_VERSION: u32 = 1;

/// A project owns its database and copied artifacts. It never owns the files
/// passed as `source` to `copy_in`.
pub struct Repository {
    root: PathBuf,
    connection: Connection,
}

impl Repository {
    /// Create a project in a new or existing directory without replacing any
    /// existing database or project snapshot.
    pub fn create(root: &Path, name: &str) -> Result<Self> {
        ensure!(!name.trim().is_empty(), "project name must not be empty");
        let absolute = absolute_lexical(root)?;
        reject_link_ancestors(&absolute)?;
        fs::create_dir_all(&absolute).context("cannot create project directory")?;
        let root = absolute.canonicalize().context("cannot resolve project directory")?;
        ensure!(root.is_dir(), "project root must be a directory");
        let database = root.join(DATABASE_NAME);
        ensure!(
            !root.join(SNAPSHOT_NAME).try_exists()?,
            "a project snapshot already exists in this directory"
        );
        // Reserving the database with create_new prevents concurrent creation
        // from replacing an existing project.
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&database)
            .context("a project database already exists or cannot be created")?;
        let mut connection = Connection::open_with_flags(
            &database,
            OpenFlags::SQLITE_OPEN_READ_WRITE,
        )
        .context("cannot open new project database")?;
        configure_and_migrate(&mut connection)?;
        let mut repository = Self { root, connection };
        let project = Project::new(name);
        repository.persist_snapshot(&project, None)?;
        Ok(repository)
    }

    /// Reopen a local project. SQLite is authoritative if a crash occurred
    /// between replacement of the readable JSON snapshot and database commit.
    pub fn open(root: &Path) -> Result<Self> {
        let absolute = absolute_lexical(root)?;
        reject_link_ancestors(&absolute)?;
        let root = absolute.canonicalize().context("project directory does not exist")?;
        ensure!(root.is_dir(), "project root must be a directory");
        let database = root.join(DATABASE_NAME);
        reject_link_ancestors(&database)?;
        ensure!(
            fs::symlink_metadata(&database)
                .context("project database does not exist")?
                .is_file(),
            "project database must be a regular file"
        );
        let mut connection = Connection::open_with_flags(
            &database,
            OpenFlags::SQLITE_OPEN_READ_WRITE,
        )
        .context("cannot open project database")?;
        configure_and_migrate(&mut connection)?;
        let repository = Self { root, connection };
        let project = repository.project()?;
        let json = snapshot_json(&project)?;
        let snapshot = repository.root.join(SNAPSHOT_NAME);
        reject_link_ancestors(&snapshot)?;
        let current = match fs::read(&snapshot) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error).context("cannot read project snapshot"),
        };
        if current.as_deref() != Some(json.as_slice()) {
            let temporary = stage_snapshot(&repository.root, &json)?;
            replace_snapshot(temporary, &snapshot)?;
        }
        Ok(repository)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn project(&self) -> Result<Project> {
        let json: Option<String> = self
            .connection
            .query_row(
                "SELECT json FROM project_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let json = json.context("project database contains no project snapshot")?;
        let project: Project = serde_json::from_str(&json)
            .context("project database snapshot is invalid")?;
        validate_project(&project)?;
        Ok(project)
    }

    pub fn save_project(&mut self, project: &Project) -> Result<()> {
        validate_project(project)?;
        let previous = self.project()?;
        ensure!(project.id == previous.id, "project identity cannot be changed");
        ensure!(
            project.created_at == previous.created_at,
            "project creation timestamp cannot be changed"
        );
        ensure!(
            project.updated_at == previous.updated_at,
            "project changed since this snapshot was read; reload before saving"
        );
        let mut updated = project.clone();
        updated.updated_at = next_timestamp(&previous.updated_at)?;
        self.persist_snapshot(&updated, Some(&previous.updated_at))
    }

    /// Copy input bytes into a new immutable artifact directory. The caller
    /// validates allowed import formats; this routine also handles locally
    /// generated thumbnails and JSON metadata.
    pub fn copy_in(&self, source: &Path, category: &str, filename: &str) -> Result<Artifact> {
        validate_component(category)?;
        validate_component(filename)?;
        let source = absolute_lexical(source)?;
        reject_link_ancestors(&source)?;
        ensure!(
            fs::symlink_metadata(&source)
                .context("artifact source does not exist")?
                .is_file(),
            "artifact source must be a regular file"
        );
        let category_root = self.ensure_category(category)?;
        let id = Uuid::new_v4().to_string();
        let artifact_root = category_root.join(&id);
        fs::create_dir(&artifact_root).context("cannot reserve new artifact directory")?;
        let target = artifact_root.join(filename);
        let copied = copy_new_hashed(&source, &target);
        let (sha256, bytes) = match copied {
            Ok(result) => result,
            Err(error) => {
                // Only files created by this call are removed. No source path
                // or recursive user directory is ever used for cleanup.
                let _ = fs::remove_dir(&artifact_root);
                return Err(error);
            }
        };
        let format = Path::new(filename)
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("bin")
            .to_lowercase();
        Ok(Artifact {
            id,
            path: format!("{category}/{}/{filename}", artifact_root.file_name().unwrap().to_string_lossy()),
            format,
            sha256,
            bytes,
            role: role_for_category(category),
        })
    }

    pub fn add_asset(&mut self, asset: Asset) -> Result<()> {
        let mut project = self.project()?;
        ensure!(
            !project.assets.iter().any(|existing| existing.id == asset.id),
            "asset id already exists"
        );
        for version in &asset.versions {
            for artifact in &version.artifacts {
                self.verify_artifact(artifact)?;
            }
        }
        project.assets.push(asset);
        self.save_project(&project)
    }

    pub fn add_version(&mut self, asset_id: &str, version: AssetVersion) -> Result<()> {
        for artifact in &version.artifacts {
            self.verify_artifact(artifact)?;
        }
        let mut project = self.project()?;
        let asset = project
            .assets
            .iter_mut()
            .find(|asset| asset.id == asset_id)
            .context("asset does not exist")?;
        ensure!(
            !asset.versions.iter().any(|existing| {
                existing.id == version.id || existing.number == version.number
            }),
            "asset version id or number already exists"
        );
        asset.active_version_id = version.id.clone();
        asset.versions.push(version);
        self.save_project(&project)
    }

    pub fn upsert_job(&mut self, job: Job) -> Result<()> {
        let mut project = self.project()?;
        ensure!(job.project_id == project.id, "job belongs to another project");
        ensure!(!job.id.trim().is_empty(), "job id must not be empty");
        match project.jobs.iter_mut().find(|existing| existing.id == job.id) {
            Some(existing) => *existing = job,
            None => project.jobs.push(job),
        }
        self.save_project(&project)
    }

    /// Resolve a relative artifact path, rejecting traversal, absolute paths,
    /// links, reparse points and files outside the project.
    pub fn artifact_path(&self, relative: &str) -> Result<PathBuf> {
        let relative = checked_relative(relative)?;
        let full = self.root.join(relative);
        reject_link_ancestors(&full)?;
        let metadata = fs::symlink_metadata(&full).context("artifact file does not exist")?;
        ensure!(metadata.is_file(), "artifact path must identify a regular file");
        let canonical = full.canonicalize().context("cannot resolve artifact file")?;
        ensure!(is_within(&canonical, &self.root), "artifact escaped the project directory");
        Ok(canonical)
    }

    /// Confirm the recorded bytes describe the file that exists on disk now.
    pub fn verify_artifact(&self, artifact: &Artifact) -> Result<()> {
        validate_artifact(artifact)?;
        let source = self.artifact_path(&artifact.path)?;
        let (actual_hash, actual_bytes) = sha256_file(&source)?;
        ensure!(
            actual_bytes == artifact.bytes && actual_hash == artifact.sha256,
            "artifact integrity check failed: {}",
            artifact.path
        );
        Ok(())
    }

    /// Export selected assets, including every version and source/output file,
    /// into a new directory beneath destination. An empty selection means all
    /// assets. No app installation or source project is needed to read the
    /// returned directory and its manifest.json.
    pub fn export_bundle(&self, destination: &Path, asset_ids: &[String]) -> Result<PathBuf> {
        let project = self.project()?;
        let destination = resolve_new_path(destination)?;
        ensure!(
            !is_within(&destination, &self.root),
            "export destination must be outside the source project"
        );
        reject_link_ancestors(&destination)?;
        if destination.try_exists()? {
            ensure!(destination.is_dir(), "export destination must be a directory");
        }

        let selected: HashSet<&str> = asset_ids.iter().map(String::as_str).collect();
        for id in &selected {
            ensure!(
                project.assets.iter().any(|asset| asset.id == *id),
                "selected asset does not exist: {id}"
            );
        }
        let assets: Vec<Asset> = project
            .assets
            .iter()
            .filter(|asset| selected.is_empty() || selected.contains(asset.id.as_str()))
            .cloned()
            .collect();
        let mut files = BTreeMap::<String, Artifact>::new();
        for artifact in assets
            .iter()
            .flat_map(|asset| &asset.versions)
            .flat_map(|version| &version.artifacts)
        {
            self.verify_artifact(artifact)?;
            let key = artifact.path.to_lowercase();
            if let Some(previous) = files.get(&key) {
                ensure!(previous == artifact, "artifact path has conflicting metadata or case: {}", artifact.path);
            } else {
                files.insert(key, artifact.clone());
            }
        }

        // Preflight happens before destination mutation. The unique directory
        // is reserved with create_dir; every output file uses create_new.
        fs::create_dir_all(&destination).context("cannot create export destination")?;
        let canonical_destination = destination.canonicalize()?;
        ensure!(!is_within(&canonical_destination, &self.root), "export destination resolved inside the project");
        let bundle = canonical_destination.join(format!("asset-studio-export-{}", Uuid::new_v4()));
        fs::create_dir(&bundle).context("cannot reserve new export directory")?;
        let outcome = (|| -> Result<()> {
            for artifact in files.values() {
                let relative = checked_relative(&artifact.path)?;
                let target = bundle.join(relative);
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                    reject_link_ancestors(parent)?;
                }
                let source = self.artifact_path(&artifact.path)?;
                let (actual_hash, actual_bytes) = copy_new_hashed(&source, &target)?;
                ensure!(
                    actual_hash == artifact.sha256 && actual_bytes == artifact.bytes,
                    "artifact changed during export: {}",
                    artifact.path
                );
                let (copied_hash, copied_bytes) = sha256_file(&target)?;
                ensure!(
                    copied_hash == artifact.sha256 && copied_bytes == artifact.bytes,
                    "exported file failed integrity check: {}",
                    artifact.path
                );
            }
            let manifest = ExportManifest {
                format: "asset-studio-bundle".into(),
                schema_version: SCHEMA_VERSION,
                exported_at: now(),
                project_id: project.id.clone(),
                project_name: project.name.clone(),
                spec: project.spec.clone(),
                style_guide: project.style_guide.clone(),
                assets,
                files: files.into_values().collect(),
            };
            let mut json = serde_json::to_vec_pretty(&manifest)?;
            json.push(b'\n');
            let mut manifest_file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(bundle.join("manifest.json"))?;
            manifest_file.write_all(&json)?;
            manifest_file.sync_all()?;
            sync_directory(&bundle)?;
            Ok(())
        })();
        if let Err(error) = outcome {
            cleanup_owned_export(&bundle, &canonical_destination);
            return Err(error).context("export did not complete");
        }
        Ok(bundle)
    }

    fn ensure_category(&self, category: &str) -> Result<PathBuf> {
        let folded = category.to_lowercase();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            ensure!(
                name == category || name.to_lowercase() != folded,
                "category collides with an existing name by case"
            );
        }
        let category_root = self.root.join(category);
        reject_link_ancestors(&category_root)?;
        match fs::create_dir(&category_root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                ensure!(category_root.is_dir(), "artifact category is not a directory");
            }
            Err(error) => return Err(error).context("cannot create artifact category"),
        }
        Ok(category_root)
    }

    fn persist_snapshot(&mut self, project: &Project, expected_timestamp: Option<&str>) -> Result<()> {
        validate_project(project)?;
        let snapshot = self.root.join(SNAPSHOT_NAME);
        reject_link_ancestors(&snapshot)?;
        let json = snapshot_json(project)?;
        // Stage and fsync first, so permissions/disk errors happen before the
        // database commit whenever possible.
        let temporary = stage_snapshot(&self.root, &json)?;
        let json_text = std::str::from_utf8(&json)?;
        let transaction = self.connection.transaction()?;
        match expected_timestamp {
            None => {
                transaction.execute(
                    "INSERT INTO project_state (singleton, json, updated_at) VALUES (1, ?1, ?2)",
                    params![json_text, project.updated_at],
                )?;
            }
            Some(expected) => {
                let changed = transaction.execute(
                    "UPDATE project_state SET json = ?1, updated_at = ?2
                     WHERE singleton = 1 AND updated_at = ?3",
                    params![json_text, project.updated_at, expected],
                )?;
                ensure!(changed == 1, "project changed concurrently; reload before saving");
            }
        }
        // Replacement errors roll back the database transaction. A crash
        // after this replacement but before commit can leave JSON ahead of
        // SQLite; open() repairs it from the authoritative committed state.
        replace_snapshot(temporary, &snapshot)?;
        transaction.commit()?;
        Ok(())
    }
}

fn configure_and_migrate(connection: &mut Connection) -> Result<()> {
    connection.busy_timeout(Duration::from_secs(5))?;
    let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    ensure!(version <= DATABASE_VERSION, "project database schema is newer than this app");
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    if version == 0 {
        let transaction = connection.transaction()?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS project_state (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                json TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
             );",
        )?;
        transaction.execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            params![DATABASE_VERSION, now()],
        )?;
        transaction.pragma_update(None, "user_version", DATABASE_VERSION)?;
        transaction.commit()?;
    }
    Ok(())
}

fn snapshot_json(project: &Project) -> Result<Vec<u8>> {
    let mut json = serde_json::to_vec_pretty(project)?;
    json.push(b'\n');
    Ok(json)
}

fn next_timestamp(previous: &str) -> Result<String> {
    let previous = DateTime::parse_from_rfc3339(previous)
        .context("project update timestamp must be RFC 3339")?
        .with_timezone(&Utc);
    let current = Utc::now();
    // Millisecond timestamps also serve as optimistic concurrency tokens.
    // Consecutive commits in one clock tick must therefore stay distinct.
    let minimum = previous + chrono::Duration::milliseconds(1);
    Ok(current.max(minimum).to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn stage_snapshot(root: &Path, bytes: &[u8]) -> Result<NamedTempFile> {
    let mut temporary = Builder::new()
        .prefix(".project-")
        .suffix(".json.tmp")
        .tempfile_in(root)
        .context("cannot stage project snapshot")?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    Ok(temporary)
}

fn replace_snapshot(temporary: NamedTempFile, snapshot: &Path) -> Result<()> {
    // tempfile's persist uses atomic replacement (MoveFileExW with replacement
    // on Windows), so an existing JSON snapshot never requires a delete gap.
    temporary.persist(snapshot).map_err(|error| {
        anyhow!("project.json atomic replacement failed: {}", error.error)
    })?;
    if let Some(root) = snapshot.parent() {
        sync_directory(root)?;
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(directory: &Path) -> Result<()> {
    File::open(directory)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_directory(_directory: &Path) -> Result<()> {
    Ok(())
}

fn validate_project(project: &Project) -> Result<()> {
    ensure!(project.schema_version == SCHEMA_VERSION, "unsupported project schema version");
    ensure!(!project.id.trim().is_empty(), "project id must not be empty");
    ensure!(!project.name.trim().is_empty(), "project name must not be empty");
    let mut asset_ids = HashSet::new();
    let mut all_version_ids = HashSet::new();
    for asset in &project.assets {
        ensure!(!asset.id.trim().is_empty() && asset_ids.insert(&asset.id), "asset id is empty or duplicated");
        ensure!(!asset.name.trim().is_empty(), "asset name must not be empty");
        let mut numbers = HashSet::new();
        for version in &asset.versions {
            ensure!(
                !version.id.trim().is_empty() && all_version_ids.insert(&version.id),
                "version id is empty or duplicated"
            );
            ensure!(version.number > 0 && numbers.insert(version.number), "version number is zero or duplicated");
            for artifact in &version.artifacts {
                validate_artifact(artifact)?;
            }
        }
        ensure!(
            (asset.versions.is_empty() && asset.active_version_id.is_empty())
                || asset.versions.iter().any(|version| version.id == asset.active_version_id),
            "active version does not belong to its asset"
        );
    }
    let mut job_ids = HashSet::new();
    for job in &project.jobs {
        ensure!(job.project_id == project.id, "job belongs to another project");
        ensure!(!job.id.trim().is_empty() && job_ids.insert(&job.id), "job id is empty or duplicated");
    }
    Ok(())
}

fn validate_artifact(artifact: &Artifact) -> Result<()> {
    ensure!(!artifact.id.trim().is_empty(), "artifact id must not be empty");
    checked_relative(&artifact.path)?;
    ensure!(
        artifact.sha256.len() == 64
            && artifact.sha256.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "artifact sha256 must contain 64 lowercase hexadecimal characters"
    );
    Ok(())
}

fn validate_component(component: &str) -> Result<()> {
    ensure!(
        !component.is_empty()
            && component != "."
            && component != ".."
            && !component.chars().any(|character| character.is_control() || "\\/:*?\"<>|".contains(character))
            && !component.ends_with(' ')
            && !component.ends_with('.'),
        "unsafe or nonportable filename component"
    );
    let base = component.split('.').next().unwrap_or("").trim_end_matches(' ').to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((base.starts_with("COM") || base.starts_with("LPT"))
            && matches!(&base[3..], "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"));
    ensure!(!reserved, "reserved Windows filename component");
    Ok(())
}

fn checked_relative(relative: &str) -> Result<PathBuf> {
    ensure!(
        !relative.is_empty() && !relative.contains('\\') && !relative.starts_with('/'),
        "artifact paths must be relative with forward slashes"
    );
    let parts: Vec<&str> = relative.split('/').collect();
    ensure!(parts.len() >= 2, "artifact paths must remain inside an artifact directory");
    let mut result = PathBuf::new();
    for part in parts {
        validate_component(part)?;
        result.push(part);
    }
    ensure!(result.components().all(|component| matches!(component, Component::Normal(_))), "artifact path traversal is forbidden");
    Ok(result)
}

fn role_for_category(category: &str) -> ArtifactRole {
    match category.to_ascii_lowercase().as_str() {
        "source" | "sources" | "input" | "inputs" | "original" | "originals" | "imports" | "references" => ArtifactRole::Source,
        "thumbnail" | "thumbnails" => ArtifactRole::Thumbnail,
        "metadata" => ArtifactRole::Metadata,
        _ => ArtifactRole::Output,
    }
}

/// Hash the actual file bytes, returning (lowercase SHA-256, byte count).
pub fn sha256_file(path: &Path) -> Result<(String, u64)> {
    reject_link_ancestors(path)?;
    let mut file = File::open(path).context("cannot open file for integrity check")?;
    ensure!(file.metadata()?.is_file(), "integrity checks require a regular file");
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        bytes = bytes.checked_add(count as u64).context("artifact size overflow")?;
    }
    Ok((format!("{:x}", digest.finalize()), bytes))
}

fn copy_new_hashed(source: &Path, target: &Path) -> Result<(String, u64)> {
    reject_link_ancestors(source)?;
    reject_link_ancestors(target)?;
    let mut input = File::open(source).context("cannot open artifact source")?;
    ensure!(input.metadata()?.is_file(), "artifact source must be a regular file");
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .context("cannot create new artifact output")?;
    let outcome = (|| -> Result<(String, u64)> {
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut bytes = 0u64;
        loop {
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count])?;
            digest.update(&buffer[..count]);
            bytes = bytes.checked_add(count as u64).context("artifact size overflow")?;
        }
        output.sync_all()?;
        Ok((format!("{:x}", digest.finalize()), bytes))
    })();
    // create_new above succeeded, so this function owns this file. If the
    // reservation failed, the early return leaves any existing file intact.
    drop(output);
    if outcome.is_err() {
        let _ = fs::remove_file(target);
    }
    outcome
}

fn absolute_lexical(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut result = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => result.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => ensure!(result.pop(), "path traversal escaped the filesystem root"),
        }
    }
    ensure!(result.is_absolute(), "path must resolve to an absolute location");
    Ok(result)
}

fn resolve_new_path(path: &Path) -> Result<PathBuf> {
    let absolute = absolute_lexical(path)?;
    reject_link_ancestors(&absolute)?;
    let mut cursor = absolute;
    let mut suffix = Vec::<OsString>::new();
    loop {
        match fs::symlink_metadata(&cursor) {
            Ok(_) => {
                let mut resolved = cursor.canonicalize()?;
                for component in suffix.into_iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                suffix.push(cursor.file_name().context("cannot resolve destination ancestor")?.to_os_string());
                ensure!(cursor.pop(), "cannot resolve destination ancestor");
            }
            Err(error) => return Err(error).context("cannot inspect destination"),
        }
    }
}

fn is_within(path: &Path, root: &Path) -> bool {
    // Case-folding also handles Windows/macOS volumes that are insensitive to
    // name case. A sibling whose name only differs in case is conservatively
    // treated as the same directory rather than a safe export destination.
    let normalize = |path: &Path| {
        path.to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_lowercase()
    };
    let path = normalize(path);
    let root = normalize(root);
    path == root || path.starts_with(&(root + "/"))
}

fn reject_link_ancestors(path: &Path) -> Result<()> {
    let absolute = absolute_lexical(path)?;
    for ancestor in absolute.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => ensure!(
                !is_link_or_reparse(&metadata) || is_standard_system_alias(ancestor),
                "symlinks and reparse points are not allowed for artifact storage"
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("cannot inspect artifact path"),
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn is_standard_system_alias(path: &Path) -> bool {
    // macOS routes these OS-owned aliases through /private. Their exact link
    // targets and resolved paths are checked; user-created file/directory
    // links anywhere else remain forbidden, including inside project storage.
    let expected = match path.to_str() {
        Some("/var") => Path::new("/private/var"),
        Some("/tmp") => Path::new("/private/tmp"),
        Some("/etc") => Path::new("/private/etc"),
        _ => return false,
    };
    let Ok(target) = fs::read_link(path) else {
        return false;
    };
    let target = if target.is_absolute() {
        target
    } else {
        path.parent().unwrap_or(Path::new("/")).join(target)
    };
    target == expected && path.canonicalize().ok().as_deref() == Some(expected)
}

#[cfg(not(target_os = "macos"))]
fn is_standard_system_alias(_path: &Path) -> bool {
    false
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn cleanup_owned_export(bundle: &Path, destination: &Path) {
    // Verify the exact resolved target immediately before recursive cleanup.
    // UUID export directories are created by this call, never user originals.
    if bundle.parent() != Some(destination)
        || !bundle
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("asset-studio-export-"))
    {
        return;
    }
    let Ok(metadata) = fs::symlink_metadata(bundle) else {
        return;
    };
    if is_link_or_reparse(&metadata) {
        return;
    }
    let Ok(resolved) = bundle.canonicalize() else {
        return;
    };
    if resolved.parent() == Some(destination) && is_within(&resolved, destination) {
        let _ = fs::remove_dir_all(&resolved);
    }
}
