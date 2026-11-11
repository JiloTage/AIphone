import { PCMEncoder } from './lib/audio-codec.js';

class MicrophoneProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.encoder = new PCMEncoder(sampleRate); }
  process(inputs) {
    if (inputs[0]?.[0]) {
      for (const frame of this.encoder.push(inputs[0][0])) {
        let sum = 0;
        for (const value of frame) sum += (value / 32768) ** 2;
        this.port.postMessage({ pcm: frame.buffer, rms: Math.sqrt(sum / frame.length) }, [frame.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('microphone-processor', MicrophoneProcessor);
