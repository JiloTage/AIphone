import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { conversationInput } from '../public/lib/store.js';
import { readSSE } from '../public/lib/stream.js';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const sendMessage = source.slice(source.indexOf('async function sendMessage('), source.indexOf('\nasync function beginCall('));

for (const outcome of ['new', 'history', 'interrupted', 'failed', 'normal']) test(`generated opening: ${outcome}`, async () => {
  const messages = outcome === 'history' ? [{ role: 'user', content: '旅行の話をしたい' }, { role: 'assistant', content: 'どこへ行きたいですか？' }] : [];
  const previous = structuredClone(messages);
  const spoken = [], requests = [];
  const generated = 'またお話しできてうれしいです。旅行の続きを聞かせてもらえますか？';
  const noop = () => {};
  const context = vm.createContext({
    configured: { openai: true }, current: { messages }, pending: null,
    call: { thinking: noop, speak: text => spoken.push(text) },
    AbortController, conversationInput, readSSE,
    notice: noop, save: noop, render: noop, scrollDown: noop,
    $: () => ({ querySelector: () => null }),
    addMessage(role, content) { const message = { role, content, id: String(messages.length) }; messages.push(message); return message; },
    stopResponse() { context.pending?.abort.abort(); context.pending = null; },
    async fetch(url, options) {
      requests.push({ url, body: JSON.parse(options.body) });
      if (outcome === 'interrupted') { context.stopResponse(); throw new DOMException('Aborted', 'AbortError'); }
      if (outcome === 'failed') return Response.json({ error: '生成失敗' }, { status: 502 });
      return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: generated })}\n\ndata: {"type":"response.completed"}\n\n`);
    },
  });
  vm.runInContext(sendMessage, context);
  await context.sendMessage(outcome === 'normal' ? 'こんにちは' : '', outcome !== 'normal');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/chat');
  assert.deepEqual(requests[0].body.messages.slice(0, previous.length), previous);
  if (outcome === 'normal') assert.equal(messages[0].content, 'こんにちは');
  else {
    assert.equal(messages.filter(m => m.role === 'user').length, previous.filter(m => m.role === 'user').length);
    assert.match(requests[0].body.messages.at(-1).content, /あなたから自然に話しかけて/);
  }
  if (['failed', 'interrupted'].includes(outcome)) {
    assert.deepEqual(spoken, []);
    assert.equal(messages.at(-1).content, '');
  } else {
    assert.deepEqual(spoken, [generated]);
    assert.equal(messages.at(-1).content, generated);
  }
});
