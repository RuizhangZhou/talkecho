/**
 * Audio Mixing Utilities
 *
 * This module provides utilities for mixing multiple audio sources using Web Audio API.
 * Used for combining system audio output with microphone input for complete conversation recording.
 */

/**
 * Converts a base64 WAV audio string to an AudioBuffer
 */
export async function base64ToAudioBuffer(
  base64Audio: string,
  audioContext: AudioContext
): Promise<AudioBuffer> {
  // Decode base64 to binary
  const binaryString = atob(base64Audio);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Decode audio data
  const audioBuffer = await audioContext.decodeAudioData(bytes.buffer);
  return audioBuffer;
}

/**
 * Converts an AudioBuffer to a base64 WAV string
 */
export async function audioBufferToBase64(
  audioBuffer: AudioBuffer
): Promise<string> {
  // Create WAV file from AudioBuffer
  const wavBlob = await audioBufferToWav(audioBuffer);

  // Convert blob to base64
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(wavBlob);
  });
}

/**
 * Converts AudioBuffer to WAV Blob
 */
async function audioBufferToWav(audioBuffer: AudioBuffer): Promise<Blob> {
  const numberOfChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length * numberOfChannels * 2;
  const sampleRate = audioBuffer.sampleRate;

  const buffer = new ArrayBuffer(44 + length);
  const view = new DataView(buffer);

  // WAV header
  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + length, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numberOfChannels * 2, true);
  view.setUint16(32, numberOfChannels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, length, true);

  // Write audio data
  const channels: Float32Array[] = [];
  for (let i = 0; i < numberOfChannels; i++) {
    channels.push(audioBuffer.getChannelData(i));
  }

  let offset = 44;
  for (let i = 0; i < audioBuffer.length; i++) {
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const sample = Math.max(-1, Math.min(1, channels[channel][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Mix two audio buffers together
 *
 * @param buffer1 - First audio buffer (e.g., system audio)
 * @param buffer2 - Second audio buffer (e.g., microphone)
 * @param audioContext - Audio context to use for mixing
 * @param gain1 - Volume gain for first buffer (0.0 to 1.0, default: 1.0)
 * @param gain2 - Volume gain for second buffer (0.0 to 1.0, default: 1.0)
 * @returns Mixed audio buffer
 */
export async function mixAudioBuffers(
  buffer1: AudioBuffer,
  buffer2: AudioBuffer,
  audioContext: AudioContext,
  gain1: number = 1.0,
  gain2: number = 1.0
): Promise<AudioBuffer> {
  // Ensure both buffers have the same sample rate
  const sampleRate = Math.max(buffer1.sampleRate, buffer2.sampleRate);

  // Resample if necessary
  const resampledBuffer1 = buffer1.sampleRate === sampleRate
    ? buffer1
    : await resampleBuffer(buffer1, sampleRate, audioContext);
  const resampledBuffer2 = buffer2.sampleRate === sampleRate
    ? buffer2
    : await resampleBuffer(buffer2, sampleRate, audioContext);

  // Use the longer duration
  const maxLength = Math.max(resampledBuffer1.length, resampledBuffer2.length);
  const numberOfChannels = Math.max(
    resampledBuffer1.numberOfChannels,
    resampledBuffer2.numberOfChannels
  );

  // Create output buffer
  const mixedBuffer = audioContext.createBuffer(
    numberOfChannels,
    maxLength,
    sampleRate
  );

  // Mix each channel
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const outputData = mixedBuffer.getChannelData(channel);

    // Get input channel data (use first channel if source has fewer channels)
    const input1 = resampledBuffer1.getChannelData(
      Math.min(channel, resampledBuffer1.numberOfChannels - 1)
    );
    const input2 = resampledBuffer2.getChannelData(
      Math.min(channel, resampledBuffer2.numberOfChannels - 1)
    );

    // Mix the audio
    for (let i = 0; i < maxLength; i++) {
      const sample1 = i < input1.length ? input1[i] * gain1 : 0;
      const sample2 = i < input2.length ? input2[i] * gain2 : 0;

      // Simple mixing: average the samples (prevents clipping better than addition)
      outputData[i] = (sample1 + sample2) / 2;
    }
  }

  return mixedBuffer;
}

/**
 * Resample an audio buffer to a different sample rate
 */
async function resampleBuffer(
  buffer: AudioBuffer,
  targetSampleRate: number,
  _audioContext: AudioContext
): Promise<AudioBuffer> {
  const offlineContext = new OfflineAudioContext(
    buffer.numberOfChannels,
    buffer.duration * targetSampleRate,
    targetSampleRate
  );

  const source = offlineContext.createBufferSource();
  source.buffer = buffer;
  source.connect(offlineContext.destination);
  source.start(0);

  return await offlineContext.startRendering();
}

/**
 * Audio Recorder class for continuous microphone recording
 * Maintains a circular buffer of recent audio for mixing with system audio
 */
export class MicrophoneRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private startTime: number = 0;

  /**
   * Start recording from microphone
   */
  async start(deviceId?: string): Promise<void> {
    try {
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      };

      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.mediaRecorder = new MediaRecorder(this.stream);
      this.audioChunks = [];
      this.startTime = Date.now();

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      // Request data every 100ms for fine-grained control
      this.mediaRecorder.start(100);
    } catch (error) {
      console.error('Failed to start microphone recording:', error);
      throw error;
    }
  }

  /**
   * Stop recording and return the recorded audio
   */
  async stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) {
        reject(new Error('MediaRecorder not initialized'));
        return;
      }

      this.mediaRecorder.onstop = () => {
        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
        this.cleanup();
        resolve(audioBlob);
      };

      this.mediaRecorder.stop();
    });
  }

  /**
   * Get recorded audio up to current time
   */
  getCurrentRecording(): Blob {
    return new Blob(this.audioChunks, { type: 'audio/webm' });
  }

  /**
   * Get recording duration in milliseconds
   */
  getDuration(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    this.mediaRecorder = null;
    this.audioChunks = [];
  }

  /**
   * Force cleanup (for unmounting)
   */
  destroy(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.cleanup();
  }
}
