import { CallAudio } from './lib/audio.js';
import { convertReference } from './lib/reference-audio.js';

export function setupVoiceSettings(closeSidebar, isCalling) {
  const $ = id => document.getElementById(id);
  const dialog = $('voice-settings'), form = $('voice-settings-form');
  let state, operation, preview, busy = false;
  const message = (text, error = false) => { $('settings-message').textContent = text; $('settings-message').classList.toggle('error', error); };
  function controls() {
    $('settings-fields').disabled = busy || !state;
    $('save-settings').disabled = $('reset-settings').disabled = busy || !state;
    $('reload-settings').disabled = busy;
    const fixed = form.elements.seconds.value !== '';
    form.elements.duration_scale.disabled = fixed;
    if (fixed) form.elements.duration_scale.value = '1';
    for (const field of $('tail-fields').querySelectorAll('input')) field.disabled = form.elements.keep_tail.checked;
  }
  function fill(options, referenceId) {
    for (const [key, value] of Object.entries(options)) {
      const field = form.elements.namedItem(key);
      if (!field) continue;
      if (field.type === 'checkbox') field.checked = value;
      else field.value = value ?? '';
    }
    $('voice-reference').value = referenceId;
    controls();
  }
  function values() {
    const options = {};
    for (const key of Object.keys(state.defaults)) {
      const field = form.elements.namedItem(key);
      options[key] = field.type === 'checkbox' ? field.checked : field.type === 'number' ? (field.value === '' ? null : Number(field.value)) : field.value;
    }
    return { options, reference_id: $('voice-reference').value };
  }
  async function api(path, init = {}) {
    const response = await fetch(`/api/voice${path}`, {
      ...init, headers: { ...(state ? { 'If-Match': state.revision } : {}), ...init.headers },
      signal: AbortSignal.any([operation.signal, AbortSignal.timeout(180_000)]),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '音声設定を読み書きできませんでした。');
    return result;
  }
  async function run(text, action) {
    if (busy) return;
    busy = true; operation = new AbortController(); controls(); message(text);
    try { await action(); }
    catch (error) { if (error.name !== 'AbortError') message(error.message, true); }
    finally { busy = false; controls(); }
  }
  function references(selected = state.reference_id) {
    for (const audio of $('reference-list').querySelectorAll('audio')) audio.pause();
    $('voice-reference').replaceChildren(new Option('おまかせ（参照音声なし）', ''));
    $('reference-list').replaceChildren();
    $('reference-count').textContent = `${state.references.length} / 32`;
    if (!state.references.length) {
      const empty = document.createElement('p'); empty.className = 'reference-empty';
      empty.textContent = 'まだ参照音声がありません。下から最初の声を登録できます。';
      $('reference-list').append(empty);
    }
    for (const reference of state.references) {
      $('voice-reference').append(new Option(reference.name, reference.id));
      const row = document.createElement('div'); row.className = 'reference-row';
      const name = document.createElement('strong'); name.textContent = reference.name;
      const duration = document.createElement('small'); duration.textContent = `${reference.duration.toFixed(1)} 秒`;
      const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none';
      audio.src = `/api/voice/references/${reference.id}`; audio.setAttribute('aria-label', `${reference.name}の参照音声`);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button';
      remove.textContent = '削除'; remove.setAttribute('aria-label', `${reference.name}を削除`);
      remove.onclick = () => {
        if (!confirm(`「${reference.name}」をアプリから削除しますか？ すべての端末から使えなくなります。`)) return;
        run('参照音声を削除しています…', async () => {
          const current = $('voice-reference').value;
          state = await api(`/references/${reference.id}`, { method: 'DELETE' });
          references(current === reference.id ? '' : current);
          message('参照音声をアプリから削除しました。');
        });
      };
      const title = document.createElement('div'); title.append(name, duration);
      row.append(title, audio, remove); $('reference-list').append(row);
    }
    $('voice-reference').value = state.references.some(item => item.id === selected) ? selected : '';
  }
  const reload = () => run('アプリの設定を読み込んでいます。サーバーの起動時は1〜2分ほどかかります…', async () => {
    state = await api('/settings'); references(); fill(state.options, state.reference_id); message('アプリに保存された設定を読み込みました。');
  });
  function stopPreview() {
    if (!preview) return;
    const old = preview; preview = null;
    clearInterval(old.timer); clearTimeout(old.timeout);
    old.socket?.close(); old.audio.close();
    $('stop-preview').hidden = true; $('preview-voice').disabled = false;
  }
  $('open-settings').onclick = () => { closeSidebar(); dialog.showModal(); reload(); };
  $('close-settings').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { operation?.abort(); stopPreview(); for (const audio of $('reference-list').querySelectorAll('audio')) audio.pause(); });
  $('reload-settings').onclick = () => { stopPreview(); reload(); };
  form.elements.seconds.oninput = controls;
  form.elements.keep_tail.onchange = controls;
  $('reset-settings').onclick = () => { fill(state.defaults, ''); message('初期値に戻しました。「設定を保存」で反映されます。'); };
  form.onsubmit = event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const body = values();
    run('アプリに保存しています…', async () => {
      state = await api('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      message('アプリに保存しました。次の通話から、この設定を使います。');
    });
  };
  $('reference-file').onchange = () => { if (!$('reference-name').value) $('reference-name').value = ($('reference-file').files[0]?.name || '').replace(/\.[^.]+$/, '').slice(0, 60); };
  $('register-reference').onclick = () => {
    const name = $('reference-name').value.trim(), file = $('reference-file').files[0];
    if (!name || !file) { message('登録名と音声ファイルを指定してください。', true); return; }
    run('音声を変換してアプリに登録しています…', async () => {
      const recording = await convertReference(file);
      operation.signal.throwIfAborted();
      const previous = new Set(state.references.map(item => item.id));
      state = await api(`/references?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: recording });
      references(state.references.find(item => !previous.has(item.id))?.id);
      $('reference-name').value = ''; $('reference-file').value = '';
      message('参照音声を登録しました。この声を通話に使うには「設定を保存」を押してください。');
    });
  };
  $('stop-preview').onclick = () => { stopPreview(); message('試聴を止めました。'); };
  $('preview-voice').onclick = async () => {
    if (isCalling()) { message('試聴するには、いったん通話を終了してください。', true); return; }
    if (!form.reportValidity()) return;
    const text = $('preview-text').value.trim();
    if (!text) { message('試聴する文章を入力してください。', true); return; }
    stopPreview();
    const current = { audio: new CallAudio(), id: crypto.randomUUID(), started: false, done: false, lastPing: Date.now() };
    preview = current;
    $('preview-voice').disabled = true; $('stop-preview').hidden = false;
    message('試聴の音声を準備しています…');
    const fail = text => { if (preview === current) { stopPreview(); message(text, true); } };
    try {
      await current.audio.resume();
      if (preview !== current) return;
      const url = new URL('/api/voice', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = current.socket = new WebSocket(url); socket.binaryType = 'arraybuffer';
      const settings = values();
      current.timeout = setTimeout(() => fail('音声の準備がタイムアウトしました。もう一度お試しください。'), 180_000);
      current.timer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN && Date.now() - current.lastPing > 20_000) { socket.send('{"type":"ping"}'); current.lastPing = Date.now(); }
        if (current.done && !current.audio.playing) { stopPreview(); message('試聴が終わりました。'); }
      }, 500);
      socket.onmessage = event => {
        if (preview !== current) return;
        if (event.data instanceof ArrayBuffer) { if (current.started) current.audio.play(event.data, current.rate); return; }
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'ready') socket.send(JSON.stringify({ type: 'speak', id: current.id, text, ...settings }));
          else if (data.type === 'audio.start') { current.started = true; current.rate = data.sample_rate; message('試聴しています…'); }
          else if (data.type === 'audio.done') { current.done = true; clearTimeout(current.timeout); }
          else if (data.type === 'error') fail(data.message || '音声を生成できませんでした。');
        } catch { fail('試聴の音声を受け取れませんでした。'); }
      };
      socket.onerror = () => fail('音声サーバーに接続できませんでした。');
      socket.onclose = () => { if (preview === current && !current.done) fail('試聴の接続が切れました。もう一度お試しください。'); };
    } catch (error) { fail(error.message); }
  };
}
