use asset_providers::{capabilities, diagnostics, probe_codex};
use std::path::Path;

fn main() {
    let mut args = std::env::args().skip(1);
    let report = match args.next() {
        Some(path) => match probe_codex(Path::new(&path)) {
            Ok(probe) => {
                serde_json::json!({ "capabilities": capabilities(), "diagnostics": diagnostics(), "probe": probe })
            }
            Err(error) => {
                eprintln!("{}: {}", error.code(), error);
                std::process::exit(1);
            }
        },
        None => serde_json::json!({ "capabilities": capabilities(), "diagnostics": diagnostics() }),
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&report).expect("serializable provider report")
    );
}
