/**
 * Captures microphone audio for Nova Sonic.
 *
 Two things are happening here, from two separate investigations:
 *
 * 1. RESAMPLING IN JS. The obvious approach is
 *    `new AudioContext({ sampleRate: 16000 })` and let the browser resample.
 *    That crackled. Hardware runs at 48kHz, and asking for 16kHz here plus
 *    24kHz for playback created two device streams with two resamplers
 *    contending on the audio thread. Both paths now share ONE context at the
 *    native rate and convert here.
 *
 * 2. BARGE GATE. While the interviewer is speaking, her voice leaks from the
 *    speakers back into the mic. Browser echo cancellation removes most of it,
 *    but the residual can be loud enough that Nova Sonic's VAD hears it as the
 *    candidate interrupting — and cuts her off mid-sentence, repeatedly. While
 *    she is speaking, anything below the gate is sent as silence; only
 *    genuinely loud speech (a real barge-in) passes. On speakers this is the
 *    difference between a usable call and one that stutters constantly.
 *
 * Nova Sonic needs 16kHz mono PCM16. `sampleRate` is the context's real rate.
 */

const TARGET_RATE = 16000;
const CHUNK_FRAMES = 512; // 32ms at 16kHz
const BARGE_GATE = 0.12;

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.muted = false;
    this.remoteSpeaking = false;
    this.buffer = new Int16Array(CHUNK_FRAMES);
    this.offset = 0;
    this.peak = 0;

    // Fractional read position, so the ratio stays exact across render quanta
    // instead of drifting a fraction of a sample every 128 frames.
    this.pos = 0;
    this.ratio = sampleRate / TARGET_RATE;
    // Carried across quanta so interpolation at the block boundary is
    // continuous — restarting each block injects a step 375 times a second.
    this.prev = 0;

    this.port.onmessage = (e) => {
      const data = e.data || {};
      if (data.type === "mute") this.muted = data.muted;
      else if (data.type === "remoteSpeaking") this.remoteSpeaking = data.value;
    };
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    while (this.pos < input.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i === 0 ? this.prev : input[i - 1];
      const raw = a + (input[i] - a) * frac;

      // Muting zeroes samples rather than stopping: Sonic's end-of-turn
      // detection needs to HEAR the silence, and a stopped stream hangs forever.
      const s = this.muted ? 0 : Math.max(-1, Math.min(1, raw));
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;

      const abs = s < 0 ? -s : s;
      if (abs > this.peak) this.peak = abs;

      if (this.offset >= CHUNK_FRAMES) {
        // While the interviewer is speaking, suppress anything that is not
        // clearly a real barge-in, so her own echo cannot be heard as one.
        const gated = this.remoteSpeaking && this.peak < BARGE_GATE;
        const chunk = new Int16Array(CHUNK_FRAMES);
        if (!gated) chunk.set(this.buffer);

        this.port.postMessage({ pcm: chunk.buffer, peak: this.peak }, [chunk.buffer]);
        this.offset = 0;
        this.peak = 0;
      }

      this.pos += this.ratio;
    }

    this.prev = input[input.length - 1];
    this.pos -= input.length;
    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
