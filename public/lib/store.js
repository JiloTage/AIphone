const KEY = 'aiphone.sessions.v1';

export function readSessions(storage = localStorage) {
  const raw = storage.getItem(KEY);
  if (!raw) return [];
  const sessions = JSON.parse(raw);
  if (!Array.isArray(sessions) || sessions.some(s => !s || typeof s.id !== 'string' || typeof s.title !== 'string' || !Array.isArray(s.messages) || s.messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string'))) {
    throw new Error('保存された会話を読み込めません。ブラウザーのデータは保持しています。');
  }
  return sessions;
}

export function writeSessions(sessions, storage = localStorage) {
  storage.setItem(KEY, JSON.stringify(sessions));
}

export function newSession() {
  return { id: crypto.randomUUID(), title: '新しい会話', updatedAt: Date.now(), messages: [] };
}

export function conversationInput(messages) {
  const result = [];
  let size = 0;
  for (const message of messages.slice().reverse()) {
    if (!message.content?.trim()) continue;
    if (message.content.length > 4000) throw new Error('一回のメッセージは4,000文字までです。');
    if (result.length === 80 || size + message.content.length > 40_000) break;
    size += message.content.length;
    result.unshift({ role: message.role, content: message.content });
  }
  // shortcut: long chats send only the latest 40k characters; add summarization if older context is needed.
  while (result[0]?.role === 'assistant') result.shift();
  return result;
}
