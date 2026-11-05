const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseMessage, findOblast } = require('./parser');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));
const PORT = process.env.PORT || 3000;
const ALERTS_TOKEN = process.env.ALERTS_TOKEN || '';
const TTL_MS = (cfg.ttlMinutes || 90) * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; ukr-alert-map/1.0)';

const events = new Map(); // id -> event
let alerts = []; // активні тривоги по областях
const status = { lastPoll: null, sources: {} };

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
  ).replace(/\s+/g, ' ').trim();
}

// Публічний веб-перегляд каналу: https://t.me/s/<channel>
async function pollTelegram(channel) {
  const res = await fetch(`https://t.me/s/${encodeURIComponent(channel)}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'uk' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const chunks = html.split('tgme_widget_message_wrap').slice(1);
  const now = Date.now();
  let added = 0;

  for (const chunk of chunks) {
    const post = (chunk.match(/data-post="([^"]+)"/) || [])[1];
    const textHtml = (chunk.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/) || [])[1];
    const dt = (chunk.match(/<time[^>]*datetime="([^"]+)"/) || [])[1];
    if (!post || !textHtml || !dt) continue;

    const ts = Date.parse(dt);
    if (!ts || now - ts > TTL_MS) continue;
    const id = `tg:${post}`;
    if (events.has(id)) continue;

    const text = htmlToText(textHtml);
    const parsed = parseMessage(text);
    if (!parsed) continue;

    events.set(id, {
      id,
      ts,
      source: `@${channel}`,
      link: `https://t.me/${post}`,
      text: text.length > 400 ? text.slice(0, 400) + '…' : text,
      ...parsed
    });
    added++;
  }
  return added;
}

// Тривоги по областях (потрібен токен з alerts.in.ua)
async function pollAlerts() {
  if (!ALERTS_TOKEN) return;
  const res = await fetch('https://api.alerts.in.ua/v1/alerts/active.json', {
    headers: { Authorization: `Bearer ${ALERTS_TOKEN}`, 'User-Agent': UA }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const seen = new Map();
  for (const a of data.alerts || []) {
    const ob = findOblast(a.location_oblast || a.location_title);
    if (!ob) continue;
    if (!seen.has(ob.name)) {
      seen.set(ob.name, { name: ob.name, lat: ob.lat, lng: ob.lng, type: a.alert_type || 'air_raid' });
    }
  }
  alerts = [...seen.values()];
}

function prune() {
  const now = Date.now();
  for (const [id, e] of events) if (now - e.ts > TTL_MS) events.delete(id);
}

async function pollAll() {
  const tasks = (cfg.telegramChannels || []).map(async ch => {
    try {
      const n = await pollTelegram(ch);
      status.sources[`telegram:${ch}`] = { ok: true, added: n, at: Date.now() };
    } catch (e) {
      status.sources[`telegram:${ch}`] = { ok: false, error: e.message, at: Date.now() };
    }
  });
  tasks.push(
    pollAlerts()
      .then(() => { if (ALERTS_TOKEN) status.sources['alerts.in.ua'] = { ok: true, at: Date.now() }; })
      .catch(e => { status.sources['alerts.in.ua'] = { ok: false, error: e.message, at: Date.now() }; })
  );
  await Promise.all(tasks);
  prune();
  status.lastPoll = Date.now();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/events') {
    const list = [...events.values()].sort((a, b) => b.ts - a.ts);
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ events: list, alerts, ttlMinutes: cfg.ttlMinutes, status }));
  }

  // статика з /public
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(__dirname, 'public', path.normalize(file));
  if (!full.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`Карта запущена: http://localhost:${PORT}`);
  if (!ALERTS_TOKEN) console.log('ALERTS_TOKEN не задано — тривоги по областях вимкнено, працюють лише Telegram-джерела.');
  pollAll();
  setInterval(pollAll, (cfg.pollSeconds || 20) * 1000);
});
