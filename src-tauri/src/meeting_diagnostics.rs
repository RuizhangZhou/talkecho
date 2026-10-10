use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::Mutex;
use tauri::Manager;

static LOG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Stt,
    Translation,
    Pipeline,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Event {
    Start,
    Complete,
    FirstToken,
    Retry,
    Failure,
    Snapshot,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    Cancelled,
    Timeout,
    Network,
    RateLimit,
    Provider,
    Authentication,
    ContextLimit,
    InvalidRequest,
    MalformedResponse,
    Unknown,
}

// There is intentionally no arbitrary message/body field in this schema.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeetingDiagnostic {
    at: u64,
    stage: Stage,
    event: Event,
    provider: Option<String>,
    model: Option<String>,
    duration_ms: Option<u64>,
    queue_wait_ms: Option<u64>,
    input_tokens: Option<u64>,
    output_characters: Option<u64>,
    audio_bytes: Option<u64>,
    audio_duration_ms: Option<u64>,
    transcript_tokens: Option<u64>,
    attempt: Option<u32>,
    segments: Option<u64>,
    kind: Option<FailureKind>,
    status: Option<u16>,
}

#[tauri::command]
pub fn get_meeting_diagnostics_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(app
        .path()
        .app_log_dir()
        .map_err(|_| "Log directory unavailable")?
        .join("meeting.log")
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
pub async fn write_meeting_diagnostic(
    app: tauri::AppHandle,
    record: MeetingDiagnostic,
) -> Result<(), String> {
    let path = get_meeting_diagnostics_path(app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if record
            .provider
            .as_ref()
            .is_some_and(|value| value.len() > 128)
            || record.model.as_ref().is_some_and(|value| value.len() > 128)
        {
            return Err("Diagnostic identifier too long".to_string());
        }
        let _guard = LOG_LOCK.lock().map_err(|_| "Log lock unavailable")?;
        let path = std::path::PathBuf::from(path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "Cannot create log directory")?;
        }
        if std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 1_048_576) {
            let backup = path.with_file_name("meeting.previous.log");
            if backup.exists() {
                std::fs::remove_file(&backup).map_err(|_| "Cannot rotate log")?;
            }
            std::fs::rename(&path, backup).map_err(|_| "Cannot rotate log")?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|_| "Cannot open meeting log")?;
        let line = serde_json::to_string(&record).map_err(|_| "Cannot encode diagnostic")?;
        writeln!(file, "{line}").map_err(|_| "Cannot write meeting log".to_string())
    })
    .await
    .map_err(|_| "Diagnostic writer failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_freeform_diagnostic_content() {
        let value = serde_json::json!({ "at": 1, "stage": "stt", "event": "failure", "transcript": "private" });
        assert!(serde_json::from_value::<MeetingDiagnostic>(value).is_err());
    }
}
