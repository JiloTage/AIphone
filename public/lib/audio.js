export class CallAudio {
  constructor(onFrame) {
    this.context = new AudioContext({ latencyHint: 'interactive' });
    this.onFrame = onFrame;
    this.sources = new Set();
    this.nextTime = 0;
    this.closed = false;
  }
  async resume() { await this.context.resume(); }
  async microphone() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream;
    await this.context.audioWorklet.addModule('/microphone-worklet.js');
    if (this.closed) return;
    this.source = this.context.createMediaStreamSource(stream);
    this.processor = new AudioWorkletNode(this.context, 'microphone-processor');
    this.processor.port.onmessage = event => this.onFrame(event.data);
    const mute = this.context.createGain();
    mute.gain.value = 0;
    this.source.connect(this.processor).connect(mute).connect(this.context.destination);
  }
  ring() {
    this.stopRing();
    const tick = () => {
      if (this.closed) return;
      const now = this.context.currentTime;
      const gain = this.context.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.035, now + .025);
      gain.gain.setValueAtTime(0.035, now + .95);
      gain.gain.linearRampToValueAtTime(0, now + 1);
      gain.connect(this.context.destination);
      for (const frequency of [400, 440]) {
        const oscillator = this.context.createOscillator();
        oscillator.frequency.value = frequency;
        oscillator.connect(gain);
        oscillator.start(now);
        oscillator.stop(now + 1.02);
        this.ringSources ??= new Set();
        this.ringSources.add(oscillator);
        oscillator.onended = () => { this.ringSources.delete(oscillator); oscillator.disconnect(); };
      }
    };
    tick();
    this.ringInterval = setInterval(tick, 3000);
  }
  stopRing() {
    clearInterval(this.ringInterval);
    for (const oscillator of this.ringSources ?? []) { try { oscillator.stop(); } catch {} }
    this.ringSources?.clear();
  }
  play(pcm, rate) {
    if (this.closed) return;
    const samples = new Int16Array(pcm);
    const buffer = this.context.createBuffer(1, samples.length, rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.nextTime = Math.max(this.context.currentTime + .035, this.nextTime);
    source.start(this.nextTime);
    this.nextTime += buffer.duration;
    this.sources.add(source);
    source.onended = () => { this.sources.delete(source); source.disconnect(); };
  }
  get playing() { return this.sources.size > 0; }
  cancel() {
    for (const source of this.sources) { try { source.stop(); } catch {} }
    this.sources.clear();
    this.nextTime = 0;
  }
  close() {
    this.closed = true;
    this.stopRing();
    this.cancel();
    this.stream?.getTracks().forEach(track => track.stop());
    this.processor?.disconnect();
    this.source?.disconnect();
    this.context.close().catch(() => {});
  }
}
