//! Pinned, user-local prerequisites for the headless CLI.
//! Downloads require caller consent. System installations, shells and user
//! asset code are never invoked; incomplete UUID folders remain unpublished.

use flate2::read::MultiGzDecoder;
use reqwest::{blocking::Client, redirect::Policy, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
use thiserror::Error;
use uuid::Uuid;

const MAX_UNPACKED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
const RECEIPT: &str = "install-receipt.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Blender,
    MacPython,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: &'static str,
    pub version: &'static str,
    pub target: &'static str,
    pub url: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
    pub source_url: &'static str,
    pub license: &'static str,
    pub license_url: &'static str,
    pub package_format: &'static str,
    pub executable: &'static str,
}

const BLENDER_WINDOWS: Manifest = Manifest {
    id: "blender",
    version: "5.2.1",
    target: "x86_64-pc-windows-msvc",
    url: "https://download.blender.org/release/Blender5.2/blender-5.2.1-windows-x64.zip",
    bytes: 404_851_964,
    sha256: "0e631dad7d0cad6d5d18abdd2e2550f6c0213215334eda00ddbd3d22b96ecb2c",
    source_url: "https://download.blender.org/release/Blender5.2/blender-5.2.1.sha256",
    license: "GPL-3.0-or-later; bundled dependency notices retained",
    license_url: "https://www.blender.org/about/license/",
    package_format: "zip",
    executable: "blender-5.2.1-windows-x64/blender.exe",
};

const BLENDER_MAC: Manifest = Manifest {
    id: "blender",
    version: "5.2.1",
    target: "aarch64-apple-darwin",
    url: "https://download.blender.org/release/Blender5.2/blender-5.2.1-macos-arm64.dmg",
    bytes: 346_264_899,
    sha256: "6409e21de80994db5f4c4a34486b6fd43cea21085b912f7491c53e923acb65a3",
    source_url: "https://download.blender.org/release/Blender5.2/blender-5.2.1.sha256",
    license: "GPL-3.0-or-later; bundled dependency notices retained",
    license_url: "https://www.blender.org/about/license/",
    package_format: "dmg",
    executable: "Blender.app/Contents/MacOS/Blender",
};

const PYTHON_MAC: Manifest = Manifest {
    id: "python",
    version: "3.9.24+20251014",
    target: "aarch64-apple-darwin",
    url: "https://github.com/astral-sh/python-build-standalone/releases/download/20251014/cpython-3.9.24%2B20251014-aarch64-apple-darwin-install_only.tar.gz",
    bytes: 18_209_249,
    sha256: "6b65213e639e91eb8072db80ed9c140d769af1d5e0386efd8f153449c3694714",
    source_url: "https://api.github.com/repos/astral-sh/python-build-standalone/releases/assets/304305976",
    license: "Python-2.0; build source MPL-2.0; bundled dependency notices retained",
    license_url: "https://github.com/astral-sh/python-build-standalone/blob/20251014/LICENSE",
    package_format: "tar.gz",
    executable: "python/bin/python3.9",
};

/// Values are compiled pins, never parsed from an untrusted CLI request.
pub fn manifest(kind: Kind) -> Option<Manifest> {
    match kind {
        Kind::Blender if cfg!(all(target_os = "windows", target_arch = "x86_64")) => {
            Some(BLENDER_WINDOWS)
        }
        Kind::Blender if cfg!(all(target_os = "macos", target_arch = "aarch64")) => {
            Some(BLENDER_MAC)
        }
        Kind::MacPython if cfg!(all(target_os = "macos", target_arch = "aarch64")) => {
            Some(PYTHON_MAC)
        }
        _ => None,
    }
}

/// Reuses an already installed, compatible Mac interpreter without copying it
/// or changing the user's Python installation. A present but incompatible
/// system Python must not hide a compatible Homebrew/python.org CPython 3.9.
pub fn system_mac_python() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    for path in [
        "/usr/bin/python3",
        "/opt/homebrew/bin/python3.9",
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3.9",
        "/usr/local/bin/python3",
        "/Library/Frameworks/Python.framework/Versions/3.9/bin/python3.9",
    ] {
        let path = PathBuf::from(path);
        if !path.is_file() {
            continue;
        }
        let output = bounded_command(
            Command::new(&path).args(["-I", "-B", "-c", "import json,platform,struct,sys;print(json.dumps({'implementation':platform.python_implementation(),'version':list(sys.version_info[:2]),'platform':platform.system(),'machine':platform.machine(),'bits':struct.calcsize('P')*8}))"]),
            Duration::from_secs(10),
        ).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        if output.is_some_and(|value| {
            value["implementation"] == "CPython"
                && value["version"] == serde_json::json!([3, 9])
                && value["platform"] == "Darwin"
                && value["machine"] == "arm64"
                && value["bits"] == 64
        }) {
            return Some(path);
        }
    }
    None
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub prerequisite: String,
    pub stage: &'static str,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Error)]
pub enum PrerequisiteError {
    #[error("Prerequisite download requires --consent-downloads")]
    ConsentRequired,
    #[error("Pinned prerequisite is unavailable for this operating system or architecture")]
    Unsupported,
    #[error(
        "Prerequisite path is unsafe or already contains unmanaged files; originals preserved"
    )]
    UnsafeRoot,
    #[error("Another prerequisite preparation owns this directory")]
    Busy,
    #[error("Pinned prerequisite download failed; partial data preserved")]
    Download,
    #[error("Prerequisite archive or installed file did not match its pinned receipt")]
    Integrity,
    #[error("Prerequisite archive contains an unsafe or unsupported entry")]
    Archive,
    #[error("Prerequisite preparation exceeded its deadline; incomplete data preserved")]
    Timeout,
    #[error("Pinned prerequisite native probe failed")]
    Probe,
    #[error("Prerequisite filesystem operation failed")]
    Io,
}

