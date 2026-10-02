mod process_guard;
mod project_lease;
pub mod workbench;

use tauri::Manager;
use workbench::Backend;

struct NativeQa(Option<std::path::PathBuf>, bool);

#[tauri::command]
fn native_qa_complete(
    app: tauri::AppHandle,
    qa: tauri::State<'_, NativeQa>,
    backend: tauri::State<'_, Backend>,
    report: serde_json::Value,
) -> Result<(), String> {
    let directory = qa
        .inner()
        .0
        .as_ref()
        .ok_or("Native QA was not explicitly requested")?;
    let snapshot = backend.snapshot().map_err(|e| e.to_string())?;
    let assets = snapshot["project"]["assets"]
        .as_array()
        .ok_or("Native asset list missing")?;
    let fixture_count = assets
        .iter()
        .filter(|asset| {
            asset["versions"].as_array().is_some_and(|versions| {
                versions
                    .iter()
                    .any(|version| version["source"] == "fixture")
            })
        })
        .count();
    let models: Vec<_> = assets
        .iter()
        .filter(|asset| asset["kind"] == "model")
        .cloned()
        .collect();
    let model_count = models.len();
    let external_jobs = snapshot["project"]["jobs"]
        .as_array()
        .map(|jobs| {
            jobs.iter()
                .filter(|job| job["resource"] == "external")
                .count()
        })
        .unwrap_or(0);
    let result = serde_json::json!({"nativeWindow":true,"platform":std::env::consts::OS,"pid":std::process::id(),"webview":report,"assets":assets.len(),"fixtureAssets":fixture_count,"modelAssets":model_count,"models":models,"withNativeModel":qa.inner().1,"project":snapshot["root"],"providerLiveGeneration":external_jobs>0});
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join("native-window.json"))
        .map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(&result).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    backend.shutdown();
    app.exit(
        if report["domReady"] == true
            && report["decodedImages"].as_u64().unwrap_or(0) >= 8
            && report["externalProviderCalls"].as_u64().unwrap_or(1) == 0
            && external_jobs == 0
            && (!qa.inner().1
                || (report["native3D"]["passed"] == true
                    && fixture_count == 12
                    && model_count == 1))
        {
            0
        } else {
            1
        },
    );
    Ok(())
}

#[tauri::command]
async fn workspace_command(
    app: tauri::AppHandle,
    backend: tauri::State<'_, Backend>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let backend = backend.inner().clone();
    let backend_for_scope = backend.clone();
    let result = tauri::async_runtime::spawn_blocking(move || backend.request(request))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let scope_root = result
        .get("root")
        .and_then(serde_json::Value::as_str)
        .map(std::path::PathBuf::from)
        .or_else(|| backend_for_scope.current_root());
    if let Some(root) = scope_root {
        app.asset_protocol_scope()
            .allow_directory(root, true)
            .map_err(|e| e.to_string())?;
    }
    Ok(result)
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let resources = app.path().resource_dir()?;
            let examples = if resources.join("examples").is_dir() {
                resources.join("examples")
            } else {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/examples")
            };
            let worker = if resources.join("workers/blender/worker.py").is_file() {
                resources.join("workers/blender/worker.py")
            } else {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../workers/blender/worker.py")
            };
            let args: Vec<String> = std::env::args().collect();
            let qa_directory = args
                .iter()
                .position(|arg| arg == "--ui-smoke" || arg == "--ui-smoke-3d")
                .and_then(|index| args.get(index + 1))
                .map(std::path::PathBuf::from);
            let data = if let Some(directory) = &qa_directory {
                if directory.exists() {
                    return Err("Native UI QA directory must be new".into());
                }
                std::fs::create_dir_all(directory)?;
                directory.join("app-data")
            } else {
                app.path().app_data_dir()?
            };
            let with_native_model = qa_directory.is_some() && args.iter().any(|arg| arg == "--ui-smoke-3d" || arg == "--with-native-model");
            app.manage(NativeQa(qa_directory, with_native_model));
            let backend = Backend::new(data, examples, worker);
            backend.start();
            app.manage(backend);
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                && webview.app_handle().state::<NativeQa>().inner().0.is_some()
            {
                let with_native_model = webview.app_handle().state::<NativeQa>().inner().1;
                let script = format!("window.__ASSET_NATIVE_QA__ = Object.freeze({{withNativeModel:{with_native_model}}});\n{}", include_str!("native_qa.js"));
                let _ = webview.eval(&script);
            }
        })
        .invoke_handler(tauri::generate_handler![
            workspace_command,
            native_qa_complete
        ])
        .build(tauri::generate_context!())
        .expect("Asset Studio native initialization failed");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            app.state::<Backend>().shutdown();
        }
    });
}
