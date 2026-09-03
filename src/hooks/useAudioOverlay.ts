import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useWindowResize, useGlobalShortcuts } from ".";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/contexts";
import {
  buildMeetingReferenceContext,
  estimateTextTokens,
  fetchSTT,
  fetchAIResponse,
  formatRequestFailure,
  getProviderTokenBudget,
  RequestFailure,
  selectRecentHistory,
  SerialTaskQueue,
} from "@/lib/functions";
import { MicVAD } from "@ricky0123/vad-web";
import {
  DEFAULT_QUICK_ACTIONS,
  DEFAULT_SYSTEM_PROMPT,
  STORAGE_KEYS,
} from "@/config";
import {
  safeLocalStorage,
  shouldUseTalkEchoAPI,
  generateConversationTitle,
  saveConversation,
  CONVERSATION_SAVE_DEBOUNCE_MS,
  generateConversationId,
  generateMessageId,
} from "@/lib";
import type {
  Message as CompletionMessage,
  ChatConversation as CompletionConversation,
} from "@/types/completion";
import { floatArrayToWav } from "@/lib/utils";

// VAD Configuration interface matching Rust
export interface VadConfig {
  enabled: boolean;
  hop_size: number;
  sensitivity_rms: number;
  peak_threshold: number;
  silence_chunks: number;
  min_speech_chunks: number;
  pre_speech_chunks: number;
  noise_gate_threshold: number;
  max_recording_duration_secs: number;
}
const DISPLAY_SAMPLE_RATE = 44100;
const MIC_VAD_SAMPLE_RATE = 16000;
const MIC_VAD_FRAME_SAMPLES = 512;
const MIC_VAD_FRAME_MS = (MIC_VAD_FRAME_SAMPLES / MIC_VAD_SAMPLE_RATE) * 1000;
// Higher = stricter detection of user speech for microphone VAD
const DEFAULT_USER_SPEAKING_THRESHOLD = 0.85;
const MEETING_QUEUE_CAPACITY = 8;

// Mic VAD tuning (front-end @ricky0123/vad-web)
// These are conservative defaults to reduce false positives
const MIC_VAD_TUNING = {
  positiveSpeechThreshold: 0.85,
  negativeSpeechThreshold: 0.5,
  minSpeechMs: 7 * MIC_VAD_FRAME_MS,
  preSpeechPadMs: MIC_VAD_FRAME_MS,
} as const;


// OPTIMIZED VAD defaults - matches backend exactly for perfect performance
export const DEFAULT_VAD_CONFIG: VadConfig = {
  enabled: true,
  hop_size: 1024,
  sensitivity_rms: 0.016, // Stricter - reduce false positives from noise
  peak_threshold: 0.045, // Higher threshold - filters clicks/noise
  silence_chunks: 45, // ~1.0s of required silence
  min_speech_chunks: 10, // ~0.23s - more confidence before STT
  pre_speech_chunks: 12, // ~0.27s - enough to catch word start
  noise_gate_threshold: 0.004, // Stronger noise filtering
  max_recording_duration_secs: 180, // 3 minutes default
};

// Previous defaults kept for one-time localStorage migration.
export const LEGACY_DEFAULT_VAD_CONFIG: VadConfig = {
  enabled: true,
  hop_size: 1024,
  sensitivity_rms: 0.012,
  peak_threshold: 0.035,
  silence_chunks: 45,
  min_speech_chunks: 7,
  pre_speech_chunks: 12,
  noise_gate_threshold: 0.003,
  max_recording_duration_secs: 180,
};

const approxEqual = (a: number, b: number, epsilon = 1e-6) =>
  Math.abs(a - b) <= epsilon;

const isVadConfigEqual = (a: VadConfig, b: VadConfig) =>
  a.enabled === b.enabled &&
  a.hop_size === b.hop_size &&
  approxEqual(a.sensitivity_rms, b.sensitivity_rms) &&
  approxEqual(a.peak_threshold, b.peak_threshold) &&
  a.silence_chunks === b.silence_chunks &&
  a.min_speech_chunks === b.min_speech_chunks &&
  a.pre_speech_chunks === b.pre_speech_chunks &&
  approxEqual(a.noise_gate_threshold, b.noise_gate_threshold) &&
  a.max_recording_duration_secs === b.max_recording_duration_secs;

// Chat message interface (reusing from useCompletion)
interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  source?: "system_audio" | "microphone" | "manual"; // audio source
}

// Conversation interface (reusing from useCompletion)
export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export type useAudioOverlayType = ReturnType<typeof useAudioOverlay>;