type Result<T> = std::result::Result<T, PrerequisiteError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileRecord {
    bytes: u64,
    sha256: String,
    link_target: Option<String>,
    executable: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallReceipt {
    schema_version: u32,
    installation_id: String,
    manifest: serde_json::Value,
    files: BTreeMap<String, FileRecord>,
    native_probe_verified: bool,
}

fn io<T>(result: std::io::Result<T>) -> Result<T> {
    result.map_err(|_| PrerequisiteError::Io)
}

fn no_links(path: &Path) -> Result<()> {
    let mut part = PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir) {
            return Err(PrerequisiteError::UnsafeRoot);
        }
        part.push(component);
        if let Ok(metadata) = fs::symlink_metadata(&part) {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err(PrerequisiteError::UnsafeRoot);
                }
            }
            if metadata.file_type().is_symlink() {
                return Err(PrerequisiteError::UnsafeRoot);
            }
        }
    }
    Ok(())
}

fn root(data: &Path, create: bool) -> Result<PathBuf> {
    if !data.is_absolute() {
        return Err(PrerequisiteError::UnsafeRoot);
    }
    let directory = data.join("cli/prerequisites");
    no_links(&directory)?;
    if create {
        io(fs::create_dir_all(&directory))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            io(fs::set_permissions(
                &directory,
                fs::Permissions::from_mode(0o700),
            ))?;
        }
    }
    Ok(directory)
}

fn lock(directory: &Path) -> Result<File> {
    let path = directory.join(".prepare.lock");
    no_links(&path)?;
    let file = io(OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path))?;
    file.try_lock().map_err(|_| PrerequisiteError::Busy)?;
    Ok(file)
}

fn hash_file(path: &Path) -> Result<(u64, String)> {
    no_links(path)?;
    let mut file = io(File::open(path))?;
    if !io(file.metadata())?.is_file() {
        return Err(PrerequisiteError::Integrity);
    }
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut block = [0u8; 256 * 1024];
    loop {
        let count = io(file.read(&mut block))?;
        if count == 0 {
            break;
        }
        size = size
            .checked_add(count as u64)
            .ok_or(PrerequisiteError::Integrity)?;
        digest.update(&block[..count]);
    }
    Ok((size, format!("{:x}", digest.finalize())))
}

fn safe_relative(value: &str) -> Result<PathBuf> {
    let normalized = value.replace('\\', "/");
    let parts: Vec<_> = normalized.trim_end_matches('/').split('/').collect();
    if normalized.starts_with('/') || parts.is_empty() || parts.len() > 64 {
        return Err(PrerequisiteError::Archive);
    }
    for part in &parts {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty()
            || *part == "."
            || *part == ".."
            || part.len() > 255
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || ":*?\"<>|".contains(c))
            || [
                "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
                "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
                "LPT9",
            ]
            .contains(&stem.as_str())
        {
            return Err(PrerequisiteError::Archive);
        }
    }
    Ok(parts.iter().collect())
}

fn contained_link(relative: &Path, target: &Path) -> Result<()> {
    if target.is_absolute() {
        return Err(PrerequisiteError::Archive);
    }
    let mut resolved = relative.parent().unwrap_or(Path::new("")).to_path_buf();
    for part in target.components() {
        match part {
            Component::Normal(value) => resolved.push(value),
            Component::CurDir => {}
            Component::ParentDir if resolved.pop() => {}
            _ => return Err(PrerequisiteError::Archive),
        }
    }
    if resolved.as_os_str().is_empty() {
        return Err(PrerequisiteError::Archive);
    }
    safe_relative(resolved.to_str().ok_or(PrerequisiteError::Archive)?)?;
    Ok(())
}

