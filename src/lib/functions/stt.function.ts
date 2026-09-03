import {
  deepVariableReplacer,
  getByPath,
  blobToBase64,
} from "./common.function";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";

import { TYPE_PROVIDER } from "@/types";
import curl2Json from "@bany/curl-to-json";
import { shouldUseTalkEchoAPI } from "./talkecho.api";
import {
  classifyHttpFailure,
  normalizeRequestFailure,
  RequestFailure,
  runWithRetry,
} from "./request-resilience";

const DEFAULT_STT_TIMEOUT_MS = 30_000;
const DEFAULT_STT_MAX_RETRIES = 1;

// TalkEcho STT function
async function fetchTalkEchoSTT(audio: File | Blob, language?: string): Promise<string> {
  try {
    // Convert audio to base64
    const audioBase64 = await blobToBase64(audio);

    // Call Tauri command
    const response = await invoke<{
      success: boolean;
      transcription?: string;
      error?: string;
    }>("transcribe_audio", {
      audioBase64,
      language: language && language !== "auto" ? language : null,
    });

    if (response.success && response.transcription) {
      const transcription = response.transcription.trim();

      // Check for hallucinations
      if (isLikelyHallucination(transcription)) {
        console.log(`🚫 Filtered hallucination (TalkEcho): "${transcription}"`);
        return ""; // Return empty string to indicate no valid speech
      }

      return transcription;
    }
    throw new Error(response.error || "Transcription failed");
  } catch (error) {
    throw normalizeRequestFailure(error);
  }
}

