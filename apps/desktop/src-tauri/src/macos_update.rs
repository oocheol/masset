//! Validate the authenticated archive before the platform installer can move an app.
//! Keep a durable previous-app copy outside the install directory for recovery.
use anyhow::{ensure, Context, Result};
use flate2::read::GzDecoder;
use std::{
    collections::HashSet,
    ffi::CString,
    fs,
    io::Cursor,
    os::unix::ffi::OsStrExt,
    path::{Component, Path, PathBuf},
    process::Command,
};

const APP_NAME: &str = "Asset Studio.app";
const MAX_EXPANDED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 30_000;

pub fn installed_app() -> Result<PathBuf> {
    let executable = std::env::current_exe()?;
    let macos = executable
        .parent()
        .context("Missing executable directory")?;
    let contents = macos.parent().context("Missing app Contents")?;
    let app = contents.parent().context("Missing app bundle")?;
    ensure!(
        macos.file_name().is_some_and(|v| v == "MacOS")
            && contents.file_name().is_some_and(|v| v == "Contents")
            && app.extension().is_some_and(|v| v == "app"),
        "Mac 업데이트는 설치한 .app에서만 사용할 수 있습니다."
    );
    ensure!(
        !fs::symlink_metadata(app)?.file_type().is_symlink(),
        "앱 바로가기 대신 설치된 앱을 실행해 주세요."
    );
    Ok(app.to_path_buf())
}

fn command(exe: &str, args: &[&std::ffi::OsStr]) -> Result<String> {
    let result = Command::new(exe).args(args).output()?;
    ensure!(
        result.status.success(),
        "Mac 앱 검증 또는 복사에 실패했습니다 ({exe})."
    );
    Ok(String::from_utf8_lossy(&result.stdout).trim().into())
}

fn verify_app(app: &Path, version: &str) -> Result<()> {
    let plist = app.join("Contents/Info.plist");
    let value = |field: &str| {
        command(
            "/usr/libexec/PlistBuddy",
            &["-c".as_ref(), field.as_ref(), plist.as_os_str()],
        )
    };
    ensure!(
        value("Print :CFBundleIdentifier")? == "org.localassets.workbench",
        "업데이트 앱 식별자가 다릅니다."
    );
    ensure!(
        value("Print :CFBundleShortVersionString")? == version,
        "업데이트 앱 버전이 다릅니다."
    );
    let executable = value("Print :CFBundleExecutable")?;
    ensure!(
        !executable.is_empty()
            && !executable.contains(['/', '\\'])
            && executable != "."
            && executable != "..",
        "업데이트 실행 파일 경로가 잘못되었습니다."
    );
    let binary = app.join("Contents/MacOS").join(executable);
    ensure!(
        command("/usr/bin/lipo", &["-archs".as_ref(), binary.as_os_str()])? == "arm64",
        "Apple Silicon 업데이트 파일이 아닙니다."
    );
    command(
        "/usr/bin/codesign",
        &[
            "--verify".as_ref(),
            "--deep".as_ref(),
            "--strict".as_ref(),
            app.as_os_str(),
        ],
    )?;
    Ok(())
}

fn copy_app(source: &Path, destination: &Path) -> Result<()> {
    command(
        "/usr/bin/ditto",
        &[
            "--noqtn".as_ref(),
            source.as_os_str(),
            destination.as_os_str(),
        ],
    )?;
    Ok(())
}