fn approved_origin(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && matches!(
            url.host_str(),
            Some(
                "download.blender.org"
                    | "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
}

fn deadline(started: Instant, timeout: Duration) -> Result<()> {
    if started.elapsed() > timeout {
        return Err(PrerequisiteError::Timeout);
    }
    Ok(())
}

fn download(
    manifest: Manifest,
    directory: &Path,
    started: Instant,
    timeout: Duration,
    progress: &mut impl FnMut(Progress),
) -> Result<PathBuf> {
    let archives = directory.join("archives");
    no_links(&archives)?;
    io(fs::create_dir_all(&archives))?;
    let basename = manifest
        .url
        .rsplit('/')
        .next()
        .ok_or(PrerequisiteError::Download)?;
    let cache = archives.join(format!("{}-{basename}", manifest.sha256));
    if cache.exists() {
        let (bytes, sha256) = hash_file(&cache)?;
        return if bytes == manifest.bytes && sha256 == manifest.sha256 {
            Ok(cache)
        } else {
            Err(PrerequisiteError::Integrity)
        };
    }
    let partial = archives.join(format!("{}.partial", Uuid::new_v4()));
    let mut output = io(OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial))?;
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .timeout(timeout.min(Duration::from_secs(900)))
        .build()
        .map_err(|_| PrerequisiteError::Download)?;
    let mut url = Url::parse(manifest.url).map_err(|_| PrerequisiteError::Download)?;
    let mut response = None;
    for _ in 0..7 {
        deadline(started, timeout)?;
        if !approved_origin(&url) {
            return Err(PrerequisiteError::Download);
        }
        let received = client
            .get(url.clone())
            .header("User-Agent", "AssetStudio-CLI-Prepare/1")
            .send()
            .map_err(|_| PrerequisiteError::Download)?;
        if received.status().is_redirection() {
            let next = received
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(PrerequisiteError::Download)?;
            url = url.join(next).map_err(|_| PrerequisiteError::Download)?;
        } else if received.status().is_success() {
            response = Some(received);
            break;
        } else {
            return Err(PrerequisiteError::Download);
        }
    }
    let mut response = response.ok_or(PrerequisiteError::Download)?;
    if response
        .content_length()
        .is_some_and(|size| size != manifest.bytes)
    {
        return Err(PrerequisiteError::Integrity);
    }
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut block = [0u8; 256 * 1024];
    let mut last = Instant::now();
    loop {
        deadline(started, timeout)?;
        let count = response
            .read(&mut block)
            .map_err(|_| PrerequisiteError::Download)?;
        if count == 0 {
            break;
        }
        size = size
            .checked_add(count as u64)
            .ok_or(PrerequisiteError::Integrity)?;
        if size > manifest.bytes {
            return Err(PrerequisiteError::Integrity);
        }
        io(output.write_all(&block[..count]))?;
        digest.update(&block[..count]);
        if last.elapsed() >= Duration::from_secs(2) {
            progress(Progress {
                prerequisite: manifest.id.into(),
                stage: "download",
                downloaded_bytes: size,
                total_bytes: manifest.bytes,
            });
            last = Instant::now();
        }
    }
    if size != manifest.bytes || format!("{:x}", digest.finalize()) != manifest.sha256 {
        return Err(PrerequisiteError::Integrity);
    }
    io(output.sync_all())?;
    drop(output);
    io(fs::rename(partial, &cache))?;
    progress(Progress {
        prerequisite: manifest.id.into(),
        stage: "verified",
        downloaded_bytes: size,
        total_bytes: manifest.bytes,
    });
    Ok(cache)
}

fn cached_archive(manifest: Manifest, directory: &Path) -> Result<PathBuf> {
    let basename = manifest
        .url
        .rsplit('/')
        .next()
        .ok_or(PrerequisiteError::Integrity)?;
    let path = directory
        .join("archives")
        .join(format!("{}-{basename}", manifest.sha256));
    let (bytes, hash) = hash_file(&path)?;
    if bytes != manifest.bytes || hash != manifest.sha256 {
        return Err(PrerequisiteError::Integrity);
    }
    Ok(path)
}

fn stream_record(
    mut input: impl Read,
    expected_bytes: u64,
    executable: bool,
    started: Instant,
    timeout: Duration,
) -> Result<FileRecord> {
    let mut block = [0u8; 256 * 1024];
    let mut size = 0u64;
    let mut digest = Sha256::new();
    loop {
        deadline(started, timeout)?;
        let count = io(input.read(&mut block))?;
        if count == 0 {
            break;
        }
        size = size
            .checked_add(count as u64)
            .ok_or(PrerequisiteError::Archive)?;
        if size > expected_bytes {
            return Err(PrerequisiteError::Archive);
        }
        digest.update(&block[..count]);
    }
    if size != expected_bytes {
        return Err(PrerequisiteError::Archive);
    }
    Ok(FileRecord {
        bytes: size,
        sha256: format!("{:x}", digest.finalize()),
        link_target: None,
        executable,
    })
}

fn archive_records(
    manifest: Manifest,
    archive: &Path,
    started: Instant,
    timeout: Duration,
) -> Result<BTreeMap<String, FileRecord>> {
    let mut files = BTreeMap::new();
    let mut names = HashSet::new();
    let mut total = 0u64;
    match manifest.package_format {
        "zip" => {
            let mut archive = zip::ZipArchive::new(io(File::open(archive))?)
                .map_err(|_| PrerequisiteError::Archive)?;
            if archive.len() > MAX_ENTRIES {
                return Err(PrerequisiteError::Archive);
            }
            for index in 0..archive.len() {
                deadline(started, timeout)?;
                let mut entry = archive
                    .by_index(index)
                    .map_err(|_| PrerequisiteError::Archive)?;
                let relative = safe_relative(entry.name())?;
                if !relative.starts_with("blender-5.2.1-windows-x64")
                    || !names.insert(relative.to_string_lossy().to_ascii_lowercase())
                    || entry.unix_mode().is_some_and(|mode| {
                        mode & 0o170000 != 0
                            && mode & 0o170000 != 0o100000
                            && mode & 0o170000 != 0o040000
                    })
                {
                    return Err(PrerequisiteError::Archive);
                }
                total = total
                    .checked_add(entry.size())
                    .ok_or(PrerequisiteError::Archive)?;
                if total > MAX_UNPACKED_BYTES {
                    return Err(PrerequisiteError::Archive);
                }
                if !entry.is_dir() {
                    let size = entry.size();
                    files.insert(
                        relative
                            .to_str()
                            .ok_or(PrerequisiteError::Archive)?
                            .replace('\\', "/"),
                        stream_record(&mut entry, size, false, started, timeout)?,
                    );
                }
            }
        }
        "tar.gz" => {
            let mut archive = tar::Archive::new(MultiGzDecoder::new(io(File::open(archive))?));
            for entry in archive.entries().map_err(|_| PrerequisiteError::Archive)? {
                deadline(started, timeout)?;
                let mut entry = entry.map_err(|_| PrerequisiteError::Archive)?;
                let path = entry.path().map_err(|_| PrerequisiteError::Archive)?;
                let relative = safe_relative(path.to_str().ok_or(PrerequisiteError::Archive)?)?;
                if !relative.starts_with("python")
                    || names.len() >= MAX_ENTRIES
                    || !names.insert(relative.to_string_lossy().to_ascii_lowercase())
                {
                    return Err(PrerequisiteError::Archive);
                }
                let entry_type = entry.header().entry_type();
                let name = relative
                    .to_str()
                    .ok_or(PrerequisiteError::Archive)?
                    .replace('\\', "/");
                if entry_type.is_file() {
                    let size = entry
                        .header()
                        .size()
                        .map_err(|_| PrerequisiteError::Archive)?;
                    total = total.checked_add(size).ok_or(PrerequisiteError::Archive)?;
                    if total > MAX_UNPACKED_BYTES {
                        return Err(PrerequisiteError::Archive);
                    }
                    let executable = entry
                        .header()
                        .mode()
                        .map_err(|_| PrerequisiteError::Archive)?
                        & 0o111
                        != 0;
                    files.insert(
                        name,
                        stream_record(&mut entry, size, executable, started, timeout)?,
                    );
                } else if entry_type.is_symlink() {
                    let target = entry
                        .link_name()
                        .map_err(|_| PrerequisiteError::Archive)?
                        .ok_or(PrerequisiteError::Archive)?
                        .to_path_buf();
                    contained_link(&relative, &target)?;
                    files.insert(
                        name,
                        FileRecord {
                            bytes: 0,
                            sha256: String::new(),
                            link_target: Some(
                                target.to_str().ok_or(PrerequisiteError::Archive)?.into(),
                            ),
                            executable: false,
                        },
                    );
                } else if !entry_type.is_dir() {
                    return Err(PrerequisiteError::Archive);
                }
            }
        }
        _ => return Err(PrerequisiteError::Unsupported),
    }
    Ok(files)
}

// This cache contains tables derived from a verified upstream archive during
// this process only. User-editable installation receipts can never populate it.
// Installed files are still checked against this trusted table on every use.
static TRUSTED_ARCHIVES: OnceLock<Mutex<BTreeMap<String, BTreeMap<String, FileRecord>>>> =
    OnceLock::new();

fn expected_records(
    manifest: Manifest,
    directory: &Path,
    started: Instant,
    timeout: Duration,
) -> Result<BTreeMap<String, FileRecord>> {
    let cache = TRUSTED_ARCHIVES.get_or_init(|| Mutex::new(BTreeMap::new()));
    if let Some(files) = cache
        .lock()
        .map_err(|_| PrerequisiteError::Integrity)?
        .get(manifest.sha256)
        .cloned()
    {
        return Ok(files);
    }
    let archive = cached_archive(manifest, directory)?;
    deadline(started, timeout)?;
    let files = match manifest.package_format {
        "zip" | "tar.gz" => archive_records(manifest, &archive, started, timeout)?,
        #[cfg(target_os = "macos")]
        "dmg" => with_dmg(&archive, directory, started, timeout, |mount| {
            let records = file_records(&mount.join("Blender.app"), started, timeout)?;
            Ok(records
                .into_iter()
                .map(|(name, record)| (format!("Blender.app/{name}"), record))
                .collect())
        })?,
        _ => return Err(PrerequisiteError::Unsupported),
    };
    cache
        .lock()
        .map_err(|_| PrerequisiteError::Integrity)?
        .insert(manifest.sha256.into(), files.clone());
    Ok(files)
}

fn write_member(
    mut input: impl Read,
    path: &Path,
    bytes: u64,
    executable: bool,
    started: Instant,
    timeout: Duration,
) -> Result<()> {
    no_links(path)?;
    io(fs::create_dir_all(
        path.parent().ok_or(PrerequisiteError::Archive)?,
    ))?;
    let mut output = io(OpenOptions::new().write(true).create_new(true).open(path))?;
    let mut written = 0u64;
    let mut block = [0u8; 256 * 1024];
    loop {
        deadline(started, timeout)?;
        let count = io(input.read(&mut block))?;
        if count == 0 {
            break;
        }
        written += count as u64;
        if written > bytes {
            return Err(PrerequisiteError::Archive);
        }
        io(output.write_all(&block[..count]))?;
    }
    if written != bytes {
        return Err(PrerequisiteError::Archive);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        io(fs::set_permissions(
            path,
            fs::Permissions::from_mode(if executable { 0o700 } else { 0o600 }),
        ))?;
    }
    #[cfg(not(unix))]
    let _ = executable;
    Ok(())
}

fn unpack_zip(archive: &Path, output: &Path, started: Instant, timeout: Duration) -> Result<()> {
    let mut zip =
        zip::ZipArchive::new(io(File::open(archive))?).map_err(|_| PrerequisiteError::Archive)?;
    if zip.len() > MAX_ENTRIES {
        return Err(PrerequisiteError::Archive);
    }
    let mut names = HashSet::new();
    let mut total = 0u64;
    for index in 0..zip.len() {
        deadline(started, timeout)?;
        let mut entry = zip
            .by_index(index)
            .map_err(|_| PrerequisiteError::Archive)?;
        let relative = safe_relative(entry.name())?;
        if !relative.starts_with("blender-5.2.1-windows-x64")
            || !names.insert(relative.to_string_lossy().to_ascii_lowercase())
            || entry.unix_mode().is_some_and(|mode| {
                mode & 0o170000 != 0 && mode & 0o170000 != 0o100000 && mode & 0o170000 != 0o040000
            })
        {
            return Err(PrerequisiteError::Archive);
        }
        total = total
            .checked_add(entry.size())
            .ok_or(PrerequisiteError::Archive)?;
        if total > MAX_UNPACKED_BYTES {
            return Err(PrerequisiteError::Archive);
        }
        let target = output.join(relative);
        if entry.is_dir() {
            no_links(&target)?;
            io(fs::create_dir_all(target))?;
        } else {
            let size = entry.size();
            write_member(&mut entry, &target, size, false, started, timeout)?;
        }
    }
    Ok(())
}

fn unpack_tar(archive: &Path, output: &Path, started: Instant, timeout: Duration) -> Result<()> {
    let mut tar = tar::Archive::new(MultiGzDecoder::new(io(File::open(archive))?));
    let mut names = HashSet::new();
    let mut total = 0u64;
    let mut links = Vec::new();
    for entry in tar.entries().map_err(|_| PrerequisiteError::Archive)? {
        deadline(started, timeout)?;
        let mut entry = entry.map_err(|_| PrerequisiteError::Archive)?;
        let entry_path = entry.path().map_err(|_| PrerequisiteError::Archive)?;
        let relative = safe_relative(entry_path.to_str().ok_or(PrerequisiteError::Archive)?)?;
        if !relative.starts_with("python")
            || names.len() >= MAX_ENTRIES
            || !names.insert(relative.to_string_lossy().to_ascii_lowercase())
        {
            return Err(PrerequisiteError::Archive);
        }
        let target = output.join(&relative);
        let entry_type = entry.header().entry_type();
        if entry_type.is_dir() {
            no_links(&target)?;
            io(fs::create_dir_all(target))?;
        } else if entry_type.is_file() {
            let bytes = entry
                .header()
                .size()
                .map_err(|_| PrerequisiteError::Archive)?;
            total = total.checked_add(bytes).ok_or(PrerequisiteError::Archive)?;
            if total > MAX_UNPACKED_BYTES {
                return Err(PrerequisiteError::Archive);
            }
            let executable = entry
                .header()
                .mode()
                .map_err(|_| PrerequisiteError::Archive)?
                & 0o111
                != 0;
            write_member(&mut entry, &target, bytes, executable, started, timeout)?;
        } else if entry_type.is_symlink() {
            let link = entry
                .link_name()
                .map_err(|_| PrerequisiteError::Archive)?
                .ok_or(PrerequisiteError::Archive)?
                .to_path_buf();
            contained_link(&relative, &link)?;
            links.push((target, link));
        } else {
            return Err(PrerequisiteError::Archive);
        }
    }
    for (target, link) in links {
        no_links(&target)?;
        io(fs::create_dir_all(
            target.parent().ok_or(PrerequisiteError::Archive)?,
        ))?;
        #[cfg(unix)]
        io(std::os::unix::fs::symlink(link, target))?;
        #[cfg(not(unix))]
        {
            let _ = (link, target);
            return Err(PrerequisiteError::Unsupported);
        }
    }
    Ok(())
}

fn bounded_command(command: &mut Command, timeout: Duration) -> Result<Vec<u8>> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| PrerequisiteError::Probe)?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let mut bytes = Vec::new();
                io(child
                    .stdout
                    .take()
                    .ok_or(PrerequisiteError::Probe)?
                    .take(65537)
                    .read_to_end(&mut bytes))?;
                return if bytes.len() <= 65536 {
                    Ok(bytes)
                } else {
                    Err(PrerequisiteError::Probe)
                };
            }
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(PrerequisiteError::Probe);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn copy_bundle(source: &Path, output: &Path, started: Instant, timeout: Duration) -> Result<()> {
    let mut pending = vec![PathBuf::from("Blender.app")];
    let mut links = Vec::new();
    let mut entries = 0usize;
    let mut total = 0u64;
    while let Some(relative) = pending.pop() {
        deadline(started, timeout)?;
        entries += 1;
        if entries > MAX_ENTRIES {
            return Err(PrerequisiteError::Archive);
        }
        safe_relative(relative.to_str().ok_or(PrerequisiteError::Archive)?)?;
        let path = source.join(&relative);
        let metadata = io(fs::symlink_metadata(&path))?;
        let destination = output.join(&relative);
        if metadata.is_dir() {
            io(fs::create_dir_all(destination))?;
            for item in io(fs::read_dir(path))? {
                pending.push(relative.join(io(item)?.file_name()));
            }
        } else if metadata.is_file() {
            use std::os::unix::fs::PermissionsExt;
            total = total
                .checked_add(metadata.len())
                .ok_or(PrerequisiteError::Archive)?;
            if total > MAX_UNPACKED_BYTES {
                return Err(PrerequisiteError::Archive);
            }
            write_member(
                io(File::open(path))?,
                &destination,
                metadata.len(),
                metadata.permissions().mode() & 0o111 != 0,
                started,
                timeout,
            )?;
        } else if metadata.file_type().is_symlink() {
            let target = io(fs::read_link(path))?;
            contained_link(&relative, &target)?;
            links.push((destination, target));
        } else {
            return Err(PrerequisiteError::Archive);
        }
    }
    for (destination, target) in links {
        io(std::os::unix::fs::symlink(target, destination))?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn with_dmg<T>(
    archive: &Path,
    directory: &Path,
    started: Instant,
    timeout: Duration,
    operation: impl FnOnce(&Path) -> Result<T>,
) -> Result<T> {
    let mount = directory.join(format!(".mount-{}", Uuid::new_v4()));
    io(fs::create_dir(&mount))?;
    // hdiutil accepts only this hash-verified image and a task-owned mountpoint.
    // No installer package runs, and /Applications is never modified.
    let remaining = timeout
        .checked_sub(started.elapsed())
        .filter(|duration| !duration.is_zero())
        .ok_or(PrerequisiteError::Timeout)?;
    bounded_command(
        Command::new("/usr/bin/hdiutil")
            .args([
                "attach",
                "-readonly",
                "-nobrowse",
                "-noautoopen",
                "-mountpoint",
            ])
            .arg(&mount)
            .arg(archive),
        remaining.min(Duration::from_secs(90)),
    )?;
    struct Mounted(PathBuf);
    impl Drop for Mounted {
        fn drop(&mut self) {
            // Detachment is mandatory cleanup even after an expired deadline.
            // Its separate 30s ceiling avoids retaining mounted images.
            let _ = bounded_command(
                Command::new("/usr/bin/hdiutil")
                    .args(["detach", "-force"])
                    .arg(&self.0),
                Duration::from_secs(30),
            );
        }
    }
    let mounted = Mounted(mount);
    let result = operation(&mounted.0);
    drop(mounted);
    result
}

fn file_records(
    directory: &Path,
    started: Instant,
    timeout: Duration,
) -> Result<BTreeMap<String, FileRecord>> {
    no_links(directory)?;
    let canonical = io(directory.canonicalize())?;
    let mut files = BTreeMap::new();
    let mut pending = vec![PathBuf::new()];
    let mut entries = 0usize;
    let mut total = 0u64;
    while let Some(relative) = pending.pop() {
        deadline(started, timeout)?;
        let path = directory.join(&relative);
        for item in io(fs::read_dir(path))? {
            deadline(started, timeout)?;
            let item = io(item)?;
            entries += 1;
            if entries > MAX_ENTRIES {
                return Err(PrerequisiteError::Integrity);
            }
            let relative = relative.join(item.file_name());
            if relative == Path::new(RECEIPT) {
                continue;
            }
            safe_relative(relative.to_str().ok_or(PrerequisiteError::Integrity)?)?;
            let path = directory.join(&relative);
            let metadata = io(fs::symlink_metadata(&path))?;
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err(PrerequisiteError::Integrity);
                }
            }
            if metadata.is_dir() {
                pending.push(relative);
            } else {
                let name = relative
                    .to_str()
                    .ok_or(PrerequisiteError::Integrity)?
                    .replace('\\', "/");
                if metadata.file_type().is_symlink() {
                    let target = io(fs::read_link(&path))?;
                    contained_link(&relative, &target)?;
                    if !io(path.canonicalize())?.starts_with(&canonical) {
                        return Err(PrerequisiteError::Integrity);
                    }
                    files.insert(
                        name,
                        FileRecord {
                            bytes: 0,
                            sha256: String::new(),
                            link_target: Some(
                                target.to_str().ok_or(PrerequisiteError::Integrity)?.into(),
                            ),
                            executable: false,
                        },
                    );
                } else if metadata.is_file() {
                    total = total
                        .checked_add(metadata.len())
                        .ok_or(PrerequisiteError::Integrity)?;
                    if total > MAX_UNPACKED_BYTES {
                        return Err(PrerequisiteError::Integrity);
                    }
                    let (bytes, sha256) = hash_file(&path)?;
                    #[cfg(unix)]
                    let executable = {
                        use std::os::unix::fs::PermissionsExt;
                        metadata.permissions().mode() & 0o111 != 0
                    };
                    #[cfg(not(unix))]
                    let executable = false;
                    files.insert(
                        name,
                        FileRecord {
                            bytes,
                            sha256,
                            link_target: None,
                            executable,
                        },
                    );
                } else {
                    return Err(PrerequisiteError::Integrity);
                }
            }
        }
    }
    Ok(files)
}

