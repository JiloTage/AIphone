export async function* readSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data && data !== '[DONE]') yield JSON.parse(data);
      }
      if (done) break;
      if (buffer.length > 2_000_000) throw new Error('応答が大きすぎます。');
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function takeSentences(text, flush = false) {
  const chunks = [];
  let rest = text;
  while (rest.length) {
    const end = /[。！？!?\n]/.exec(rest);
    let length = end ? end.index + 1 : 0;
    if (!length || length > 70) {
      if (rest.length < 70 && !flush) break;
      const cap = Math.min(70, rest.length);
      const comma = Math.max(rest.lastIndexOf('、', cap - 1), rest.lastIndexOf(' ', cap - 1));
      length = comma >= 20 ? comma + 1 : cap;
    }
    if (/[\uD800-\uDBFF]/.test(rest[length - 1]) && length < rest.length) length++;
    const sentence = rest.slice(0, length).trim();
    if (sentence) chunks.push(sentence);
    rest = rest.slice(length);
  }
  return { chunks, rest };
}
