import { readSessions, writeSessions, newSession, conversationInput } from './lib/store.js';
import { readSSE } from './lib/stream.js';
import { VoiceCall } from './lib/call.js';
import { setupVoiceSettings } from './settings.js';

const $ = id => document.getElementById(id);
const mobile = matchMedia('(max-width: 760px)');
let sessions = [], current, call = null, pending = null, configured = { openai: false, voice: false };
let storageHealthy = true;
function notice(message, error = false) { $('notice').textContent = message; $('notice').hidden = !message; $('notice').classList.toggle('error', error); }
try { sessions = readSessions(); } catch (error) { storageHealthy = false; notice(error.message, true); }
current = sessions[0] || newSession();

function save() {
  if (!storageHealthy) return;
  try { writeSessions(sessions); } catch { notice('会話を保存できませんでした。ブラウザーの空き容量や保存の許可を確認してください。', true); }
}
function ensureSession() {
  if (!sessions.some(session => session.id === current.id)) sessions.unshift(current);
}
function renderSidebar() {
  $('session-list').replaceChildren();
  for (const session of sessions) {
    const row = document.createElement('div');
    row.className = `session-row${session.id === current.id ? ' active' : ''}`;
    const button = document.createElement('button');
    button.className = 'session-button';
    button.textContent = session.title;
    button.title = session.title;
    if (session.id === current.id) button.setAttribute('aria-current', 'page');
    button.onclick = () => { switchSession(session); sidebar(false); };
    const remove = document.createElement('button');
    remove.className = 'delete-session';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `${session.title}を削除`);
    remove.onclick = () => {
      if (!confirm(`「${session.title}」を削除しますか？`)) return;
      if (session.id === current.id) { endCall(); stopResponse(); }
      sessions = sessions.filter(item => item.id !== session.id);
      if (session.id === current.id) current = sessions[0] || newSession();
      save(); render();
    };
    row.append(button, remove);
    $('session-list').append(row);
  }
  $('sidebar-empty').hidden = sessions.length > 0;
}
function messageElement(message) {
  const article = $('message-template').content.firstElementChild.cloneNode(true);
  article.classList.add(message.role);
  article.dataset.id = message.id;
  article.querySelector('.message-avatar').textContent = message.role === 'assistant' ? 'ai' : 'You';
  article.querySelector('.message-meta').textContent = message.role === 'assistant' ? 'AIphone' : 'あなた';
  article.querySelector('.message-text').textContent = message.content;
  article.querySelector('.message-state').textContent = message.state || '';
  if (message.pending) article.classList.add('pending');
  return article;
}
function render() {
  renderSidebar();
  $('chat-title').textContent = current.title;
  $('welcome').hidden = current.messages.length > 0 || Boolean(call);
  $('messages').replaceChildren(...current.messages.map(messageElement));
  $('send').hidden = Boolean(pending);
  $('stop').hidden = !pending;
}
function scrollDown() { $('conversation').scrollTop = $('conversation').scrollHeight; }
function switchSession(session) {
  if (session.id === current.id) return;
  endCall(); stopResponse(); current = session;
  $('message-input').value = ''; $('message-input').style.height = '';
  render();
}
function addMessage(role, content) {
  ensureSession();
  const message = { id: crypto.randomUUID(), role, content };
  current.messages.push(message);
  current.updatedAt = Date.now();
  if (role === 'user' && current.title === '新しい会話') current.title = content.slice(0, 24);
  return message;
}
function stopResponse() {
  if (pending) {
    pending.message.state = '応答を中断しました';
    pending.message.pending = false;
    pending.abort.abort();
    pending = null;
    save();
  }
  call?.cancelSpeech();
  call?.thinking(false);
  render();
}
async function sendMessage(text, opening = false) {
  text = text.trim();
  if (!text && !opening) return;
  if (!configured.openai) { notice('OpenAIの接続設定が必要です。設定後に、もう一度お試しください。', true); return; }
  stopResponse();
  notice('');
  if (!opening) addMessage('user', text);
  const input = conversationInput(opening ? [...current.messages, {
    role: 'user', content: '通話が今つながりました。あなたから自然に話しかけて会話を始めてください。会話履歴があれば踏まえてください。この指示自体には言及せず、最初の短い一言だけを話してください。',
  }] : current.messages);
  const message = addMessage('assistant', '');
  message.pending = true;
  const task = { message, abort: new AbortController(), session: current, voice: call };
  pending = task;
  save(); render(); scrollDown();
  call?.thinking(true);
  let finished = false;
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: input }), signal: task.abort.signal });
    if (!response.ok) throw new Error((await response.json()).error || '応答を取得できませんでした。');
    for await (const event of readSSE(response.body)) {
      if (pending !== task) break;
      if (event.type === 'response.output_text.delta') {
        message.content += event.delta;
        const node = $('messages').querySelector(`[data-id="${message.id}"] .message-text`);
        if (node) node.textContent = message.content;
        scrollDown();
      } else if (event.type === 'response.refusal.delta') {
        message.content += event.delta;
      } else if (event.type === 'response.completed') finished = true;
      else if (event.type === 'response.failed' || event.type === 'error') throw new Error('AIの応答中にエラーが発生しました。');
      else if (event.type === 'response.incomplete') throw new Error('応答が途中で終了しました。続きはもう一度話しかけてください。');
    }
    if (pending === task) {
      if (!finished) throw new Error('応答中に接続が途切れました。');
      if (task.voice === call) call?.speak(message.content);
    }
  } catch (error) {
    if (error.name !== 'AbortError') { message.state = error.message; if (pending === task) notice(error.message, true); }
  } finally {
    message.pending = false;
    if (pending === task) { pending = null; call?.thinking(false); render(); }
    save();
  }
}

