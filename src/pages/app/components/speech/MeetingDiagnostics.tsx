import { useState } from "react";
import { Button } from "@/components";
import { copyMeetingDiagnosticReport } from "@/lib/meeting-diagnostics";

export function MeetingDiagnostics({
  errors,
  timings,
}: {
  errors: string[];
  timings: { sttMs?: number; firstTokenMs?: number; translationMs?: number };
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const seconds = (value?: number) =>
    value === undefined ? "—" : `${(value / 1_000).toFixed(1)}s`;
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">
        Meeting diagnostics
        {errors.length ? ` · ${errors.length} recent errors` : ""}
      </summary>
      <div className="space-y-2 py-2 select-text">
        <p>
          Last completed: STT {seconds(timings.sttMs)} · AI first text{" "}
          {seconds(timings.firstTokenMs)} · AI total{" "}
          {seconds(timings.translationMs)}
        </p>
        <p>
          Timings and error codes are saved locally in meeting.log. Copy
          includes the log location and recent events.
        </p>
        {errors.map((error, index) => (
          <p key={index} className="text-red-600">
            {error}
          </p>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            try {
              await copyMeetingDiagnosticReport();
              setCopyStatus("Copied");
            } catch {
              setCopyStatus("Could not copy diagnostics");
            }
          }}
        >
          Copy diagnostics
        </Button>
        {copyStatus && <span className="ml-2">{copyStatus}</span>}
      </div>
    </details>
  );
}
