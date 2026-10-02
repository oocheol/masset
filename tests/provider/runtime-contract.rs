//! Protocol fixtures only: these do not authenticate or call live generation.
use asset_providers::{
    runtime::{
        parse_usage, validate_native_request, write_image_artifact, ProviderEvent, RuntimeError,
    },
    ImageGenerationRequest, REQUESTED_IMAGE_MODEL,
};
use serde_json::json;
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

fn request() -> ImageGenerationRequest {
    ImageGenerationRequest {
        prompt: "A blue square".into(),
        requested_model: REQUESTED_IMAGE_MODEL.into(),
        reference_paths: vec![],
        width: None,
        height: None,
        transparent_background: None,
        mask_path: None,
        requires_confirmed_model: false,
    }
}

#[test]
fn native_model_and_unknown_actual_model_are_separate() {
    let mut r = request();
    assert!(validate_native_request(&r).is_ok());
    r.requires_confirmed_model = true;
    assert!(matches!(
        validate_native_request(&r),
        Err(RuntimeError::ActualModelUnconfirmed)
    ));
    r.requires_confirmed_model = false;
    r.requested_model = "gpt-image-2.5-sunburst".into();
    assert!(matches!(
        validate_native_request(&r),
        Err(RuntimeError::UnsupportedModel)
    ));
}

#[test]
fn missing_usage_is_unknown_and_multibucket_is_preserved() {
    let usage = parse_usage(
        &json!({"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":36,"windowDurationMins":300,"resetsAt":1234},"secondary":null},"images":{"primary":{},"secondary":null}}}),
    );
    assert_eq!(usage.len(), 2);
    assert_eq!(usage[0].primary.as_ref().unwrap().used_percent, Some(36.0));
    assert_eq!(usage[1].primary.as_ref().unwrap().used_percent, None);
    assert!(parse_usage(&json!({})).is_empty());
}

#[test]
fn image_event_does_not_accept_a_remote_url_or_untrusted_saved_path() {
    let root = std::env::temp_dir().join(format!(
        "masset-provider-contract-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    assert!(
        write_image_artifact(&json!({"result":"https://example.test/private.png"}), &root).is_err()
    );
    assert!(
        write_image_artifact(&json!({"result":"","savedPath":root.join("..")}), &root).is_err()
    );
    // PNG signature fixture verifies bounded receiving only. Full image decode
    // belongs to asset-pipeline; a signature alone is not success proof.
    let path = write_image_artifact(&json!({"result":"iVBORw0KGgo="}), &root).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"\x89PNG\r\n\x1a\n");
    fs::remove_file(path).unwrap();
    fs::remove_dir(root).unwrap();
}

#[test]
fn cancellation_acknowledgement_has_a_different_event_from_terminal_interruption() {
    let ack = serde_json::to_value(ProviderEvent::InterruptAcknowledged {
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
    })
    .unwrap();
    let end = serde_json::to_value(ProviderEvent::Interrupted {
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
    })
    .unwrap();
    assert_eq!(ack["type"], "interruptAcknowledged");
    assert_eq!(end["type"], "interrupted");
    assert_eq!(ack["threadId"], "thread-1");
}
