//! Agent-facing CLI over the same native backend as the desktop.
//! A command owns its project until its workers exit; JSON is data, never code.
mod install;
mod jobs;
mod prepare;
mod production;
use crate::workbench::Backend;
use anyhow::{bail, Context, Result};
pub(crate) use install::install_default as install_codex_skill;
use jobs::wait;
use production::produce;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

const HELP: &str = "Asset Studio CLI\n\
  asset-cli doctor [--check-gpt] [--check-claude] [--data-dir PATH]\n\
  asset-cli prepare [--consent-downloads] [--needs-3d] [--login-if-needed] [--local-only] [--data-dir PATH]\n\
  asset-cli install-codex [--destination PATH]\n\
  asset-cli init --workspace PATH [--name NAME]\n\
  asset-cli command --workspace PATH --json FILE [--allow-gpt] [--allow-claude] [--timeout SECONDS]\n\
  asset-cli produce --game-root PATH --manifest FILE --request-id UUID --allow-gpt [--workspace PATH] [--timeout SECONDS]\n\
  asset-cli status --workspace PATH\n\
Options: --resources PATH for a development checkout/resource directory.\n\
Output is JSON Lines. Job commands wait for real files; no paid API fallback.\n\
Same request UUID resumes the same run; unknown GPT requests are never resent.\n\
--smoke remains the isolated native integration harness.";

#[derive(Default)]
struct Args {
    command: String,
    options: BTreeMap<String, String>,
}
impl Args {
    fn parse(args: &[String]) -> Result<Self> {
        let command = args.first().map(String::as_str).unwrap_or("--help");
        if ["--help", "-h", "help", "--version"].contains(&command) {
            return Ok(Self {
                command: command.into(),
                ..Self::default()
            });
        }
        if ![
            "doctor",
            "prepare",
            "install-codex",
            "init",
            "command",
            "produce",
            "status",
        ]
        .contains(&command)
        {
            bail!("Unknown command. Run asset-cli --help.");
        }
        let mut result = Self {
            command: command.into(),
            ..Self::default()
        };
        let flags = [
            "--allow-gpt",
            "--check-gpt",
            "--allow-claude",
            "--check-claude",
            "--consent-downloads",
            "--needs-3d",
            "--login-if-needed",
            "--local-only",
        ];
        let values = [
            "--workspace",
            "--resources",
            "--data-dir",
            "--destination",
            "--name",
            "--json",
            "--timeout",
            "--game-root",
            "--manifest",
            "--request-id",
        ];
        let mut i = 1;
        while i < args.len() {
            let key = &args[i];
            let value = if flags.contains(&key.as_str()) {
                "true".into()
            } else if values.contains(&key.as_str()) {
                i += 1;
                args.get(i)
                    .filter(|v| !v.starts_with("--"))
                    .context("Option requires a value")?
                    .clone()
            } else {
                bail!("Unknown CLI option: {key}");
            };
            if result.options.insert(key.clone(), value).is_some() {
                bail!("Duplicate CLI option: {key}");
            }
            i += 1;
        }
        Ok(result)
    }
    fn get(&self, key: &str) -> Option<&str> {
        self.options.get(key).map(String::as_str)
    }
    fn required(&self, key: &str) -> Result<&str> {
        self.get(key).with_context(|| format!("Missing {key}"))
    }
    fn path(&self, key: &str) -> Result<PathBuf> {
        absolute(self.required(key)?)
    }
    fn timeout(&self) -> Result<u64> {
        let value = self.get("--timeout").unwrap_or("86400").parse()?;
        if !(1..=86400).contains(&value) {
            bail!("Timeout must be 1..86400 seconds");
        }
        Ok(value)
    }
    fn allow_gpt(&self) -> Result<()> {
        if self.get("--allow-gpt") != Some("true") {
            bail!("GPT transmission requires --allow-gpt for the authorized brief and selected references.");
        }
        Ok(())
    }
    fn allow_claude(&self) -> Result<()> {
        if self.get("--allow-claude") != Some("true") {
            bail!("Claude text transmission requires --allow-claude and transmissionApproved:true in the JSON request. No paid API fallback.");
        }
        Ok(())
    }
}

fn absolute(text: &str) -> Result<PathBuf> {
    let p = PathBuf::from(text);
    if !p.is_absolute()
        || p.components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        bail!("Use an absolute path without '..'");
    }
    Ok(p)
}
fn read_json(path: &Path) -> Result<Value> {
    let f = fs::File::open(path)?;
    if f.metadata()?.len() > 1024 * 1024 {
        bail!("CLI JSON is limited to 1 MiB");
    }
    let mut bytes = Vec::new();
    f.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}
