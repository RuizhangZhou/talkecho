import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useWindowResize, useGlobalShortcuts } from ".";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/contexts";
import { fetchSTT, fetchAIResponse } from "@/lib/functions";
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
// Higher = stricter detection of user speech for microphone VAD
const DEFAULT_USER_SPEAKING_THRESHOLD = 0.85;

// Mic VAD tuning (front-end @ricky0123/vad-web)
// These are conservative defaults to reduce false positives
const MIC_VAD_TUNING = {
  positiveSpeechThreshold: 0.85,
  negativeSpeechThreshold: 0.5,
  minSpeechFrames: 7,
  preSpeechPadFrames: 1,
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
    selectedAIProvider,
    allAiProviders,
    systemPrompt,
    selectedAudioDevices,
  } = useApp();
  const abortControllerRef = useRef<AbortController | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isSavingRef = useRef<boolean>(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

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

  const microphoneRedemptionFrames = useMemo(() => {
    const frameDuration = MIC_VAD_FRAME_SAMPLES / MIC_VAD_SAMPLE_RATE;
    return Math.max(1, Math.round(microphoneSilenceSeconds / frameDuration));
  }, [microphoneSilenceSeconds]);

  const microphoneRedemptionFramesRef = useRef(microphoneRedemptionFrames);
  useEffect(() => {
    microphoneRedemptionFramesRef.current = microphoneRedemptionFrames;
    if (micVadInstanceRef.current) {
      micVadInstanceRef.current.setOptions({
        redemptionFrames: microphoneRedemptionFrames,
      });
    }
  }, [microphoneRedemptionFrames]);

  useEffect(() => {
    let canceled = false;
    setMicVadLoading(true);
    setMicVadErrored(false);

    const initializeMicVAD = async () => {
      try {
        const vad = await MicVAD.new({
          additionalAudioConstraints: audioConstraints,
          frameSamples: MIC_VAD_FRAME_SAMPLES,
          positiveSpeechThreshold: MIC_VAD_TUNING.positiveSpeechThreshold,
          negativeSpeechThreshold: MIC_VAD_TUNING.negativeSpeechThreshold,
          minSpeechFrames: MIC_VAD_TUNING.minSpeechFrames,
          preSpeechPadFrames: MIC_VAD_TUNING.preSpeechPadFrames,
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
        vad.setOptions({ redemptionFrames: microphoneRedemptionFramesRef.current });
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
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      try {
        unlisten = await listen<{ value: boolean }>("includeMicrophoneChanged", (event) => {
          const newValue = event.payload?.value;
          if (typeof newValue === "boolean") {
            setIncludeMicrophone(newValue);
          }
        });
      } catch (error) {
        console.error("Failed to listen for includeMicrophoneChanged event:", error);
      }
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      try {
        unlisten = await listen<{ config: VadConfig }>(
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
      } catch (error) {
        console.error("Failed to listen for vadConfigChanged event:", error);
      }
    };

    setupListener();

    return () => {
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
    let progressUnlisten: (() => void) | undefined;
    let startUnlisten: (() => void) | undefined;
    let stopUnlisten: (() => void) | undefined;
    let errorUnlisten: (() => void) | undefined;
    let discardedUnlisten: (() => void) | undefined;

    const setupContinuousListeners = async () => {
      try {
        // Progress updates (every second)
        progressUnlisten = await listen("recording-progress", (event) => {
          const seconds = event.payload as number;
          setRecordingProgress(seconds);
        });

        // Recording started
        startUnlisten = await listen("continuous-recording-start", () => {
          setRecordingProgress(0);
          setIsRecordingInContinuousMode(true);
        });

        // Recording stopped
        stopUnlisten = await listen("continuous-recording-stopped", () => {
          setRecordingProgress(0);
          setIsRecordingInContinuousMode(false);
        });

        // Audio encoding errors
        errorUnlisten = await listen("audio-encoding-error", (event) => {
          const errorMsg = event.payload as string;
          console.error("Audio encoding error:", errorMsg);
          setError(`Failed to process audio: ${errorMsg}`);
          setIsProcessing(false);
          setIsAIProcessing(false);
          setIsRecordingInContinuousMode(false);
        });

        // Speech discarded (too short)
        discardedUnlisten = await listen("speech-discarded", () => {
          // Don't show error - this is expected behavior
        });
      } catch (err) {
        console.error("Failed to setup continuous recording listeners:", err);
      }
    };

    setupContinuousListeners();

    return () => {
      if (progressUnlisten) progressUnlisten();
      if (startUnlisten) startUnlisten();
      if (stopUnlisten) stopUnlisten();
      if (errorUnlisten) errorUnlisten();
      if (discardedUnlisten) discardedUnlisten();
    };
  }, []);

  // Handle single speech detection event (both VAD and continuous modes)
  useEffect(() => {
    let speechUnlisten: (() => void) | undefined;

    const setupEventListener = async () => {
      try {
        speechUnlisten = await listen("speech-detected", async (event) => {
          try {
            if (!capturing) return;

            const base64Audio = event.payload as string;

            // Convert to blob (system audio only, microphone handled separately)
            const binaryString = atob(base64Audio);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            const audioBlob = new Blob([bytes], { type: "audio/wav" });

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

            setIsProcessing(true);

            // Add timeout wrapper for STT request (30 seconds)
            const sttPromise = fetchSTT({
              provider: providerConfig,
              selectedProvider: selectedSttProvider,
              audio: audioBlob,
            });

            const timeoutPromise = new Promise<string>((_, reject) => {
              setTimeout(
                () => reject(new Error("Speech transcription timed out (30s)")),
                30000
              );
            });

            try {
              const transcription = await Promise.race([
                sttPromise,
                timeoutPromise,
              ]);

              if (transcription.trim()) {
                setLastTranscription(transcription);
                setError("");

                const effectiveSystemPrompt = useSystemPrompt
                  ? systemPrompt || DEFAULT_SYSTEM_PROMPT
                  : contextContent || DEFAULT_SYSTEM_PROMPT;

                const previousMessages = buildConversationHistory();

                // Real-time STT: auto-triggered, stateless (no history needed)
                await processWithAI(
                  transcription,
                  effectiveSystemPrompt,
                  previousMessages,
                  "system_audio"  // Auto-detect: STT source = no history
                );
              } else {
                setError("Received empty transcription");
              }
            } catch (sttError: any) {
              console.error("STT Error:", sttError);
              setError(sttError.message || "Failed to transcribe audio");
              setIsPopoverOpen(true);
            }
          } catch (err) {
            setError("Failed to process speech");
          } finally {
            setIsProcessing(false);
          }
        });
      } catch (err) {
        setError("Failed to setup speech listener");
      }
    };

    setupEventListener();

    return () => {
      if (speechUnlisten) speechUnlisten();
    };
  }, [
    capturing,
    selectedSttProvider,
    allSttProviders,
    conversation.messages.length,
    includeMicrophone,
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

    // Q&A mode: manual input with full conversation history
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
  const processMicrophoneAudio = useCallback(
    async (audioData: Float32Array) => {
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
        });

        if (!transcription.trim()) {
          setError("Received empty transcription from microphone");
          return;
        }

        // AI translation (independent, no history needed for translation)
        const effectiveSystemPrompt = useSystemPrompt
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

        let fullResponse = "";
        try {
          for await (const chunk of fetchAIResponse({
            provider: useTalkEchoAPI ? undefined : aiProvider,
            selectedProvider: selectedAIProvider,
            systemPrompt: effectiveSystemPrompt,
            history: [], // No history for independent translation
            userMessage: transcription,
            imagesBase64: [],
          })) {
            fullResponse += chunk;
          }
        } catch (aiError: any) {
          console.error("Microphone AI error:", aiError);
          setError(aiError.message || "Failed to get AI response for microphone");
        }

        // Save to conversation with microphone source
        // Always save the transcription, even if translation fails
        const timestamp = Date.now();
        setConversation((prev) => ({
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
        }));
      } catch (err) {
        console.error("Microphone processing error:", err);
        setError("Failed to process microphone audio");
      } finally {
        setIsMicProcessing(false);
      }
    },
    [
      selectedSttProvider,
      allSttProviders,
      selectedAIProvider,
      allAiProviders,
      systemPrompt,
      useSystemPrompt,
      contextContent,
    ]
  );

  // Update the ref whenever the processing function changes
  useEffect(() => {
    processMicrophoneAudioRef.current = processMicrophoneAudio;
  }, [processMicrophoneAudio]);

  // AI Processing function
  const processWithAI = useCallback(
    async (
      transcription: string,
      prompt: string,
      previousMessages: CompletionMessage[],
      source: ChatMessage["source"] = "system_audio"
    ) => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      abortControllerRef.current = new AbortController();

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

        // Auto-detect: only "manual" input needs history, all STT-triggered sources are stateless
        const useHistory = source === "manual";

        // Limit history tokens for manual Q&A to avoid context overflow
        // Simple estimation: 1 token ≈ 4 characters, limit to ~4000 tokens = 16000 chars
        const MAX_HISTORY_CHARS = 16000;
        let filteredHistory: CompletionMessage[] = [];

        if (useHistory && previousMessages.length > 0) {
          let totalChars = 0;
          // Take messages from most recent (reversed order already) until we hit the limit
          for (const msg of previousMessages) {
            const msgChars = msg.content.length;
            if (totalChars + msgChars > MAX_HISTORY_CHARS) {
              break;
            }
            filteredHistory.push(msg);
            totalChars += msgChars;
          }
        }

        try {
          for await (const chunk of fetchAIResponse({
            provider: useTalkEchoAPI ? undefined : provider,
            selectedProvider: selectedAIProvider,
            systemPrompt: prompt,
            history: useHistory ? filteredHistory : [],  // Stateless for STT, with limited history for manual Q&A
            userMessage: transcription,
            imagesBase64: [],
          })) {
            fullResponse += chunk;
            setLastAIResponse((prev) => prev + chunk);
          }
        } catch (aiError: any) {
          setError(aiError.message || "Failed to get AI response");
        }

        if (fullResponse) {
          const timestamp = Date.now();
          setConversation((prev) => ({
            ...prev,
            messages: [
              {
                id: generateMessageId("user", timestamp),
                role: "user" as const,
                content: transcription,
                timestamp,
                source: source ?? "system_audio",
              },
              {
                id: generateMessageId("assistant", timestamp + 1),
                role: "assistant" as const,
                content: fullResponse,
                timestamp: timestamp + 1,
                source: source ?? "system_audio",
              },
              ...prev.messages,
            ],
            updatedAt: timestamp,
            title: prev.title || generateConversationTitle(transcription),
          }));
        }
      } catch (err) {
        setError("Failed to get AI response");
      } finally {
        setIsAIProcessing(false);
        // No auto-restart - user manually controls when to start next recording
      }
    },
    [selectedAIProvider, allAiProviders, conversation.messages]
  );

  const sendManualPrompt = useCallback(
    async (promptText: string) => {
      const trimmed = promptText.trim();
      if (!trimmed) return;

      const previousMessages = buildConversationHistory();

      // Q&A mode: manual input with full conversation history
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
      setConversation({
        id: conversationId,
        title: "",
        messages: [],
        createdAt: 0,
        updatedAt: 0,
      });

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
      setError(errorMessage);
      setIsPopoverOpen(true);
    }
  }, [vadConfig, selectedAudioDevices.output, includeMicrophone, selectedAudioDevices.input]);

  const stopCapture = useCallback(async () => {
    try {
      // Abort any ongoing AI requests
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }

      // Stop the audio capture
      await invoke<string>("stop_system_audio_capture");

      // Reset ALL states
      setCapturing(false);
      setIsProcessing(false);
      setIsAIProcessing(false);
      setIsContinuousMode(false);
      setIsRecordingInContinuousMode(false);
      setRecordingProgress(0);
      setLastTranscription("");
      setLastAIResponse("");
      setError("");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to stop capture: ${errorMessage}`);
      console.error("Stop capture error:", err);
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
    setConversation({
      id: generateConversationId("sysaudio"),
      title: "",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    });
    setLastTranscription("");
    setLastAIResponse("");
    setError("");
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