fn unpack(bytes: &[u8], output: &Path) -> Result<PathBuf> {
    let mut archive = tar::Archive::new(GzDecoder::new(Cursor::new(bytes)));
    archive.set_unpack_xattrs(false);
    let mut paths = HashSet::new();
    let mut total = 0_u64;
    for (index, entry) in archive.entries()?.enumerate() {
        ensure!(index < MAX_ENTRIES, "업데이트 압축 항목이 너무 많습니다.");
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        ensure!(
            path.components()
                .all(|part| matches!(part, Component::Normal(_)))
                && path
                    .components()
                    .next()
                    .is_some_and(|part| part.as_os_str() == APP_NAME),
            "업데이트 압축 경로가 잘못되었습니다."
        );
        ensure!(
            path.as_os_str().len() <= 2048 && paths.insert(path.clone()),
            "업데이트 압축 경로가 중복되거나 너무 깁니다."
        );
        let kind = entry.header().entry_type();
        ensure!(
            kind.is_file() || kind.is_dir(),
            "업데이트 압축에는 일반 파일과 디렉터리만 허용합니다."
        );
        total = total
            .checked_add(entry.size())
            .context("Archive size overflow")?;
        ensure!(
            total <= MAX_EXPANDED_BYTES,
            "업데이트 압축 해제 크기가 허용 범위를 넘습니다."
        );
        ensure!(
            entry.unpack_in(output)?,
            "업데이트 파일이 압축 해제 경로를 벗어납니다."
        );
    }
    let app = output.join(APP_NAME);
    ensure!(
        app.join("Contents/Info.plist").is_file(),
        "업데이트에 앱 번들이 없습니다."
    );
    Ok(app)
}

pub struct PreparedUpdate {
    app: PathBuf,
    directory: PathBuf,
    backup: PathBuf,
    old_version: String,
    new_version: String,
}

impl PreparedUpdate {
    pub fn prepare(bytes: &[u8], current: &str, next: &str, cache: &Path) -> Result<Self> {
        let app = installed_app()?;
        let parent = CString::new(
            app.parent()
                .context("Missing app parent")?
                .as_os_str()
                .as_bytes(),
        )?;
        ensure!(unsafe { libc::access(parent.as_ptr(), libc::W_OK) } == 0, "앱 설치 폴더에 쓰기 권한이 없습니다. 앱을 ~/Applications에 설치한 뒤 업데이트해 주세요.");
        let directory = cache
            .join("updates")
            .join(format!("{current}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory)?;
        let stage = directory.join("staged");
        fs::create_dir(&stage)?;
        verify_app(&unpack(bytes, &stage)?, next)?;
        let backup = directory.join(APP_NAME);
        copy_app(&app, &backup)?;
        verify_app(&backup, current)?;
        Ok(Self {
            app,
            directory,
            backup,
            old_version: current.into(),
            new_version: next.into(),
        })
    }

    pub fn verify_installed(&self) -> Result<()> {
        verify_app(&self.app, &self.new_version)
    }

    pub fn restore(&self) -> Result<()> {
        if verify_app(&self.app, &self.old_version).is_ok() {
            return Ok(());
        }
        let restored = self.directory.join("restored.app");
        copy_app(&self.backup, &restored)?;
        verify_app(&restored, &self.old_version)?;
        if self.app.exists() {
            fs::rename(&self.app, self.directory.join("failed-install.app"))?;
        }
        fs::rename(restored, &self.app)?;
        Ok(())
    }

    pub fn backup(&self) -> &Path {
        &self.backup
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn archive(path: &str, link: bool) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        {
            let mut tar = tar::Builder::new(&mut encoder);
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o644);
            if link {
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_link_name("/outside").unwrap();
                header.set_size(0);
                header.set_cksum();
                tar.append_data(&mut header, path, std::io::empty())
                    .unwrap();
            } else {
                header.set_size(4);
                header.set_cksum();
                tar.append_data(&mut header, path, Cursor::new(b"test"))
                    .unwrap();
            }
            tar.finish().unwrap();
        }
        encoder.flush().unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn rejects_non_app_archives_and_links_before_installing() {
        let root =
            std::env::temp_dir().join(format!("asset-update-archive-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        assert!(unpack(&archive("other.app/Contents/Info.plist", false), &root).is_err());
        assert!(unpack(
            &archive("Asset Studio.app/Contents/Info.plist", true),
            &root
        )
        .is_err());
        assert!(!root.join(APP_NAME).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn accepts_only_the_expected_app_tree() {
        let root =
            std::env::temp_dir().join(format!("asset-update-archive-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let app = unpack(
            &archive("Asset Studio.app/Contents/Info.plist", false),
            &root,
        )
        .unwrap();
        assert_eq!(fs::read(app.join("Contents/Info.plist")).unwrap(), b"test");
        fs::remove_dir_all(root).unwrap();
    }
}
