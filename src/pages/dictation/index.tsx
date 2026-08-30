import { Check, Copy, Loader2, Mic, TriangleAlert, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useDictation } from "@/hooks";
import { useCopyToClipboard } from "@/hooks";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<string, string> = {
  idle: "Press Right Ctrl to dictate",
  recording: "Listening… press Right Ctrl to stop",
  transcribing: "Transcribing…",
  cleaning: "Cleaning up…",
  done: "Done",
  error: "Something went wrong",
};

/**
 * Small always-on-top floating window for the "press Right Ctrl" dictation
 * flow. Shows live status while recording, then the cleaned transcript with
 * a copy button — direct injection into the focused field happens silently
 * via Rust, this UI is the fallback/confirmation surface.
 */
const Dictation = () => {
  const { status, resultText, errorText, injected } = useDictation();
  const { isCopied, handleCopy } = useCopyToClipboard({ text: resultText });

  const isBusy = status === "recording" || status === "transcribing" || status === "cleaning";
  const handleClose = () => invoke("hide_dictation_window").catch(() => {});
  const handleCopyAndClose = async () => {
    if (await handleCopy()) {
      handleClose();
    }
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-transparent p-2">
      <div className="w-full rounded-xl border border-border/60 bg-popover/95 backdrop-blur-md shadow-xl px-4 py-3 flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm">
          {status === "recording" && (
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
            </span>
          )}
          {(status === "transcribing" || status === "cleaning") && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
          {status === "idle" && <Mic className="h-3.5 w-3.5 text-muted-foreground" />}
          {status === "done" && <Check className="h-3.5 w-3.5 text-green-500" />}
          {status === "error" && <TriangleAlert className="h-3.5 w-3.5 text-destructive" />}

          <span className="flex-1 text-muted-foreground truncate">
            {status === "error" && errorText ? errorText : STATUS_LABEL[status]}
          </span>

          {!isBusy && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 shrink-0"
              onClick={handleClose}
              aria-label="Close dictation window"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {status === "error" && errorText && (
          <p className="text-xs leading-snug text-destructive whitespace-pre-wrap">
            {errorText}
          </p>
        )}

        {status === "done" && resultText && (
          <div className="flex items-start gap-2">
            <p className="flex-1 text-sm leading-snug max-h-24 overflow-y-auto whitespace-pre-wrap">
              {resultText}
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="shrink-0 h-7 px-2"
              onClick={handleCopyAndClose}
            >
              {isCopied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        )}

        {status === "done" && (
          <p className={cn("text-xs", injected ? "text-green-500" : "text-muted-foreground")}>
            {injected
              ? "Inserted at your cursor."
              : "Couldn't insert directly — copy it from above."}
          </p>
        )}

        {isBusy && (
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
          </div>
        )}
      </div>
    </div>
  );
};

export default Dictation;
