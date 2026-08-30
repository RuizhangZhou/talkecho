import { TYPE_PROVIDER } from "@/types";
import { fetchAIResponse } from "./ai-response.function";

// Tight, narrow-scope prompt: only remove disfluencies/repetition and fix
// grammar/punctuation. Never add information, never change meaning, never
// answer the content — this keeps a small/fast model reliable.
export const DICTATION_CLEANUP_SYSTEM_PROMPT = [
  "You clean up a raw speech-to-text transcript for dictation.",
  "Rules:",
  "- Remove filler words (um, uh, like, you know, I mean) and false starts.",
  "- Collapse repeated words/phrases into a single clean statement.",
  "- Fix punctuation, capitalization, and obvious grammar mistakes only.",
  "- Keep the speaker's wording, meaning, tone, and language exactly otherwise.",
  "- Never answer questions, never add information, never explain anything.",
  "- Output ONLY the cleaned text. No quotes, no notes, no preamble.",
  "If the transcript is already clean, return it unchanged.",
].join("\n");

export interface CleanupTranscriptParams {
  text: string;
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  /** Abort the cleanup call after this many ms and fall back to raw text. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_CLEANUP_TIMEOUT_MS = 4000;

/**
 * Runs a fast LLM pass over a raw STT transcript to strip filler words,
 * repetition, and false starts. Speed matters more than perfection here:
 * on any error/timeout/abort it silently falls back to the original text
 * so dictation never blocks on this step.
 */
export async function cleanupTranscript(
  params: CleanupTranscriptParams
): Promise<string> {
  const { text, provider, selectedProvider, timeoutMs, signal } = params;

  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);

  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS
  );

  try {
    let cleaned = "";
    for await (const chunk of fetchAIResponse({
      provider,
      selectedProvider,
      systemPrompt: DICTATION_CLEANUP_SYSTEM_PROMPT,
      userMessage: trimmed,
      signal: controller.signal,
    })) {
      cleaned += chunk;
    }

    cleaned = cleaned.trim();
    // Guard against error strings or empty/garbled output from the LLM call —
    // dictation should never end up worse than the raw transcript.
    if (!cleaned || /^(network error|api request failed|talkecho)/i.test(cleaned)) {
      return trimmed;
    }

    return cleaned;
  } catch {
    return trimmed;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}
