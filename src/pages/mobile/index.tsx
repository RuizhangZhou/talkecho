import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMicVAD } from "@ricky0123/vad-react";
import { MicIcon, MicOffIcon, SettingsIcon, Volume2Icon, VolumeXIcon } from "lucide-react";

import { Button, Input } from "@/components";
import { useApp } from "@/contexts";
import { DEFAULT_SYSTEM_PROMPT } from "@/config";
import { fetchAIResponse, fetchSTT } from "@/lib";
import { floatArrayToWav } from "@/lib/utils";
import { shouldUseTalkEchoAPI } from "@/lib/functions/talkecho.api";

const DEFAULT_MOBILE_PROMPT =
  "You are a real-time translation assistant. Translate the user's speech into clear, natural text. Be concise and quick.";

export default function MobileTranslation() {
  const {
    selectedSttProvider,
    allSttProviders,
    selectedAIProvider,
    allAiProviders,
    systemPrompt,
    sttLanguage,
    onSetSelectedAIProvider,
    onSetSelectedSttProvider,
  } = useApp();

  const [groqApiKey, setGroqApiKey] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastTranscription, setLastTranscription] = useState("");
  const [lastTranslation, setLastTranslation] = useState("");
  const [error, setError] = useState("");
  const [isMuted, setIsMuted] = useState(false);

  const isListeningRef = useRef(false);
  const isProcessingRef = useRef(false);

  useEffect(() => {
    isListeningRef.current = isListening;
  }, [isListening]);

  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  useEffect(() => {
    if (selectedAIProvider.provider === "groq") {
      setGroqApiKey(selectedAIProvider.variables?.api_key || "");
    }
  }, [selectedAIProvider.provider, selectedAIProvider.variables]);

  const effectiveSystemPrompt = useMemo(() => {
    return systemPrompt?.trim() ? systemPrompt : DEFAULT_MOBILE_PROMPT;
  }, [systemPrompt]);

  const processAudio = useCallback(
    async (audio: Float32Array) => {
      if (!isListeningRef.current || isProcessingRef.current) {
        return;
      }

      setIsProcessing(true);
      setError("");

      try {
        const audioBlob = floatArrayToWav(audio, 16000, "wav");

        const useTalkEchoAPI = await shouldUseTalkEchoAPI();
        const sttProviderConfig = allSttProviders.find(
          (p) => p.id === selectedSttProvider.provider
        );

        if (!selectedSttProvider.provider && !useTalkEchoAPI) {
          setError("请先配置 STT provider（Settings 里选一个，或先用 Groq Quickstart）。");
          return;
        }
        if (!sttProviderConfig && !useTalkEchoAPI) {
          setError("STT provider 配置不存在，请检查 Settings。");
          return;
        }

        const transcription = await fetchSTT({
          provider: useTalkEchoAPI ? undefined : sttProviderConfig,
          selectedProvider: selectedSttProvider,
          audio: audioBlob,
          language: sttLanguage,
        });

        if (!transcription?.trim()) {
          return;
        }

        setLastTranscription(transcription);
        setLastTranslation("");

        const aiProviderConfig = allAiProviders.find(
          (p) => p.id === selectedAIProvider.provider
        );

        if (!selectedAIProvider.provider && !useTalkEchoAPI) {
          setError("请先配置 AI provider（Settings 里选一个，或先用 Groq Quickstart）。");
          return;
        }
        if (!aiProviderConfig && !useTalkEchoAPI) {
          setError("AI provider 配置不存在，请检查 Settings。");
          return;
        }

        let translation = "";
        for await (const chunk of fetchAIResponse({
          provider: useTalkEchoAPI ? undefined : aiProviderConfig,
          selectedProvider: selectedAIProvider,
          systemPrompt: effectiveSystemPrompt || DEFAULT_SYSTEM_PROMPT,
          history: [],
          userMessage: transcription,
          imagesBase64: [],
        })) {
          translation += chunk;
          setLastTranslation(translation);
        }

        if (translation && !isMuted && "speechSynthesis" in window) {
          try {
            const utterance = new SpeechSynthesisUtterance(translation);
            utterance.rate = 0.95;
            window.speechSynthesis.cancel();
            window.speechSynthesis.speak(utterance);
          } catch {}
        }
      } catch (err) {
        console.error("Mobile translation failed:", err);
        setError(err instanceof Error ? err.message : "处理失败");
      } finally {
        setIsProcessing(false);
      }
    },
    [
      allAiProviders,
      allSttProviders,
      effectiveSystemPrompt,
      isMuted,
      selectedAIProvider,
      selectedSttProvider,
      sttLanguage,
    ]
  );

  const vad = useMicVAD({
    userSpeakingThreshold: 0.85,
    positiveSpeechThreshold: 0.85,
    negativeSpeechThreshold: 0.5,
    minSpeechFrames: 7,
    preSpeechPadFrames: 1,
    frameSamples: 512,
    startOnLoad: false,
    onSpeechEnd: processAudio,
  });

  const toggleListening = useCallback(() => {
    if (vad.loading) return;

    if (vad.listening) {
      vad.pause();
      setIsListening(false);
      return;
    }

    setError("");
    setIsListening(true);
    vad.start();
  }, [vad]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev);
    try {
      window.speechSynthesis?.cancel();
    } catch {}
  }, []);

  const applyGroqQuickstart = useCallback(() => {
    const apiKeyValue = groqApiKey.trim();
    if (!apiKeyValue) {
      setError("请先填写 Groq API Key。");
      return;
    }

    setError("");

    onSetSelectedAIProvider({
      provider: "groq",
      variables: {
        api_key: apiKeyValue,
        model: "llama-3.1-8b-instant",
      },
    });

    onSetSelectedSttProvider({
      provider: "groq",
      variables: {
        api_key: apiKeyValue,
        model: "whisper-large-v3-turbo",
      },
    });
  }, [groqApiKey, onSetSelectedAIProvider, onSetSelectedSttProvider]);

  const openSettings = () => {
    window.location.hash = "#/settings";
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 bg-background/80 backdrop-blur border-b border-border">
        <div className="max-w-xl mx-auto p-4 flex items-center justify-between">
          <div className="space-y-0.5">
            <div className="font-semibold leading-none">TalkEcho Mobile</div>
            <div className="text-xs text-muted-foreground">
              Microphone-only translation (web/PWA)
            </div>
          </div>
          <Button variant="outline" size="icon" onClick={openSettings} title="Settings">
            <SettingsIcon className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <main className="max-w-xl mx-auto p-4 space-y-6">
        <section className="space-y-3">
          <div className="text-sm font-medium">Groq Quickstart</div>
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder="Groq API Key (sk-...)"
              value={groqApiKey}
              onChange={(e) => setGroqApiKey(e.target.value)}
            />
            <Button onClick={applyGroqQuickstart} variant="secondary">
              Use
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            注意：在浏览器里使用第三方 API key 可能有泄露风险。更安全的做法是使用你自己的
            代理服务端。
          </p>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Live</div>
            <Button variant="outline" size="sm" onClick={toggleMute}>
              {isMuted ? (
                <>
                  <VolumeXIcon className="h-4 w-4 mr-2" />
                  Mute
                </>
              ) : (
                <>
                  <Volume2Icon className="h-4 w-4 mr-2" />
                  Speak
                </>
              )}
            </Button>
          </div>

          <Button
            onClick={toggleListening}
            disabled={vad.loading || isProcessing}
            className="w-full h-12"
          >
            {vad.loading ? (
              "Loading mic…"
            ) : vad.listening ? (
              <>
                <MicOffIcon className="h-5 w-5 mr-2" />
                Stop
              </>
            ) : (
              <>
                <MicIcon className="h-5 w-5 mr-2" />
                Start
              </>
            )}
          </Button>

          {error ? (
            <div className="text-sm text-red-600 bg-red-500/10 border border-red-500/20 rounded-md p-3">
              {error}
            </div>
          ) : null}
        </section>

        {lastTranscription ? (
          <section className="space-y-2">
            <div className="text-xs text-muted-foreground">Transcription</div>
            <div className="rounded-md border border-border bg-card p-3 text-sm whitespace-pre-wrap">
              {lastTranscription}
            </div>
          </section>
        ) : null}

        {lastTranslation ? (
          <section className="space-y-2">
            <div className="text-xs text-muted-foreground">Translation</div>
            <div className="rounded-md border border-border bg-card p-3 text-sm whitespace-pre-wrap">
              {lastTranslation}
              {isProcessing ? <span className="inline-block w-2 h-4 animate-pulse ml-1" /> : null}
            </div>
          </section>
        ) : isProcessing ? (
          <div className="text-sm text-muted-foreground">Processing…</div>
        ) : null}
      </main>
    </div>
  );
}

