import { useState, useEffect } from "react";
import { Button, Card, Label, Slider, Switch } from "@/components";
import { ArrowDownIcon, ArrowUpIcon, SettingsIcon } from "lucide-react";
import { VadConfig } from "@/hooks/useSystemAudio";

interface VadConfigPanelProps {
  vadConfig: VadConfig;
  onUpdate: (config: VadConfig) => void;
}

// Recommended presets for different scenarios
const PRESETS = {
  quiet: {
    name: "Quiet Environment",
    description: "More sensitive, picks up quiet speech",
    config: {
      sensitivity_rms: 0.008,
      noise_gate_threshold: 0.002,
      silence_chunks: 35,
    },
  },
  normal: {
    name: "Normal (Recommended)",
    description: "Balanced for most environments",
    config: {
      sensitivity_rms: 0.012,
      noise_gate_threshold: 0.003,
      silence_chunks: 45,
    },
  },
  noisy: {
    name: "Noisy Environment",
    description: "Less sensitive, reduces false positives",
    config: {
      sensitivity_rms: 0.020,
      noise_gate_threshold: 0.005,
      silence_chunks: 55,
    },
  },
};

export const VadConfigPanel = ({
  vadConfig,
  onUpdate,
}: VadConfigPanelProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [localConfig, setLocalConfig] = useState(vadConfig);

  useEffect(() => {
    setLocalConfig(vadConfig);
  }, [vadConfig]);

  const handleUpdate = (updates: Partial<VadConfig>) => {
    const newConfig = { ...localConfig, ...updates };
    setLocalConfig(newConfig);
    onUpdate(newConfig);
  };

  const applyPreset = (presetConfig: Partial<VadConfig>) => {
    handleUpdate(presetConfig);
  };

  return (
    <div className="space-y-2">
      <div
        className="flex items-center justify-between cursor-pointer p-2 hover:bg-accent/50 rounded-md transition-colors"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center gap-2">
          <SettingsIcon className="w-4 h-4 text-muted-foreground" />
          <div>
            <h3 className="font-semibold text-sm">Audio Detection Settings</h3>
            <p className="text-xs text-muted-foreground">
              {localConfig.enabled
                ? "Voice Activity Detection enabled"
                : `Continuous recording (max ${
                    localConfig.max_recording_duration_secs / 60
                  } min)`}
            </p>
          </div>
        </div>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
          {isOpen ? (
            <ArrowUpIcon className="w-4 h-4" />
          ) : (
            <ArrowDownIcon className="w-4 h-4" />
          )}
        </Button>
      </div>

      {isOpen && (
        <Card className="p-4 space-y-4 bg-muted/30">
          {/* VAD Enable/Disable */}
          <div className="flex items-center justify-between gap-4 pb-3 border-b border-border/50">
            <div>
              <Label className="text-sm font-medium">
                Voice Activity Detection (VAD)
              </Label>
              <p className="text-xs text-muted-foreground mt-1">
                {localConfig.enabled
                  ? "Automatically detect and capture speech"
                  : "Record continuously up to maximum duration"}
              </p>
            </div>
            <Switch
              checked={localConfig.enabled}
              onCheckedChange={(enabled) => handleUpdate({ enabled })}
            />
          </div>

          {localConfig.enabled ? (
            <>
              {/* Presets */}
              <div className="space-y-2">
                <Label className="text-xs font-medium">Quick Presets</Label>
                <div className="grid grid-cols-3 gap-2">
                  {Object.entries(PRESETS).map(([key, preset]) => (
                    <Button
                      key={key}
                      size="sm"
                      variant="outline"
                      onClick={() => applyPreset(preset.config)}
                      className="flex flex-col h-auto py-2 text-xs"
                      title={preset.description}
                    >
                      <span className="font-medium">{preset.name}</span>
                      <span className="text-[10px] text-muted-foreground opacity-70">
                        {preset.description}
                      </span>
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground bg-blue-500/10 p-2 rounded-md border border-blue-500/20">
                  💡 <strong>Tip:</strong> If you're getting false
                  transcriptions, try the "Noisy Environment" preset to reduce
                  sensitivity.
                </p>
              </div>
              {/* Sensitivity */}
              <div className="space-y-2">
                <Label className="text-xs font-medium flex items-center justify-between">
                  <span>Speech Sensitivity</span>
                  <span className="text-muted-foreground font-normal">
                    {(localConfig.sensitivity_rms * 1000).toFixed(1)}
                  </span>
                </Label>
                <Slider
                  value={[localConfig.sensitivity_rms * 1000]}
                  onValueChange={([value]) =>
                    handleUpdate({ sensitivity_rms: value / 1000 })
                  }
                  min={1}
                  max={10}
                  step={0.5}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">
                  Lower = more sensitive (picks up quieter sounds)
                </p>
              </div>

              {/* Silence Duration */}
              <div className="space-y-2">
                <Label className="text-xs font-medium flex items-center justify-between">
                  <span>Silence Duration to End Speech</span>
                  <span className="text-muted-foreground font-normal">
                    {(
                      (localConfig.silence_chunks * localConfig.hop_size) /
                      44100
                    ).toFixed(1)}
                    s
                  </span>
                </Label>
                <Slider
                  value={[localConfig.silence_chunks]}
                  onValueChange={([value]) =>
                    handleUpdate({ silence_chunks: Math.round(value) })
                  }
                  min={10}
                  max={180}
                  step={5}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">
                  How long to wait after speech stops before processing
                </p>
              </div>

              {/* Noise Gate */}
              <div className="space-y-2">
                <Label className="text-xs font-medium flex items-center justify-between">
                  <span>Background Noise Reduction</span>
                  <span className="text-muted-foreground font-normal">
                    {(localConfig.noise_gate_threshold * 1000).toFixed(1)}
                  </span>
                </Label>
                <Slider
                  value={[localConfig.noise_gate_threshold * 1000]}
                  onValueChange={([value]) =>
                    handleUpdate({ noise_gate_threshold: value / 1000 })
                  }
                  min={0}
                  max={5}
                  step={0.1}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">
                  Filters out low-level background noise
                </p>
              </div>
            </>
          ) : (
            <>
              {/* Max Recording Duration */}
              <div className="space-y-2">
                <Label className="text-xs font-medium flex items-center justify-between">
                  <span>Maximum Recording Duration</span>
                  <span className="text-muted-foreground font-normal">
                    {localConfig.max_recording_duration_secs / 60} minutes
                  </span>
                </Label>
                <Slider
                  value={[localConfig.max_recording_duration_secs / 60]}
                  onValueChange={([value]) =>
                    handleUpdate({
                      max_recording_duration_secs: Math.round(value * 60),
                    })
                  }
                  min={1}
                  max={3}
                  step={0.5}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">
                  Recording will automatically stop after this duration (max 3
                  minutes)
                </p>
              </div>

              {/* Noise Gate for continuous mode */}
              <div className="space-y-2">
                <Label className="text-xs font-medium flex items-center justify-between">
                  <span>Background Noise Reduction</span>
                  <span className="text-muted-foreground font-normal">
                    {(localConfig.noise_gate_threshold * 1000).toFixed(1)}
                  </span>
                </Label>
                <Slider
                  value={[localConfig.noise_gate_threshold * 1000]}
                  onValueChange={([value]) =>
                    handleUpdate({ noise_gate_threshold: value / 1000 })
                  }
                  min={0}
                  max={5}
                  step={0.1}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">
                  Filters out low-level background noise
                </p>
              </div>
            </>
          )}

          {/* Reset Button */}
          <div className="pt-2 border-t border-border/50">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const defaultConfig: VadConfig = {
                  enabled: true,
                  hop_size: 1024,
                  sensitivity_rms: 0.012,
                  peak_threshold: 0.035,
                  silence_chunks: 45,
                  min_speech_chunks: 7,
                  pre_speech_chunks: 12,
                  noise_gate_threshold: 0.003,
                  max_recording_duration_secs: 180, // 3 minutes
                };
                setLocalConfig(defaultConfig);
                onUpdate(defaultConfig);
              }}
              className="w-full"
            >
              Reset to Defaults
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
};