export function useAudioOverlay() {
  const { resizeWindow } = useWindowResize();
  const globalShortcuts = useGlobalShortcuts();
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const closeConversationPopover = useCallback(
    () => setIsPopoverOpen(false),
    []
  );
  const toggleConversationPopover = useCallback(
    () => setIsPopoverOpen((prev) => !prev),
    []
  );
  const openConversationPopover = useCallback(() => setIsPopoverOpen(true), []);
  const [capturing, setCapturing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAIProcessing, setIsAIProcessing] = useState(false);
  const [lastTranscription, setLastTranscription] = useState<string>("");
  const [lastAIResponse, setLastAIResponse] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");
  const [queueDepth, setQueueDepth] = useState(0);
  const [setupRequired, setSetupRequired] = useState<boolean>(false);
  const [quickActions, setQuickActions] = useState<string[]>([]);
  const [isManagingQuickActions, setIsManagingQuickActions] =
    useState<boolean>(false);
  const [showQuickActions, setShowQuickActions] = useState<boolean>(true);
  const [vadConfig, setVadConfig] = useState<VadConfig>(DEFAULT_VAD_CONFIG);
  const [recordingProgress, setRecordingProgress] = useState<number>(0); // For continuous mode
  const [isContinuousMode, setIsContinuousMode] = useState<boolean>(false);
  const [isRecordingInContinuousMode, setIsRecordingInContinuousMode] =
    useState<boolean>(false);
  const [stream, setStream] = useState<MediaStream | null>(null); // for audio visualizer
  const streamRef = useRef<MediaStream | null>(null);

  // Microphone dual-track mode
  const [includeMicrophone, setIncludeMicrophone] = useState<boolean>(false);
  const [isMicProcessing, setIsMicProcessing] = useState<boolean>(false);

  const [conversation, setConversation] = useState<ChatConversation>({
    id: "",
    title: "",
    messages: [],
    createdAt: 0,
    updatedAt: 0,
  });

  const buildConversationHistory = useCallback(() => {
    const history: CompletionMessage[] = conversation.messages
      .slice()
      .reverse()
      .map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));
    return history;
  }, [conversation.messages]);

  const convertConversationForSave = useCallback((): CompletionConversation => {
    return {
      ...conversation,
      messages: conversation.messages.map((msg) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        source: msg.source === "microphone" ? "microphone" : "system_audio",
      })),
    };
  }, [conversation]);

  // Context management states
  const [useSystemPrompt, setUseSystemPrompt] = useState<boolean>(true);
  const [contextContent, setContextContent] = useState<string>("");

  const {
    selectedSttProvider,
    allSttProviders,
    sttLanguage,
    selectedAIProvider,
    allAiProviders,
    systemPrompt,
    selectedAudioDevices,
  } = useApp();
  const abortControllerRef = useRef<AbortController | null>(null);
  const meetingRequestControllersRef = useRef(new Set<AbortController>());
  const meetingQueueRef = useRef<SerialTaskQueue | null>(null);
  if (!meetingQueueRef.current) {
    meetingQueueRef.current = new SerialTaskQueue(
      MEETING_QUEUE_CAPACITY,
      setQueueDepth
    );
  }
  const aiQueueRef = useRef<Promise<void>>(Promise.resolve());
  const aiQueueGenerationRef = useRef(0);
  const lastSpeechEventRef = useRef({ fingerprint: "", receivedAt: 0 });
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef<boolean>(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef(conversation);

  useEffect(() => {
    conversationRef.current = conversation;
  }, [conversation]);

  // Ref to hold the microphone processing function to avoid closure issues
  const processMicrophoneAudioRef = useRef<((audio: Float32Array) => Promise<void>) | null>(null);

  // Microphone VAD for dual-track mode
  const audioConstraints: MediaTrackConstraints = useMemo(
    () =>
      selectedAudioDevices.input
        ? { deviceId: { exact: selectedAudioDevices.input } }
        : { deviceId: "default" },
    [selectedAudioDevices.input]
  );

  const micVadInstanceRef = useRef<MicVAD | null>(null);
  const [micVadListening, setMicVadListening] = useState(false);
  const [micVadLoading, setMicVadLoading] = useState(true);
  const [micVadErrored, setMicVadErrored] = useState<string | false>(false);
  const [micVadUserSpeaking, setMicVadUserSpeaking] = useState(false);

  const includeMicRef = useRef(includeMicrophone);
  useEffect(() => {
    includeMicRef.current = includeMicrophone;
  }, [includeMicrophone]);

  const capturingRef = useRef(capturing);
  useEffect(() => {
    capturingRef.current = capturing;
  }, [capturing]);

  const microphoneSilenceSeconds = useMemo(() => {
    return (vadConfig.silence_chunks * vadConfig.hop_size) / DISPLAY_SAMPLE_RATE;
  }, [vadConfig.silence_chunks, vadConfig.hop_size]);

  const microphoneRedemptionMs = useMemo(() => {
    return Math.max(MIC_VAD_FRAME_MS, microphoneSilenceSeconds * 1000);
  }, [microphoneSilenceSeconds]);

  const microphoneRedemptionMsRef = useRef(microphoneRedemptionMs);
  useEffect(() => {
    microphoneRedemptionMsRef.current = microphoneRedemptionMs;
    if (micVadInstanceRef.current) {
      micVadInstanceRef.current.setOptions({
        redemptionMs: microphoneRedemptionMs,
      });
    }
  }, [microphoneRedemptionMs]);

  useEffect(() => {
    let canceled = false;
    setMicVadLoading(true);
    setMicVadErrored(false);

    const initializeMicVAD = async () => {
      try {
        const vad = await MicVAD.new({
          model: "v5",
          getStream: () =>
            navigator.mediaDevices.getUserMedia({ audio: audioConstraints }),
          resumeStream: () =>
            navigator.mediaDevices.getUserMedia({ audio: audioConstraints }),
          positiveSpeechThreshold: MIC_VAD_TUNING.positiveSpeechThreshold,
          negativeSpeechThreshold: MIC_VAD_TUNING.negativeSpeechThreshold,
          minSpeechMs: MIC_VAD_TUNING.minSpeechMs,
          preSpeechPadMs: MIC_VAD_TUNING.preSpeechPadMs,
          onFrameProcessed: (probabilities) => {
            setMicVadUserSpeaking(
              probabilities.isSpeech > DEFAULT_USER_SPEAKING_THRESHOLD
            );
          },
          onSpeechEnd: async (audio: Float32Array) => {
            if (
              includeMicRef.current &&
              capturingRef.current &&
              processMicrophoneAudioRef.current
            ) {
              await processMicrophoneAudioRef.current(audio);
            }
          },
        });

        if (canceled) {
          vad.destroy();
          return;
        }

        micVadInstanceRef.current = vad;
        vad.setOptions({ redemptionMs: microphoneRedemptionMsRef.current });
        setMicVadLoading(false);

        if (includeMicRef.current && capturingRef.current) {
          vad.start();
          setMicVadListening(true);
        }
      } catch (err) {
        if (canceled) return;
        const message = err instanceof Error ? err.message : String(err);
        setMicVadErrored(message || "Microphone VAD failed to initialize");
        setMicVadLoading(false);
      }
    };

    initializeMicVAD();

    return () => {
      canceled = true;
      if (micVadInstanceRef.current) {
        micVadInstanceRef.current.destroy();
        micVadInstanceRef.current = null;
      }
      setMicVadListening(false);
      setMicVadUserSpeaking(false);
    };
  }, [audioConstraints]);

  const startMicVad = useCallback(() => {
    if (micVadLoading || micVadErrored || !micVadInstanceRef.current) {
      return;
    }
    micVadInstanceRef.current.start();
    setMicVadListening(true);
  }, [micVadLoading, micVadErrored]);

  const pauseMicVad = useCallback(() => {
    if (!micVadInstanceRef.current) {
      return;
    }
    micVadInstanceRef.current.pause();
    setMicVadListening(false);
  }, []);

  // Control microphone VAD based on includeMicrophone and capturingçŠ¶æ€
  useEffect(() => {
    if (includeMicrophone && capturing) {
      if (!micVadListening) {
        startMicVad();
      }
    } else {
      // Always pause when includeMicrophone is false or not capturing
      if (micVadListening) {
        pauseMicVad();
      }
    }
  }, [includeMicrophone, capturing, micVadListening, startMicVad, pauseMicVad]);

  // Load context settings and VAD config from localStorage on mount
  useEffect(() => {
    const savedContext = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT
    );
    if (savedContext) {
      try {
        const parsed = JSON.parse(savedContext);
        setUseSystemPrompt(parsed.useSystemPrompt ?? true);
        setContextContent(parsed.contextContent ?? "");
      } catch (error) {
        console.error("Failed to load system audio context:", error);
      }
    }

    // Load VAD config
    const savedVadConfig = safeLocalStorage.getItem("vad_config");
    if (savedVadConfig) {
      try {
        const parsed = JSON.parse(savedVadConfig) as Partial<VadConfig>;
        const normalized: VadConfig = { ...DEFAULT_VAD_CONFIG, ...parsed };
        const migrated = isVadConfigEqual(normalized, LEGACY_DEFAULT_VAD_CONFIG)
          ? { ...DEFAULT_VAD_CONFIG }
          : normalized;

        setVadConfig(migrated);
        safeLocalStorage.setItem("vad_config", JSON.stringify(migrated));
        invoke("update_vad_config", { config: migrated }).catch((error) => {
          console.error("Failed to update VAD config:", error);
        });
      } catch (error) {
        console.error("Failed to load VAD config:", error);
      }
    }

    // Load microphone mixing setting
    const savedIncludeMic = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_INCLUDE_MICROPHONE
    );
    if (savedIncludeMic !== null) {
      try {
        setIncludeMicrophone(savedIncludeMic === "true");
      } catch (error) {
        console.error("Failed to load microphone mixing setting:", error);
      }
    }
  }, []);

  // Listen for includeMicrophone setting changes from SystemAudioSettings (across windows)
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      try {
        const registeredUnlisten = await listen<{ value: boolean }>(
          "includeMicrophoneChanged",
          (event) => {
            const newValue = event.payload?.value;
            if (typeof newValue === "boolean") {
              setIncludeMicrophone(newValue);
            }
          }
        );
        if (disposed) registeredUnlisten();
        else unlisten = registeredUnlisten;
      } catch (error) {
        console.error("Failed to listen for includeMicrophoneChanged event:", error);
      }
    };

    setupListener();

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      try {
        const registeredUnlisten = await listen<{ config: VadConfig }>(
          "vadConfigChanged",
          async (event) => {
            const newConfig = event.payload?.config;
            if (!newConfig) return;

            setVadConfig(newConfig);
            safeLocalStorage.setItem("vad_config", JSON.stringify(newConfig));
            invoke("update_vad_config", { config: newConfig }).catch((error) => {
              console.error("Failed to update VAD config:", error);
            });
          }
        );
        if (disposed) registeredUnlisten();
        else unlisten = registeredUnlisten;
      } catch (error) {
        console.error("Failed to listen for vadConfigChanged event:", error);
      }
    };

    setupListener();

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  // Load quick actions from localStorage on mount
  useEffect(() => {
    const savedActions = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_QUICK_ACTIONS
    );
    if (savedActions) {
      try {
        const parsed = JSON.parse(savedActions);
        setQuickActions(parsed);
      } catch (error) {
        console.error("Failed to load quick actions:", error);
        setQuickActions(DEFAULT_QUICK_ACTIONS);
      }
    } else {
      setQuickActions(DEFAULT_QUICK_ACTIONS);
    }
  }, []);

  // Handle continuous recording progress events AND error events
  useEffect(() => {
    let disposed = false;
    let progressUnlisten: (() => void) | undefined;
    let startUnlisten: (() => void) | undefined;
    let stopUnlisten: (() => void) | undefined;
    let errorUnlisten: (() => void) | undefined;
    let discardedUnlisten: (() => void) | undefined;

    const setupContinuousListeners = async () => {
      try {
        // Progress updates (every second)
        const registeredProgress = await listen("recording-progress", (event) => {
          const seconds = event.payload as number;
          setRecordingProgress(seconds);
        });
        if (disposed) registeredProgress();
        else progressUnlisten = registeredProgress;

        // Recording started
        const registeredStart = await listen("continuous-recording-start", () => {
          setRecordingProgress(0);
          setIsRecordingInContinuousMode(true);
        });
        if (disposed) registeredStart();
        else startUnlisten = registeredStart;

        // Recording stopped
        const registeredStop = await listen("continuous-recording-stopped", () => {
          setRecordingProgress(0);
          setIsRecordingInContinuousMode(false);
        });
        if (disposed) registeredStop();
        else stopUnlisten = registeredStop;

        // Audio encoding errors
        const registeredError = await listen("audio-encoding-error", (event) => {
          const errorMsg = event.payload as string;
          console.error("Audio encoding error:", errorMsg);
          setError(`Failed to process audio: ${errorMsg}`);
          setIsProcessing(false);
          setIsAIProcessing(false);
          setIsRecordingInContinuousMode(false);
        });
        if (disposed) registeredError();
        else errorUnlisten = registeredError;

        // Speech discarded (too short)
        const registeredDiscarded = await listen("speech-discarded", () => {
          // Don't show error - this is expected behavior
        });
        if (disposed) registeredDiscarded();
        else discardedUnlisten = registeredDiscarded;
      } catch (err) {
        console.error("Failed to setup continuous recording listeners:", err);
      }
    };

    setupContinuousListeners();

    return () => {
      disposed = true;
      if (progressUnlisten) progressUnlisten();
      if (startUnlisten) startUnlisten();
      if (stopUnlisten) stopUnlisten();
      if (errorUnlisten) errorUnlisten();
      if (discardedUnlisten) discardedUnlisten();
    };
  }, []);

  // Handle single speech detection event (both VAD and continuous modes)
  useEffect(() => {
    let disposed = false;
    let speechUnlisten: (() => void) | undefined;

    const setupEventListener = async () => {
      try {
        const unlisten = await listen("speech-detected", (event) => {
          if (!capturing) return;

          const base64Audio = event.payload as string;
          const fingerprint = `${base64Audio.length}:${base64Audio.slice(
            0,
            64
          )}:${base64Audio.slice(-64)}`;
          const receivedAt = Date.now();
          if (
            lastSpeechEventRef.current.fingerprint === fingerprint &&
            receivedAt - lastSpeechEventRef.current.receivedAt < 10_000
          ) {
            console.warn("Skipping duplicate speech-detected event");
            return;
          }
          lastSpeechEventRef.current = { fingerprint, receivedAt };

          void meetingQueueRef.current!
            .enqueue(async () => {
              const controller = new AbortController();
              meetingRequestControllersRef.current.add(controller);
              setIsProcessing(true);
              setNotice("");

              try {
                const binaryString = atob(base64Audio);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                  bytes[i] = binaryString.charCodeAt(i);
                }
                const audioBlob = new Blob([bytes], { type: "audio/wav" });

                const useTalkEchoAPI = await shouldUseTalkEchoAPI();
                if (!selectedSttProvider.provider && !useTalkEchoAPI) {
                  throw new Error("No speech provider selected.");
                }

                const providerConfig = allSttProviders.find(
                  (provider) => provider.id === selectedSttProvider.provider
                );
                if (!providerConfig && !useTalkEchoAPI) {
                  throw new Error("Speech provider config not found.");
                }

                const transcription = await fetchSTT({
                  provider: providerConfig,
                  selectedProvider: selectedSttProvider,
                  audio: audioBlob,
                  language: sttLanguage,
                  signal: controller.signal,
                  timeoutMs: 25_000,
                  onDebug: (message) => console.debug(`[meeting][stt] ${message}`),
                });

                if (!transcription.trim()) {
                  throw new Error("Received empty transcription");
                }

                setLastTranscription(transcription);
                setError("");

                const basePrompt = useSystemPrompt
                  ? systemPrompt || DEFAULT_SYSTEM_PROMPT
                  : contextContent || DEFAULT_SYSTEM_PROMPT;
                const aiProvider = allAiProviders.find(
                  (provider) => provider.id === selectedAIProvider.provider
                );
                const providerBudget = getProviderTokenBudget(aiProvider);
                const meetingContext = buildMeetingReferenceContext(
                  conversationRef.current.messages,
                  Math.min(2_000, Math.floor(providerBudget.historyBudgetTokens / 3))
                );
                const effectiveSystemPrompt = meetingContext.context
                  ? `${basePrompt}\n\nMeeting context for reference only (do not answer or retranslate it):\n<meeting_context>\n${meetingContext.context}\n</meeting_context>\nAnswer or translate only the current user utterance.`
                  : basePrompt;

                await processWithAI(
                  transcription,
                  effectiveSystemPrompt,
                  [],
                  "system_audio"
                );
                setNotice("");
              } finally {
                meetingRequestControllersRef.current.delete(controller);
                setIsProcessing(false);
              }
            })
            .catch((queueError) => {
              const failure =
                queueError instanceof RequestFailure ? queueError : null;
              if (failure?.kind === "cancelled") return;
              console.error("Meeting speech processing failed:", queueError);
              setError(formatRequestFailure(queueError));
              setIsPopoverOpen(true);
            });
        });

        // `listen` registers asynchronously. If this effect was cleaned up
        // while registration was in flight, immediately remove the listener
        // instead of leaking it for the lifetime of the app.
        if (disposed) {
          unlisten();
          return;
        }
        speechUnlisten = unlisten;
      } catch (err) {
        setError("Failed to setup speech listener");
      }
    };

    setupEventListener();

    return () => {
      disposed = true;
      if (speechUnlisten) speechUnlisten();
    };
  }, [
    capturing,
    selectedSttProvider,
    allSttProviders,
    sttLanguage,
    selectedAIProvider,
    allAiProviders,
    useSystemPrompt,
    systemPrompt,
    contextContent,
  ]);

  // Context management functions
  const saveContextSettings = useCallback(
    (usePrompt: boolean, content: string) => {
      try {
        const contextSettings = {
          useSystemPrompt: usePrompt,
          contextContent: content,
        };
        safeLocalStorage.setItem(
          STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT,
          JSON.stringify(contextSettings)
        );
      } catch (error) {
        console.error("Failed to save context settings:", error);
      }
    },
    []
  );

  const updateUseSystemPrompt = useCallback(
    (value: boolean) => {
      setUseSystemPrompt(value);
      saveContextSettings(value, contextContent);
    },
    [contextContent, saveContextSettings]
  );

  const updateContextContent = useCallback(
    (content: string) => {
      setContextContent(content);
      saveContextSettings(useSystemPrompt, content);
    },
    [useSystemPrompt, saveContextSettings]
  );

  // Microphone mixing management
  const updateIncludeMicrophone = useCallback((value: boolean) => {
    setIncludeMicrophone(value);
    try {
      safeLocalStorage.setItem(
        STORAGE_KEYS.SYSTEM_AUDIO_INCLUDE_MICROPHONE,
        value.toString()
      );
    } catch (error) {
      console.error("Failed to save microphone mixing setting:", error);
    }
  }, []);

  // Quick actions management
  const saveQuickActions = useCallback((actions: string[]) => {
    try {
      safeLocalStorage.setItem(
        STORAGE_KEYS.SYSTEM_AUDIO_QUICK_ACTIONS,
        JSON.stringify(actions)
      );
    } catch (error) {
      console.error("Failed to save quick actions:", error);
    }
  }, []);

  const addQuickAction = useCallback(
    (action: string) => {
      if (action && !quickActions.includes(action)) {
        const newActions = [...quickActions, action];
        setQuickActions(newActions);
        saveQuickActions(newActions);
      }
    },
    [quickActions, saveQuickActions]
  );

  const removeQuickAction = useCallback(
    (action: string) => {
      const newActions = quickActions.filter((a) => a !== action);
      setQuickActions(newActions);
      saveQuickActions(newActions);
    },
    [quickActions, saveQuickActions]
  );

  const handleQuickActionClick = async (action: string) => {
    setLastTranscription(action); // Show the action as if it were a transcription
    setError("");

    const effectiveSystemPrompt = useSystemPrompt
      ? systemPrompt || DEFAULT_SYSTEM_PROMPT
      : contextContent || DEFAULT_SYSTEM_PROMPT;

    const previousMessages = buildConversationHistory();

    // Q&A mode: runAIRequest applies the selected provider's history budget.
    await processWithAI(action, effectiveSystemPrompt, previousMessages, "manual");
  };

  // Start continuous recording manually
  const startContinuousRecording = useCallback(async () => {
    try {
      setRecordingProgress(0);
      setError("");

      const deviceId =
        selectedAudioDevices.output !== "default"
          ? selectedAudioDevices.output
          : null;

      // Start a new continuous recording session
      await invoke<string>("start_system_audio_capture", {
        vadConfig: vadConfig,
        deviceId: deviceId,
      });
    } catch (err) {
      console.error("Failed to start continuous recording:", err);
      setError(`Failed to start recording: ${err}`);
    }
  }, [vadConfig, selectedAudioDevices.output]);

  // Ignore current recording (stop without transcription)
  const ignoreContinuousRecording = useCallback(async () => {
    try {
      if (!isContinuousMode || !isRecordingInContinuousMode) return;

      // Stop the capture without processing
      await invoke<string>("stop_system_audio_capture");

      // Reset states
      setRecordingProgress(0);
      setIsProcessing(false);
      setIsRecordingInContinuousMode(false);
    } catch (err) {
      console.error("Failed to ignore recording:", err);
      setError(`Failed to ignore recording: ${err}`);
    }
  }, [isContinuousMode, isRecordingInContinuousMode]);

  // Microphone audio processing function (for dual-track mode)
  const processMicrophoneAudioNow = useCallback(
    async (audioData: Float32Array) => {
      const controller = new AbortController();
      meetingRequestControllersRef.current.add(controller);
      try {
        setIsMicProcessing(true);
        setError("");

        // Convert Float32Array to WAV blob
        const audioBlob = floatArrayToWav(audioData, 16000, "wav");

        const useTalkEchoAPI = await shouldUseTalkEchoAPI();
        if (!selectedSttProvider.provider && !useTalkEchoAPI) {
          setError("No speech provider selected.");
          return;
        }

        const providerConfig = allSttProviders.find(
          (p) => p.id === selectedSttProvider.provider
        );

        if (!providerConfig && !useTalkEchoAPI) {
          setError("Speech provider config not found.");
          return;
        }

        // STT transcription
        const transcription = await fetchSTT({
          provider: providerConfig,
          selectedProvider: selectedSttProvider,
          audio: audioBlob,
          language: sttLanguage,
          signal: controller.signal,
          onDebug: (message) => console.debug(`[meeting][mic-stt] ${message}`),
        });

        if (!transcription.trim()) {
          setError("Received empty transcription from microphone");
          return;
        }

        // AI translation uses recent raw meeting context in the system prompt;
        // prior AI translations are deliberately excluded from message history.
        const basePrompt = useSystemPrompt
          ? systemPrompt || DEFAULT_SYSTEM_PROMPT
          : contextContent || DEFAULT_SYSTEM_PROMPT;

        if (!selectedAIProvider.provider && !useTalkEchoAPI) {
          setError("No AI provider selected.");
          return;
        }

        const aiProvider = allAiProviders.find(
          (p) => p.id === selectedAIProvider.provider
        );
        if (!aiProvider && !useTalkEchoAPI) {
          setError("AI provider config not found.");
          return;
        }

        const providerBudget = getProviderTokenBudget(aiProvider);
        const meetingContext = buildMeetingReferenceContext(
          conversationRef.current.messages,
          Math.min(2_000, Math.floor(providerBudget.historyBudgetTokens / 3))
        );
        const effectiveSystemPrompt = meetingContext.context
          ? `${basePrompt}\n\nMeeting context for reference only (do not answer or retranslate it):\n<meeting_context>\n${meetingContext.context}\n</meeting_context>\nAnswer or translate only the current user utterance.`
          : basePrompt;

        let fullResponse = "";
        try {
          for await (const chunk of fetchAIResponse({
            provider: useTalkEchoAPI ? undefined : aiProvider,
            selectedProvider: selectedAIProvider,
            systemPrompt: effectiveSystemPrompt,
            history: [],
            userMessage: transcription,
            imagesBase64: [],
            signal: controller.signal,
            timeoutMs: 60_000,
            inactivityTimeoutMs: 20_000,
            onRetry: (attempt, reason) => {
              setNotice(`Retrying microphone AI request (${attempt}): ${reason}`);
            },
          })) {
            fullResponse += chunk;
          }
        } catch (aiError: any) {
          console.error("Microphone AI error:", aiError);
          if (!(aiError instanceof RequestFailure && aiError.kind === "cancelled")) {
            setError(formatRequestFailure(aiError));
          }
        }

        // Save to conversation with microphone source
        // Always save the transcription, even if translation fails
        const timestamp = Date.now();
        setConversation((prev) => {
          const nextConversation = {
            ...prev,
            messages: [
              {
                id: generateMessageId("user", timestamp),
                role: "user" as const,
                content: transcription,
                timestamp,
                source: "microphone" as const,
              },
              ...(fullResponse
                ? [
                    {
                      id: generateMessageId("assistant", timestamp + 1),
                      role: "assistant" as const,
                      content: fullResponse,
                      timestamp: timestamp + 1,
                      source: "microphone" as const,
                    },
                  ]
                : []),
              ...prev.messages,
            ],
            updatedAt: timestamp,
            title: prev.title || generateConversationTitle(transcription),
          };
          conversationRef.current = nextConversation;
          return nextConversation;
        });
        setNotice("");
      } catch (err) {
        console.error("Microphone processing error:", err);
        if (!(err instanceof RequestFailure && err.kind === "cancelled")) {
          setError(formatRequestFailure(err));
        }
      } finally {
        meetingRequestControllersRef.current.delete(controller);
        setIsMicProcessing(false);
      }
    },
    [
      selectedSttProvider,
      allSttProviders,
      sttLanguage,
      selectedAIProvider,
      allAiProviders,
      systemPrompt,
      useSystemPrompt,
      contextContent,
    ]
  );

  const processMicrophoneAudio = useCallback(
    async (audioData: Float32Array) => {
      try {
        await meetingQueueRef.current!.enqueue(() =>
          processMicrophoneAudioNow(audioData)
        );
      } catch (error) {
        if (!(error instanceof RequestFailure && error.kind === "cancelled")) {
          setError(formatRequestFailure(error));
        }
      }
    },
    [processMicrophoneAudioNow]
  );

  // Update the ref whenever the processing function changes
  useEffect(() => {
    processMicrophoneAudioRef.current = processMicrophoneAudio;
  }, [processMicrophoneAudio]);

  // AI Processing function
  const runAIRequest = useCallback(
    async (
      transcription: string,
      prompt: string,
      previousMessages: CompletionMessage[],
      source: ChatMessage["source"] = "system_audio"
    ) => {
      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        setIsAIProcessing(true);
        setLastAIResponse("");
        setError("");

        let fullResponse = "";

        const useTalkEchoAPI = await shouldUseTalkEchoAPI();
        if (!selectedAIProvider.provider && !useTalkEchoAPI) {
          setError("No AI provider selected.");
          return;
        }

        const provider = allAiProviders.find(
          (p) => p.id === selectedAIProvider.provider
        );
        if (!provider && !useTalkEchoAPI) {
          setError("AI provider config not found.");
          return;
        }

        // Instant Ask uses a provider-aware recent-history budget. Automatic
        // meeting translation receives a smaller raw-transcript reference in
        // its system prompt and does not resend prior AI translations.
        let history: CompletionMessage[] = [];
        if (source === "manual") {
          const budget = getProviderTokenBudget(provider);
          const fixedTokens =
            estimateTextTokens(prompt) + estimateTextTokens(transcription) + 64;
          const selectedHistory = selectRecentHistory(
            previousMessages,
            Math.max(512, budget.historyBudgetTokens - fixedTokens)
          );
          history = selectedHistory.history as CompletionMessage[];
          if (selectedHistory.omittedMessages > 0) {
            setNotice(
              `Using recent context: ${selectedHistory.omittedMessages} older messages were omitted to stay within the model context window.`
            );
          } else {
            setNotice("");
          }
          console.debug("[meeting][context]", {
            estimatedHistoryTokens: selectedHistory.estimatedTokens,
            omittedMessages: selectedHistory.omittedMessages,
            contextWindowTokens: budget.contextWindowTokens,
          });
        }

        try {
          for await (const chunk of fetchAIResponse({
            provider: useTalkEchoAPI ? undefined : provider,
            selectedProvider: selectedAIProvider,
            systemPrompt: prompt,
            history,
            userMessage: transcription,
            imagesBase64: [],
            signal: controller.signal,
            timeoutMs: 60_000,
            inactivityTimeoutMs: 20_000,
            onRetry: (attempt, reason) => {
              setNotice(`Retrying AI request (${attempt}): ${reason}`);
              console.warn(`[meeting][ai] retry ${attempt}: ${reason}`);
            },
          })) {
            fullResponse += chunk;
            setLastAIResponse((prev) => prev + chunk);
          }
        } catch (aiError: any) {
          if (!controller.signal.aborted) {
            setError(formatRequestFailure(aiError));
          }
        }

        if (!controller.signal.aborted) {
          const timestamp = Date.now();
          setConversation((prev) => {
            const nextConversation = {
              ...prev,
              messages: [
                {
                  id: generateMessageId("user", timestamp),
                  role: "user" as const,
                  content: transcription,
                  timestamp,
                  source: source ?? "system_audio",
                },
                ...(fullResponse
                  ? [
                      {
                        id: generateMessageId("assistant", timestamp + 1),
                        role: "assistant" as const,
                        content: fullResponse,
                        timestamp: timestamp + 1,
                        source: source ?? "system_audio",
                      },
                    ]
                  : []),
                ...prev.messages,
              ],
              updatedAt: timestamp,
              title: prev.title || generateConversationTitle(transcription),
            };
            conversationRef.current = nextConversation;
            return nextConversation;
          });
        }
      } catch (err) {
        if (!(err instanceof RequestFailure && err.kind === "cancelled")) {
          setError(formatRequestFailure(err));
        }
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        setIsAIProcessing(false);
        // No auto-restart - user manually controls when to start next recording
      }
    },
    [selectedAIProvider, allAiProviders]
  );

  // Speech segments can arrive faster than an LLM responds. Preserve every
  // segment and process them in order instead of cancelling the previous one
  // or allowing responses to race into the same UI state.
  const processWithAI = useCallback(
    (
      transcription: string,
      prompt: string,
      previousMessages: CompletionMessage[],
      source: ChatMessage["source"] = "system_audio"
    ) => {
      const generation = aiQueueGenerationRef.current;
      const queuedRequest = aiQueueRef.current.then(async () => {
        if (generation !== aiQueueGenerationRef.current) return;
        await runAIRequest(transcription, prompt, previousMessages, source);
      });

      // Keep the queue usable after a failed request; the caller still receives
      // the original rejection through `queuedRequest`.
      aiQueueRef.current = queuedRequest.catch(() => {});
      return queuedRequest;
    },
    [runAIRequest]
  );

  const sendManualPrompt = useCallback(
    async (promptText: string) => {
      const trimmed = promptText.trim();
      if (!trimmed) return;

      const previousMessages = buildConversationHistory();

      // Q&A mode: manual input with provider-budgeted recent history.
      await processWithAI(
        trimmed,
        DEFAULT_SYSTEM_PROMPT,
        previousMessages,
        "manual"  // Auto-detect: manual source = use history
      );
    },
    [buildConversationHistory, processWithAI]
  );

  const startCapture = useCallback(async () => {
    try {
      setError("");

      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (!hasAccess) {
        setSetupRequired(true);
        setIsPopoverOpen(true);
        return;
      }

      const isContinuous = !vadConfig.enabled;

      // Set up conversation
      const conversationId = generateConversationId("sysaudio");
      const newConversation = {
        id: conversationId,
        title: "",
        messages: [],
        createdAt: 0,
        updatedAt: 0,
      };
      conversationRef.current = newConversation;
      setConversation(newConversation);

      setCapturing(true);
      setIsPopoverOpen(true);
      setIsContinuousMode(isContinuous);
      setRecordingProgress(0);

      // If continuous mode
      if (isContinuous) {
        setIsRecordingInContinuousMode(false);
        return;
      }

      // VAD mode: Start recording immediately
      // Stop any existing capture
      await invoke<string>("stop_system_audio_capture");

      const deviceId =
        selectedAudioDevices.output !== "default"
          ? selectedAudioDevices.output
          : null;

      // Start capture with VAD config
      await invoke<string>("start_system_audio_capture", {
        vadConfig: vadConfig,
        deviceId: deviceId,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setCapturing(false);
      setIsContinuousMode(false);
      setIsRecordingInContinuousMode(false);
      setError(errorMessage);
      setIsPopoverOpen(true);
    }
  }, [vadConfig, selectedAudioDevices.output, includeMicrophone, selectedAudioDevices.input]);

  const stopCapture = useCallback(async () => {
    // Cancel local work first; stopping the UI must not depend on the native
    // capture command succeeding.
    meetingQueueRef.current?.cancelPending();
    for (const controller of meetingRequestControllersRef.current) {
      controller.abort();
    }
    meetingRequestControllersRef.current.clear();
    aiQueueGenerationRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    lastSpeechEventRef.current = { fingerprint: "", receivedAt: 0 };

    let stopError = "";
    try {
      await invoke<string>("stop_system_audio_capture");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      stopError = `Failed to stop native capture: ${errorMessage}`;
      console.error("Stop capture error:", err);
    } finally {
      setCapturing(false);
      setIsProcessing(false);
      setIsAIProcessing(false);
      setIsContinuousMode(false);
      setIsRecordingInContinuousMode(false);
      setRecordingProgress(0);
      setLastTranscription("");
      setLastAIResponse("");
      setError(stopError);
      setNotice("");
    }
  }, []);

  // Manual stop for continuous recording
  const manualStopAndSend = useCallback(async () => {
    try {
      if (!isContinuousMode) {
        console.warn("Not in continuous mode");
        return;
      }

      // Show processing state immediately
      setIsProcessing(true);

      // Trigger manual stop event
      await invoke("manual_stop_continuous");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to manually stop: ${errorMessage}`);
      setIsProcessing(false); // Clear processing state on error
      console.error("Manual stop error:", err);
    }
  }, [isContinuousMode]);

  const handleSetup = useCallback(async () => {
    try {
      const platform = navigator.platform.toLowerCase();

      if (platform.includes("mac") || platform.includes("win")) {
        await invoke("request_system_audio_access");
      }

      // Delay to give the user time to grant permissions in the system dialog.
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (hasAccess) {
        setSetupRequired(false);
        await startCapture();
      } else {
        setSetupRequired(true);
        setError("Permission not granted. Please try the manual steps.");
      }
    } catch (err) {
      setError("Failed to request access. Please try the manual steps below.");
      setSetupRequired(true);
    }
  }, [startCapture]);

  useEffect(() => {
    const shouldAutoOpen =
      capturing ||
      setupRequired ||
      isAIProcessing ||
      !!lastAIResponse ||
      !!error;

    if (shouldAutoOpen) {
      setIsPopoverOpen(true);
    }

    const effectiveOpen = shouldAutoOpen || isPopoverOpen;
    resizeWindow(effectiveOpen);
  }, [
    capturing,
    setupRequired,
    isAIProcessing,
    lastAIResponse,
    error,
    resizeWindow,
    isPopoverOpen,
  ]);

  useEffect(() => {
    globalShortcuts.registerSystemAudioCallback(async () => {
      if (capturing) {
        await stopCapture();
      } else {
        await startCapture();
      }
    });
  }, [startCapture, stopCapture]);

  // Manage microphone stream for audio visualizer
  useEffect(() => {
    const getStream = async () => {
      if (capturing) {
        try {
          const mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          streamRef.current = mediaStream;
          setStream(mediaStream);
        } catch (error) {
          console.error("Failed to get microphone stream:", error);
        }
      } else {
        // Stop all tracks when not capturing
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
        setStream(null);
      }
    };

    getStream();
  }, [capturing]);

  useEffect(() => {
    return () => {
      meetingQueueRef.current?.cancelPending("Meeting overlay closed");
      for (const controller of meetingRequestControllersRef.current) {
        controller.abort();
      }
      meetingRequestControllersRef.current.clear();
      aiQueueGenerationRef.current += 1;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      // Clean up stream on unmount
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      // Microphone VAD cleanup handled by useMicVAD
      invoke("stop_system_audio_capture").catch(() => {});
    };
  }, []);

  // Debounced save to prevent race conditions and improve performance
  useEffect(() => {
    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Only debounce if there are messages to save
    if (
      !conversation.id ||
      conversation.updatedAt === 0 ||
      conversation.messages.length === 0
    ) {
      return;
    }

    // Debounce saves (only save 500ms after last change)
    saveTimeoutRef.current = setTimeout(async () => {
      // Don't save if already saving (prevent concurrent saves)
      if (isSavingRef.current) {
        return;
      }

      try {
        isSavingRef.current = true;
        const conversationForSave = convertConversationForSave();
        await saveConversation(conversationForSave);
      } catch (error) {
        console.error("Failed to save system audio conversation:", error);
      } finally {
        isSavingRef.current = false;
      }
    }, CONVERSATION_SAVE_DEBOUNCE_MS);

    // Cleanup on unmount or dependency change
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [
    conversation.messages.length,
    conversation.title,
    conversation.id,
    conversation.updatedAt,
    convertConversationForSave,
  ]);

  const startNewConversation = useCallback(() => {
    meetingQueueRef.current?.cancelPending("New conversation started");
    for (const controller of meetingRequestControllersRef.current) {
      controller.abort();
    }
    meetingRequestControllersRef.current.clear();
    aiQueueGenerationRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    const newConversation = {
      id: generateConversationId("sysaudio"),
      title: "",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    };
    conversationRef.current = newConversation;
    setConversation(newConversation);
    setLastTranscription("");
    setLastAIResponse("");
    setError("");
    setNotice("");
    setSetupRequired(false);
    setIsProcessing(false);
    setIsAIProcessing(false);
    setUseSystemPrompt(true);
  }, []);

  // Update VAD configuration
  const updateVadConfiguration = useCallback(async (config: VadConfig) => {
    try {
      setVadConfig(config);
      safeLocalStorage.setItem("vad_config", JSON.stringify(config));
      await invoke("update_vad_config", { config });
    } catch (error) {
      console.error("Failed to update VAD config:", error);
    }
  }, []);

  useEffect(() => {
    if (capturing) {
      setIsContinuousMode(!vadConfig.enabled);

      if (!vadConfig.enabled) {
        setIsRecordingInContinuousMode(false);
      }
    }
  }, [vadConfig.enabled, capturing]);

  // Keyboard arrow key support for scrolling (local shortcut)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPopoverOpen) return;

      const scrollElement = scrollAreaRef.current?.querySelector(
        "[data-radix-scroll-area-viewport]"
      ) as HTMLElement;

      if (!scrollElement) return;

      const scrollAmount = 100; // pixels to scroll

      if (e.key === "ArrowDown") {
        e.preventDefault();
        scrollElement.scrollBy({ top: scrollAmount, behavior: "smooth" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        scrollElement.scrollBy({ top: -scrollAmount, behavior: "smooth" });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPopoverOpen]);

  // Keyboard shortcuts for continuous mode recording (local shortcuts)
  useEffect(() => {
    const handleRecordingShortcuts = (e: KeyboardEvent) => {
      if (!isPopoverOpen || !isContinuousMode) return;
      if (isProcessing || isAIProcessing) return;

      // Enter: Start recording (when not recording) or Stop & Send (when recording)
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (!isRecordingInContinuousMode) {
          startContinuousRecording();
        } else {
          manualStopAndSend();
        }
      }

      // Escape: Ignore recording (when recording)
      if (e.key === "Escape" && isRecordingInContinuousMode) {
        e.preventDefault();
        ignoreContinuousRecording();
      }

      // Space: Start recording (when not recording) - only if not typing in input
      if (
        e.key === " " &&
        !isRecordingInContinuousMode &&
        !e.metaKey &&
        !e.ctrlKey &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        startContinuousRecording();
      }
    };

    window.addEventListener("keydown", handleRecordingShortcuts);
    return () =>
      window.removeEventListener("keydown", handleRecordingShortcuts);
  }, [
    isPopoverOpen,
    isContinuousMode,
    isRecordingInContinuousMode,
    isProcessing,
    isAIProcessing,
    startContinuousRecording,
    manualStopAndSend,
    ignoreContinuousRecording,
  ]);

  const micVAD = useMemo(
    () => ({
      listening: micVadListening,
      loading: micVadLoading,
      errored: micVadErrored,
      userSpeaking: micVadUserSpeaking,
      start: startMicVad,
      pause: pauseMicVad,
      toggle: () => {
        if (micVadListening) {
          pauseMicVad();
        } else {
          startMicVad();
        }
      },
    }),
    [
      micVadListening,
      micVadLoading,
      micVadErrored,
      micVadUserSpeaking,
      startMicVad,
      pauseMicVad,
    ]
  );

  return {
    capturing,
    isProcessing,
    isAIProcessing,
    lastTranscription,
    lastAIResponse,
    error,
    notice,
    queueDepth,
    setupRequired,
    startCapture,
    stopCapture,
    handleSetup,
    isPopoverOpen,
    setIsPopoverOpen,
    openConversationPopover,
    closeConversationPopover,
    toggleConversationPopover,
    // Conversation management
    conversation,
    setConversation,
    // AI processing
    processWithAI,
    // Context management
    useSystemPrompt,
    setUseSystemPrompt: updateUseSystemPrompt,
    contextContent,
    setContextContent: updateContextContent,
    startNewConversation,
    // Window resize
    resizeWindow,
    quickActions,
    addQuickAction,
    removeQuickAction,
    isManagingQuickActions,
    setIsManagingQuickActions,
    showQuickActions,
    setShowQuickActions,
    handleQuickActionClick,
    sendManualPrompt,
    // VAD configuration
    vadConfig,
    updateVadConfiguration,
    // Continuous recording
    isContinuousMode,
    isRecordingInContinuousMode,
    recordingProgress,
    manualStopAndSend,
    startContinuousRecording,
    ignoreContinuousRecording,
    // Scroll area ref for keyboard navigation
    scrollAreaRef,
    stream,
    // Microphone dual-track mode
    includeMicrophone,
    setIncludeMicrophone: updateIncludeMicrophone,
    isMicProcessing,
    micVAD,
  };
}