fn emit(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string(value)?);
    std::io::stdout().flush()?;
    Ok(())
}
fn identity(path: &Path) -> String {
    format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes()))
}
fn default_data() -> Result<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return Ok(
            PathBuf::from(std::env::var_os("HOME").context("HOME unavailable")?)
                .join("Library/Application Support/org.localassets.workbench"),
        );
    }
    #[cfg(windows)]
    {
        return Ok(
            PathBuf::from(std::env::var_os("APPDATA").context("APPDATA unavailable")?)
                .join("org.localassets.workbench"),
        );
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        bail!("Asset Studio CLI supports macOS and Windows only");
    }
}
fn resources(args: &Args) -> Result<PathBuf> {
    if let Some(value) = args.get("--resources") {
        let path = absolute(value)?;
        if path.join("workers/blender/worker.py").is_file() {
            return Ok(path);
        }
        bail!("Resource directory must contain workers/blender/worker.py");
    }
    let exe = std::env::current_exe()?;
    let dir = exe.parent().context("CLI executable directory missing")?;
    #[cfg(target_os = "macos")]
    if let Some(contents) = dir
        .parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "Contents"))
    {
        let path = contents.join("Resources");
        if path.join("workers/blender/worker.py").is_file() {
            return Ok(path);
        }
    }
    for path in [dir.to_owned(), dir.join("resources")] {
        if path.join("workers/blender/worker.py").is_file() {
            return Ok(path);
        }
    }
    // Development use is explicit; a relocated production binary cannot silently
    // execute workers from the build machine's compile-time checkout.
    bail!("Bundled resources missing. Use --resources with a checkout/resource directory.")
}
fn backend(args: &Args, workspace: Option<&Path>) -> Result<Backend> {
    let data = args
        .get("--data-dir")
        .map(absolute)
        .transpose()?
        .unwrap_or(default_data()?);
    let resource = resources(args)?;
    let session = data
        .join("cli/sessions")
        .join(workspace.map(identity).unwrap_or_else(|| "doctor".into()));
    let examples = if resource.join("examples").is_dir() {
        resource.join("examples")
    } else {
        resource.join("apps/desktop/public/examples")
    };
    Ok(Backend::with_runtime_data(
        session,
        examples,
        resource.join("workers/blender/worker.py"),
        data,
    ))
}
struct Owner(Backend);
impl Drop for Owner {
    fn drop(&mut self) {
        self.0.shutdown();
        let started = Instant::now();
        while !self.0.workers_idle() && started.elapsed() < Duration::from_secs(15) {
            thread::sleep(Duration::from_millis(50));
        }
    }
}
fn open_workspace(backend: &Backend, root: &Path, name: &str) -> Result<Value> {
    if root.join("project.sqlite").is_file() {
        backend.request(json!({"action":"open","root":root}))
    } else {
        backend.request(json!({"action":"create","root":root,"name":name}))
    }
}
fn is_gpt(action: &str) -> bool {
    matches!(
        action,
        "generate"
            | "plan_assets"
            | "generate_bundle"
            | "production_plan"
            | "production_start"
            | "production_retry"
            | "production_continue"
    )
}

