//! Optional text planning. Only the explicitly supplied brief is transmitted.
use super::*;
use asset_providers::claude::{
    probe_claude, run_claude_brief, ClaudeBriefOptions, ClaudeBriefRequest,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanCommand {
    action: String,
    brief: String,
    art_direction: String,
    asset_count: usize,
    transmission_approved: bool,
}

struct ActivePlan<'a>(&'a Mutex<Option<Arc<AtomicBool>>>);
impl Drop for ActivePlan<'_> {
    fn drop(&mut self) {
        self.0.lock().unwrap().take();
    }
}

impl Backend {
    fn claude_options(&self) -> Result<ClaudeBriefOptions> {
        let work_dir = self.inner.data.join("claude-brief-runtime");
        fs::create_dir_all(&work_dir)?;
        ClaudeBriefOptions::discover(&work_dir)
            .map_err(|error| anyhow!("{} ({})", error, error.code()))
    }

    pub(super) fn claude_request(&self, request: &Value) -> Result<Value> {
        let action = text_field(request, "action")?;
        if self.inner.stop.load(Ordering::SeqCst) {
            bail!("작업 백엔드가 종료되었습니다.");
        }
        match action {
            "claude_cancel" => {
                let active = self.inner.claude_cancel.lock().unwrap();
                if let Some(cancel) = active.as_ref() {
                    cancel.store(true, Ordering::SeqCst);
                }
                Ok(json!({"cancelRequested":active.is_some(),"automaticRetry":false}))
            }
            "claude_status" => {
                let status = self.claude_options().and_then(|options| {
                    probe_claude(&options, &self.inner.stop)
                        .map_err(|error| anyhow!("{} ({})", error, error.code()))
                });
                match status {
                    Ok(status) => Ok(serde_json::to_value(status)?),
                    Err(error) => Ok(json!({
                        "provider":"claude-code", "cliVersion":null,
                        "authentication":"unavailable", "planningAvailable":false,
                        "generationAttempted":false, "reason":error.to_string(),
                    })),
                }
            }
            "claude_plan" => {
                let command: PlanCommand = serde_json::from_value(request.clone())
                    .map_err(|_| anyhow!("Claude 계획 요청 형식을 확인해 주세요."))?;
                if command.action != "claude_plan" || !command.transmission_approved {
                    bail!("입력한 게임 설명과 아트 방향을 Claude에 전송하려면 먼저 승인해 주세요. (claude.transmission_not_approved)");
                }
                let cancel = Arc::new(AtomicBool::new(false));
                {
                    let mut active = self.inner.claude_cancel.lock().unwrap();
                    if self.inner.stop.load(Ordering::SeqCst) {
                        bail!("작업 백엔드가 종료되었습니다.");
                    }
                    if active.is_some() {
                        bail!("Claude 계획 요청이 이미 실행 중입니다. 기존 요청을 완료하거나 취소해 주세요.");
                    }
                    *active = Some(cancel.clone());
                }
                let _active = ActivePlan(&self.inner.claude_cancel);
                let options = self.claude_options()?;
                let input = ClaudeBriefRequest {
                    brief: command.brief,
                    art_direction: command.art_direction,
                    asset_count: command.asset_count,
                };
                let result = run_claude_brief(&options, &input, &cancel)
                    .map_err(|error| anyhow!("{} ({})", error, error.code()))?;
                Ok(serde_json::to_value(result)?)
            }
            _ => bail!("지원하지 않는 Claude 작업입니다."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_is_required_before_any_claude_discovery() {
        let request = json!({"action":"claude_plan", "brief":"game", "artDirection":"low-poly", "assetCount":3, "transmissionApproved":false});
        let backend = Backend::new(PathBuf::new(), PathBuf::new(), PathBuf::new());
        let error = backend.request(request).unwrap_err().to_string();
        assert!(error.contains("claude.transmission_not_approved"));
        assert!(backend.inner.claude_cancel.lock().unwrap().is_none());
    }

    #[test]
    fn planning_does_not_accept_project_paths_or_references() {
        let request = json!({"action":"claude_plan", "brief":"game", "artDirection":"low-poly", "assetCount":3, "transmissionApproved":true, "referencePaths":["private.png"]});
        assert!(serde_json::from_value::<PlanCommand>(request).is_err());
    }

    #[test]
    fn idle_cancel_cannot_mark_a_future_request_cancelled() {
        let backend = Backend::new(PathBuf::new(), PathBuf::new(), PathBuf::new());
        let result = backend.request(json!({"action":"claude_cancel"})).unwrap();
        assert_eq!(result["cancelRequested"], false);
        assert_eq!(result["automaticRetry"], false);
        assert!(backend.inner.claude_cancel.lock().unwrap().is_none());
    }
}
