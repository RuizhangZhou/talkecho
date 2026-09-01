import {
  buildDynamicMessages,
  deepVariableReplacer,
  extractVariables,
  getByPath,
  getStreamingContent,
} from "./common.function";
import { MARKDOWN_FORMATTING_INSTRUCTIONS } from "@/config";
import { Message, TYPE_PROVIDER } from "@/types";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import curl2Json from "@bany/curl-to-json";
import { shouldUseTalkEchoAPI } from "./talkecho.api";
import { CHUNK_POLL_INTERVAL_MS } from "../chat-constants";
import { getResponseSettings, RESPONSE_LENGTHS, LANGUAGES } from "@/lib";
import {
  classifyHttpFailure,
  createLinkedAbortContext,
  delayWithSignal,
  normalizeRequestFailure,
  RequestFailure,
} from "./request-resilience";

const DEFAULT_AI_TIMEOUT_MS = 90_000;
const DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS = 30_000;
const DEFAULT_AI_MAX_RETRIES = 1;

async function readStreamWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    throw new DOMException("Request aborted", "AbortError");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void reader.cancel("Stream inactivity timeout");
          reject(
            new RequestFailure(
              `The provider stream produced no data for ${Math.round(
                timeoutMs / 1000
              )} seconds.`,
              { kind: "timeout", retryable: true }
            )
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildEnhancedSystemPrompt(baseSystemPrompt?: string): string {
  const responseSettings = getResponseSettings();
  const prompts: string[] = [];

  if (baseSystemPrompt) {
    prompts.push(baseSystemPrompt);
  }

  const lengthOption = RESPONSE_LENGTHS.find(
    (l) => l.id === responseSettings.responseLength
  );
  if (lengthOption?.prompt?.trim()) {
    prompts.push(lengthOption.prompt);
  }

  const languageOption = LANGUAGES.find(
    (l) => l.id === responseSettings.language
  );
  if (languageOption?.prompt?.trim()) {
    prompts.push(languageOption.prompt);
  }

  if (MARKDOWN_FORMATTING_INSTRUCTIONS?.trim()) {
    prompts.push(MARKDOWN_FORMATTING_INSTRUCTIONS);
  }

  return prompts.join(" ");
}

// TalkEcho AI streaming function
async function* fetchTalkEchoAIResponse(params: {
  systemPrompt?: string;
  userMessage: string;
  imagesBase64?: string[];
  history?: Message[];
  signal?: AbortSignal;
}): AsyncIterable<string> {
  const {
    systemPrompt,
    userMessage,
    imagesBase64 = [],
    history = [],
    signal,
  } = params;

  if (signal?.aborted) return;

  let historyString: string | undefined;
  if (history.length > 0) {
    // Callers pass history in chronological order; preserve that order.
    const formattedHistory = history.map((msg) => ({
      role: msg.role,
      content: [{ type: "text", text: msg.content }],
    }));
    historyString = JSON.stringify(formattedHistory);
  }

  let imageBase64: unknown = undefined;
  if (imagesBase64.length > 0) {
    imageBase64 = imagesBase64.length === 1 ? imagesBase64[0] : imagesBase64;
  }

  const requestId =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let streamComplete = false;
  const streamChunks: string[] = [];
  let unlisten: (() => void) | undefined;
  let unlistenComplete: (() => void) | undefined;
  let rejectOnAbort: (() => void) | undefined;

  const onAbort = () => {
    void invoke("cancel_chat_stream", { requestId }).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal?.aborted) return;

    unlisten = await listen<{ requestId: string; chunk: string }>(
      "chat_stream_chunk",
      (event) => {
        if (event.payload.requestId === requestId) {
          streamChunks.push(event.payload.chunk);
        }
      }
    );
    unlistenComplete = await listen<{ requestId: string }>(
      "chat_stream_complete",
      (event) => {
        if (event.payload.requestId === requestId) streamComplete = true;
      }
    );
    if (signal?.aborted) return;

    const invokePromise = invoke("chat_stream_response", {
      userMessage,
      systemPrompt,
      imageBase64,
      history: historyString,
      requestId,
    });
    // Prevent a later Rust-side cancellation rejection from becoming unhandled
    // if the abort branch wins this race.
    void invokePromise.catch(() => {});

    const abortPromise = new Promise<never>((_, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Request aborted", "AbortError"));
        return;
      }
      rejectOnAbort = () =>
        reject(new DOMException("Request aborted", "AbortError"));
      signal?.addEventListener("abort", rejectOnAbort, { once: true });
    });
    await Promise.race([invokePromise, abortPromise]);

    let lastIndex = 0;
    while (!streamComplete) {
      if (signal?.aborted) return;

      await new Promise((resolve) => setTimeout(resolve, CHUNK_POLL_INTERVAL_MS));

      if (signal?.aborted) return;

      for (let i = lastIndex; i < streamChunks.length; i++) {
        yield streamChunks[i];
      }
      lastIndex = streamChunks.length;
    }

    if (signal?.aborted) return;

    for (let i = lastIndex; i < streamChunks.length; i++) {
      yield streamChunks[i];
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (rejectOnAbort) signal?.removeEventListener("abort", rejectOnAbort);
    unlisten?.();
    unlistenComplete?.();
  }
}

