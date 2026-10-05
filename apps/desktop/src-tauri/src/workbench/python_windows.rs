//! Hash-pinned official CPython bootstrap for Windows machines without Python.
//! Preparation is reached only after the explicit model-download consent gate.
use super::*;
use std::io::{Read, Write};
use std::os::windows::fs::MetadataExt;
use std::os::windows::fs::OpenOptionsExt;

const VERSION: &str = "3.12.10";
const URL: &str = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip";
const BYTES: u64 = 11_133_606;
const SHA256: &str = "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3";
const PTH: &[u8] = b"python312.zip\r\n.\r\nimport site\r\n";

pub(super) fn vc_runtime_available() -> bool {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32/msvcp140.dll").is_file()
}

fn regular(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && m.file_attributes() & 0x400 == 0)
}

fn valid_archive(path: &Path) -> bool {
    regular(path) && asset_core::sha256_file(path).is_ok_and(|(hash, size)| hash == SHA256 && size == BYTES)
}

fn flat_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\', ':'])
        && !name.ends_with(['.', ' '])
        && Path::new(name).components().count() == 1
        && matches!(Path::new(name).components().next(), Some(std::path::Component::Normal(_)))
}

fn bootstrap_lock(path: &Path) -> Result<fs::File> {
    if path.exists() && !regular(path) { bail!("전용 Python 잠금 파일이 올바르지 않습니다."); }
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).truncate(false).share_mode(3).custom_flags(0x0020_0000);
    let mut file = if path.exists() { options.open(path)? } else { options.create_new(true).open(path)? };
    let meta = file.metadata()?;
    if !meta.is_file() || meta.file_attributes() & 0x400 != 0 { bail!("전용 Python 잠금 파일이 올바르지 않습니다."); }
    file.try_lock().map_err(|_| anyhow!("다른 앱이 전용 Python을 준비하고 있습니다."))?;
    file.set_len(0)?;
    write!(file, "{}", std::process::id())?;
    // Keep the OS-locked handle open through preparation. The file remains on
    // disk; even abrupt process termination releases ownership automatically.
    Ok(file)
}

