import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/contexts";
import { cleanupTranscript, fetchSTT } from "@/lib/functions";
import { floatArrayToWav } from "@/lib/utils";
import { shouldUseTalkEchoAPI } from "@/lib";

const RECORDER_SAMPLE_RATE = 16000;
const RECORDER_BUFFER_SIZE = 4096;

// TEMPORARY DEBUG: mirrors progress to the Rust terminal since this window
// has no visible devtools.
const debugLog = (message: string) => {
  invoke("dictation_debug_log", { message }).catch(() => {});
};

export type DictationStatus =
  | "idle"
  | "recording"
  | "transcribing"
  | "cleaning"
  | "done"
  | "error";

export type useDictationType = ReturnType<typeof useDictation>;

/**
 * Drives the "press Right Ctrl to dictate" flow: listens for the toggle event
 * from Rust, records the microphone while active, then runs
 * STT -> smart cleanup -> direct text injection (with copy-to-clipboard as
 * the always-available fallback shown in the floating window).
 */
export function useDictation() {
  const {
    selectedSttProvider,
    allSttProviders,
    selectedAIProvider,
    allAiProviders,
    dictationSttLanguage,
  } = useApp();

  const [status, setStatus] = useState<DictationStatus>("idle");
  const [resultText, setResultText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [injected, setInjected] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef<number>(RECORDER_SAMPLE_RATE);
  const dictationActiveRef = useRef(false);
  const recordingRequestIdRef = useRef(0);
  const startingRequestRef = useRef<number | null>(null);

  const teardownRecording = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
    }
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close().catch(() => {});
    }
    audioContextRef.current = null;
  }, []);

  const startRecording = useCallback(async () => {
    if (
      startingRequestRef.current !== null ||
      streamRef.current !== null ||
      audioContextRef.current !== null
    ) {
      debugLog("startRecording: ignored duplicate start request");
      return;
    }

    const requestId = ++recordingRequestIdRef.current;
    startingRequestRef.current = requestId;

    try {
      debugLog("startRecording: requesting getUserMedia...");
      setErrorText("");
      setResultText("");
      setInjected(false);
      chunksRef.current = [];

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      debugLog("startRecording: getUserMedia resolved");

      // Stop may be pressed while the browser permission/device request is in
      // flight. Never attach a stream that belongs to a cancelled start.
      if (
        startingRequestRef.current !== requestId ||
        !dictationActiveRef.current
      ) {
        stream.getTracks().forEach((track) => track.stop());
        debugLog("startRecording: discarded stream from cancelled start");
        return;
      }
      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: RECORDER_SAMPLE_RATE });
      audioContextRef.current = audioContext;
      sampleRateRef.current = audioContext.sampleRate;
      debugLog(`startRecording: AudioContext.sampleRate=${audioContext.sampleRate}`);

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      // ScriptProcessorNode is deprecated but remains the simplest way to get
      // raw Float32 PCM frames without shipping a separate AudioWorklet module.
      const processor = audioContext.createScriptProcessor(RECORDER_BUFFER_SIZE, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (event) => {
        chunksRef.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      setStatus("recording");
      debugLog("startRecording: status set to 'recording'");
    } catch (err) {
      debugLog(
        `startRecording: ERROR ${err instanceof Error ? err.message : String(err)}`
      );
      if (startingRequestRef.current === requestId) {
        teardownRecording();
        setStatus("error");
        setErrorText(
          `Microphone access failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } finally {
      if (startingRequestRef.current === requestId) {
        startingRequestRef.current = null;
      }
    }
  }, [teardownRecording]);

  const stopRecordingAndProcess = useCallback(async () => {
    // Invalidate any getUserMedia request that has not resolved yet.
    recordingRequestIdRef.current += 1;
    startingRequestRef.current = null;

    const chunks = chunksRef.current;
    chunksRef.current = [];
    teardownRecording();

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    debugLog(`stopRecording: ${chunks.length} chunks, totalLength=${totalLength}`);
    if (totalLength === 0) {
      debugLog("stopRecording: no audio captured, returning to idle");
      setStatus("idle");
      invoke("hide_dictation_window").catch(() => {});
      return;
    }

    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    try {
      setStatus("transcribing");
      const audioBlob = floatArrayToWav(combined, sampleRateRef.current, "wav");
      debugLog(`stopRecording: encoded wav blob, size=${audioBlob.size} bytes`);

      const useTalkEchoAPI = await shouldUseTalkEchoAPI();
      const sttProviderConfig = allSttProviders.find(
        (p) => p.id === selectedSttProvider.provider
      );
      debugLog(
        `stopRecording: useTalkEchoAPI=${useTalkEchoAPI} sttProvider=${selectedSttProvider.provider} found=${!!sttProviderConfig} language=${dictationSttLanguage}`
      );
      if (!useTalkEchoAPI && (!selectedSttProvider.provider || !sttProviderConfig)) {
        throw new Error("No speech-to-text provider configured. Set one up in Dev Space.");
      }

      const rawTranscript = await fetchSTT({
        provider: sttProviderConfig,
        selectedProvider: selectedSttProvider,
        audio: audioBlob,
        language: dictationSttLanguage,
        onDebug: (message) => debugLog(message),
      });
      debugLog(`stopRecording: STT returned "${rawTranscript}"`);

      const trimmed = rawTranscript.trim();
      if (!trimmed) {
        debugLog("stopRecording: empty transcript");
        setStatus("error");
        setErrorText(
          `No speech recognized (Dictation STT language: ${dictationSttLanguage}). Try Auto detect or Chinese in Dev Space → STT Providers.`
        );
        return;
      }

      setStatus("cleaning");
      const aiProviderConfig = allAiProviders.find(
        (p) => p.id === selectedAIProvider.provider
      );
      debugLog(
        `stopRecording: aiProvider=${selectedAIProvider.provider} found=${!!aiProviderConfig}`
      );
      const cleaned = await cleanupTranscript({
        text: trimmed,
        provider: useTalkEchoAPI ? undefined : aiProviderConfig,
        selectedProvider: selectedAIProvider,
      });
      debugLog(`stopRecording: cleanup returned "${cleaned}"`);

      setResultText(cleaned);
      setStatus("done");

      try {
        await invoke("inject_text", { text: cleaned });
        setInjected(true);
        debugLog("stopRecording: inject_text succeeded");
      } catch (err) {
        // Direct injection isn't available (e.g. non-Windows) — the floating
        // window already shows the cleaned text with a copy button.
        setInjected(false);
        debugLog(
          `stopRecording: inject_text failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } catch (err) {
      debugLog(
        `stopRecording: ERROR ${err instanceof Error ? err.message : String(err)}`
      );
      setStatus("error");
      setErrorText(err instanceof Error ? err.message : String(err));
    }
  }, [
    teardownRecording,
    allSttProviders,
    selectedSttProvider,
    dictationSttLanguage,
    allAiProviders,
    selectedAIProvider,
  ]);

  const startRecordingRef = useRef(startRecording);
  const stopRecordingAndProcessRef = useRef(stopRecordingAndProcess);
  useEffect(() => {
    startRecordingRef.current = startRecording;
    stopRecordingAndProcessRef.current = stopRecordingAndProcess;
  }, [startRecording, stopRecordingAndProcess]);

  useEffect(() => {
    debugLog("useDictation: mounted, registering toggle listener");
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const register = async () => {
      const registeredUnlisten = await listen<{ active: boolean }>(
        "dictation://toggle",
        (event) => {
          const { active } = event.payload;
          debugLog(`useDictation: received toggle active=${active}`);

          if (dictationActiveRef.current === active) {
            debugLog(`useDictation: ignored duplicate active=${active}`);
            return;
          }
          dictationActiveRef.current = active;

          if (active) {
            invoke("show_dictation_window").catch(() => {});
            startRecordingRef.current();
          } else {
            stopRecordingAndProcessRef.current();
          }
        }
      );

      if (disposed) {
        registeredUnlisten();
        return;
      }
      unlisten = registeredUnlisten;
    };

    register().catch((err) => {
      debugLog(
        `useDictation: failed to register toggle listener: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });

    return () => {
      disposed = true;
      dictationActiveRef.current = false;
      recordingRequestIdRef.current += 1;
      startingRequestRef.current = null;
      unlisten?.();
      teardownRecording();
    };
  }, [teardownRecording]);

  return { status, resultText, errorText, injected };
}
