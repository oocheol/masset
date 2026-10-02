use std::fs::{self, File, Metadata, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};

const LOCK_FILE: &str = ".workbench.lock";

/// Exclusive ownership of a project until this value is dropped.
///
/// The file stays on disk permanently. Ownership comes from the OS lock, not
/// its contents or existence; closing the handle, including on process exit,
/// releases the lock without deleting or rewriting the file.
#[derive(Debug)]
pub struct ProjectLease {
    root: PathBuf,
    _file: File,
}

impl ProjectLease {
    /// Acquire a nonblocking, exclusive OS lock for an existing project root.
    pub fn acquire(root: &Path) -> io::Result<Self> {
        let absolute = if root.is_absolute() {
            root.to_owned()
        } else {
            std::env::current_dir()?.join(root)
        };
        reject_link_ancestors(&absolute)?;
        if !fs::symlink_metadata(&absolute)?.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "project root must be an existing directory",
            ));
        }
        let root = absolute.canonicalize()?;
        reject_link_ancestors(&root)?;
        let path = root.join(LOCK_FILE);
        let file = open_lock_file(&path)?;
        validate_open_file(&file, &path)?;

        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "이 프로젝트는 다른 앱 인스턴스에서 사용 중입니다.",
                ));
            }
            Err(TryLockError::Error(error)) => return Err(error),
        }

        // Reject a path replacement while acquiring the lock. On Windows the
        // handle also denies delete sharing, keeping this pathname in place.
        reject_link_ancestors(&root)?;
        if root.canonicalize()? != root {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "project root changed while acquiring its lock",
            ));
        }
        validate_open_file(&file, &path)?;
        Ok(Self { root, _file: file })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

fn lock_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ | FILE_SHARE_WRITE, intentionally no FILE_SHARE_DELETE.
        // OPEN_REPARSE_POINT opens a final link itself so metadata can reject it.
        options.share_mode(0x0000_0001 | 0x0000_0002);
        options.custom_flags(0x0020_0000);
    }
    options
}

fn open_lock_file(path: &Path) -> io::Result<File> {
    // Only create_new may create a lock file. An existing file is never
    // truncated, replaced or removed, even if lock acquisition later fails.
    for _ in 0..8 {
        let opened = match fs::symlink_metadata(path) {
            Ok(metadata) => {
                validate_lock_metadata(&metadata)?;
                lock_options().open(path)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                lock_options().create_new(true).open(path)
            }
            Err(error) => return Err(error),
        };
        match opened {
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::AlreadyExists | io::ErrorKind::NotFound
                ) => {}
            result => return result,
        }
    }
    Err(io::Error::new(
        io::ErrorKind::WouldBlock,
        "project lock path kept changing while opening it",
    ))
}

fn validate_lock_metadata(metadata: &Metadata) -> io::Result<()> {
    if is_link_or_reparse(metadata) || !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "project lock must be a regular file, without symlinks or reparse points",
        ));
    }
    Ok(())
}

fn validate_open_file(file: &File, path: &Path) -> io::Result<()> {
    let opened = file.metadata()?;
    let current = fs::symlink_metadata(path)?;
    validate_lock_metadata(&opened)?;
    validate_lock_metadata(&current)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.dev() != current.dev() || opened.ino() != current.ino() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "project lock file changed while opening it",
            ));
        }
    }
    Ok(())
}

