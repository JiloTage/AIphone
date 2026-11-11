export class PCMEncoder {
  constructor(inputRate, outputRate = 24000, frameSize = 960) {
    this.ratio = inputRate / outputRate;
    this.frame = new Int16Array(frameSize);
    this.offset = 0;
    this.sum = 0;
    this.weight = 0;
  }
  push(samples) {
    const frames = [];
    for (const sample of samples) {
      let remaining = 1;
      while (remaining > 1e-8) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * take;
        this.weight += take;
        remaining -= take;
        if (this.weight >= this.ratio - 1e-8) {
          const value = Math.max(-1, Math.min(1, this.sum / this.weight));
          this.frame[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767));
          this.weight = this.sum = 0;
          if (this.offset === this.frame.length) {
            frames.push(this.frame);
            this.frame = new Int16Array(this.frame.length);
            this.offset = 0;
          }
        }
      }
    }
    return frames;
  }
}

export class VoiceActivity {
  // shortcut: energy VAD needs real-microphone calibration; use a speech VAD model if noise triggers false turns.
  constructor() { this.noise = 0.003; this.reset(); }
  reset() { this.active = false; this.attack = 0; this.silence = 0; this.duration = 0; this.voiced = 0; }
  update(rms, ms = 40) {
    const speaking = rms > Math.max(0.012, Math.min(0.04, this.noise * 3));
    if (!this.active) {
      if (!speaking) this.noise = this.noise * 0.98 + rms * 0.02;
      this.attack = speaking ? this.attack + ms : 0;
      if (this.attack >= 120) { this.active = true; this.voiced = this.attack; return 'start'; }
      return null;
    }
    this.duration += ms;
    this.silence = speaking ? 0 : this.silence + ms;
    if (speaking) this.voiced += ms;
    if (this.silence >= 560 || this.duration >= 25_000) {
      const event = this.voiced >= 200 ? 'end' : 'discard';
      this.reset();
      return event;
    }
    return null;
  }
}

export function pcmBase64(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}
