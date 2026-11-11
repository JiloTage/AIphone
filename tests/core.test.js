import test from 'node:test';
import assert from 'node:assert/strict';
import { PCMEncoder, VoiceActivity, pcmBase64 } from '../public/lib/audio-codec.js';
import { readSSE } from '../public/lib/stream.js';
import { conversationInput, readSessions, writeSessions } from '../public/lib/store.js';
import { VoiceCall } from '../public/lib/call.js';

test('streaming SSE preserves Japanese split across arbitrary UTF-8 boundaries', async () => {
  const source = 'data: {"type":"response.output_text.delta","delta":"もしもし。"}\r\n\r\ndata: {"type":"response.completed"}\n\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(source);
  const stream = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2)); controller.close(); } });
  const events = [];
  for await (const event of readSSE(stream)) events.push(event);
  assert.deepEqual(events, [{ type: 'response.output_text.delta', delta: 'もしもし。' }, { type: 'response.completed' }]);
});

for (const rate of [24000, 44100, 48000]) test(`PCM capture resamples ${rate} Hz to 24 kHz across worklet frames`, () => {
  const encoder = new PCMEncoder(rate);
  const output = [];
  const input = new Float32Array(rate).fill(0.5);
  for (let offset = 0; offset < input.length; offset += 128) output.push(...encoder.push(input.slice(offset, offset + 128)));
  assert.equal(output.length, 25);
  assert.equal(output.flatMap(frame => Array.from(frame)).length, 24000);
  assert.ok(output.every(frame => frame.every(sample => sample === 16384)));
  assert.equal(Buffer.from(pcmBase64(output[0]), 'base64').length, 1920);
});

test('VAD ignores a click, starts sustained speech and commits after silence', () => {
  const vad = new VoiceActivity();
  assert.equal(vad.update(.08), null);
  for (let i = 0; i < 20; i++) assert.equal(vad.update(.001), null);
  assert.equal(vad.update(.08), null);
  assert.equal(vad.update(.08), null);
  assert.equal(vad.update(.08), 'start');
  for (let i = 0; i < 6; i++) vad.update(.08);
  let event;
  for (let i = 0; i < 14; i++) event = vad.update(.001);
  assert.equal(event, 'end');
  assert.equal(vad.active, false);
});

test('VAD closes an uninterrupted turn at 25 seconds', () => {
  const vad = new VoiceActivity();
  let ended = false;
  for (let i = 0; i < 630; i++) if (vad.update(.1) === 'end') ended = true;
  assert.equal(ended, true);
});

test('sessions remain separate and corrupt storage is not overwritten', () => {
  let raw = null;
  const storage = { getItem: () => raw, setItem: (_, value) => { raw = value; } };
  const sessions = [
    { id: 'one', title: '仕事', messages: [{ role: 'user', content: '会議の相談' }] },
    { id: 'two', title: '日常', messages: [{ role: 'user', content: '今日のこと' }] },
  ];
  writeSessions(sessions, storage);
  assert.deepEqual(readSessions(storage), sessions);
  raw = '{bad';
  assert.throws(() => readSessions(storage));
  assert.equal(raw, '{bad');
  assert.deepEqual(conversationInput(sessions[1].messages), [{ role: 'user', content: '今日のこと' }]);
});

test('chat context stays bounded and never adds a system role from history', () => {
  const messages = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: String(i).repeat(700) }));
  const result = conversationInput(messages);
  assert.ok(result.length <= 80);
  assert.ok(result.reduce((sum, item) => sum + item.content.length, 0) <= 40_000);
  assert.equal(result[0].role, 'user');
  assert.deepEqual(result.at(-1), messages.at(-1));
});

test('transcription completion is reconciled by committed turn order', () => {
  const result = [];
  const call = new VoiceCall({ transcript: text => result.push(text), partial: () => {}, error: () => {} });
  call.onTranscript({ type: 'input_audio_buffer.committed', item_id: 'first' });
  call.onTranscript({ type: 'input_audio_buffer.committed', item_id: 'second' });
  call.onTranscript({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'second', transcript: '二つ目' });
  assert.deepEqual(result, []);
  call.onTranscript({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'first', transcript: '一つ目' });
  assert.deepEqual(result, ['一つ目', '二つ目']);
  assert.equal(call.transcripts.size, 0);
});

test('failed transcription releases later completed turns', () => {
  const result = [];
  const call = new VoiceCall({ transcript: text => result.push(text), partial: () => {}, error: () => {} });
  call.onTranscript({ type: 'input_audio_buffer.committed', item_id: 'first' });
  call.onTranscript({ type: 'input_audio_buffer.committed', item_id: 'second' });
  call.onTranscript({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'second', transcript: '続き' });
  call.onTranscript({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'first' });
  assert.deepEqual(result, ['続き']);
});

test('long silence still sends heartbeats to both live services', () => {
  const sent = [[], []];
  const call = new VoiceCall({ time: () => {}, state: () => {} });
  call.active = call.ready = true;
  call.audio = { playing: false };
  [call.voice, call.transcription] = sent.map(messages => ({ readyState: WebSocket.OPEN, lastMessage: Date.now(), send: message => messages.push(JSON.parse(message)) }));
  call.tick();
  call.tick();
  assert.deepEqual(sent, [[{ type: 'ping' }], [{ type: 'ping' }]]);
});

test('interruption stops playback, clears pending speech, and cancels remote synthesis', () => {
  let stopped = false;
  const sent = [];
  const call = new VoiceCall({});
  call.audio = { cancel: () => { stopped = true; } };
  call.voice = { readyState: WebSocket.OPEN, send: event => sent.push(JSON.parse(event)) };
  call.pendingAudio.add('old');
  call.currentAudio = 'old';
  call.cancelSpeech();
  assert.equal(stopped, true);
  assert.equal(call.pendingAudio.size, 0);
  assert.equal(call.currentAudio, null);
  assert.deepEqual(sent, [{ type: 'cancel' }]);
});

test('mute stops microphone tracks and clears unfinished transcription', () => {
  const track = { enabled: true };
  const sent = [];
  const call = new VoiceCall({});
  call.audio = { stream: { getAudioTracks: () => [track] } };
  call.transcription = { readyState: WebSocket.OPEN, send: event => sent.push(JSON.parse(event)) };
  call.vad.active = true;
  assert.equal(call.toggleMute(), true);
  assert.equal(track.enabled, false);
  assert.equal(call.vad.active, false);
  assert.deepEqual(sent, [{ type: 'input_audio_buffer.clear' }]);
});
