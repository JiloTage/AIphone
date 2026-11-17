import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCall } from '../public/lib/call.js';
import { CallAudio } from '../public/lib/audio.js';

for (const outcome of ['audio', 'hangup', 'error']) test(`prepared opening waits for PCM: ${outcome}`, async t => {
  let socket, finishText;
  for (const [object, key, value] of [
    [globalThis, 'AudioContext', class {}], [globalThis, 'AudioWorkletNode', class {}],
    [globalThis, 'location', { href: 'https://example.test/' }],
    [navigator, 'mediaDevices', { getUserMedia() {} }],
    [globalThis, 'WebSocket', class {
      static OPEN = 1; readyState = 1; sent = [];
      constructor() { socket = this; }
      send(data) { this.sent.push(JSON.parse(data)); }
      close() {}
    }],
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key]; });
  }
  for (const method of ['resume', 'microphone', 'ring', 'stopRing', 'close', 'play']) t.mock.method(CallAudio.prototype, method, async () => {});
  t.mock.method(globalThis, 'setInterval', () => 1);
  t.mock.method(globalThis, 'clearInterval', () => {});
  const order = [], errors = [];
  const call = new VoiceCall({ greeting: () => { order.push('generate'); return new Promise(resolve => { finishText = resolve; }); }, state() {}, partial() {}, ended() {}, error: text => errors.push(text) });
  t.mock.method(call, 'connect', async () => {
    order.push('connect');
    const ready = call.openSocket('/api/voice', 'voice', call.abort.signal);
    socket.onmessage({ data: '{"type":"ready"}' });
    call.voice = await ready;
  });
  const starting = call.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['generate', 'connect']);
  assert.equal(call.ready, true);
  assert.equal(socket.sent.length, 0);
  if (outcome === 'hangup') call.stop();
  finishText('こんにちは'); await starting;
  if (outcome === 'hangup') { assert.equal(socket.sent.length, 0); return; }
  const speech = socket.sent[0];
  assert.equal(speech.text, 'こんにちは');
  assert.equal(call.audio.stopRing.mock.callCount(), 0);
  if (outcome === 'error') {
    socket.onmessage({ data: JSON.stringify({ type: 'error', id: speech.id, message: 'synthesis failed' }) });
    assert.deepEqual(errors, ['synthesis failed']);
  } else {
    socket.onmessage({ data: JSON.stringify({ type: 'audio.start', id: speech.id, sample_rate: 48000 }) });
    assert.equal(call.audio.stopRing.mock.callCount(), 0);
    assert.equal(call.startedAt, undefined);
    socket.onmessage({ data: new Int16Array([1, 2]).buffer });
    assert.equal(call.audio.play.mock.callCount(), 1);
  }
  assert.equal(call.audio.stopRing.mock.callCount(), 1);
  assert.equal(call.openingAudio, false);
  assert.ok(call.startedAt);
  call.stop();
});
