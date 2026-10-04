//! Explicit lifecycle QA, restricted to a disposable app copy and isolated data.
use crate::{macos_update, updater::AppUpdater, workbench::Backend};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{fs, io::Write, path::PathBuf};
use tauri::Manager;

pub struct UpdateQa {
    pub root: PathBuf,
    pub from: String,
    pub to: String,
    pub endpoint: String,
}

impl UpdateQa {
    pub fn from_args(args: &[String]) -> Result<Option<Self>> {
        let flags: Vec<_> = args
            .iter()
            .enumerate()
            .filter(|(_, arg)| *arg == "--update-smoke")
            .collect();
        ensure!(flags.len() <= 1, "Use only one update lifecycle QA mode");
        let Some((index, _)) = flags.first() else {
            return Ok(None);
        };
        ensure!(
            !args.iter().any(|arg| arg.starts_with("--ui-smoke")),
            "QA modes cannot be combined"
        );
        let root = PathBuf::from(
            args.get(index + 1)
                .filter(|v| !v.starts_with("--"))
                .context("Update QA directory required")?,
        )
        .canonicalize()?;
        let marker = root.join(".asset-studio-update-qa.json");
        ensure!(
            !fs::symlink_metadata(&marker)?.file_type().is_symlink(),
            "QA marker must be a regular file"
        );
        let value: Value = serde_json::from_slice(&fs::read(marker)?)?;
        ensure!(
            value["kind"] == "disposable-native-update-copy",
            "QA ownership marker missing"
        );
        ensure!(
            macos_update::installed_app()?.canonicalize()?
                == root.join("installed/Asset Studio.app").canonicalize()?,
            "Update QA may only replace its disposable app copy"
        );
        let from = value["fromVersion"]
            .as_str()
            .context("QA starting version missing")?
            .to_owned();
        let to = value["toVersion"]
            .as_str()
            .context("QA target version missing")?
            .to_owned();
        let old = semver::Version::parse(&from)?;
        let new = semver::Version::parse(&to)?;
        ensure!(
            new > old && new.pre.is_empty() && new.build.is_empty(),
            "QA target must be a newer stable version"
        );
        Ok(Some(Self {
            root,
            from,
            endpoint: format!(
                "https://github.com/oocheol/masset/releases/download/v{to}/latest-macos.json"
            ),
            to,
        }))
    }
    pub fn updater(&self, current: String) -> Result<AppUpdater> {
        ensure!(
            current == self.from || current == self.to,
            "Unexpected QA app version"
        );
        AppUpdater::for_update_qa(current, self.endpoint.clone(), self.root.join("cache"))
    }
}

fn write_new(path: PathBuf, value: &Value) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.sync_all()?;
    Ok(())
}

#[tauri::command]
pub fn update_qa_checkpoint(
    app: tauri::AppHandle,
    phase: String,
    report: Value,
) -> Result<(), String> {
    let result = (|| -> Result<()> {
        let qa = app.state::<Option<UpdateQa>>();
        let qa = qa
            .as_ref()
            .context("Update lifecycle QA was not requested")?;
        let backend = app.state::<Backend>();
        let snapshot = backend.snapshot()?;
        let project_root = PathBuf::from(snapshot["root"].as_str().context("QA project missing")?)
            .canonicalize()?;
        ensure!(
            project_root.starts_with(qa.root.join("app-data")),
            "QA project escaped isolated data"
        );
        let assets = snapshot["project"]["assets"]
            .as_array()
            .context("QA assets missing")?;
        ensure!(
            assets.len() == 12,
            "QA expects 12 actual local fixture assets"
        );
        ensure!(
            snapshot["project"]["jobs"]
                .as_array()
                .context("QA jobs missing")?
                .is_empty(),
            "QA must not request provider jobs"
        );
        let mut files = serde_json::Map::new();
        for asset in assets {
            for version in asset["versions"]
                .as_array()
                .context("QA versions missing")?
            {
                for artifact in version["artifacts"]
                    .as_array()
                    .context("QA artifacts missing")?
                {
                    let relative = artifact["path"]
                        .as_str()
                        .context("QA artifact path missing")?;
                    let path = project_root.join(relative).canonicalize()?;
                    ensure!(
                        path.starts_with(&project_root),
                        "QA artifact outside project"
                    );
                    let (hash, bytes) = asset_core::sha256_file(&path)?;
                    files.insert(relative.into(), json!({"sha256":hash,"bytes":bytes}));
                }
            }
        }
        let version = app.package_info().version.to_string();
        let updater = app.state::<AppUpdater>().status();
        let result = json!({"nativeWindow":true,"platform":"macos-arm64","pid":std::process::id(),"version":version,
            "app":macos_update::installed_app()?,"projectRoot":project_root,"project":snapshot["project"],"files":files,"webview":report,"updater":updater});
        match phase.as_str() {
            "before" => {
                ensure!(
                    version == qa.from
                        && updater.state == "available"
                        && updater.latest_version.as_deref() == Some(&qa.to),
                    "QA update not available"
                );
                ensure!(
                    report["installDisabledBeforeApproval"] == true
                        && report["installEnabledAfterApproval"] == true,
                    "QA approval UI did not gate installation"
                );
                write_new(qa.root.join("before.json"), &result)?;
            }
            "after" => {
                ensure!(
                    version == qa.to && report["decodedImages"].as_u64().unwrap_or(0) >= 8,
                    "QA new app did not render assets"
                );
                let before: Value =
                    serde_json::from_slice(&fs::read(qa.root.join("before.json"))?)?;
                ensure!(before["pid"] != result["pid"], "QA app did not restart");
                ensure!(
                    before["projectRoot"] == result["projectRoot"]
                        && before["project"] == result["project"]
                        && before["files"] == result["files"],
                    "QA project, versions or original files changed"
                );
                write_new(qa.root.join("after.json"), &result)?;
                backend.shutdown();
                app.exit(0);
            }
            "error" => {
                write_new(qa.root.join("error.json"), &result)?;
                backend.shutdown();
                app.exit(1);
            }
            _ => anyhow::bail!("Unknown update QA phase"),
        }
        Ok(())
    })();
    result.map_err(|error| error.to_string())
}
