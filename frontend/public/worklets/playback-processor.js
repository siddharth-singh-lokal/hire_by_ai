/**
 * Plays back the interviewer's voice.
 *
 * Nova Sonic streams 24kHz PCM16 in chunks that arrive faster than real time, so
 * they are queued here and drained one render quantum at a time. The queue is
 * flushable: when the candidate interrupts, Sonic sends an INTERRUPTED event and
 * we drop everything still buffered so Sarah stops mid-sentence instead of
 * talking over them.
 */
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.wasPlaying = false;

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

    let peak = 0;

    for (let i = 0; i < out.length; i++) {
      if (!this.queue.length) {
        out[i] = 0;
        continue;
      }

      const chunk = this.queue[0];
      const sample = chunk[this.offset++] / 0x8000;
      out[i] = sample;

      const abs = sample < 0 ? -sample : sample;
      if (abs > peak) peak = abs;

      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }

    // Let the main thread drive the "speaking" indicator off actual output,
    // which is more accurate than the stream events for UI purposes.
    const playing = this.queue.length > 0;
    if (playing !== this.wasPlaying) {
      this.wasPlaying = playing;
      this.port.postMessage({ type: "playing", playing });
    }
    if (playing) this.port.postMessage({ type: "level", peak });

    return true;
  }
}

registerProcessor("playback-processor", PlaybackProcessor);