pub fn run(values: &[String]) -> Result<()> {
    let args = Args::parse(values)?;
    let _ = args.timeout()?;
    match args.command.as_str() {
        "--help" | "-h" | "help" => {
            println!("{HELP}");
            return Ok(());
        }
        "--version" => {
            return emit(&json!({"version":env!("CARGO_PKG_VERSION"),"schemaVersion":1}));
        }
        "install-codex" => {
            return install::run(&args);
        }
        "prepare" => {
            return prepare::run(&args);
        }
        "status" => {
            return emit(&read_json(
                &args.path("--workspace")?.join("cli-status.json"),
            )?);
        }
        _ => {}
    }
    let workspace = if args.command == "produce" {
        let game = args.path("--game-root")?.canonicalize()?;
        Some(
            args.get("--workspace")
                .map(absolute)
                .transpose()?
                .unwrap_or(default_data()?.join("cli/workspaces").join(identity(&game))),
        )
    } else if args.command == "doctor" {
        None
    } else {
        Some(args.path("--workspace")?)
    };
    let owner = Owner(backend(&args, workspace.as_deref())?);
    let backend = &owner.0;
    if args.command == "doctor" {
        let mut value = json!({"type":"doctor","version":env!("CARGO_PKG_VERSION"),"environment":backend.request(json!({"action":"environment"}))?,"local3D":backend.request(json!({"action":"quality3d_status"}))?,"paidApiFallback":false,"gptChecked":false});
        if args.get("--check-gpt") == Some("true") {
            let connection = backend.request(json!({"action":"provider_status"}))?;
            value["gptChecked"] = json!(true);
            value["gpt"] = json!({"available":connection["available"],"authenticated":connection["authenticated"],"ready":connection["ready"],"reasoningModel":connection["reasoningModel"],"requestedModel":connection["requestedModel"],"confirmedModel":connection["confirmedModel"]});
        }
        if args.get("--check-claude") == Some("true") {
            value["claude"] = backend.request(json!({"action":"claude_status"}))?;
        }
        return emit(&value);
    }
    let root = workspace.as_ref().unwrap();
    let snapshot = open_workspace(
        backend,
        root,
        args.get("--name").unwrap_or("Codex game assets"),
    )?;
    if args.command == "init" {
        return emit(
            &json!({"type":"initialized","workspace":root,"projectId":snapshot["project"]["id"]}),
        );
    }
    if args.command == "produce" {
        return produce(&args, backend, root);
    }
    let request = read_json(&args.path("--json")?)?;
    let action = request["action"]
        .as_str()
        .context("JSON requires action")?
        .to_owned();
    let allowed = [
        "snapshot",
        "import",
        "update",
        "process",
        "material",
        "atlas",
        "sprites",
        "model",
        "quality3d",
        "quality3d_status",
        "quality3d_trellis_configure",
        "game_connect",
        "production_state",
        "production_verify",
        "production_manifest",
        "production_plan",
        "production_start",
        "production_review",
        "production_retry",
        "production_continue",
        "production_cancel",
        "generate",
        "plan_assets",
        "claude_status",
        "claude_plan",
        "claude_cancel",
        "generate_bundle",
        "export",
        "reuse",
        "rerun",
        "cancel",
        "job_events",
    ];
    if !allowed.contains(&action.as_str()) {
        bail!("Action is not exposed by the agent CLI");
    }
    if action == "claude_plan" {
        args.allow_claude()?;
    }
    if is_gpt(&action) {
        args.allow_gpt()?;
        let c = backend.request(json!({"action":"provider_status"}))?;
        if c["ready"] != true {
            bail!("Official GPT subscription/image tool unavailable. Run asset-cli prepare --consent-downloads --login-if-needed, then check doctor --check-gpt. No paid API fallback.");
        }
    }
    let before: Vec<String> = snapshot["project"]["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|j| j["id"].as_str().map(str::to_owned))
        .collect();
    let response = backend.request(request)?;
    let after = backend.snapshot()?;
    let ids: Vec<String> = after["project"]["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|j| j["id"].as_str())
        .filter(|id| !before.iter().any(|old| old == id))
        .map(str::to_owned)
        .collect();
    let job_action = matches!(
        action.as_str(),
        "process"
            | "material"
            | "atlas"
            | "sprites"
            | "model"
            | "quality3d"
            | "generate"
            | "generate_bundle"
            | "production_start"
            | "production_retry"
            | "production_continue"
            | "rerun"
    );
    if !job_action {
        return emit(&json!({"type":"result","workspace":root,"response":response}));
    }
    let tracked: Vec<String> = after["project"]["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|j| {
            ids.iter().any(|id| j["id"] == id.as_str())
                || ["ready", "pending", "running", "retry_wait"]
                    .contains(&j["status"].as_str().unwrap_or(""))
        })
        .filter_map(|j| j["id"].as_str().map(str::to_owned))
        .collect();
    backend.start();
    // Also drain existing work on explicit rerun/resume. Queued commands cannot
    // appear successful merely because admission has returned a snapshot.
    let result = wait(backend, root, args.timeout()?, None, &tracked)?;
    emit(
        &json!({"type":"result","workspace":root,"newJobIds":ids,"response":response,"snapshot":result}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_or_unknown_options_are_rejected() {
        for args in [
            vec!["doctor", "--check-gpt", "--check-gpt"],
            vec!["doctor", "--paid-api"],
            vec!["produce", "--manifest"],
        ] {
            assert!(Args::parse(&args.into_iter().map(str::to_owned).collect::<Vec<_>>()).is_err());
        }
    }
    #[test]
    fn gpt_transmission_requires_cli_authorization() {
        let args = Args::parse(&["produce".into()]).unwrap();
        assert!(args.allow_gpt().is_err());
        assert!(absolute("../game").is_err());
        assert!(absolute("/game/../other").is_err());
    }
    #[test]
    fn claude_transmission_is_separately_authorized() {
        let gpt_only = Args::parse(&["command".into(), "--allow-gpt".into()]).unwrap();
        assert!(gpt_only.allow_claude().is_err());
        let claude_only = Args::parse(&["command".into(), "--allow-claude".into()]).unwrap();
        assert!(claude_only.allow_claude().is_ok());
        assert!(claude_only.allow_gpt().is_err());
        assert!(!is_gpt("claude_plan"));
    }
}
