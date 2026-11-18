// YouTube 热门榜采集 (GitHub Actions 海外 runner 执行, Node 22 内置 fetch, 零依赖)
// 环境变量: YOUTUBE_API_KEY (仓库 Secrets), YOUTUBE_REGION (仓库 Variables, 默认 US)
// 输出: data/youtube.json  {ts, region, items:[统一字段视频]}
import fs from 'node:fs';

const KEY = process.env.YOUTUBE_API_KEY;
const REGION = process.env.YOUTUBE_REGION || 'US';
if (!KEY) {
  console.error('缺少 YOUTUBE_API_KEY：请在仓库 Settings → Secrets and variables → Actions 添加');
  process.exit(1);
}

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isoDur = s => {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || '');
  return m ? num(m[1]) * 3600 + num(m[2]) * 60 + num(m[3]) : 0;
};

const items = [];
let pageToken = '';
for (let p = 0; p < 4; p++) {           // 最多 200 条, 配额消耗 4 单位/次
  const u = new URL('https://www.googleapis.com/youtube/v3/videos');
  u.searchParams.set('part', 'snippet,contentDetails,statistics');
  u.searchParams.set('chart', 'mostPopular');
  u.searchParams.set('regionCode', REGION);
  u.searchParams.set('maxResults', '50');
  u.searchParams.set('key', KEY);
  if (pageToken) u.searchParams.set('pageToken', pageToken);
  const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('YouTube API 错误:', (j.error && j.error.message) || r.status);
    process.exit(1);
  }
  for (const it of j.items || []) {
    const sn = it.snippet || {}, st = it.statistics || {}, cd = it.contentDetails || {};
    items.push({
      id: it.id, platform: 'youtube',
      title: sn.title || '', author: sn.channelTitle || '',
      duration: isoDur(cd.duration),
      view: num(st.viewCount), like: num(st.likeCount),
      coin: 0, favorite: 0, share: 0, reply: num(st.commentCount), danmaku: 0,
      pubdate: sn.publishedAt || '',
      url: 'https://www.youtube.com/watch?v=' + it.id,
      cover: ((sn.thumbnails || {}).medium || (sn.thumbnails || {}).default || {}).url || '',
      tname: sn.categoryId || '', source: '热门榜',
    });
  }
  pageToken = j.nextPageToken || '';
  if (!pageToken) break;
}

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/youtube.json', JSON.stringify({ ts: new Date().toISOString(), region: REGION, items }));
console.log(`已写入 data/youtube.json: ${items.length} 条 (region=${REGION})`);
