import { invoke } from "@tauri-apps/api/core";
import {
  normalizeRequestFailure,
  RequestFailureKind,
} from "./functions/request-resilience";

export interface MeetingDiagnostic {
  at: number;
  stage: "stt" | "translation" | "pipeline";
  event:
    | "start"
    | "complete"
    | "first_token"
    | "retry"
    | "failure"
    | "snapshot";
  provider?: string;
  model?: string;
  durationMs?: number;
  queueWaitMs?: number;
  inputTokens?: number;
  outputCharacters?: number;
  audioBytes?: number;
  audioDurationMs?: number;
  transcriptTokens?: number;
  attempt?: number;
  segments?: number;
  kind?: RequestFailureKind;
  status?: number;
}

const recent: MeetingDiagnostic[] = [];
export function recordMeetingDiagnostic(
  record: Omit<MeetingDiagnostic, "at">,
): void {
  const entry = { ...record, at: Date.now() };
  recent.push(entry);
  if (recent.length > 200) recent.shift();
  // Native serialization accepts only typed metadata. No provider response or transcript.
  void invoke("write_meeting_diagnostic", { record: entry }).catch(() => {});
}

export function meetingFailureLabel(
  stage: "stt" | "translation",
  error: unknown,
): string {
  const failure = normalizeRequestFailure(error);
  const name = stage === "stt" ? "Transcription" : "Translation";
  return `${name}: ${failure.kind}${failure.status ? ` (HTTP ${failure.status})` : ""}. ${
    stage === "translation"
      ? "Transcript retained in history."
      : "This audio segment was not transcribed."
  }`;
}

export async function copyMeetingDiagnosticReport(): Promise<void> {
  const logPath = await invoke<string>("get_meeting_diagnostics_path").catch(
    () => "Unavailable",
  );
  const version = await invoke<string>("get_app_version").catch(
    () => "Unknown",
  );
  await navigator.clipboard.writeText(
    JSON.stringify({ version, logPath, events: recent }, null, 2),
  );
}
