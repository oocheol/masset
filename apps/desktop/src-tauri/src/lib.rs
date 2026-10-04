#[cfg(target_os = "macos")]
mod macos_update;
mod process_guard;
mod project_lease;
#[cfg(target_os = "macos")]
mod update_qa;
pub mod updater;
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
            && report["error"].is_null()
            && report["decodedImages"].as_u64().unwrap_or(0) >= 8
            && report["readability"]["guideOpened"] == true
            && report["readability"]["escapeRestoredFocus"] == true
            && report["appUpdater"]["supported"] == false
            && report["appUpdater"]["networkActions"] == 0
            && report["updateNetworkActions"] == 0
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
    if let Some(action) = request["action"]
        .as_str()
        .filter(|value| value.starts_with("update_"))
    {
        let updates = app.state::<updater::AppUpdater>().inner().clone();
        let result = match action {
            "update_status" => Ok(updates.status()),
            "update_check" => updates.check(&app).await,
            "update_install" => {
                updates
                    .install(
                        &app,
                        backend.inner(),
                        request["expectedVersion"]
                            .as_str()
                            .ok_or("업데이트 버전을 확인해 주세요.")?,
                        request["expectedSha256"]
                            .as_str()
                            .ok_or("업데이트 파일을 확인해 주세요.")?,
                    )
                    .await
            }
            _ => return Err("지원하지 않는 업데이트 명령입니다.".into()),
        };
        return result
            .map_err(|error| error.to_string())
            .and_then(|status| {
                serde_json::to_value(status).map_err(|_| "업데이트 상태를 읽지 못했습니다.".into())
            });
    }
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

fn native_qa_directory(args: &[String]) -> anyhow::Result<Option<std::path::PathBuf>> {
    let flags: Vec<_> = args
        .iter()
        .enumerate()
        .filter(|(_, arg)| arg.as_str() == "--ui-smoke" || arg.as_str() == "--ui-smoke-3d")
        .map(|(index, _)| index)
        .collect();
    anyhow::ensure!(flags.len() <= 1, "Use only one native UI QA mode");
    let Some(index) = flags.first() else {
        return Ok(None);
    };
    let directory = args
        .get(index + 1)
        .filter(|value| !value.is_empty() && !value.starts_with("--"))
        .ok_or_else(|| anyhow::anyhow!("Native UI QA requires a new output directory"))?;
    Ok(Some(directory.into()))
}

#[cfg(test)]
mod qa_arguments_tests {
    use super::native_qa_directory;
    #[test]
    fn incomplete_qa_mode_cannot_become_normal_app_mode() {
        for args in [
            vec!["app", "--ui-smoke"],
            vec!["app", "--ui-smoke-3d", "--with-native-model"],
            vec!["app", "--ui-smoke", ""],
            vec!["app", "--ui-smoke", "new", "--ui-smoke-3d", "other"],
        ] {
            assert!(
                native_qa_directory(&args.into_iter().map(String::from).collect::<Vec<_>>())
                    .is_err()
            );
        }
        assert!(native_qa_directory(&["app".into()]).unwrap().is_none());
        assert!(
            native_qa_directory(&["app".into(), "--ui-smoke".into(), "new".into()])
                .unwrap()
                .is_some()
        );
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            let qa_directory = native_qa_directory(&args)?;
            #[cfg(target_os = "macos")]
            let update_qa = update_qa::UpdateQa::from_args(&args)?;
            #[cfg(not(target_os = "macos"))]
            if args.iter().any(|arg| arg == "--update-smoke") { return Err("Update lifecycle QA is Mac-only".into()); }
            let data = if let Some(directory) = &qa_directory {
                if directory.exists() {
                    return Err("Native UI QA directory must be new".into());
                }
                std::fs::create_dir_all(directory)?;
                directory.join("app-data")
            } else {
                #[cfg(target_os = "macos")]
                { match &update_qa { Some(qa) => qa.root.join("app-data"), None => app.path().app_data_dir()? } }
                #[cfg(not(target_os = "macos"))]
                { app.path().app_data_dir()? }
            };
            let with_native_model = qa_directory.is_some() && args.iter().any(|arg| arg == "--ui-smoke-3d" || arg == "--with-native-model");
            let updates = updater::AppUpdater::new(app.package_info().version.to_string(), qa_directory.is_some());
            #[cfg(target_os = "macos")]
            let updates = match &update_qa { Some(qa) => qa.updater(app.package_info().version.to_string())?, None => updates };
            app.manage(updates);
            #[cfg(target_os = "macos")]
            app.manage(update_qa);
            app.manage(NativeQa(qa_directory, with_native_model));
            let backend = Backend::new(data, examples, worker);
            backend.start();
            app.manage(backend);
            Ok(())
        })
        .on_page_load(|webview, payload| {
            #[cfg(target_os = "macos")]
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let qa = webview.app_handle().state::<Option<update_qa::UpdateQa>>();
                if let Some(qa) = qa.as_ref() {
                    let parameters = serde_json::json!({"fromVersion":qa.from,"toVersion":qa.to});
                    let _ = webview.eval(format!("window.__ASSET_UPDATE_QA__={parameters};\n{}", include_str!("update_qa.js")));
                }
            }
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
            native_qa_complete,
            #[cfg(target_os = "macos")]
            update_qa::update_qa_checkpoint
        ])
        .build(tauri::generate_context!())
        .expect("Asset Studio native initialization failed");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            app.state::<Backend>().shutdown();
        }
    });
}