fn native_probe(manifest: Manifest, directory: &Path, timeout: Duration) -> Result<()> {
    let executable = directory.join(manifest.executable);
    no_links(&executable)?;
    let mut command = Command::new(&executable);
    command.env_remove("PYTHONPATH").env_remove("PYTHONHOME");
    if manifest.id == "blender" {
        command.args([
            "--background",
            "--factory-startup",
            "--disable-autoexec",
            "--threads",
            "2",
            "--version",
        ]);
        let text = bounded_command(&mut command, timeout.min(Duration::from_secs(30)))?;
        if !String::from_utf8_lossy(&text)
            .lines()
            .any(|line| line.starts_with("Blender 5.2.1"))
        {
            return Err(PrerequisiteError::Probe);
        }
    } else {
        command.args(["-I", "-B", "-c", "import json,platform,struct,sys;print(json.dumps({'implementation':platform.python_implementation(),'version':list(sys.version_info[:3]),'platform':platform.system(),'machine':platform.machine(),'bits':struct.calcsize('P')*8}))"]);
        let value: serde_json::Value = serde_json::from_slice(&bounded_command(
            &mut command,
            timeout.min(Duration::from_secs(15)),
        )?)
        .map_err(|_| PrerequisiteError::Probe)?;
        if value["implementation"] != "CPython"
            || value["version"] != serde_json::json!([3, 9, 24])
            || value["platform"] != "Darwin"
            || value["machine"] != "arm64"
            || value["bits"] != 64
        {
            return Err(PrerequisiteError::Probe);
        }
    }
    Ok(())
}

