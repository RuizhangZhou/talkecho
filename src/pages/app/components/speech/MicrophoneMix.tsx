import { Switch, Header } from "@/components";
import { MicIcon } from "lucide-react";

interface MicrophoneMixProps {
  includeMicrophone: boolean;
  setIncludeMicrophone: (value: boolean) => void;
  microphoneDeviceName?: string;
}

export const MicrophoneMix = ({
  includeMicrophone,
  setIncludeMicrophone,
  microphoneDeviceName,
}: MicrophoneMixProps) => {
  return (
    <div className="space-y-3 border rounded-lg p-4 bg-muted/30">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-3 flex-1">
          <MicIcon className="w-5 h-5 mt-0.5 text-primary" />
          <div className="flex-1">
            <Header
              title="Include Microphone"
              description={
                includeMicrophone
                  ? `Capturing system audio + microphone input${
                      microphoneDeviceName
                        ? ` (${microphoneDeviceName})`
                        : ""
                    }`
                  : "Enable to mix your microphone input with system audio for complete conversation recording"
              }
            />
          </div>
        </div>
        <Switch
          checked={includeMicrophone}
          onCheckedChange={setIncludeMicrophone}
        />
      </div>

      {includeMicrophone && (
        <div className="space-y-2">
          <div className="text-xs text-green-600 bg-green-500/10 p-3 rounded-md">
            <strong>✅ Dual-Track Mode Enabled!</strong>
            <br />
            <br />
            <strong>Chat-style display:</strong>
            <br />
            • <strong>Left (Others):</strong> System audio → Auto-detected, transcribed & translated
            <br />
            • <strong>Right (You):</strong> Microphone → Auto-detected, transcribed & translated
            <br />
            <br />
            Messages are displayed in chronological order, just like a chat app!
          </div>
          <div className="text-xs text-blue-600 bg-blue-500/10 p-3 rounded-md">
            <strong>💡 How it works:</strong> Each side has its own VAD (Voice Activity Detection)
            to automatically detect speech, cut, transcribe (STT), and translate (AI).
            Original text and translation are shown together for each message.
          </div>
        </div>
      )}
    </div>
  );
};
