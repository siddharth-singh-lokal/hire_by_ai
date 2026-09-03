/**
 * Plays back the interviewer's voice.
 *
 * Nova Sonic streams 24kHz PCM16 in chunks that arrive faster than real time, so
 * they are queued and drained one render quantum at a time. The queue is
 * flushable: when the candidate interrupts, Sonic sends an INTERRUPTED event and
 * everything still buffered is dropped so Sarah stops mid-sentence rather than
 * talking over them.
 *
 * PERFORMANCE: at 24kHz a render quantum is 5.3ms, so posting a level on every
 * call meant ~187 messages and ~187 React re-renders per second. Levels are now
 * throttled to roughly 20fps, which is more than enough for a volume meter and
 * removes the jank. Start/stop transitions are still posted immediately, since
 * those drive the "speaking" indicator and must not lag.
 */

const LEVEL_INTERVAL_QUANTA = 8; // ~43ms at 24kHz -> ~23 updates/sec

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.wasPlaying = false;
    this.quantaSinceLevel = 0;
    this.peakSinceLevel = 0;

    this.port.onmessage = (e) => {
      const { type, pcm } = e.data || {};
      if (type === "push") {
        this.queue.push(new Int16Array(pcm));
      } else if (type === "flush") {
        this.queue = [];
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    for (let i = 0; i < out.length; i++) {
      if (!this.queue.length) {
        out[i] = 0;
        continue;
      }

      const chunk = this.queue[0];
      const sample = chunk[this.offset++] / 0x8000;
      out[i] = sample;

      const abs = sample < 0 ? -sample : sample;
      if (abs > this.peakSinceLevel) this.peakSinceLevel = abs;

      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }

    const playing = this.queue.length > 0;

    // Transitions post immediately — this drives the speaking indicator.
    if (playing !== this.wasPlaying) {
      this.wasPlaying = playing;
      this.port.postMessage({ type: "playing", playing });
      if (!playing) {
        this.quantaSinceLevel = 0;
        this.peakSinceLevel = 0;
      }
    }

    // Levels are throttled.
    if (playing && ++this.quantaSinceLevel >= LEVEL_INTERVAL_QUANTA) {
      this.port.postMessage({ type: "level", peak: this.peakSinceLevel });
      this.quantaSinceLevel = 0;
      this.peakSinceLevel = 0;
    }

    return true;
  }
}

registerProcessor("playback-processor", PlaybackProcessor);
