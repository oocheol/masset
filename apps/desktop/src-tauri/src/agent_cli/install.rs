use super::*;

const FILES: [&str; 8] = [
    "SKILL.md",
    "agents/openai.yaml",
    "references/cli.md",
    "references/manifest.json",
    "references/native-runtime.json",
    "scripts/bootstrap.py",
    "scripts/bootstrap.ps1",
    "scripts/bootstrap.sh",
];
fn home() -> Result<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .context("Home directory unavailable")
}
fn no_links(path: &Path) -> Result<()> {
    let mut part = PathBuf::new();
    for c in path.components() {
        part.push(c);
        if let Ok(m) = fs::symlink_metadata(&part) {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if m.file_attributes() & 0x400 != 0 {
                    bail!("Skill install path cannot contain reparse points");
                }
            }
            if m.file_type().is_symlink() {
                bail!("Skill install path cannot contain symbolic links");
            }
        }
    }
    Ok(())
}
pub(super) fn run(args: &Args) -> Result<()> {
    let source = resources(args)?;
    let destination = args
        .get("--destination")
        .map(absolute)
        .transpose()?
        .unwrap_or(home()?.join(".agents/skills/asset-studio"));
    let data = args
        .get("--data-dir")
        .map(absolute)
        .transpose()?
        .unwrap_or(default_data()?);
    emit(&install(
        &source,
        &data,
        &destination,
        &std::env::current_exe()?,
    )?)
}
pub(crate) fn install(
    resource: &Path,
    data: &Path,
    destination: &Path,
    cli: &Path,
) -> Result<Value> {
    no_links(destination)?;
    let source = resource.join("integrations/codex/skills/asset-studio");
    let mut files = BTreeMap::new();
    for name in FILES {
        let path = source.join(name);
        no_links(&path)?;
        let bytes = fs::read(&path)?;
        if bytes.len() > 128 * 1024 {
            bail!("Skill resource too large");
        }
        files.insert(
            name.to_owned(),
            (bytes.clone(), format!("{:x}", Sha256::digest(&bytes))),
        );
    }
    let metadata = json!({"format":"asset-studio-codex-skill","version":env!("CARGO_PKG_VERSION"),"cliPath":cli,"files":files.iter().map(|(name,(_,hash))|(name.clone(),hash.clone())).collect::<BTreeMap<_,_>>()});
    let parent = destination
        .parent()
        .context("Skill destination parent missing")?;
    fs::create_dir_all(parent)?;
    let mut backup = None;
    if destination.exists() {
        let marker = read_json(&destination.join("installation.json")).context(
            "Existing skill is not managed by Asset Studio; preserved without overwrite",
        )?;
        if marker["format"] != "asset-studio-codex-skill" {
            bail!("Existing skill is not managed by Asset Studio");
        }
        let prior = marker["files"].as_object().context("Managed skill inventory missing")?;
        if prior.is_empty() || prior.keys().any(|name| !FILES.contains(&name.as_str())) {
            bail!("Managed skill inventory is invalid; existing files preserved");
        }
        // Verify the previous inventory, including the four-file 0.1.10 layout.
        for name in prior.keys() {
            no_links(&destination.join(name))?;
            let hash = format!("{:x}", Sha256::digest(fs::read(destination.join(name))?));
            if prior[name] != hash {
                bail!("Existing skill was edited; preserved without overwrite");
            }
        }
        if marker == metadata {
            return Ok(
                json!({"installed":true,"unchanged":true,"skillPath":destination,"cliPath":cli,"reloadRequired":true}),
            );
        }
        let path = data
            .join("cli/skill-backups")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(path.parent().unwrap())?;
        backup = Some(path);
    }
    let staged = parent.join(format!(".asset-studio-install-{}", Uuid::new_v4()));
    fs::create_dir(&staged)?;
    for (name, (bytes, _)) in files {
        let path = staged.join(name);
        fs::create_dir_all(path.parent().unwrap())?;
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?
            .write_all(&bytes)?;
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(staged.join("installation.json"))?
        .write_all(&serde_json::to_vec_pretty(&metadata)?)?;
    if let Some(path) = &backup {
        fs::rename(destination, path)?;
    }
    if let Err(error) = fs::rename(&staged, destination) {
        if let Some(path) = &backup {
            fs::rename(path, destination)?;
        }
        return Err(error.into());
    }
    Ok(
        json!({"installed":true,"unchanged":false,"skillPath":destination,"cliPath":cli,"backup":backup,"reloadRequired":true,"publicPluginPublished":false}),
    )
}
pub(crate) fn install_default(resource: &Path, data: &Path, cli: &Path) -> Result<Value> {
    install(
        resource,
        data,
        &home()?.join(".agents/skills/asset-studio"),
        cli,
    )
}
