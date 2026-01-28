import { fetchSTT } from "@/lib";
import { UseCompletionReturn } from "@/types";
import { useMicVAD } from "@ricky0123/vad-react";
import { LoaderCircleIcon, MicIcon, MicOffIcon } from "lucide-react";
import { useState, useRef } from "react";
import { Button } from "@/components";
import { useApp } from "@/contexts";
import { floatArrayToWav } from "@/lib/utils";
import { shouldUseTalkEchoAPI } from "@/lib/functions/talkecho.api";

interface AutoSpeechVADProps {
  submit: UseCompletionReturn["submit"];
  setState: UseCompletionReturn["setState"];
  setEnableVAD: UseCompletionReturn["setEnableVAD"];
  microphoneDeviceId: string;
}

const AutoSpeechVADInternal = ({
  submit,
  setState,
  setEnableVAD,
  microphoneDeviceId,
}: AutoSpeechVADProps) => {
  const [isTranscribing, setIsTranscribing] = useState(false);
  const { selectedSttProvider, allSttProviders } = useApp();
  const lastTranscriptionRef = useRef<string>("");
  const lastTranscriptionTimeRef = useRef<number>(0);

  const audioConstraints: MediaTrackConstraints = microphoneDeviceId
    ? { deviceId: { exact: microphoneDeviceId } }
    : { deviceId: "default" };

  const vad = useMicVAD({
    userSpeakingThreshold: 0.85,
    positiveSpeechThreshold: 0.85,
    negativeSpeechThreshold: 0.5,
    minSpeechFrames: 7,
    preSpeechPadFrames: 1,
    frameSamples: 512,
    startOnLoad: true,
    additionalAudioConstraints: audioConstraints,
    onSpeechEnd: async (audio) => {
      // Prevent concurrent transcription requests
      if (isTranscribing) {
        console.log("🚫 Skipping concurrent transcription request");
        return;
      }

      try {
        // convert float32array to blob
        const audioBlob = floatArrayToWav(audio, 16000, "wav");

        let transcription: string;
        const useTalkEchoAPI = await shouldUseTalkEchoAPI();

        // Check if we have a configured speech provider
        if (!selectedSttProvider.provider && !useTalkEchoAPI) {
          console.warn("No speech provider selected");
          setState((prev: any) => ({
            ...prev,
            error:
              "No speech provider selected. Please select one in settings.",
          }));
          return;
        }

        const providerConfig = allSttProviders.find(
          (p) => p.id === selectedSttProvider.provider
        );

        if (!providerConfig && !useTalkEchoAPI) {
          console.warn("Selected speech provider configuration not found");
          setState((prev: any) => ({
            ...prev,
            error:
              "Speech provider configuration not found. Please check your settings.",
          }));
          return;
        }

        setIsTranscribing(true);

        // Use the fetchSTT function for all providers
        transcription = await fetchSTT({
          provider: useTalkEchoAPI ? undefined : providerConfig,
          selectedProvider: selectedSttProvider,
          audio: audioBlob,
        });

        if (transcription) {
          // Deduplicate: Skip if same transcription within 3 seconds
          const now = Date.now();
          const timeSinceLastTranscription = now - lastTranscriptionTimeRef.current;

          if (
            transcription === lastTranscriptionRef.current &&
            timeSinceLastTranscription < 3000
          ) {
            console.log(`🚫 Skipping duplicate transcription: "${transcription}" (${timeSinceLastTranscription}ms ago)`);
            return;
          }

          // Update refs
          lastTranscriptionRef.current = transcription;
          lastTranscriptionTimeRef.current = now;

          submit(transcription);
        }
      } catch (error) {
        console.error("Failed to transcribe audio:", error);
        setState((prev: any) => ({
          ...prev,
          error:
            error instanceof Error ? error.message : "Transcription failed",
        }));
      } finally {
        setIsTranscribing(false);
      }
    },
  });

  return (
    <>
      <Button
        size="icon"
        onClick={() => {
          if (vad.listening) {
            vad.pause();
            setEnableVAD(false);
          } else {
            vad.start();
            setEnableVAD(true);
          }
        }}
        className="cursor-pointer"
      >
        {isTranscribing ? (
          <LoaderCircleIcon className="h-4 w-4 animate-spin text-green-500" />
        ) : vad.userSpeaking ? (
          <LoaderCircleIcon className="h-4 w-4 animate-spin" />
        ) : vad.listening ? (
          <MicOffIcon className="h-4 w-4 animate-pulse" />
        ) : (
          <MicIcon className="h-4 w-4" />
        )}
      </Button>
    </>
  );
};

export const AutoSpeechVAD = (props: AutoSpeechVADProps) => {
  return <AutoSpeechVADInternal key={props.microphoneDeviceId} {...props} />;
};


