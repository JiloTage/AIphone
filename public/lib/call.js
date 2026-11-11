import { CallAudio } from './audio.js';
import { VoiceActivity, pcmBase64 } from './audio-codec.js';

function socketUrl(path) { const url = new URL(path, location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; return url; }
const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
  const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});

export class VoiceCall {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.active = false;
    this.ready = false;
    this.muted = false;
    this.vad = new VoiceActivity();
    this.preRoll = [];
    this.pendingAudio = new Set();
    this.turnOrder = [];
    this.transcripts = new Map();
    this.partial = new Map();
    this.generation = 0;
  }
  async start() {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioWorkletNode) throw new Error('このブラウザーでは音声通話を利用できません。最新版のChromeまたはSafariをお試しください。');
    this.active = true;
    this.abort = new AbortController();
    try {
      this.audio = new CallAudio(frame => this.onFrame(frame));
      this.state('ringing', '呼び出しています…', '相手の応答を待っています');
      await this.audio.resume();
      this.audio.ring();
      await Promise.all([this.audio.microphone(), this.connect()]);
      if (!this.active) return;
      this.startedAt = Date.now();
      this.becomeReady();
      this.clock = setInterval(() => this.tick(), 1000);
    } catch (error) {
      this.stop();
      if (error.name === 'NotAllowedError') throw new Error('マイクの使用が許可されていません。ブラウザーの設定でマイクを許可してください。');
      if (error.name !== 'AbortError') throw error;
    }
  }
  async connect() {
    this.connecting = true;
    this.ready = false;
    this.turnOrder = [];
    this.transcripts.clear();
    this.partial.clear();
    const attempt = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, attempt.signal]);
    try {
      await Promise.all([
        (async () => {
          const response = await fetch('/api/call/warm', { method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) });
          if (!response.ok) throw new Error((await response.json()).error || '音声の準備に失敗しました。');
          this.voice = await this.openSocket('/api/voice', 'voice', signal);
        })(),
        (async () => { this.transcription = await this.openSocket('/api/transcription', 'transcription', signal); })(),
      ]);
      if (this.voice.readyState !== WebSocket.OPEN || this.transcription.readyState !== WebSocket.OPEN) throw new Error('音声接続が閉じられました。');
    } catch (error) { attempt.abort(); throw error; }
    finally { this.connecting = false; }
  }
  openSocket(path, kind, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      const ws = new WebSocket(socketUrl(path));
      ws.binaryType = 'arraybuffer';
      this.sockets ??= new Set();
      this.sockets.add(ws);
      let opened = false;
      ws.lastMessage = Date.now();
      const abort = () => { ws.intentional = true; ws.close(); reject(new DOMException('Aborted', 'AbortError')); };
      signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => { ws.close(); reject(new Error('接続に時間がかかっています。もう一度お試しください。')); }, 30_000);
      ws.onmessage = event => {
        ws.lastMessage = Date.now();
        if (!this.active) return;
        if (event.data instanceof ArrayBuffer) {
          if (this.currentAudio && this.pendingAudio.has(this.currentAudio)) this.audio.play(event.data, this.sampleRate);
          return;
        }
        let data;
        try { data = JSON.parse(event.data); } catch { ws.close(); return; }
        if (data.type === 'ready') { opened = true; clearTimeout(timeout); resolve(ws); return; }
        if (data.type === 'error') {
          if (!opened) { clearTimeout(timeout); reject(new Error(data.error?.message || data.message || '接続に失敗しました。')); ws.close(); return; }
          if (kind === 'voice') this.pendingAudio.delete(data.id);
          this.callbacks.error(data.message || data.error?.message || '音声処理でエラーが発生しました。');
          if (kind === 'transcription') ws.close();
          return;
        }
        if (kind === 'voice') this.onVoice(data);
        else this.onTranscript(data);
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        this.sockets.delete(ws);
        signal.removeEventListener('abort', abort);
        if (!opened) reject(new Error('音声接続を開始できませんでした。接続設定を確認してください。'));
        else if (this.active && !this.connecting && !ws.intentional) this.reconnect();
      };
      ws.onerror = () => { if (!opened) { clearTimeout(timeout); reject(new Error('音声サーバーへの接続に失敗しました。')); } };
    });
  }
  becomeReady() {
    this.ready = true;
    this.audio.stopRing();
    this.vad.reset();
    this.preRoll = [];
    this.state('listening', 'お話しください', '声は自動で文字になります');
  }
  async reconnect() {
    if (!this.active || this.reconnecting) return;
    this.reconnecting = true;
    this.ready = false;
    this.callbacks.interrupt();
    this.cancelSpeech();
    for (const socket of this.sockets) socket.close();
    this.audio.ring();
    this.state('ringing', '接続を戻しています…', '会話を残して、つなぎ直します');
    let attempt = 0;
    while (this.active) {
      try {
        await delay(Math.min(1000 * 2 ** attempt++, 10_000), this.abort.signal);
        await this.connect();
        if (this.active) this.becomeReady();
        break;
      } catch (error) {
        this.connecting = true;
        for (const socket of this.sockets) socket.close();
        this.connecting = false;
        if (!this.active || error.name === 'AbortError') break;
      }
    }
    this.reconnecting = false;
  }
  onFrame({ pcm, rms }) {
    if (!this.ready || this.muted || this.transcription?.readyState !== WebSocket.OPEN) return;
    const frame = new Int16Array(pcm);
    this.preRoll.push(frame);
    if (this.preRoll.length > 7) this.preRoll.shift();
    const wasActive = this.vad.active;
    const event = this.vad.update(rms);
    if (event === 'start') {
      this.callbacks.interrupt();
      this.cancelSpeech();
      this.state('listening', '聞いています', '話し終わると、AIが応答します');
      for (const buffered of this.preRoll) this.appendAudio(buffered);
    } else if (wasActive) this.appendAudio(frame);
    if (event === 'end') {
      this.transcription.send('{"type":"input_audio_buffer.commit"}');
      this.state('thinking', '言葉を受け取っています', '少しだけお待ちください');
      this.preRoll = [];
    } else if (event === 'discard') {
      this.transcription.send('{"type":"input_audio_buffer.clear"}');
      this.preRoll = [];
    }
  }
  appendAudio(frame) {
    if (this.transcription.bufferedAmount > 256_000) { this.transcription.close(); return; }
    this.transcription.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcmBase64(frame) }));
  }
  onTranscript(data) {
    if (data.type === 'input_audio_buffer.committed') {
      this.turnOrder.push(data.item_id);
    } else if (data.type === 'conversation.item.input_audio_transcription.delta') {
      this.partial.set(data.item_id, (this.partial.get(data.item_id) || '') + data.delta);
      this.callbacks.partial(this.partial.get(data.item_id));
    } else if (data.type === 'conversation.item.input_audio_transcription.completed') {
      this.transcripts.set(data.item_id, data.transcript);
    } else if (data.type === 'conversation.item.input_audio_transcription.failed') {
      this.transcripts.set(data.item_id, '');
      this.callbacks.error('言葉を聞き取れませんでした。もう一度お話しください。');
    }
    while (this.turnOrder.length && this.transcripts.has(this.turnOrder[0])) {
      const id = this.turnOrder.shift();
      const text = this.transcripts.get(id)?.trim();
      this.transcripts.delete(id);
      this.partial.delete(id);
      this.callbacks.partial('');
      if (text) this.callbacks.transcript(text);
    }
  }
  onVoice(data) {
    if (data.type === 'audio.start') {
      this.currentAudio = data.id;
      this.sampleRate = data.sample_rate;
      if (this.pendingAudio.has(data.id)) this.state('speaking', 'AIが話しています', '話しかけると、応答を止められます');
    } else if (data.type === 'audio.done') this.pendingAudio.delete(data.id);
    else if (data.type === 'audio.cancelled') this.currentAudio = null;
  }
  speak(text) {
    if (!this.ready || this.voice?.readyState !== WebSocket.OPEN) return;
    const id = `${this.generation}-${crypto.randomUUID()}`;
    this.pendingAudio.add(id);
    this.voice.send(JSON.stringify({ type: 'speak', id, text }));
  }
  cancelSpeech() {
    this.generation++;
    this.pendingAudio.clear();
    this.currentAudio = null;
    this.audio?.cancel();
    if (this.voice?.readyState === WebSocket.OPEN) this.voice.send('{"type":"cancel"}');
  }
  thinking(value) { this.isThinking = value; if (value && this.ready) this.state('thinking', 'AIが考えています', 'そのままお待ちください'); }
  toggleMute() {
    this.muted = !this.muted;
    this.audio.stream?.getAudioTracks().forEach(track => { track.enabled = !this.muted; });
    this.vad.reset();
    this.preRoll = [];
    if (this.transcription?.readyState === WebSocket.OPEN) this.transcription.send('{"type":"input_audio_buffer.clear"}');
    this.tick();
    return this.muted;
  }
  state(mode, title, detail) { this.mode = mode; this.callbacks.state(mode, title, detail); }
  tick() {
    if (!this.active) return;
    this.callbacks.time(this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0);
    if (this.ready) {
      for (const socket of [this.voice, this.transcription]) {
        if (socket?.readyState !== WebSocket.OPEN) { this.reconnect(); return; }
        if (Date.now() - socket.lastMessage > 75_000) { socket.close(); return; }
        if (!this.lastPing || Date.now() - this.lastPing > 20_000) socket.send('{"type":"ping"}');
      }
      if (!this.lastPing || Date.now() - this.lastPing > 20_000) this.lastPing = Date.now();
      if (!this.vad.active && !this.audio.playing && !this.pendingAudio.size && !this.isThinking) {
        this.state('listening', this.muted ? 'マイクはミュート中です' : 'お話しください', this.muted ? 'マイクのボタンで解除できます' : '声は自動で文字になります');
      }
    }
  }
  stop() {
    this.active = this.ready = false;
    this.abort?.abort();
    clearInterval(this.clock);
    for (const socket of this.sockets ?? []) socket.close();
    this.audio?.close();
    this.callbacks.partial('');
    this.callbacks.ended();
  }
}
