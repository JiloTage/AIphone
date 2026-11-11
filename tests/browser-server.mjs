// Local UI fixture only. This file is outside the deployed assets and never calls an AI API.
import { createServer } from 'node:http';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const log = fileURLToPath(new URL('../evidence/browser-fixture.jsonl', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
export function fixtureAnswer(messages) {
  assert.ok(Array.isArray(messages) && messages.at(-1)?.role === 'user');
  return `画面検証用の応答です。「${messages.at(-1).content}」を受け取りました。`;
}
assert.equal(fixtureAnswer([{ role: 'user', content: 'テスト' }]), '画面検証用の応答です。「テスト」を受け取りました。');
await mkdir(path.dirname(log), { recursive: true });
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1:8788');
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ openai: true, voice: false }));
      return;
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 128000) throw new Error('Too large'); }
      const input = JSON.parse(body);
      const output = fixtureAnswer(input.messages);
      await appendFile(log, JSON.stringify({ at: new Date().toISOString(), source: 'local fixture, no AI call', input, output }) + '\n');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      for (const delta of output.match(/.{1,8}/gu)) res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`);
      res.end('data: {"type":"response.completed"}\n\n');
      return;
    }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(bytes);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(8788, '127.0.0.1', () => console.log('UI fixture: http://127.0.0.1:8788 (no AI calls)'));