/// Discovery never downloads or executes a runtime. Each published file and
/// internal symlink must still match the complete installation receipt.
pub fn discover(data: &Path, kind: Kind) -> Result<Option<PathBuf>> {
    let Some(manifest) = manifest(kind) else {
        return Ok(None);
    };
    let directory = root(data, false)?;
    if !directory.exists() {
        return Ok(None);
    }
    let started = Instant::now();
    let timeout = Duration::from_secs(300);
    let mut expected = None;
    let prefix = format!("{}-{}-", manifest.id, manifest.version);
    let mut candidates = Vec::new();
    for item in io(fs::read_dir(&directory))?.take(1024) {
        let item = io(item)?;
        let name = item.file_name().to_string_lossy().to_string();
        let Some(id) = name
            .strip_prefix(&prefix)
            .and_then(|value| Uuid::parse_str(value).ok())
        else {
            continue;
        };
        if name != format!("{prefix}{id}") {
            continue;
        }
        let folder = item.path();
        no_links(&folder)?;
        let receipt_path = folder.join(RECEIPT);
        no_links(&receipt_path)?;
        let mut input = io(File::open(receipt_path))?;
        if io(input.metadata())?.len() > 32 * 1024 * 1024 {
            return Err(PrerequisiteError::Integrity);
        }
        let mut bytes = Vec::new();
        io(std::io::Read::by_ref(&mut input)
            .take(32 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes))?;
        let receipt: InstallReceipt =
            serde_json::from_slice(&bytes).map_err(|_| PrerequisiteError::Integrity)?;
        if expected.is_none() {
            expected = Some(expected_records(manifest, &directory, started, timeout)?);
        }
        if receipt.schema_version != 1
            || receipt.installation_id != id.to_string()
            || receipt.manifest
                != serde_json::to_value(manifest).map_err(|_| PrerequisiteError::Integrity)?
            || !receipt.native_probe_verified
            || Some(&receipt.files) != expected.as_ref()
            || receipt.files != file_records(&folder, started, timeout)?
        {
            return Err(PrerequisiteError::Integrity);
        }
        let executable = folder.join(manifest.executable);
        if !executable.is_file() {
            return Err(PrerequisiteError::Integrity);
        }
        candidates.push(executable);
    }
    candidates.sort();
    Ok(candidates.pop())
}