export async function* fetchAIResponse(params: {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  systemPrompt?: string;
  history?: Message[];
  userMessage: string;
  imagesBase64?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  inactivityTimeoutMs?: number;
  maxRetries?: number;
  onRetry?: (attempt: number, reason: string) => void;
}): AsyncIterable<string> {
  try {
    const {
      provider,
      selectedProvider,
      systemPrompt,
      history = [],
      userMessage,
      imagesBase64 = [],
      signal,
      timeoutMs = DEFAULT_AI_TIMEOUT_MS,
      inactivityTimeoutMs = DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS,
      maxRetries = DEFAULT_AI_MAX_RETRIES,
      onRetry,
    } = params;

    // Check if already aborted
    if (signal?.aborted) {
      return;
    }

    const enhancedSystemPrompt = buildEnhancedSystemPrompt(systemPrompt);

    // Check if we should use TalkEcho API instead
    const useTalkEchoAPI = await shouldUseTalkEchoAPI();
    if (useTalkEchoAPI) {
      const abortContext = createLinkedAbortContext(signal, timeoutMs);
      try {
        yield* fetchTalkEchoAIResponse({
          systemPrompt: enhancedSystemPrompt,
          userMessage,
          imagesBase64,
          history,
          signal: abortContext.signal,
        });
      } catch (error) {
        throw normalizeRequestFailure(error, {
          timedOut: abortContext.didTimeout(),
          cancelled: signal?.aborted,
        });
      } finally {
        abortContext.cleanup();
      }
      return;
    }
    if (!provider) {
      throw new Error(`Provider not provided`);
    }
    if (!selectedProvider) {
      throw new Error(`Selected provider not provided`);
    }

    let curlJson;
    try {
      curlJson = curl2Json(provider.curl);
    } catch (error) {
      throw new Error(
        `Failed to parse curl: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }

    const extractedVariables = extractVariables(provider.curl);
    const requiredVars = extractedVariables.filter(
      ({ key }) => key !== "SYSTEM_PROMPT" && key !== "TEXT" && key !== "IMAGE"
    );
    for (const { key } of requiredVars) {
      if (
        !selectedProvider.variables?.[key] ||
        selectedProvider.variables[key].trim() === ""
      ) {
        throw new Error(
          `Missing required variable: ${key}. Please configure it in settings.`
        );
      }
    }

    if (!userMessage) {
      throw new Error("User message is required");
    }
    if (imagesBase64.length > 0 && !provider.curl.includes("{{IMAGE}}")) {
      throw new Error(
        `Provider ${provider?.id ?? "unknown"} does not support image input`
      );
    }

    let bodyObj: any = curlJson.data
      ? JSON.parse(JSON.stringify(curlJson.data))
      : {};
    const messagesKey = Object.keys(bodyObj).find((key) =>
      ["messages", "contents", "conversation", "history"].includes(key)
    );

    if (messagesKey && Array.isArray(bodyObj[messagesKey])) {
      const finalMessages = buildDynamicMessages(
        bodyObj[messagesKey],
        history,
        userMessage,
        imagesBase64
      );
      bodyObj[messagesKey] = finalMessages;
    }

    const allVariables = {
      ...Object.fromEntries(
        Object.entries(selectedProvider.variables).map(([key, value]) => [
          key.toUpperCase(),
          value,
        ])
      ),
      SYSTEM_PROMPT: enhancedSystemPrompt || "",
    };

    bodyObj = deepVariableReplacer(bodyObj, allVariables);
    let url = deepVariableReplacer(curlJson.url || "", allVariables);

    const headers = deepVariableReplacer(curlJson.header || {}, allVariables);
    headers["Content-Type"] = "application/json";

    if (provider?.streaming) {
      if (typeof bodyObj === "object" && bodyObj !== null) {
        const streamKey = Object.keys(bodyObj).find(
          (k) => k.toLowerCase() === "stream"
        );
        if (streamKey) {
          bodyObj[streamKey] = true;
        } else {
          bodyObj.stream = true;
        }
      }
    }

    // Always use tauriFetch to avoid CORS issues, except for localhost during development
    const isLocalhost = url?.includes("localhost") || url?.includes("127.0.0.1");
    const fetchFunction = isLocalhost ? fetch : tauriFetch;

    for (let attempt = 0; ; attempt += 1) {
      const abortContext = createLinkedAbortContext(signal, timeoutMs);
      let emittedContent = false;
      try {
        const response = await fetchFunction(url, {
          method: curlJson.method || "POST",
          headers,
          body: curlJson.method === "GET" ? undefined : JSON.stringify(bodyObj),
          signal: abortContext.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          throw classifyHttpFailure(
            response.status,
            response.statusText,
            errorText,
            response.headers.get("Retry-After")
          );
        }

        if (!provider.streaming) {
          let json: unknown;
          try {
            json = await response.json();
          } catch (parseError) {
            throw new RequestFailure("The provider returned invalid JSON.", {
              kind: "malformed_response",
              cause: parseError,
            });
          }
          const content = getByPath(json, provider.responseContentPath || "") || "";
          if (!content) {
            throw new RequestFailure(
              "The provider response did not contain text at the configured response path.",
              { kind: "malformed_response" }
            );
          }
          emittedContent = true;
          yield String(content);
          return;
        }

        if (!response.body) {
          throw new RequestFailure("The provider returned no streaming body.", {
            kind: "malformed_response",
          });
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const processLine = (line: string): string => {
          if (!line.startsWith("data:")) return "";
          const trimmed = line.substring(5).trim();
          if (!trimmed || trimmed === "[DONE]") return "";
          try {
            return String(
              getStreamingContent(
                JSON.parse(trimmed),
                provider.responseContentPath || ""
              ) || ""
            );
          } catch {
            return "";
          }
        };

        while (true) {
          const { done, value } = await readStreamWithTimeout(
            reader,
            inactivityTimeoutMs,
            abortContext.signal
          );
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const delta = processLine(line);
            if (delta) {
              emittedContent = true;
              yield delta;
            }
          }
        }

        const finalDelta = processLine(buffer.trim());
        if (finalDelta) {
          emittedContent = true;
          yield finalDelta;
        }
        if (!emittedContent) {
          throw new RequestFailure(
            "The provider stream completed without any response text.",
            { kind: "malformed_response" }
          );
        }
        return;
      } catch (error) {
        const failure = normalizeRequestFailure(error, {
          timedOut: abortContext.didTimeout(),
          cancelled: signal?.aborted,
        });
        if (!emittedContent && failure.retryable && attempt < maxRetries) {
          onRetry?.(attempt + 1, failure.message);
          await delayWithSignal(500 * 2 ** attempt, signal);
          continue;
        }
        throw failure;
      } finally {
        abortContext.cleanup();
      }
    }
  } catch (error) {
    throw normalizeRequestFailure(error, { cancelled: params.signal?.aborted });
  }
}


