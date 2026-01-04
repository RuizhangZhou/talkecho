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

// TalkEcho STT function
async function fetchTalkEchoSTT(audio: File | Blob): Promise<string> {
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
    });

    if (response.success && response.transcription) {
      const transcription = response.transcription.trim();

      // Check for hallucinations
      if (isLikelyHallucination(transcription)) {
        console.log(`🚫 Filtered hallucination (TalkEcho): "${transcription}"`);
        return ""; // Return empty string to indicate no valid speech
      }

      return transcription;
    } else {
      return response.error || "Transcription failed";
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return `TalkEcho STT Error: ${errorMessage}`;
  }
}

export interface STTParams {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  audio: File | Blob;
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
  // Too short (single character after trimming)
  if (trimmed.length < 2) {
    return true;
  }

  // Only punctuation
  if (/^[^\w\s]+$/.test(trimmed)) {
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
    const { provider, selectedProvider, audio } = params;

    // Validate audio quality first
    const validation = await validateAudioQuality(audio);
    if (!validation.valid) {
      console.log(`🚫 Audio validation failed: ${validation.reason}`);
      return ""; // Return empty string for invalid audio
    }

    // Check if we should use TalkEcho API instead
    const useTalkEchoAPI = await shouldUseTalkEchoAPI();
    if (useTalkEchoAPI) {
      return await fetchTalkEchoSTT(audio);
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
    const allVariables = {
      ...Object.fromEntries(
        Object.entries(selectedProvider.variables).map(([key, value]) => [
          key.toUpperCase(),
          value,
        ])
      ),
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
    const queryString = new URLSearchParams(replacedParams).toString();
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
    let response: Response;
    try {
      response = await fetchFunction(url, {
        method: curlJson.method || "POST",
        headers: finalHeaders,
        body: curlJson.method === "GET" ? undefined : body,
      });
    } catch (e) {
      throw new Error(`Network error: ${e instanceof Error ? e.message : e}`);
    }

    if (!response.ok) {
      let errText = "";
      try {
        errText = await response.text();
      } catch {}
      let errMsg: string;
      try {
        const errObj = JSON.parse(errText);
        errMsg = errObj.message || errText;
      } catch {
        errMsg = errText || response.statusText;
      }
      throw new Error(`HTTP ${response.status}: ${errMsg}`);
    }

    const responseText = await response.text();
    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch {
      return [...warnings, responseText.trim()].filter(Boolean).join("; ");
    }

    // Extract transcription
    const rawPath = provider.responseContentPath || "text";
    const path = rawPath.charAt(0).toLowerCase() + rawPath.slice(1);
    const transcription = (getByPath(data, path) || "").trim();

    if (!transcription) {
      return [...warnings, "No transcription found"].join("; ");
    }

    // Check for hallucinations
    if (isLikelyHallucination(transcription)) {
      console.log(`🚫 Filtered hallucination: "${transcription}"`);
      return ""; // Return empty string to indicate no valid speech
    }

    // Return transcription with any warnings
    return [...warnings, transcription].filter(Boolean).join("; ");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg);
  }
}


