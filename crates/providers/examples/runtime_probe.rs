//! Read-only handshake. Does not call thread/start or turn/start.
use asset_providers::runtime::{CodexRuntime, RuntimeOptions};
use std::path::PathBuf;
fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    let executable = args.get(1).map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from("C:/Users/PC/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe")
    });
    let output = args.get(2).map(PathBuf::from).unwrap_or_else(|| {
        std::env::current_dir()
            .unwrap()
            .join("tests/provider/runtime-artifacts")
    });
    match CodexRuntime::connect(RuntimeOptions::new(executable, output)) {
        Ok(actor) => println!("{}", serde_json::to_string_pretty(actor.status()).unwrap()),
        Err(error) => {
            eprintln!("{}: {}", error.code(), error);
            std::process::exit(1)
        }
    }
}
