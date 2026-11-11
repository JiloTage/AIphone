const OPENAI = 'https://api.openai.com/v1';
const MAX_BODY = 128_000;

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function configuration(env) {
  return { openai: Boolean(env.OPENAI_API_KEY), voice: Boolean(env.MODAL_API_URL && env.MODAL_API_TOKEN) };
}

export function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 80) return false;
  let size = 0;
  for (const message of messages) {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') return false;
    if (!message.content.trim() || message.content.length > 4000) return false;
    size += message.content.length;
  }
  return size <= 40_000 && messages.at(-1).role === 'user';
}

export function transcriptionSession(models, prompt) {
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: { input: {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription: { ...models.transcription, prompt: prompt.trim() },
        turn_detection: null,
      } },
    },
  };
}

async function readBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('JSON形式で送信してください。');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('本文がありません。');
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY) { await reader.cancel(); throw new Error('会話が長すぎます。新しい会話を始めてください。'); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

function closeSocket(socket, code = 1011, reason = 'Connection lost') {
  try { socket.close(code, reason); } catch { /* The peer may already be closed. */ }
}

async function transcriptionSocket(request, env, settings, fetcher) {
  const response = await fetcher(`${OPENAI}/realtime?intent=transcription`, {
    headers: { Upgrade: 'websocket', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
  });
  const upstream = response.webSocket;
  if (!upstream) return json({ error: '文字起こしに接続できませんでした。OpenAIの設定を確認してください。' }, 502);
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  upstream.accept();
  let ready = false;
  upstream.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'session.updated') {
        ready = true;
        server.send(JSON.stringify({ type: 'ready' }));
      } else if (data.type === 'error') {
        server.send(JSON.stringify({ type: 'error', error: { message: '文字起こしでエラーが発生しました。接続をやり直してください。' } }));
      } else if (data.type.startsWith('conversation.item.input_audio_transcription.') || data.type === 'input_audio_buffer.committed') {
        server.send(event.data);
      }
    } catch { closeSocket(server); closeSocket(upstream); }
  });
  server.addEventListener('message', event => {
    try {
      if (typeof event.data !== 'string' || event.data.length > 32_000) throw new Error('Invalid message');
      const data = JSON.parse(event.data);
      if (data.type === 'ping') { server.send('{"type":"pong"}'); return; }
      if (!ready) return;
      if (data.type === 'input_audio_buffer.append') {
        if (typeof data.audio !== 'string' || data.audio.length > 24_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.audio)) throw new Error('Invalid audio');
        upstream.send(JSON.stringify({ type: data.type, audio: data.audio }));
      } else if (['input_audio_buffer.commit', 'input_audio_buffer.clear'].includes(data.type)) {
        upstream.send(JSON.stringify({ type: data.type }));
      } else throw new Error('Invalid event');
    } catch { closeSocket(server, 1008, 'Invalid audio event'); closeSocket(upstream); }
  });
  for (const [a, b] of [[server, upstream], [upstream, server]]) {
    a.addEventListener('close', () => closeSocket(b, 1000, 'Peer closed'));
    a.addEventListener('error', () => closeSocket(b));
  }
  upstream.send(JSON.stringify(transcriptionSession(settings.models, settings.transcriptionPrompt)));
  return new Response(null, { status: 101, webSocket: client });
}

export async function handleRequest(request, env, settings, fetcher = fetch) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: '別のサイトからは利用できません。' }, 403);
  if (path === '/api/status' && request.method === 'GET') {
    return json({ ...configuration(env), models: { chat: settings.models.chat.model, transcription: settings.models.transcription.model } });
  }
  const routes = { '/api/chat': 'POST', '/api/call/warm': 'POST', '/api/voice': 'GET', '/api/transcription': 'GET' };
  if (!routes[path]) return json({ error: 'Not found' }, 404);
  if (request.method !== routes[path]) return json({ error: 'Method not allowed' }, 405);
  const configured = configuration(env);
  if (!configured.openai || (path !== '/api/chat' && !configured.voice)) {
    return json({ error: '接続設定が完了していません。OpenAIと音声サーバーの設定が必要です。', configured }, 503);
  }
  try {
    if (path === '/api/chat') {
      let body;
      try { body = await readBody(request); } catch { return json({ error: '会話データが不正、または長すぎます。' }, 400); }
      if (!body || !validateMessages(body.messages)) return json({ error: '会話データが不正、または長すぎます。' }, 400);
      const response = await fetcher(`${OPENAI}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settings.models.chat, instructions: settings.systemPrompt.trim(), input: body.messages.map(({ role, content }) => ({ role, content })), stream: true, store: false }),
        signal: request.signal,
      });
      if (!response.ok) {
        console.error('chat_upstream_error', response.status, response.headers.get('x-request-id'));
        return json({ error: 'AIの応答を取得できませんでした。時間をおいて再度お試しください。' }, response.status === 429 ? 429 : 502);
      }
      return new Response(response.body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
    }
    if (path === '/api/transcription') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 426);
      return await transcriptionSocket(request, env, settings, fetcher);
    }
    const modalUrl = new URL(env.MODAL_API_URL);
    if (modalUrl.protocol !== 'https:') throw new Error('Invalid Modal URL');
    modalUrl.pathname = path === '/api/voice' ? '/ws' : '/health';
    modalUrl.search = '';
    const headers = { Authorization: `Bearer ${env.MODAL_API_TOKEN}` };
    if (path === '/api/voice') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 426);
      headers.Upgrade = 'websocket';
    }
    const response = await fetcher(modalUrl, { headers, signal: request.signal });
    if (path === '/api/voice' && response.webSocket) return response;
    if (!response.ok) return json({ error: '音声サーバーに接続できませんでした。しばらくしてからお試しください。' }, 502);
    if (path === '/api/voice') return json({ error: '音声接続を開始できませんでした。' }, 502);
    const health = await response.json();
    if (health.status !== 'ready') throw new Error('TTS not ready');
    return json({ ready: true });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.error('upstream_connection_error', error.name);
    return json({ error: '接続が途切れました。もう一度お試しください。' }, 502);
  }
}