fn reject_link_ancestors(path: &Path) -> io::Result<()> {
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)?;
        if is_link_or_reparse(&metadata) && !is_standard_system_alias(ancestor) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "project paths cannot contain symlinks or reparse points",
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x0000_0400 != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(target_os = "macos")]
fn is_standard_system_alias(path: &Path) -> bool {
    // Match Repository's narrow exception for macOS-owned /private aliases.
    // A link in a user project is never an allowed alias.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    struct TempProject {
        base: PathBuf,
        root: PathBuf,
    }

    impl TempProject {
        fn new() -> Self {
            let base = std::env::temp_dir().canonicalize().unwrap();
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            for _ in 0..8 {
                let serial = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
                let root = base.join(format!(
                    "asset studio 프로젝트 lease-{}-{timestamp}-{serial}",
                    std::process::id()
                ));
                match fs::create_dir(&root) {
                    Ok(()) => return Self { base, root },
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => panic!("cannot create lease test project: {error}"),
                }
            }
            panic!("could not reserve a unique lease test directory");
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            // Recursively clean only our own resolved, direct temp child.
            let Ok(metadata) = fs::symlink_metadata(&self.root) else {
                return;
            };
            if is_link_or_reparse(&metadata) {
                return;
            }
            let Ok(resolved) = self.root.canonicalize() else {
                return;
            };
            if resolved.parent() == Some(self.base.as_path())
                && resolved.file_name() == self.root.file_name()
            {
                let _ = fs::remove_dir_all(resolved);
            }
        }
    }

    #[test]
    fn an_independent_handle_is_excluded_until_drop() {
        let project = TempProject::new();
        let lease = ProjectLease::acquire(&project.root.join(".")).unwrap();
        assert_eq!(lease.root(), project.root.canonicalize().unwrap());
        let conflict = ProjectLease::acquire(&project.root).unwrap_err();
        assert_eq!(conflict.kind(), io::ErrorKind::WouldBlock);
        assert!(conflict.to_string().contains("다른 앱 인스턴스"));
        drop(lease);
        assert!(project.root.join(LOCK_FILE).is_file());
        let reacquired = ProjectLease::acquire(&project.root).unwrap();
        drop(reacquired);
        assert!(project.root.join(LOCK_FILE).is_file());
    }

    #[test]
    fn existing_lock_file_contents_are_preserved() {
        let project = TempProject::new();
        let path = project.root.join(LOCK_FILE);
        let bytes = b"existing lock marker\0must never be truncated";
        fs::write(&path, bytes).unwrap();
        let lease = ProjectLease::acquire(&project.root).unwrap();
        // Windows exclusive byte-range locks can prohibit reads through a
        // separate handle. Check length now and contents after releasing it.
        assert_eq!(fs::metadata(&path).unwrap().len(), bytes.len() as u64);
        assert_eq!(
            ProjectLease::acquire(&project.root).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        assert_eq!(fs::metadata(&path).unwrap().len(), bytes.len() as u64);
        drop(lease);
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[cfg(windows)]
    #[test]
    fn an_active_lease_denies_deleting_its_lock_file() {
        let project = TempProject::new();
        let path = project.root.join(LOCK_FILE);
        let lease = ProjectLease::acquire(&project.root).unwrap();
        assert!(fs::remove_file(&path).is_err());
        assert!(path.is_file());
        drop(lease);
        assert!(path.is_file());
    }

    #[test]
    fn a_directory_cannot_be_used_as_the_lock_file() {
        let project = TempProject::new();
        let path = project.root.join(LOCK_FILE);
        fs::create_dir(&path).unwrap();
        let error = ProjectLease::acquire(&project.root).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(path.is_dir());
    }

    #[test]
    fn missing_and_file_roots_are_rejected() {
        let project = TempProject::new();
        let missing = project.root.join("missing");
        assert_eq!(
            ProjectLease::acquire(&missing).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        let file = project.root.join("file");
        fs::write(&file, b"original").unwrap();
        assert_eq!(
            ProjectLease::acquire(&file).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(fs::read(&file).unwrap(), b"original");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_roots_and_lock_files_are_rejected() {
        use std::os::unix::fs::symlink;
        let project = TempProject::new();
        let foreign = TempProject::new();
        let linked_root = project.root.join("linked root");
        symlink(&foreign.root, &linked_root).unwrap();
        assert_eq!(
            ProjectLease::acquire(&linked_root).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        let original = foreign.root.join("original");
        fs::write(&original, b"preserved").unwrap();
        let lock = project.root.join(LOCK_FILE);
        symlink(&original, &lock).unwrap();
        assert_eq!(
            ProjectLease::acquire(&project.root).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(fs::read(&original).unwrap(), b"preserved");
        fs::remove_file(&lock).unwrap();
        symlink(foreign.root.join("missing"), &lock).unwrap();
        assert_eq!(
            ProjectLease::acquire(&project.root).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[cfg(windows)]
    #[test]
    fn junction_roots_are_rejected() {
        use std::os::windows::process::CommandExt;
        let project = TempProject::new();
        let foreign = TempProject::new();
        let junction = project.root.join("linked root");
        let result = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&foreign.root)
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "junction creation failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let error = ProjectLease::acquire(&junction).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        // Remove the test junction itself before recursive owned-directory cleanup.
        fs::remove_dir(&junction).unwrap();
        assert!(foreign.root.is_dir());
    }

    #[cfg(windows)]
    #[test]
    fn file_symlinks_are_rejected_when_windows_allows_creating_them() {
        use std::os::windows::fs::symlink_file;
        let project = TempProject::new();
        let foreign = TempProject::new();
        let original = foreign.root.join("original");
        fs::write(&original, b"preserved").unwrap();
        let lock = project.root.join(LOCK_FILE);
        match symlink_file(&original, &lock) {
            Ok(()) => {}
            Err(error) if error.raw_os_error() == Some(1314) => {
                eprintln!(
                    "SKIPPED_WINDOWS_FILE_SYMLINK: create-symbolic-link privilege is unavailable"
                );
                return;
            }
            Err(error) => panic!("cannot create lease test symlink: {error}"),
        }
        let error = ProjectLease::acquire(&project.root).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(fs::read(&original).unwrap(), b"preserved");
        fs::remove_file(&lock).unwrap();
    }
}
