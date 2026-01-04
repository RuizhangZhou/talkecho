import { Header } from "@/components";
import { MicrophoneMix } from "@/pages/app/components/speech/MicrophoneMix";
import { Context } from "@/pages/app/components/speech/Context";
import { VadConfigPanel } from "@/pages/app/components/speech/VadConfigPanel";
import { useState, useEffect, useCallback } from "react";
import { safeLocalStorage } from "@/lib";
import { emit } from "@tauri-apps/api/event";
import { STORAGE_KEYS } from "@/config";
import { invoke } from "@tauri-apps/api/core";
import type { VadConfig } from "@/hooks/useAudioOverlay";
import { DEFAULT_VAD_CONFIG, LEGACY_DEFAULT_VAD_CONFIG } from "@/hooks/useAudioOverlay";

const isLegacyDefaultVadConfig = (config: VadConfig) =>
  config.enabled === LEGACY_DEFAULT_VAD_CONFIG.enabled &&
  config.hop_size === LEGACY_DEFAULT_VAD_CONFIG.hop_size &&
  config.sensitivity_rms === LEGACY_DEFAULT_VAD_CONFIG.sensitivity_rms &&
  config.peak_threshold === LEGACY_DEFAULT_VAD_CONFIG.peak_threshold &&
  config.silence_chunks === LEGACY_DEFAULT_VAD_CONFIG.silence_chunks &&
  config.min_speech_chunks === LEGACY_DEFAULT_VAD_CONFIG.min_speech_chunks &&
  config.pre_speech_chunks === LEGACY_DEFAULT_VAD_CONFIG.pre_speech_chunks &&
  config.noise_gate_threshold === LEGACY_DEFAULT_VAD_CONFIG.noise_gate_threshold &&
  config.max_recording_duration_secs ===
    LEGACY_DEFAULT_VAD_CONFIG.max_recording_duration_secs;

export const SystemAudioSettings = () => {
  // State for microphone mixing
  const [includeMicrophone, setIncludeMicrophoneState] = useState<boolean>(false);

  // State for context
  const [useSystemPrompt, setUseSystemPromptState] = useState<boolean>(true);
  const [contextContent, setContextContentState] = useState<string>("");

  // State for VAD config
  const [vadConfig, setVadConfigState] = useState<VadConfig>(DEFAULT_VAD_CONFIG);

  // Load settings from localStorage on mount
  useEffect(() => {
    // Load microphone setting
    const savedIncludeMic = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_INCLUDE_MICROPHONE
    );
    if (savedIncludeMic !== null) {
      setIncludeMicrophoneState(savedIncludeMic === "true");
    }

    // Load context settings
    const savedContext = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT
    );
    if (savedContext) {
      try {
        const parsed = JSON.parse(savedContext);
        setUseSystemPromptState(parsed.useSystemPrompt ?? true);
        setContextContentState(parsed.contextContent ?? "");
      } catch (error) {
        console.error("Failed to load context settings:", error);
      }
    }

    // Load VAD config
    const savedVadConfig = safeLocalStorage.getItem("vad_config");
    if (savedVadConfig) {
      try {
        const parsed = JSON.parse(savedVadConfig) as Partial<VadConfig>;
        const normalized: VadConfig = { ...DEFAULT_VAD_CONFIG, ...parsed };
        const shouldMigrate = isLegacyDefaultVadConfig(normalized);
        const nextConfig = shouldMigrate ? { ...DEFAULT_VAD_CONFIG } : normalized;

        setVadConfigState(nextConfig);

        if (shouldMigrate) {
          safeLocalStorage.setItem("vad_config", JSON.stringify(nextConfig));
          emit("vadConfigChanged", { config: nextConfig }).catch((error) => {
            console.error("Failed to emit vadConfigChanged event:", error);
          });
          invoke("update_vad_config", { config: nextConfig }).catch((error) => {
            console.error("Failed to invoke update_vad_config:", error);
          });
        }
      } catch (error) {
        console.error("Failed to load VAD config:", error);
      }
    }
  }, []);

  // Update functions that save to localStorage
  const setIncludeMicrophone = useCallback((value: boolean) => {
    setIncludeMicrophoneState(value);
    safeLocalStorage.setItem(
      STORAGE_KEYS.SYSTEM_AUDIO_INCLUDE_MICROPHONE,
      value.toString()
    );
    // Emit Tauri event so other windows (e.g. system audio overlay) can react
    emit("includeMicrophoneChanged", { value }).catch((error) => {
      console.error("Failed to emit includeMicrophoneChanged event:", error);
    });
  }, []);

  const setUseSystemPrompt = useCallback((value: boolean) => {
    setUseSystemPromptState(value);
    const contextSettings = {
      useSystemPrompt: value,
      contextContent: contextContent,
    };
    safeLocalStorage.setItem(
      STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT,
      JSON.stringify(contextSettings)
    );
  }, [contextContent]);

  const setContextContent = useCallback((content: string) => {
    setContextContentState(content);
    const contextSettings = {
      useSystemPrompt: useSystemPrompt,
      contextContent: content,
    };
    safeLocalStorage.setItem(
      STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT,
      JSON.stringify(contextSettings)
    );
  }, [useSystemPrompt]);

  const updateVadConfiguration = useCallback((config: VadConfig) => {
    setVadConfigState(config);
    safeLocalStorage.setItem("vad_config", JSON.stringify(config));

    // Keep the running overlay + backend capture in sync (cross-window).
    emit("vadConfigChanged", { config }).catch((error) => {
      console.error("Failed to emit vadConfigChanged event:", error);
    });
    invoke("update_vad_config", { config }).catch((error) => {
      console.error("Failed to invoke update_vad_config:", error);
    });
  }, []);

  // Get microphone device name
  const getMicrophoneDeviceName = () => {
    return undefined; // Will show "Default Microphone"
  };

  return (
    <div className="space-y-4">
      <Header
        title="Audio Capture Settings"
        description="Configure audio capture, voice detection, and AI context settings"
      />

      {/* Include Microphone - Top Level Setting */}
      <div className="border rounded-lg p-4">
        <MicrophoneMix
          includeMicrophone={includeMicrophone}
          setIncludeMicrophone={setIncludeMicrophone}
          microphoneDeviceName={getMicrophoneDeviceName()}
        />
      </div>

      {/* Context Settings */}
      <div className="border rounded-lg p-4">
        <Context
          useSystemPrompt={useSystemPrompt}
          setUseSystemPrompt={setUseSystemPrompt}
          contextContent={contextContent}
          setContextContent={setContextContent}
        />
      </div>

      {/* VAD Configuration */}
      <div className="border rounded-lg p-4">
        <VadConfigPanel vadConfig={vadConfig} onUpdate={updateVadConfiguration} />
      </div>
    </div>
  );
};