async function beginCall() {
  if (call) return;
  if (!configured.openai || !configured.voice) { notice('通話の接続設定がまだ完了していません。OpenAIと音声サーバーの設定後に利用できます。', true); return; }
  stopResponse();
  notice('');
  ensureSession(); save();
  const voice = new VoiceCall({
    greeting: () => { sendMessage('', true).catch(error => notice(error.message, true)); },
    state: (state, title, detail) => {
      $('call-panel').dataset.state = state;
      $('call-status').textContent = title;
      $('call-detail').textContent = detail;
      $('connection-badge').classList.add('active');
      $('connection-label').textContent = state === 'ringing' ? '接続中' : '通話中';
    },
    partial: text => { $('live-transcript').textContent = text; $('live-transcript').hidden = !text; },
    transcript: text => { sendMessage(text).catch(error => notice(error.message, true)); },
    interrupt: () => stopResponse(),
    error: message => notice(message, true),
    time: seconds => { $('call-time').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; },
    ended: () => {
      if (call !== voice) return;
      call = null;
      $('call-panel').hidden = true;
      $('call-toggle').disabled = false;
      $('connection-badge').classList.remove('active');
      $('connection-label').textContent = configured.openai && configured.voice ? '通話できます' : '設定待ち';
      render();
    },
  });
  call = voice;
  $('call-panel').hidden = false;
  $('call-toggle').disabled = true;
  $('mute').setAttribute('aria-pressed', 'false');
  $('mute').setAttribute('aria-label', 'マイクをミュート');
  $('call-time').textContent = '00:00';
  render();
  try { await voice.start(); } catch (error) { if (call === voice) voice.stop(); notice(error.message, true); }
}
function endCall() { if (!call) return; stopResponse(); call.stop(); }
function sidebar(open) {
  const visible = Boolean(open && mobile.matches);
  const hadFocus = $('sidebar').contains(document.activeElement);
  $('sidebar').classList.toggle('open', visible);
  $('sidebar').inert = mobile.matches && !visible;
  document.querySelector('main').inert = visible;
  $('sidebar-backdrop').hidden = !visible;
  $('menu-toggle').setAttribute('aria-expanded', String(visible));
  if (visible) $('new-chat').focus();
  else if (hadFocus && mobile.matches) $('menu-toggle').focus();
}
mobile.addEventListener('change', () => sidebar(false));

$('new-chat').onclick = () => { switchSession(newSession()); sidebar(false); $('message-input').focus(); };
$('menu-toggle').onclick = () => sidebar(!$('sidebar').classList.contains('open'));
$('sidebar-backdrop').onclick = () => sidebar(false);
setupVoiceSettings(() => sidebar(false), () => Boolean(call));
$('welcome-call').onclick = beginCall;
$('call-toggle').onclick = beginCall;
$('hangup').onclick = endCall;
$('mute').onclick = () => { const muted = call?.toggleMute(); $('mute').setAttribute('aria-pressed', String(Boolean(muted))); $('mute').setAttribute('aria-label', muted ? 'マイクのミュートを解除' : 'マイクをミュート'); };
$('stop').onclick = stopResponse;
$('composer').onsubmit = event => {
  event.preventDefault();
  const text = $('message-input').value;
  if (configured.openai && text.trim()) { $('message-input').value = ''; $('message-input').style.height = ''; }
  sendMessage(text).catch(error => notice(error.message, true));
};
$('message-input').oninput = () => { $('message-input').style.height = 'auto'; $('message-input').style.height = `${Math.min($('message-input').scrollHeight, 150)}px`; };
$('message-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } };
for (const button of document.querySelectorAll('[data-starter]')) button.onclick = () => { $('message-input').value = button.dataset.starter; $('message-input').focus(); };
document.addEventListener('keydown', event => {
  if ($('voice-settings').open) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('new-chat').click(); }
  if (event.key === 'Escape') sidebar(false);
});
window.addEventListener('pagehide', () => { endCall(); save(); });
if (!navigator.platform?.includes('Mac')) $('new-chat').querySelector('kbd').textContent = 'Ctrl K';
sidebar(false);
render();
try {
  const response = await fetch('/api/status');
  if (!response.ok) throw new Error('接続状態を確認できませんでした。ページを再読み込みしてください。');
  configured = await response.json();
  const ready = configured.openai && configured.voice;
  $('connection-label').textContent = ready ? '通話できます' : '設定待ち';
  $('connection-badge').classList.toggle('ready', ready);
  if (!ready && storageHealthy) notice('通話をはじめるには、OpenAIと音声サーバーの接続設定が必要です。');
} catch (error) { $('connection-label').textContent = '接続を確認できません'; notice(error.message, true); }
