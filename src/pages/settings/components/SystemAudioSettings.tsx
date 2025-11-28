import { Header } from "@/components";
import { MicrophoneMix } from "@/pages/app/components/speech/MicrophoneMix";
import { Context } from "@/pages/app/components/speech/Context";
import { VadConfigPanel } from "@/pages/app/components/speech/VadConfigPanel";
import { useState, useEffect, useCallback } from "react";
import { safeLocalStorage } from "@/lib";
import { STORAGE_KEYS } from "@/config";
import type { VadConfig } from "@/hooks/useSystemAudio";

// Default VAD configuration (same as in useSystemAudio)
const DEFAULT_VAD_CONFIG: VadConfig = {
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
        const parsed = JSON.parse(savedVadConfig);
        setVadConfigState(parsed);
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
  }, []);

  // Get microphone device name
  const getMicrophoneDeviceName = () => {
    return undefined; // Will show "Default Microphone"
  };

  return (
    <div className="space-y-4 border rounded-lg p-4">
      <Header
        title="System Audio"
        description="Configure system audio capture settings"
      />

      {/* Microphone Mixing */}
      <div className="space-y-2">
        <MicrophoneMix
          includeMicrophone={includeMicrophone}
          setIncludeMicrophone={setIncludeMicrophone}
          microphoneDeviceName={getMicrophoneDeviceName()}
        />
      </div>

      {/* Context Settings */}
      <div className="space-y-2">
        <Context
          useSystemPrompt={useSystemPrompt}
          setUseSystemPrompt={setUseSystemPrompt}
          contextContent={contextContent}
          setContextContent={setContextContent}
        />
      </div>

      {/* VAD Configuration */}
      <div className="space-y-2">
        <VadConfigPanel vadConfig={vadConfig} onUpdate={updateVadConfiguration} />
      </div>
    </div>
  );
};
