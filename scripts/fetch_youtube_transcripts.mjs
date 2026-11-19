// YouTube 字幕中转：visitorData + Android Innertube，观看页仅作备用
import fs from 'node:fs';
import path from 'node:path';

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ANDROID_VERSION = '20.10.38';
const ANDROID_UA = `com.google.android.youtube/${ANDROID_VERSION} (Linux; U; Android 14) gzip`;
const DIR = 'data/transcripts';
fs.mkdirSync(DIR, { recursive: true });

async function apiPost(endpoint, body, headers) {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.youtube.com', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`${endpoint.split('/').pop()} HTTP ${r.status}`);
  return r.json();
}
async function visitorData(id) {
  const data = await apiPost('https://www.youtube.com/youtubei/v1/next?prettyPrint=false', {
    context: { client: { clientName: 'WEB', clientVersion: '2.20261118.00.00', hl: 'en', gl: 'US' } },
    videoId: id,
  }, { 'User-Agent': WEB_UA });
  return data.responseContext?.visitorData || '';
}
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
function decodeXml(value) {
  return String(value || '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
function xmlSegments(xml) {
  const out = [];
  const parse = (tag, start, dur, body) => {
    const text = decodeXml(String(body || '').replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (text) out.push({ start: +start.toFixed(2), end: +(start + dur).toFixed(2), text });
  };
  for (const m of xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(x => [x[1], x[2]]));
    parse('text', Number(attrs.start || 0), Number(attrs.dur || 0), m[2]);
  }
  for (const m of xml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(x => [x[1], x[2]]));
    parse('p', Number(attrs.t || 0) / 1000, Number(attrs.d || 0) / 1000, m[2]);
  }
  return out;
}
function jsonSegments(data) {
  const events = (data.events || []).filter(x => Array.isArray(x.segs));
  return events.map((event, i) => {
    const start = Number(event.tStartMs || 0) / 1000;
    const next = events[i + 1];
    const end = event.dDurationMs != null
      ? start + Number(event.dDurationMs || 0) / 1000
      : next ? Number(next.tStartMs || 0) / 1000 : start + 3;
    const text = event.segs.map(x => x.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    return { start: +start.toFixed(2), end: +end.toFixed(2), text };
  }).filter(x => x.text);
}
async function downloadTrack(track, visitor) {
  const r = await fetch(track.baseUrl + '&fmt=json3', {
    headers: { 'User-Agent': ANDROID_UA, 'X-Goog-Visitor-Id': visitor },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error('字幕 HTTP ' + r.status);
  const text = await r.text();
  const segments = text.trim().startsWith('{') ? jsonSegments(JSON.parse(text)) : xmlSegments(text);
  if (!segments.length) throw new Error('字幕内容为空');
  return segments;
}
async function mobileTranscript(id, useIos = false) {
  const visitor = await visitorData(id);
  console.log('visitorData', id, visitor.length);
  const version = useIos ? '20.10.3' : ANDROID_VERSION;
  const userAgent = useIos
    ? `com.google.ios.youtube/${version} (iPhone16,2; U; CPU iOS 26.0 like Mac OS X)`
    : ANDROID_UA;
  const client = {
    clientName: useIos ? 'IOS' : 'ANDROID', clientVersion: version,
    hl: 'en', gl: 'US', userAgent, visitorData: visitor,
  };
  if (!useIos) client.androidSdkVersion = 34;
  else { client.deviceMake = 'Apple'; client.deviceModel = 'iPhone16,2'; client.osName = 'iPhone OS'; client.osVersion = '26.0'; }
  const player = await apiPost('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    context: { client }, videoId: id,
  }, {
    'User-Agent': userAgent,
    'X-YouTube-Client-Name': useIos ? '5' : '3',
    'X-YouTube-Client-Version': version,
    'X-Goog-Visitor-Id': visitor,
  });
  const status = player.playabilityStatus || {};
  if (status.status && status.status !== 'OK') throw new Error('视频不可播放：' + status.status + (status.reason ? ' / ' + status.reason : ''));
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) return { id, ts: new Date().toISOString(), language: '', segments: [], error: 'no_captions' };
  const track = tracks.find(x => x.languageCode === 'en') || tracks[0];
  const segments = await downloadTrack(track, visitor);
  return { id, ts: new Date().toISOString(), language: track.languageCode || '', segments };
}
async function watchTranscript(id) {
  const r = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, {
    headers: { 'User-Agent': WEB_UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error('观看页 HTTP ' + r.status);
  const html = await r.text();
  const player = extractPlayerResponse(html);
  const status = player.playabilityStatus || {};
  if (status.status && status.status !== 'OK') throw new Error('视频不可播放：' + status.status + (status.reason ? ' / ' + status.reason : ''));
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) return { id, ts: new Date().toISOString(), language: '', segments: [], error: 'no_captions' };
  const track = tracks.find(x => x.languageCode === 'en') || tracks[0];
  const sub = await fetch(track.baseUrl + '&fmt=json3', { headers: { 'User-Agent': WEB_UA }, signal: AbortSignal.timeout(30000) });
  if (!sub.ok) throw new Error('字幕 HTTP ' + sub.status);
  const text = await sub.text();
  const segments = text.trim().startsWith('{') ? jsonSegments(JSON.parse(text)) : xmlSegments(text);
  if (!segments.length) throw new Error('字幕内容为空');
  return { id, ts: new Date().toISOString(), language: track.languageCode || '', segments };
}
async function fetchTranscript(id) {
  try { return await mobileTranscript(id, false); }
  catch (error) {
    console.error('Android失败', id, error.message);
    try { return await mobileTranscript(id, true); }
    catch (iosError) {
      console.error('iOS失败', id, iosError.message);
      return watchTranscript(id);
    }
  }
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