export interface STTParams {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  audio: File | Blob;
  language?: string;
  onDebug?: (message: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * Validates audio quality to avoid processing noise/silence
 */
async function validateAudioQuality(audio: File | Blob): Promise<{
  valid: boolean;
  reason?: string;
}> {
  try {
    // Minimum audio size (0.3 seconds at 16kHz, mono, 16-bit = ~9.6KB)
    const MIN_AUDIO_SIZE = 9600; // bytes

    if (audio.size < MIN_AUDIO_SIZE) {
      return {
        valid: false,
        reason: `Audio too short (${audio.size} bytes, minimum ${MIN_AUDIO_SIZE})`,
      };
    }

    // Maximum audio size (10 minutes at 16kHz, mono, 16-bit = ~19.2MB)
    const MAX_AUDIO_SIZE = 20 * 1024 * 1024; // 20MB to be safe

    if (audio.size > MAX_AUDIO_SIZE) {
      return {
        valid: false,
        reason: `Audio too long (${audio.size} bytes, maximum ${MAX_AUDIO_SIZE})`,
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      reason: `Audio validation error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// Whisper hallucination patterns (known false positives)
const WHISPER_HALLUCINATIONS = [
  // Non-speech artifacts
  /^\[.*\]$/i, // [Music], [Applause], etc.
  /^♪.*♪$/i,
  // Empty or whitespace only
  /^\s*$/,
  // Subtitle artifacts
  /^www\./i,
];

/**
 * Checks if transcription is likely a Whisper hallucination
 */
function isLikelyHallucination(text: string): boolean {
  const trimmed = text.trim();

  // Check against known patterns
  for (const pattern of WHISPER_HALLUCINATIONS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // Additional heuristics
  // Only punctuation/symbols. Use Unicode properties because JavaScript's
  // `\w` is ASCII-only and would classify valid Chinese/Japanese/etc. text
  // as punctuation.
  if (/^[^\p{L}\p{N}\s]+$/u.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Transcribes audio and returns either the transcription or an error/warning message as a single string.
 */
export async function fetchSTT(params: STTParams): Promise<string> {
  let warnings: string[] = [];

  try {
    const {
      provider,
      selectedProvider,
      audio,
      language,
      onDebug,
      signal,
      timeoutMs = DEFAULT_STT_TIMEOUT_MS,
      maxRetries = DEFAULT_STT_MAX_RETRIES,
    } = params;

    // Validate audio quality first
    const validation = await validateAudioQuality(audio);
    if (!validation.valid) {
      console.log(`🚫 Audio validation failed: ${validation.reason}`);
      onDebug?.(`STT audio rejected: ${validation.reason}`);
      return ""; // Return empty string for invalid audio
    }

    // Check if we should use TalkEcho API instead
    const useTalkEchoAPI = await shouldUseTalkEchoAPI();
    if (useTalkEchoAPI) {
      return await runWithRetry(
        async ({ signal: attemptSignal }) => {
          const transcriptionPromise = fetchTalkEchoSTT(audio, language);
          const abortPromise = new Promise<never>((_, reject) => {
            attemptSignal.addEventListener(
              "abort",
              () =>
                reject(
                  new RequestFailure("Speech transcription timed out.", {
                    kind: "timeout",
                    retryable: true,
                  })
                ),
              { once: true }
            );
          });
          return await Promise.race([transcriptionPromise, abortPromise]);
        },
        {
          signal,
          timeoutMs,
          // The TalkEcho backend already has a configured STT fallback. Its
          // Tauri invoke cannot be safely replayed while the first invocation
          // may still be unwinding, so do not add a second frontend retry.
          maxRetries: 0,
          onRetry: (failure, nextAttempt) =>
            onDebug?.(
              `STT retry ${nextAttempt}/${maxRetries}: ${failure.message}`
            ),
        }
      );
    }

    if (!provider) throw new Error("Provider not provided");
    if (!selectedProvider) throw new Error("Selected provider not provided");
    if (!audio) throw new Error("Audio file is required");

    let curlJson: any;
    try {
      curlJson = curl2Json(provider.curl);
    } catch (error) {
      throw new Error(
        `Failed to parse curl: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }

    // Validate audio file
    const file = audio as File;
    if (file.size === 0) throw new Error("Audio file is empty");
    // maximum size of 10MB
    // const maxSize = 10 * 1024 * 1024;
    // if (file.size > maxSize) {
    //   warnings.push("Audio exceeds 10MB limit");
    // }

    // Build variable map
    // "auto" means the provider should infer the language. For multipart
    // providers the empty replacement causes the language field to be omitted.
    let finalLanguage = language === "auto" ? "" : language || "en";
    
    // Some providers prefer xx-XX format (like Google, Azure or Deepgram)
    const providerId = provider.id?.toLowerCase() || "";
    if (
      providerId === "google-stt" ||
      providerId === "azure-stt" ||
      providerId === "deepgram-stt"
    ) {
      const mapping: Record<string, string> = {
        en: "en-US",
        ru: "ru-RU",
        de: "de-DE",
        fr: "fr-FR",
        es: "es-ES",
        it: "it-IT",
        zh: "zh-CN",
        ja: "ja-JP",
        pt: "pt-PT",
        ko: "ko-KR",
      };
      if (mapping[finalLanguage]) {
        finalLanguage = mapping[finalLanguage];
      }
    }

    const allVariables: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(selectedProvider.variables).map(([key, value]) => [
          key.toUpperCase(),
          value,
        ])
      ),
      LANGUAGE: finalLanguage,
    };

    // Prepare request
    let url = deepVariableReplacer(curlJson.url || "", allVariables);
    const headers = deepVariableReplacer(curlJson.header || {}, allVariables);
    const formData = deepVariableReplacer(curlJson.form || {}, allVariables);

    // To Check if API accepts Binary Data
    const isBinaryUpload = provider.curl.includes("--data-binary");
    // Fetch URL Params
    const rawParams = curlJson.params || {};
    // Decode Them
    const decodedParams = Object.fromEntries(
      Object.entries(rawParams).map(([key, value]) => [
        key,
        typeof value === "string" ? decodeURIComponent(value) : "",
      ])
    );
    // Get the Parameters from allVariables
    const replacedParams = deepVariableReplacer(decodedParams, allVariables);

    // Add query parameters to URL
    const nonEmptyParams = Object.fromEntries(
      Object.entries(replacedParams).filter(
        ([, value]) => value !== "" && value !== null && value !== undefined
      )
    ) as Record<string, string>;
    const queryString = new URLSearchParams(nonEmptyParams).toString();
    if (queryString) {
      url += (url.includes("?") ? "&" : "?") + queryString;
    }

    let finalHeaders = { ...headers };
    let body: FormData | string | Blob;

    const isForm =
      provider.curl.includes("-F ") || provider.curl.includes("--form");
    if (isForm) {
      const form = new FormData();
      const freshBlob = new Blob([await audio.arrayBuffer()], {
        type: audio.type,
      });
      form.append("file", freshBlob, "audio.wav");
      const headerKeys = Object.keys(headers).map((k) =>
        k.toUpperCase().replace(/[-_]/g, "")
      );

      for (const [key, val] of Object.entries(formData)) {
        if (typeof val !== "string") {
          if (
            !val ||
            headerKeys.includes(key.toUpperCase()) ||
            key.toUpperCase() === "AUDIO"
          )
            continue;
          form.append(key.toLowerCase(), val as string | Blob);
          continue;
        }

        // Check if key is a number, which indicates array-like parsing from curl2json
        if (!isNaN(parseInt(key, 10))) {
          const [formKey, ...formValueParts] = val.split("=");
          const formValue = formValueParts.join("=");

          if (formKey.toLowerCase() === "file") continue; // Already handled by form.append('file', audio)

          if (
            !formValue ||
            headerKeys.includes(formKey.toUpperCase().replace(/[-_]/g, ""))
          )
            continue;

          form.append(formKey, formValue);
        } else {
          if (key.toLowerCase() === "file") continue; // Already handled by form.append('file', audio)
          if (
            !val ||
            headerKeys.includes(key.toUpperCase()) ||
            key.toUpperCase() === "AUDIO"
          )
            continue;
          form.append(key.toLowerCase(), val as string | Blob);
        }
      }
      delete finalHeaders["Content-Type"];
      body = form;
    } else if (isBinaryUpload) {
      // Deepgram-style: raw binary body
      body = new Blob([await audio.arrayBuffer()], {
        type: audio.type,
      });
    } else {
      // Google-style: JSON payload with base64
      allVariables.AUDIO = await blobToBase64(audio);
      const dataObj = curlJson.data ? { ...curlJson.data } : {};
      body = JSON.stringify(deepVariableReplacer(dataObj, allVariables));
    }

    const fetchFunction = url?.includes("http") ? fetch : tauriFetch;

    // Send request
    const sttResponse = await runWithRetry(
      async ({ signal: attemptSignal }) => {
        let result: Response;
        try {
          result = await fetchFunction(url, {
            method: curlJson.method || "POST",
            headers: finalHeaders,
            body: curlJson.method === "GET" ? undefined : body,
            signal: attemptSignal,
          });
        } catch (error) {
          throw normalizeRequestFailure(error, {
            cancelled: signal?.aborted,
          });
        }

        if (!result.ok) {
          const errorText = await result.text().catch(() => "");
          throw classifyHttpFailure(
            result.status,
            result.statusText,
            errorText,
            result.headers.get("Retry-After")
          );
        }
        return {
          status: result.status,
          text: await result.text(),
        };
      },
      {
        signal,
        timeoutMs,
        maxRetries,
        onRetry: (failure, nextAttempt) =>
          onDebug?.(`STT retry ${nextAttempt}/${maxRetries}: ${failure.message}`),
      }
    );

    const responseText = sttResponse.text;
    onDebug?.(
      `STT response received: status=${sttResponse.status} bytes=${responseText.length}`
    );
    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch {
      const plainText = responseText.trim();
      if (!plainText) {
        throw new RequestFailure("The STT provider returned an empty response.", {
          kind: "malformed_response",
        });
      }
      if (isLikelyHallucination(plainText)) return "";
      return [...warnings, plainText].filter(Boolean).join("; ");
    }

    // Extract transcription
    const rawPath = provider.responseContentPath || "text";
    const path = rawPath.charAt(0).toLowerCase() + rawPath.slice(1);
    const transcription = (getByPath(data, path) || "").trim();

    if (!transcription) {
      throw new RequestFailure(
        `The STT response did not contain text at "${rawPath}". Check the configured response path.`,
        { kind: "malformed_response" }
      );
    }

    // Check for hallucinations
    if (isLikelyHallucination(transcription)) {
      console.log(`🚫 Filtered hallucination: "${transcription}"`);
      onDebug?.(`STT filtered possible hallucination: "${transcription}"`);
      return ""; // Return empty string to indicate no valid speech
    }

    // Return transcription with any warnings
    return [...warnings, transcription].filter(Boolean).join("; ");
  } catch (err) {
    throw normalizeRequestFailure(err, { cancelled: params.signal?.aborted });
  }
}


