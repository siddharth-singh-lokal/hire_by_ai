/**
 * Captures microphone audio for Nova Sonic.
 *
 * The AudioContext feeding this node runs at 16kHz, so the browser has already
 * resampled — this converts Float32 [-1,1] to signed 16-bit PCM and reports a
 * level for the visualiser.
 *
 * PERFORMANCE: process() is called every 128 frames, which at 16kHz is every
 * 8ms — 125 times a second. Posting on each call meant 125 WebSocket sends and
 * 125 React state updates per second, which visibly janked the UI and added
 * latency to the audio path. Samples are therefore accumulated into ~32ms
 * chunks before being posted. That is still well inside what Nova Sonic's
 * voice-activity detection needs to feel responsive, at a quarter of the
 * message rate.
 */

const CHUNK_FRAMES = 512; // 32ms at 16kHz

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.muted = false;
    this.buffer = new Int16Array(CHUNK_FRAMES);
    this.offset = 0;
    this.peak = 0;

    this.port.onmessage = (e) => {
      if (e.data?.type === "mute") this.muted = e.data.muted;
    };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      // While muted we still emit silence rather than stopping: Sonic's
      // end-of-turn detection needs a continuous stream to hear the pause.
      const sample = this.muted ? 0 : Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.offset++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;

      const abs = sample < 0 ? -sample : sample;
      if (abs > this.peak) this.peak = abs;

      if (this.offset >= CHUNK_FRAMES) {
        // Copy out — the buffer is reused, so the transfer needs its own memory.
        const chunk = new Int16Array(this.buffer);
        this.port.postMessage({ pcm: chunk.buffer, peak: this.peak }, [chunk.buffer]);
        this.offset = 0;
        this.peak = 0;
      }
    }

    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