pub(super) fn prepare(
    root: &Path,
    cancelled: impl Fn() -> bool,
    progress: impl Fn(&str, String),
) -> Result<(PathBuf, PathBuf)> {
    if !vc_runtime_available() {
        bail!("Microsoft Visual C++ 2015–2022 x64 런타임이 필요합니다. 공식 설치 안내에서 준비한 뒤 다시 시도해 주세요. 모델 다운로드는 시작하지 않았습니다.");
    }
    let marker = root.join(".asset-python.json");
    let expected = json!({"schemaVersion":1,"version":VERSION,"sha256":SHA256});
    if root.exists() {
        let meta = fs::symlink_metadata(root)?;
        if !meta.is_dir() || meta.file_attributes() & 0x400 != 0 {
            bail!("전용 Python 경로는 실제 폴더여야 합니다.");
        }
        if fs::read_dir(root)?.next().is_some() && !regular(&marker) {
            bail!("앱이 준비하지 않은 Python 폴더는 변경하지 않습니다.");
        }
    } else { fs::create_dir_all(root)?; }
    if marker.exists() {
        let value: Value = serde_json::from_slice(&fs::read(&marker)?)?;
        if value != expected { bail!("전용 Python 폴더의 버전이 일치하지 않습니다."); }
    } else {
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&marker)?;
        output.write_all(&serde_json::to_vec(&expected)?)?;
    }
    let lock_path = root.join(".bootstrap-lock");
    let _owned_lock = bootstrap_lock(&lock_path)?;
    let archive_path = root.join("python-3.12.10-embed-amd64.zip");
    if archive_path.exists() && !valid_archive(&archive_path) {
        bail!("Python 다운로드 파일의 SHA-256이 다릅니다. 기존 파일은 보존했습니다.");
    }
    if !archive_path.exists() {
        progress("python-download", "전용 Python 3.12.10을 공식 배포처에서 내려받습니다 (약 10.6MiB).".into());
        let client = reqwest::blocking::Client::builder().no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(90))
            .user_agent("AssetStudio-Image3D-Setup/1").build()?;
        let mut response = client.get(URL).send().context("공식 Python 다운로드에 연결하지 못했습니다.")?;
        if !response.status().is_success() { bail!("공식 Python 다운로드가 실패했습니다."); }
        if response.content_length().is_some_and(|length| length != BYTES) {
            bail!("공식 Python 다운로드 크기가 고정된 버전과 다릅니다.");
        }
        let partial = root.join(format!("python-download-{}.part", Uuid::new_v4()));
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&partial)?;
        let mut digest = Sha256::new();
        let mut size = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            if cancelled() { bail!("Python 준비를 취소했습니다. 내려받은 파일은 보존했습니다."); }
            let length = response.read(&mut buffer).context("Python 다운로드가 중단됐습니다.")?;
            if length == 0 { break; }
            size += length as u64;
            if size > BYTES { bail!("Python 다운로드가 고정된 크기를 초과했습니다."); }
            output.write_all(&buffer[..length])?;
            digest.update(&buffer[..length]);
        }
        output.sync_all()?;
        drop(output);
        if size != BYTES || format!("{:x}", digest.finalize()) != SHA256 {
            bail!("공식 Python 파일의 크기·SHA-256 검증이 실패했습니다.");
        }
        fs::rename(partial, &archive_path)?;
    }
    progress("python-verify", "검증한 Python을 앱 전용 폴더에 준비합니다. 시스템 Python은 변경하지 않습니다.".into());
    let mut archive = zip::ZipArchive::new(fs::File::open(&archive_path)?)?;
    if archive.len() > 256 { bail!("Python ZIP 항목 수가 제한을 초과했습니다."); }
    let mut total = 0u64;
    let mut names = std::collections::HashSet::new();
    for index in 0..archive.len() {
        if cancelled() { bail!("Python 준비를 취소했습니다."); }
        let mut entry = archive.by_index(index)?;
        let name = entry.name().to_owned();
        if !flat_name(&name) || !names.insert(name.to_ascii_lowercase()) || entry.is_dir()
            || entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000)
            || entry.size() > 50 * 1024 * 1024 {
            bail!("공식 Python ZIP에 허용되지 않은 항목이 있습니다.");
        }
        total += entry.size();
        if total > 100 * 1024 * 1024 { bail!("Python 압축 해제 크기가 제한을 초과했습니다."); }
        let mut contents = Vec::new();
        entry.read_to_end(&mut contents)?;
        if name == "python312._pth" { contents = PTH.to_vec(); }
        let path = root.join(&name);
        if path.exists() {
            if !regular(&path) || fs::read(&path)? != contents {
                bail!("전용 Python 파일이 변경됐습니다. 기존 파일은 보존했습니다.");
            }
        } else {
            let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
            output.write_all(&contents)?;
        }
    }
    if !["python.exe", "python312.dll", "python312.zip", "python312._pth"].iter().all(|name| names.contains(*name)) {
        bail!("전용 Python ZIP에 필수 실행 파일이 없습니다.");
    }
    for item in fs::read_dir(root)? {
        let name = item?.file_name().to_string_lossy().to_string();
        if !names.contains(&name.to_ascii_lowercase())
            && ![".asset-python.json", ".bootstrap-lock", "python-3.12.10-embed-amd64.zip"].contains(&name.as_str())
            && !(name.starts_with("python-download-") && name.ends_with(".part")) {
            bail!("전용 Python 폴더에 알 수 없는 파일이 있습니다.");
        }
    }
    Ok((root.join("python.exe"), archive_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_retained_bootstrap_lock_does_not_prevent_retry() {
        let directory = std::env::temp_dir().join(format!("asset-python-lock-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join(".bootstrap-lock");
        fs::write(&path, b"old terminated owner").unwrap();
        let owner = bootstrap_lock(&path).unwrap();
        assert!(bootstrap_lock(&path).is_err());
        drop(owner);
        let retry = bootstrap_lock(&path).unwrap();
        drop(retry);
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }
    #[test]
    fn archive_paths_cannot_escape_or_use_windows_streams() {
        for name in ["../python.exe", "..\\python.exe", "C:python.exe", "python.exe:stream", ".", "..", "python.exe.", "python.exe ", "a/b", ""] {
            assert!(!flat_name(name), "{name}");
        }
        assert!(flat_name("python312.dll"));
    }
    #[test]
    fn preparation_preserves_an_unmanaged_folder_without_network_access() {
        let root = std::env::temp_dir().join(format!("asset-python-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("original.txt"), b"keep").unwrap();
        assert!(prepare(&root, || false, |_, _| {}).is_err());
        assert_eq!(fs::read(root.join("original.txt")).unwrap(), b"keep");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_file(root.join("original.txt")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
