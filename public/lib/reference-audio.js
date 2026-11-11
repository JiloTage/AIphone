export function encodeReferenceWav(samples) {
  if (!(samples instanceof Float32Array) || samples.length < 12_000 || samples.length > 2_880_000) throw new Error('参照音声は0.5〜120秒にしてください。');
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const tag = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  tag(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) throw new Error('音声データに不正な値があります。');
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export async function convertReference(file) {
  if (!file || file.size > 25_000_000) throw new Error('25 MB以下の音声ファイルを選択してください。');
  let decoded;
  try { decoded = await new OfflineAudioContext(1, 1, 24000).decodeAudioData(await file.arrayBuffer()); }
  catch { throw new Error('この音声形式を読み込めませんでした。WAVやMP3でお試しください。'); }
  if (decoded.duration < 0.5 || decoded.duration > 120) throw new Error('参照音声は0.5〜120秒にしてください。');
  const renderer = new OfflineAudioContext(1, Math.round(decoded.duration * 24000), 24000);
  const source = renderer.createBufferSource();
  source.buffer = decoded;
  source.connect(renderer.destination);
  source.start();
  return encodeReferenceWav((await renderer.startRendering()).getChannelData(0));
}
