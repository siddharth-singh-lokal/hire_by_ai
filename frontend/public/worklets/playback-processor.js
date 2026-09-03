/**
 * Plays back the interviewer's voice.
 *
 * JITTER BUFFER — this is the important part.
 *
 * Nova Sonic does not stream audio smoothly. It delivers in bursts: a rush of
 * chunks a millisecond apart, then a pause of up to ~800ms while it generates
 * the next segment. Measured on a real session:
 *
 *     inter-arrival p50   1ms      (inside a burst)
 *     inter-arrival p95 441ms      (between bursts)
 *     inter-arrival p99 699ms
 *     worst gap         792ms
 *
 * Playing the moment the first chunk arrives means draining that chunk in ~40ms
 * and then outputting silence until the next burst — which is heard as speech
 * chopping mid-word ("s—he—ll"). It looks like a network problem and isn't.
 *
 * The fix is to accumulate a cushion before starting. Once a turn is underway
 * the cushion grows on its own, because bursts deliver far more audio than the
 * gaps consume; the only fragile moment is the start of each turn. Costs about
 * half a second of added latency per turn, which is a trade worth making —
 * choppy audio is far more damaging than a slightly later start.
 */

const SAMPLE_RATE = 24000;
/** Cushion before a turn starts. Covers the measured p99 gap. */
const PRIME_SAMPLES = Math.round(SAMPLE_RATE * 0.6);
/**
 * How long the queue must stay empty before we treat the turn as finished and
 * re-prime. Anything shorter and an ordinary between-burst gap would be
 * mistaken for the end of speech, re-priming mid-sentence and making the
 * stutter worse rather than better.
 */
const DRY_GRACE_QUANTA = Math.round(1.0 / (128 / SAMPLE_RATE));

const LEVEL_INTERVAL_QUANTA = 8; // ~43ms -> ~23 level updates/sec

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.buffered = 0; // samples queued but not yet played
    this.primed = false;
    this.dryQuanta = 0;
    this.wasPlaying = false;
    this.quantaSinceLevel = 0;
    this.peakSinceLevel = 0;
    // Diagnostics: how often the buffer ran dry mid-speech, and for how long.
    this.underruns = 0;
    this.underrunQuanta = 0;
    this.inUnderrun = false;

    this.port.onmessage = (e) => {
      const { type, pcm } = e.data || {};
      if (type === "push") {
        const chunk = new Int16Array(pcm);
        this.queue.push(chunk);
        this.buffered += chunk.length;
      } else if (type === "flush") {
        // Barge-in: drop everything and require a fresh cushion.
        this.queue = [];
        this.offset = 0;
        this.buffered = 0;
        this.primed = false;
        this.dryQuanta = 0;
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

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    // --- waiting for the cushion to fill ---
    if (!this.primed) {
      if (this.buffered >= PRIME_SAMPLES) {
        this.primed = true;
        this.dryQuanta = 0;
      } else {
        out.fill(0);
        // Stay silent, and stay "not speaking", until there is enough to play.
        if (this.buffered === 0) this.setPlaying(false);
        return true;
      }
    }

    // --- draining ---
    let peak = 0;
    let starved = false;

    for (let i = 0; i < out.length; i++) {
      if (!this.queue.length) {
        out[i] = 0;
        starved = true;
        continue;
      }

      const chunk = this.queue[0];
      const sample = chunk[this.offset++] / 0x8000;
      out[i] = sample;
      this.buffered--;

      const abs = sample < 0 ? -sample : sample;
      if (abs > peak) peak = abs;

      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }

    if (starved) {
      this.underrunQuanta++;
      if (!this.inUnderrun) {
        this.inUnderrun = true;
        this.underruns++;
        this.port.postMessage({ type: "underrun", count: this.underruns });
      }
      // A brief dry spell is an ordinary between-burst gap — keep the turn
      // alive. Only a sustained one means she actually stopped talking.
      if (++this.dryQuanta >= DRY_GRACE_QUANTA) {
        this.primed = false;
        this.dryQuanta = 0;
        this.buffered = 0;
        this.setPlaying(false);
        return true;
      }
    } else {
      this.dryQuanta = 0;
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
