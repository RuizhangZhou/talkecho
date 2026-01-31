import { useState, useEffect, useCallback, useRef } from 'react';
import { MicVAD } from '@ricky0123/vad-web';
import { fetchSTT, fetchAIResponse, shouldUseTalkEchoAPI } from '@/lib/functions';
import { useApp } from '@/contexts';
import { floatArrayToWav } from '@/lib/utils';
import { DEFAULT_SYSTEM_PROMPT } from '@/config';
import { Button } from '@/components/ui';
import { Mic, MicOff, Settings, Volume2, VolumeX } from 'lucide-react';

/**
 * Mobile Face-to-Face Translation Mode
 * Optimized for iPhone/Android PWA
 */
export default function MobileTranslation() {
  const {
    selectedSttProvider,
    allSttProviders,
    selectedAIProvider,
    allAiProviders,
    systemPrompt,
  } = useApp();

  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastTranscription, setLastTranscription] = useState('');
  const [lastTranslation, setLastTranslation] = useState('');
  const [error, setError] = useState('');
  const [isMuted, setIsMuted] = useState(false);

  const micVadRef = useRef<MicVAD | null>(null);

  // Initialize MicVAD
  useEffect(() => {
    let canceled = false;

    const initVAD = async () => {
      try {
        const vad = await MicVAD.new({
          positiveSpeechThreshold: 0.8,
          negativeSpeechThreshold: 0.5,
          minSpeechFrames: 5,
          preSpeechPadFrames: 1,
          onSpeechEnd: async (audio: Float32Array) => {
            if (!isListening) return;
            await processAudio(audio);
          },
        });

        if (canceled) {
          vad.destroy();
          return;
        }

        micVadRef.current = vad;
      } catch (err) {
        console.error('Failed to initialize VAD:', err);
        setError('无法访问麦克风');
      }
    };

    initVAD();

    return () => {
      canceled = true;
      if (micVadRef.current) {
        micVadRef.current.destroy();
        micVadRef.current = null;
      }
    };
  }, []);

  const processAudio = useCallback(
    async (audioData: Float32Array) => {
      try {
        setIsProcessing(true);
        setError('');

        // Convert to WAV
        const audioBlob = floatArrayToWav(audioData, 16000, 'wav');

        const useTalkEchoAPI = await shouldUseTalkEchoAPI();
        const providerConfig = allSttProviders.find(
          (p) => p.id === selectedSttProvider.provider
        );

        if (!providerConfig && !useTalkEchoAPI) {
          setError('未配置 STT provider');
          return;
        }

        // Transcribe
        const transcription = await fetchSTT({
          provider: providerConfig,
          selectedProvider: selectedSttProvider,
          audio: audioBlob,
        });

        if (!transcription.trim()) {
          setIsProcessing(false);
          return;
        }

        setLastTranscription(transcription);

        // Translate
        const aiProvider = allAiProviders.find(
          (p) => p.id === selectedAIProvider.provider
        );

        if (!aiProvider && !useTalkEchoAPI) {
          setError('未配置 AI provider');
          return;
        }

        let translation = '';
        for await (const chunk of fetchAIResponse({
          provider: useTalkEchoAPI ? undefined : aiProvider,
          selectedProvider: selectedAIProvider,
          systemPrompt: systemPrompt || DEFAULT_SYSTEM_PROMPT,
          history: [],
          userMessage: transcription,
          imagesBase64: [],
        })) {
          translation += chunk;
          setLastTranslation(translation);
        }

        // Text-to-speech
        if (translation && !isMuted && 'speechSynthesis' in window) {
          const utterance = new SpeechSynthesisUtterance(translation);
          utterance.rate = 0.9;
          window.speechSynthesis.speak(utterance);
        }

        // Vibrate on success
        if ('vibrate' in navigator) {
          navigator.vibrate(50);
        }
      } catch (err) {
        console.error('Processing error:', err);
        setError(err instanceof Error ? err.message : '处理失败');
      } finally {
        setIsProcessing(false);
      }
    },
    [
      selectedSttProvider,
      allSttProviders,
      selectedAIProvider,
      allAiProviders,
      systemPrompt,
      isMuted,
      isListening,
    ]
  );

  const toggleListening = useCallback(() => {
    if (!micVadRef.current) {
      setError('麦克风未初始化');
      return;
    }

    if (isListening) {
      micVadRef.current.pause();
      setIsListening(false);
    } else {
      micVadRef.current.start();
      setIsListening(true);
      setError('');
    }
  }, [isListening]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev);
    if (!isMuted) {
      window.speechSynthesis?.cancel();
    }
  }, [isMuted]);

  // Keep screen awake
  useEffect(() => {
    let wakeLock: any = null;

    const requestWakeLock = async () => {
      if ('wakeLock' in navigator && isListening) {
        try {
          wakeLock = await (navigator as any).wakeLock.request('screen');
        } catch (err) {
          console.log('Wake lock failed:', err);
        }
      }
    };

    requestWakeLock();

    return () => {
      if (wakeLock) {
        wakeLock.release();
      }
    };
  }, [isListening]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black text-white flex flex-col">
      {/* Header */}
      <header className="p-4 flex items-center justify-between border-b border-gray-800">
        <h1 className="text-xl font-bold">TalkEcho</h1>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => (window.location.hash = '#/settings')}
        >
          <Settings className="w-5 h-5" />
        </Button>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center p-6 space-y-8">
        {/* Status Indicator */}
        <div className="text-center space-y-2">
          {isListening && (
            <div className="animate-pulse">
              <div className="w-24 h-24 mx-auto rounded-full bg-green-500/20 flex items-center justify-center">
                <div className="w-16 h-16 rounded-full bg-green-500/40 flex items-center justify-center">
                  <Mic className="w-8 h-8 text-green-400" />
                </div>
              </div>
            </div>
          )}
          {!isListening && (
            <div className="w-24 h-24 mx-auto rounded-full bg-gray-800 flex items-center justify-center">
              <MicOff className="w-8 h-8 text-gray-500" />
            </div>
          )}

          <p className="text-sm text-gray-400">
            {isProcessing ? '处理中...' : isListening ? '正在监听...' : '点击开始'}
          </p>
        </div>

        {/* Transcription Display */}
        {lastTranscription && (
          <div className="w-full max-w-md space-y-4">
            <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
              <p className="text-xs text-blue-400 mb-1">原文</p>
              <p className="text-white">{lastTranscription}</p>
            </div>

            {lastTranslation && (
              <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
                <p className="text-xs text-green-400 mb-1">翻译</p>
                <p className="text-white">{lastTranslation}</p>
              </div>
            )}
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div className="w-full max-w-md bg-red-500/10 border border-red-500/30 rounded-lg p-4">
            <p className="text-red-400 text-sm">{error}</p>
          </div>
        )}
      </main>

      {/* Controls */}
      <footer className="p-6 border-t border-gray-800 space-y-4">
        <Button
          onClick={toggleListening}
          disabled={isProcessing}
          className={`w-full h-16 text-lg font-semibold rounded-full ${
            isListening ? 'bg-red-500 hover:bg-red-600' : 'bg-green-500 hover:bg-green-600'
          }`}
        >
          {isListening ? (
            <>
              <MicOff className="w-6 h-6 mr-2" />
              停止监听
            </>
          ) : (
            <>
              <Mic className="w-6 h-6 mr-2" />
              开始监听
            </>
          )}
        </Button>

        <div className="flex items-center justify-center">
          <Button variant="outline" size="sm" onClick={toggleMute} className="flex items-center">
            {isMuted ? <VolumeX className="w-4 h-4 mr-2" /> : <Volume2 className="w-4 h-4 mr-2" />}
            {isMuted ? '取消静音' : '静音'}
          </Button>
        </div>
      </footer>
    </div>
  );
}
