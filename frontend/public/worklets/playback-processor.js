/**
 * Plays back the interviewer's voice.
 *
 * Three things this has to get right, all established by measurement:
 *
 * 1. RESAMPLE IN JS. Sonic emits 24kHz; hardware runs at 48kHz. Two contexts at
 *    two non-native rates meant two device streams and two resamplers competing
 *    on the audio thread, which crackles in Chrome. One context, converted here.
 *
 * 2. JITTER BUFFER, SIZED FROM DATA. Sonic delivers in bursts — 80-240ms chunks
 *    a millisecond apart, then a pause. But it delivers at ~1.57x realtime, so
 *    the cushion GROWS once a turn is underway; replaying a real 211-chunk
 *    arrival trace the buffer never fell below 147ms even with no prime at all.
 *    200ms is therefore ample, where the original 600ms was 400ms of pure
 *    wasted latency.
 *
 * 3. NEVER STEP DISCONTINUOUSLY. Cutting from a loud sample to zero is a click.
 *    An underrun inserts silence then resumes mid-waveform, producing a gap AND
 *    a click — stutter and crackle together, exactly as reported. Every entry
 *    into and out of silence is ramped.
 *
 * Verified against real Bedrock output: its chunks are 16-bit aligned and abut
 * cleanly (boundary steps ~14x smaller than the waveform's own slew), so any
 * discontinuity heard is introduced here, not by the model.
 */

const SOURCE_RATE = 24000;
const PRIME_SECONDS = 0.2;
/**
 * The prime is adaptive. 200ms is right for a clean delivery path, but the
 * path is not always clean: the relay's event loop can stall, the browser's
 * main thread can be held by a detector pass, and Bedrock's gaps between
 * bursts have a long tail. Every underrun is a ramp-down/ramp-up pair — heard
 * as a crackle — so after each one the cushion for the NEXT turn grows by half,
 * up to this cap. Latency is traded for continuity only once continuity has
 * actually been lost.
 */
const MAX_PRIME_SECONDS = 0.6;
const PRIME_GROWTH = 1.5;
const FADE_SECONDS = 0.002; // inaudible, but kills the click
const DRY_SECONDS = 1.0; // shorter and an ordinary gap re-primes mid-sentence
const LEVEL_INTERVAL_QUANTA = 8;

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.readIndex = 0;
    this.buffered = 0;
    this.primed = false;
    this.dryFrames = 0;
    this.wasPlaying = false;

    this.ratio = SOURCE_RATE / sampleRate;
    this.primeSamples = Math.round(SOURCE_RATE * PRIME_SECONDS);
    this.maxPrimeSamples = Math.round(SOURCE_RATE * MAX_PRIME_SECONDS);
    this.fadeFrames = Math.max(1, Math.round(sampleRate * FADE_SECONDS));
    this.dryLimit = Math.round(sampleRate * DRY_SECONDS);

    this.gain = 0;
    this.gainTarget = 0;
    this.gainStep = 1 / this.fadeFrames;
    this.last = 0; // held through a gap so the ramp starts where audio was

    this.quantaSinceLevel = 0;
    this.peakSinceLevel = 0;
    this.underruns = 0;
    this.inUnderrun = false;

    this.port.onmessage = (e) => {
      const { type, pcm } = e.data || {};
      if (type === "push") {
        const chunk = new Int16Array(pcm);
        this.queue.push(chunk);
        this.buffered += chunk.length;
      } else if (type === "flush") {
        this.queue = [];
        this.readIndex = 0;
        this.buffered = 0;
        this.primed = false;
        this.dryFrames = 0;
        this.gainTarget = 0; // fade out rather than cut
      }
    };
  }

  setPlaying(playing) {
    if (playing === this.wasPlaying) return;
    this.wasPlaying = playing;
    this.port.postMessage({ type: "playing", playing });
    if (!playing) {
      this.quantaSinceLevel = 0;
      this.peakSinceLevel = 0;
    }
  }

  /** One interpolated source sample, or null when the queue is dry. */
  nextSample() {
    while (this.queue.length) {
      const chunk = this.queue[0];
      const i = Math.floor(this.readIndex);

      if (i >= chunk.length) {
        this.queue.shift();
        this.readIndex -= chunk.length;
        continue;
      }

      const frac = this.readIndex - i;
      const a = chunk[i];
      // Interpolate ACROSS the chunk boundary rather than restarting at it —
      // otherwise every join is a small step, and there are hundreds of them.
      const b =
        i + 1 < chunk.length ? chunk[i + 1] : this.queue.length > 1 ? this.queue[1][0] : a;

      this.readIndex += this.ratio;
      this.buffered = Math.max(0, this.buffered - this.ratio);
      return (a + (b - a) * frac) / 0x8000;
    }
    return null;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    if (!this.primed) {
      if (this.buffered >= this.primeSamples) {
        this.primed = true;
        this.dryFrames = 0;
        this.gainTarget = 1;
      } else {
        for (let i = 0; i < out.length; i++) {
          this.gain = Math.max(0, this.gain - this.gainStep);
          out[i] = this.last * this.gain;
        }
        if (this.gain === 0 && this.buffered === 0) this.setPlaying(false);
        return true;
      }
    }

    let peak = 0;
    let starved = false;

    for (let i = 0; i < out.length; i++) {
      const sample = this.nextSample();
      if (sample === null) {
        starved = true;
        this.gainTarget = 0;
      } else {
        this.last = sample;
        this.gainTarget = 1;
      }

      this.gain +=
        this.gain < this.gainTarget
          ? Math.min(this.gainStep, this.gainTarget - this.gain)
          : Math.max(-this.gainStep, this.gainTarget - this.gain);

      const v = this.last * this.gain;
      out[i] = v;
      const abs = v < 0 ? -v : v;
      if (abs > peak) peak = abs;
    }

    if (starved) {
      if (!this.inUnderrun) {
        this.inUnderrun = true;
        this.underruns++;
        this.primeSamples = Math.min(
          this.maxPrimeSamples,
          Math.round(this.primeSamples * PRIME_GROWTH)
        );
        this.port.postMessage({
          type: "underrun",
          count: this.underruns,
          primeMs: Math.round((this.primeSamples / SOURCE_RATE) * 1000),
        });
      }
      this.dryFrames += out.length;
      if (this.dryFrames >= this.dryLimit) {
        this.primed = false;
        this.dryFrames = 0;
        this.buffered = 0;
        this.setPlaying(false);
        return true;
      }
    } else {
      this.dryFrames = 0;
      this.inUnderrun = false;
    }

    this.setPlaying(true);

    if (peak > this.peakSinceLevel) this.peakSinceLevel = peak;
    if (++this.quantaSinceLevel >= LEVEL_INTERVAL_QUANTA) {
      this.port.postMessage({ type: "level", peak: this.peakSinceLevel });
      this.quantaSinceLevel = 0;
      this.peakSinceLevel = 0;
    }

    return true;
  }
}

registerProcessor("playback-processor", PlaybackProcessor);
