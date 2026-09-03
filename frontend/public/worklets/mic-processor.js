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
 * 2. BARGE GATE, PROPORTIONAL TO HER OWN VOLUME. While the interviewer is
 *    speaking, her voice leaks from the speakers back into the mic. Browser
 *    echo cancellation removes most of it, but the residual can be loud enough
 *    that Nova Sonic's VAD hears it as the candidate interrupting.
 *
 *    The first version used a FIXED gate of 0.12, and that was the bug behind
 *    "she just keeps talking and never stops". Normal conversational speech on
 *    a laptop mic peaks around 0.05-0.15, so a fixed 0.12 gate replaced most
 *    real candidate speech with silence: Sonic never heard them start, so it
 *    never registered a barge-in, so she talked straight over them. The gate
 *    was protecting her from echo by deafening her to the candidate.
 *
 *    The gate is now proportional to how loud SHE currently is, because that is
 *    what the echo scales with. When she is silent the floor is low enough to
 *    pass a quiet voice; when she is loud it rises just enough to reject the
 *    residual. Below the gate we now attenuate rather than hard-zero, so Sonic
 *    still hears that *something* is happening.
 *
 * Nova Sonic needs 16kHz mono PCM16. `sampleRate` is the context's real rate.
 */

const TARGET_RATE = 16000;
const CHUNK_FRAMES = 512; // 32ms at 16kHz

/**
 * Absolute floor: below this it is room noise, never speech. Deliberately low —
 * missing a real interruption is far worse than passing a little noise.
 */
const GATE_FLOOR = 0.022;
/**
 * Extra headroom proportional to her current output level. Browser AEC leaves
 * a few percent of the far-end signal; 0.18 is generous cover for that without
 * reaching normal speech.
 */
const GATE_ECHO_RATIO = 0.18;
/** Residual below the gate is attenuated to this, not zeroed. */
const DUCK_GAIN = 0.15;

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.muted = false;
    this.remoteSpeaking = false;
    /** Her current playback peak, mirrored from the playback worklet. */
    this.remoteLevel = 0;
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
      else if (data.type === "remoteSpeaking") {
        this.remoteSpeaking = data.value;
        if (!data.value) this.remoteLevel = 0;
      } else if (data.type === "remoteLevel") this.remoteLevel = data.value || 0;
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
        // While she is speaking, reject only what is plausibly her own echo —
        // a threshold that rises with her volume — instead of everything below
        // a fixed level, which used to swallow the candidate entirely.
        const gate = GATE_FLOOR + this.remoteLevel * GATE_ECHO_RATIO;
        const ducking = this.remoteSpeaking && this.peak < gate;

        const chunk = new Int16Array(CHUNK_FRAMES);
        if (ducking) {
          // Attenuate rather than zero: Sonic's VAD still gets a signal that
          // the line is not dead, and a real voice riding just under the gate
          // is not erased outright.
          for (let k = 0; k < CHUNK_FRAMES; k++) chunk[k] = (this.buffer[k] * DUCK_GAIN) | 0;
        } else {
          chunk.set(this.buffer);
        }

        this.port.postMessage(
          { pcm: chunk.buffer, peak: this.peak, gated: ducking, gate },
          [chunk.buffer]
        );
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