/// Prepares only a missing prerequisite, to a new versioned private directory.
/// Complete original installs and interrupted stages are never overwritten.
pub fn ensure(
    data: &Path,
    kind: Kind,
    consent: bool,
    timeout: Duration,
    mut progress: impl FnMut(Progress),
) -> Result<PathBuf> {
    if let Some(path) = discover(data, kind)? {
        return Ok(path);
    }
    if !consent {
        return Err(PrerequisiteError::ConsentRequired);
    }
    let manifest = manifest(kind).ok_or(PrerequisiteError::Unsupported)?;
    let started = Instant::now();
    let directory = root(data, true)?;
    let _owner = lock(&directory)?;
    if let Some(path) = discover(data, kind)? {
        return Ok(path);
    }
    let id = Uuid::new_v4();
    let staged = directory.join(format!(".prepare-{id}"));
    io(fs::create_dir(&staged))?;
    let archive = download(manifest, &directory, started, timeout, &mut progress)?;
    progress(Progress {
        prerequisite: manifest.id.into(),
        stage: "extract",
        downloaded_bytes: manifest.bytes,
        total_bytes: manifest.bytes,
    });
    match manifest.package_format {
        "zip" => unpack_zip(&archive, &staged, started, timeout)?,
        "tar.gz" => unpack_tar(&archive, &staged, started, timeout)?,
        #[cfg(target_os = "macos")]
        "dmg" => with_dmg(&archive, &directory, started, timeout, |mount| {
            copy_bundle(mount, &staged, started, timeout)
        })?,
        _ => return Err(PrerequisiteError::Unsupported),
    }
    deadline(started, timeout)?;
    let before = file_records(&staged, started, timeout)?;
    if before.is_empty() || before != expected_records(manifest, &directory, started, timeout)? {
        return Err(PrerequisiteError::Integrity);
    }
    let remaining = timeout
        .checked_sub(started.elapsed())
        .filter(|duration| !duration.is_zero())
        .ok_or(PrerequisiteError::Timeout)?;
    native_probe(manifest, &staged, remaining)?;
    if file_records(&staged, started, timeout)? != before {
        return Err(PrerequisiteError::Integrity);
    }
    let receipt = InstallReceipt {
        schema_version: 1,
        installation_id: id.to_string(),
        manifest: serde_json::to_value(manifest).map_err(|_| PrerequisiteError::Integrity)?,
        files: before,
        native_probe_verified: true,
    };
    let mut output = io(OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(staged.join(RECEIPT)))?;
    io(output.write_all(
        &serde_json::to_vec_pretty(&receipt).map_err(|_| PrerequisiteError::Integrity)?,
    ))?;
    io(output.sync_all())?;
    drop(output);
    deadline(started, timeout)?;
    let complete = directory.join(format!("{}-{}-{id}", manifest.id, manifest.version));
    io(fs::rename(staged, &complete))?;
    let executable = discover(data, kind)?.ok_or(PrerequisiteError::Integrity)?;
    if executable != complete.join(manifest.executable) {
        return Err(PrerequisiteError::Integrity);
    }
    progress(Progress {
        prerequisite: manifest.id.into(),
        stage: "ready",
        downloaded_bytes: manifest.bytes,
        total_bytes: manifest.bytes,
    });
    Ok(executable)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("asset-prerequisite-test-{}", Uuid::new_v4()));
            fs::create_dir(&directory).unwrap();
            Self(directory)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn archive_paths_reject_traversal_streams_devices_and_ambiguous_names() {
        for path in [
            "../blender.exe",
            "/blender.exe",
            "C:/blender.exe",
            "bin/../blender.exe",
            "bin//blender.exe",
            "blender.exe:stream",
            "NUL.txt",
            "COM1",
            "a\\..\\b",
            "file.",
            "file ",
            "",
        ] {
            assert!(safe_relative(path).is_err(), "{path}");
        }
        assert!(safe_relative(
            "blender-5.2.1-windows-x64/5.2/datafiles/locale/en_US/LC_MESSAGES/blender.mo"
        )
        .is_ok());
    }

    #[test]
    fn internal_links_cannot_escape_the_owned_package() {
        assert!(contained_link(Path::new("python/bin/python3"), Path::new("python3.9")).is_ok());
        assert!(contained_link(
            Path::new("python/lib/libpython3.9.dylib"),
            Path::new("../bin/python3.9")
        )
        .is_ok());
        for target in [
            "../../../outside",
            "/usr/bin/python3",
            "../../../../outside",
        ] {
            assert!(contained_link(Path::new("python/bin/python3"), Path::new(target)).is_err());
        }
    }

    #[test]
    fn uncommitted_staging_folder_never_becomes_a_runtime() {
        if manifest(Kind::Blender).is_none() {
            return;
        }
        let temp = Scratch::new();
        let root = root(&temp.0, true).unwrap();
        let staged = root.join(format!(".prepare-{}", Uuid::new_v4()));
        fs::create_dir(&staged).unwrap();
        fs::write(staged.join("blender.exe"), b"not a runtime").unwrap();
        assert_eq!(discover(&temp.0, Kind::Blender).unwrap(), None);
        assert!(matches!(
            ensure(
                &temp.0,
                Kind::Blender,
                false,
                Duration::from_secs(1),
                |_| {}
            ),
            Err(PrerequisiteError::ConsentRequired)
        ));
        assert_eq!(
            fs::read(staged.join("blender.exe")).unwrap(),
            b"not a runtime"
        );
    }

    #[test]
    fn released_lock_can_be_reused_after_an_interrupted_owner() {
        let temp = Scratch::new();
        let root = root(&temp.0, true).unwrap();
        let first = lock(&root).unwrap();
        assert!(matches!(lock(&root), Err(PrerequisiteError::Busy)));
        drop(first);
        assert!(lock(&root).is_ok());
    }

    #[test]
    fn redirect_policy_only_accepts_compiled_https_origins() {
        for value in [
            "http://download.blender.org/release/x",
            "https://download.blender.org.attacker.test/x",
            "https://user:secret@github.com/x",
            "https://github.com:8080/x",
            "file:///tmp/python.tar.gz",
        ] {
            assert!(!approved_origin(&Url::parse(value).unwrap()));
        }
        assert!(approved_origin(&Url::parse(BLENDER_WINDOWS.url).unwrap()));
        assert!(approved_origin(&Url::parse(PYTHON_MAC.url).unwrap()));
    }

    #[test]
    fn zip_symlinks_and_parent_paths_do_not_extract_user_files() {
        use zip::{write::SimpleFileOptions, ZipWriter};
        let temp = Scratch::new();
        let archive = temp.0.join("unsafe.zip");
        let mut zip = ZipWriter::new(File::create(&archive).unwrap());
        zip.start_file("../original.txt", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"replace").unwrap();
        zip.finish().unwrap();
        let output = temp.0.join("output");
        fs::create_dir(&output).unwrap();
        fs::write(temp.0.join("original.txt"), b"preserve").unwrap();
        assert!(unpack_zip(&archive, &output, Instant::now(), Duration::from_secs(10)).is_err());
        assert_eq!(fs::read(temp.0.join("original.txt")).unwrap(), b"preserve");
    }

    #[test]
    fn forged_installed_hashes_cannot_replace_source_derived_file_tables() {
        use zip::{write::SimpleFileOptions, ZipWriter};
        let temp = Scratch::new();
        let archive = temp.0.join("source.zip");
        let mut zip = ZipWriter::new(File::create(&archive).unwrap());
        zip.start_file(
            "blender-5.2.1-windows-x64/blender.exe",
            SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(b"trusted upstream fixture").unwrap();
        zip.finish().unwrap();
        let output = temp.0.join("output");
        fs::create_dir(&output).unwrap();
        let started = Instant::now();
        let timeout = Duration::from_secs(10);
        unpack_zip(&archive, &output, started, timeout).unwrap();
        let expected = archive_records(BLENDER_WINDOWS, &archive, started, timeout).unwrap();
        assert_eq!(file_records(&output, started, timeout).unwrap(), expected);
        fs::write(
            output.join("blender-5.2.1-windows-x64/blender.exe"),
            b"edited runtime and forged receipt",
        )
        .unwrap();
        let forged = file_records(&output, started, timeout).unwrap();
        assert_ne!(forged, expected);
        fs::write(output.join(RECEIPT), serde_json::to_vec(&forged).unwrap()).unwrap();
        assert_ne!(file_records(&output, started, timeout).unwrap(), expected);
    }

    #[test]
    fn archive_derived_hashes_have_a_finite_read_deadline() {
        assert!(matches!(
            stream_record(&b"bytes"[..], 5, false, Instant::now(), Duration::ZERO),
            Err(PrerequisiteError::Timeout)
        ));
        assert!(matches!(
            stream_record(
                &b"too long"[..],
                3,
                false,
                Instant::now(),
                Duration::from_secs(1)
            ),
            Err(PrerequisiteError::Archive)
        ));
    }

    #[test]
    fn zip_case_collisions_are_rejected_on_windows_and_default_macos_filesystems() {
        use zip::{write::SimpleFileOptions, ZipWriter};
        let temp = Scratch::new();
        let archive = temp.0.join("collision.zip");
        let mut zip = ZipWriter::new(File::create(&archive).unwrap());
        for path in [
            "blender-5.2.1-windows-x64/Blender.exe",
            "blender-5.2.1-windows-x64/blender.exe",
        ] {
            zip.start_file(path, SimpleFileOptions::default()).unwrap();
            zip.write_all(b"runtime").unwrap();
        }
        zip.finish().unwrap();
        assert!(archive_records(
            BLENDER_WINDOWS,
            &archive,
            Instant::now(),
            Duration::from_secs(10)
        )
        .is_err());
    }
}
