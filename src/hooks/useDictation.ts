import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/contexts";
import { cleanupTranscript, fetchSTT } from "@/lib/functions";
import { floatArrayToWav } from "@/lib/utils";
import { shouldUseTalkEchoAPI } from "@/lib";

const RECORDER_SAMPLE_RATE = 16000;
const RECORDER_BUFFER_SIZE = 4096;

type DictationState = { active: boolean; sequence: number };

type DictationLifecycle =
  | "mounted"
  | "microphoneRequested"
  | "microphoneReady"
  | "microphoneFailed"
  | "recordingStarted"
  | "noAudio"
  | "transcriptionReturned"
  | "emptyTranscript"
  | "cleanupReturned"
  | "textInjected"
  | "textInjectionFailed"
  | "processingFailed"
  | "syncFailed"
  | "listenerRegistrationFailed"
  | { staleState: DictationState }
  | { toggleReceived: DictationState }
  | { synchronized: DictationState };

const logLifecycle = (event: DictationLifecycle) => {
  invoke("dictation_log_lifecycle", { event }).catch(() => {});
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
    selectedDictationSttProvider,
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
  const dictationSequenceRef = useRef(-1);
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
      return;
    }

    const requestId = ++recordingRequestIdRef.current;
    startingRequestRef.current = requestId;

    try {
      logLifecycle("microphoneRequested");
      setErrorText("");
      setResultText("");
      setInjected(false);
      chunksRef.current = [];

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      logLifecycle("microphoneReady");

      // Stop may be pressed while the browser permission/device request is in
      // flight. Never attach a stream that belongs to a cancelled start.
      if (
        startingRequestRef.current !== requestId ||
        !dictationActiveRef.current
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: RECORDER_SAMPLE_RATE });
      audioContextRef.current = audioContext;
      sampleRateRef.current = audioContext.sampleRate;

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
      logLifecycle("recordingStarted");
    } catch (err) {
      logLifecycle("microphoneFailed");
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
    if (totalLength === 0) {
      logLifecycle("noAudio");
      setStatus("idle");
      invoke("hide_dictation_window", { expectedSequence: dictationSequenceRef.current }).catch(() => {});
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

      const useTalkEchoAPI = await shouldUseTalkEchoAPI();
      const sttProviderConfig = allSttProviders.find(
        (p) => p.id === selectedDictationSttProvider.provider
      );
      if (!useTalkEchoAPI && (!selectedDictationSttProvider.provider || !sttProviderConfig)) {
        throw new Error("No speech-to-text provider configured. Set one up in Dev Space.");
      }

      const rawTranscript = await fetchSTT({
        provider: sttProviderConfig,
        selectedProvider: selectedDictationSttProvider,
        audio: audioBlob,
        language: dictationSttLanguage,
      });
      logLifecycle("transcriptionReturned");

      const trimmed = rawTranscript.trim();
      if (!trimmed) {
        logLifecycle("emptyTranscript");
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
      const cleaned = await cleanupTranscript({
        text: trimmed,
        provider: useTalkEchoAPI ? undefined : aiProviderConfig,
        selectedProvider: selectedAIProvider,
      });
      logLifecycle("cleanupReturned");

      setResultText(cleaned);
      setStatus("done");

      try {
        await invoke("inject_text", { text: cleaned });
        setInjected(true);
        logLifecycle("textInjected");
      } catch {
        // Direct injection isn't available (e.g. non-Windows) — the floating
        // window already shows the cleaned text with a copy button.
        setInjected(false);
        logLifecycle("textInjectionFailed");
      }
    } catch (err) {
      logLifecycle("processingFailed");
      setStatus("error");
      setErrorText(err instanceof Error ? err.message : String(err));
    }
  }, [
    teardownRecording,
    allSttProviders,
    selectedDictationSttProvider,
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
    logLifecycle("mounted");
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let removeVisibilityListener: (() => void) | undefined;

    const register = async () => {
      const applyState = (active: boolean, sequence: number) => {
        if (sequence < dictationSequenceRef.current) {
          logLifecycle({ staleState: { active, sequence } });
          return;
        }

        if (
          sequence === dictationSequenceRef.current &&
          dictationActiveRef.current === active
        ) {
          return;
        }

        dictationSequenceRef.current = sequence;
        if (dictationActiveRef.current === active) {
          // Initial inactive state: the preload window has finished loading
          // and can now be hidden without preventing its JS listener from
          // being initialized.
          if (!active) {
            invoke("hide_dictation_window", { expectedSequence: sequence }).catch(() => {});
          }
          return;
        }

        dictationActiveRef.current = active;
        if (active) {
          invoke("show_dictation_window").catch(() => {});
          startRecordingRef.current();
        } else {
          stopRecordingAndProcessRef.current();
        }
      };

      const registeredUnlisten = await listen<DictationState>(
        "dictation://toggle",
        (event) => {
          const { active, sequence } = event.payload;
          logLifecycle({ toggleReceived: { active, sequence } });
          applyState(active, sequence);
        }
      );

      if (disposed) {
        registeredUnlisten();
        return;
      }
      unlisten = registeredUnlisten;

      const synchronize = async () => {
        const currentState = await invoke<DictationState>("get_dictation_state");
        if (!disposed) {
          logLifecycle({ synchronized: currentState });
          applyState(currentState.active, currentState.sequence);
        }
      };
      // Native hotkey handling wakes the window even if WebView event delivery
      // was suspended. Reconcile on visibility restoration without polling.
      const onVisible = () => {
        if (document.visibilityState === "visible") {
          synchronize().catch(() => logLifecycle("syncFailed"));
        }
      };
      document.addEventListener("visibilitychange", onVisible);
      removeVisibilityListener = () => document.removeEventListener("visibilitychange", onVisible);
      await synchronize();
    };

    register().catch(() => logLifecycle("listenerRegistrationFailed"));

    return () => {
      disposed = true;
      dictationActiveRef.current = false;
      recordingRequestIdRef.current += 1;
      startingRequestRef.current = null;
      unlisten?.();
      removeVisibilityListener?.();
      teardownRecording();
    };
  }, [teardownRecording]);

  const getSequence = useCallback(() => dictationSequenceRef.current, []);
  return { status, resultText, errorText, injected, getSequence };
}
