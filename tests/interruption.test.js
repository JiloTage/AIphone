import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCall } from '../public/lib/call.js';

function fixture() {
  const events = [], sent = [], transcripts = [];
  const call = new VoiceCall({ interrupt: () => events.push('interrupt'), state() {}, partial() {}, error() {}, transcript: text => transcripts.push(text) });
  call.ready = true;
  call.audio = { cancel: () => events.push('cancel') };
  call.voice = { readyState: WebSocket.OPEN, send: data => sent.push(JSON.parse(data)) };
  call.transcription = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: data => sent.push(JSON.parse(data)) };
  call.pendingAudio.add('playing');
  call.currentAudio = 'playing';
  return { call, events, sent, transcripts };
}
function frames(call, count, rms) {
  for (let i = 0; i < count; i++) call.onFrame({ pcm: new Int16Array(960).buffer, rms });
}
function transcript(call, type, fields = {}) {
  call.onTranscript({ type: `conversation.item.input_audio_transcription.${type}`, item_id: 'one', ...fields });
}

test('a 120ms sound discarded as noise does not interrupt playback', () => {
  const { call, events, sent } = fixture();
  frames(call, 3, 0.02); frames(call, 14, 0);
  assert.equal(sent.at(-1).type, 'input_audio_buffer.clear');
  assert.deepEqual(events, []);
  assert.equal(call.pendingAudio.has('playing'), true);
});

test('capture and commit keep playback; first words interrupt once', () => {
  const { call, events, sent, transcripts } = fixture();
  frames(call, 5, 0.02); frames(call, 14, 0);
  assert.equal(sent.at(-1).type, 'input_audio_buffer.commit');
  assert.deepEqual(events, []);
  call.onTranscript({ type: 'input_audio_buffer.committed', item_id: 'one' });
  transcript(call, 'delta', { delta: ' ' });
  assert.deepEqual(events, []);
  transcript(call, 'delta', { delta: '待って' });
  assert.deepEqual(events, ['interrupt', 'cancel']);
  transcript(call, 'delta', { delta: 'ください' });
  transcript(call, 'completed', { transcript: '待ってください' });
  assert.deepEqual(events, ['interrupt', 'cancel']);
  assert.equal(sent.filter(event => event.type === 'cancel').length, 1);
  assert.equal(call.pendingAudio.size, 0);
  assert.deepEqual(transcripts, ['待ってください']);
});

test('completed words interrupt even without partial results', () => {
  const { call, events, transcripts } = fixture();
  call.onTranscript({ type: 'input_audio_buffer.committed', item_id: 'one' });
  transcript(call, 'completed', { transcript: '待って' });
  assert.deepEqual(events, ['interrupt', 'cancel']);
  assert.deepEqual(transcripts, ['待って']);
});

for (const type of ['completed', 'failed']) test(`${type} without words does not interrupt`, () => {
  const { call, events, transcripts } = fixture();
  call.onTranscript({ type: 'input_audio_buffer.committed', item_id: 'one' });
  transcript(call, type, { transcript: '  ' });
  assert.deepEqual(events, []);
  assert.deepEqual(transcripts, []);
});
