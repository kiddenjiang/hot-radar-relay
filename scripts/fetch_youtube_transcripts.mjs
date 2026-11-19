// YouTube 热门视频字幕中转：每轮最多处理前10个新视频，成功结果写入 data/transcripts/
import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DIR = 'data/transcripts';
fs.mkdirSync(DIR, { recursive: true });

function extractPlayerResponse(html) {
  const marker = 'ytInitialPlayerResponse';
  const at = html.indexOf(marker);
  if (at < 0) throw new Error('页面缺少播放器响应');
  const start = html.indexOf('{', at);
  if (start < 0) throw new Error('播放器响应为空');
  let depth = 0, quote = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { quote = !quote; continue; }
    if (quote) continue;
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('播放器响应不完整');
}
async function fetchTranscript(id) {
  const r = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error('观看页 HTTP ' + r.status);
  const html = await r.text();
  const player = extractPlayerResponse(html);
  const status = player.playabilityStatus || {};
  if (status.status && status.status !== 'OK') throw new Error('视频不可播放：' + status.status);
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) return { id, ts: new Date().toISOString(), language: '', segments: [], error: 'no_captions' };
  const track = tracks.find(x => x.languageCode === 'en') || tracks[0];
  const sub = await fetch(track.baseUrl + '&fmt=json3', {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!sub.ok) throw new Error('字幕 HTTP ' + sub.status);
  const data = await sub.json();
  const events = (data.events || []).filter(x => Array.isArray(x.segs));
  const segments = events.map((event, i) => {
    const start = Number(event.tStartMs || 0) / 1000;
    const next = events[i + 1];
    const end = event.dDurationMs != null
      ? start + Number(event.dDurationMs || 0) / 1000
      : next ? Number(next.tStartMs || 0) / 1000 : start + 3;
    const text = event.segs.map(x => x.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    return { start: +start.toFixed(2), end: +end.toFixed(2), text };
  }).filter(x => x.text);
  if (!segments.length) throw new Error('字幕内容为空');
  return { id, ts: new Date().toISOString(), language: track.languageCode || '', segments };
}

const trending = JSON.parse(fs.readFileSync('data/youtube.json', 'utf8'));
const items = (trending.items || []).slice(0, 10);
for (const item of items) {
  const file = path.join(DIR, item.id + '.json');
  if (fs.existsSync(file)) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cached.segments?.length || Date.now() - new Date(cached.ts).getTime() < 86400000) {
        console.log('缓存命中', item.id);
        continue;
      }
    } catch {}
  }
  try {
    const result = await fetchTranscript(item.id);
    fs.writeFileSync(file, JSON.stringify(result));
    console.log('字幕完成', item.id, result.segments?.length || 0, result.error || '');
  } catch (error) {
    console.error('字幕失败', item.id, error.message);
  }
}
