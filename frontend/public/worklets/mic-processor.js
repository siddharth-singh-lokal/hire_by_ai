/**
 * Captures microphone audio for Nova Sonic.
 *
 * The AudioContext feeding this node is created at 16kHz, so the browser has
 * already resampled for us — all this does is convert Float32 [-1,1] to the
 * signed 16-bit PCM Sonic expects, and report a level for the visualizer.
 */
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.muted = false;
    this.port.onmessage = (e) => {
      if (e.data?.type === "mute") this.muted = e.data.muted;
    };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    let peak = 0;
    const pcm = new Int16Array(channel.length);

    for (let i = 0; i < channel.length; i++) {
      // While muted we still emit silence rather than stopping, because Sonic's
      // end-of-turn detection relies on hearing a continuous stream.
      const sample = this.muted ? 0 : Math.max(-1, Math.min(1, channel[i]));
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      const abs = sample < 0 ? -sample : sample;
      if (abs > peak) peak = abs;
    }

    this.port.postMessage({ pcm: pcm.buffer, peak }, [pcm.buffer]);
    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
