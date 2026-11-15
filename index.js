/**
 * Budd.io Müzik Botu (tek dosya, Node 18+)
 *
 * Nasıl çalışır: Budd, Gateway URL'ine WebSocket ile bağlanır. Komutu yazan kişiye
 * bot "ses odasına gir" ve "şu URL'yi çal" eylemlerini yollar. Bu dosya aynı portta
 * hem WebSocket gateway'i hem de şarkıyı yt-dlp + ffmpeg ile mp3 akışına çeviren
 * HTTP ucunu sunar. Tam şarkı çalar (YouTube / SoundCloud), isimle arar.
 *
 * Gereksinim:  npm i ws        +  sistemde  yt-dlp  ve  ffmpeg
 * Çalıştır:    PUBLIC_URL=https://botun.alanadin.com node budd-muzik-bot.js
 *   (PUBLIC_URL, bu sunucuya HTTPS ile dışarıdan erişilen adres olmalı; Budd https
 *    olduğu için http://ip:port çalışmaz. Cloudflare Tunnel / Caddy / nginx kullan.)
 * Budd Portal > Genel Bilgi > Gateway URL:  wss://botun.alanadin.com
 */
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080;
const PUBLIC = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const fs = require('fs'), os = require('os'), path = require('path');
let YTDLP = process.env.YTDLP || 'yt-dlp';
let FFMPEG = process.env.FFMPEG || (() => { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } })();
// yt-dlp yoksa (ör. Render) açılışta indir
async function ensureYtdlp() {
  if (process.env.YTDLP) return;
  const p = path.join(os.tmpdir(), 'yt-dlp');
  try { if (fs.existsSync(p)) { YTDLP = p; return; } } catch {}
  try {
    const r = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()), { mode: 0o755 });
    YTDLP = p; console.log('yt-dlp indirildi');
  } catch (e) { console.error('yt-dlp indirilemedi:', e.message); }
}
ensureYtdlp();
const MAXQ = 50;

const fmt = s => { s = Math.floor(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const ALLOWED = /^https?:\/\/([\w-]+\.)?(youtube\.com|youtu\.be|soundcloud\.com|music\.youtube\.com)\//i;

/* ---------- arama ---------- */
function ytdlpJson(target) {
  return new Promise((ok, no) => {
    execFile(YTDLP, ['--no-playlist', '--no-warnings', '-j', '--skip-download',
      '--extractor-args', 'youtube:player_client=tv,android,web', '--', target],
      { maxBuffer: 20 << 20, timeout: 40000 }, (err, out, errout) => {
        if (err) { const msg = String(errout || err.message).trim().split('\n').pop().slice(0, 200); console.error('yt-dlp hata [' + target.slice(0, 40) + ']:', msg); return no(new Error(msg)); }
        try {
          const j = JSON.parse(out.trim().split('\n')[0]);
          ok({ title: j.title, url: j.webpage_url || j.original_url, dur: j.duration || 0, by: j.uploader || '', thumb: j.thumbnail || '' });
        } catch { no(new Error('Çözümlenemedi')); }
      });
  });
}
// Sırayla dene: YouTube -> SoundCloud (Render gibi sunucu IP'lerinde YouTube engelleyebilir)
async function search(q) {
  const targets = ALLOWED.test(q) ? [q] : [`ytsearch1:${q}`, `scsearch1:${q}`];
  let last;
  for (const t of targets) { try { return await ytdlpJson(t); } catch (e) { last = e; } }
  throw new Error('Şarkı bulunamadı (' + (last && last.message || '?') + ')');
}

/* ---------- oturumlar (her Budd bağlantısı bir oturum) ---------- */
const sessions = new Map(); // ws -> S
const tokens = new Map();   // token -> { S, track }

function send(S, o) { if (S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); }
function say(S, replyTo, content, embed) {
  send(S, { op: 'message', d: Object.assign({ reply_to: replyTo, content: content || '' }, embed ? { embeds: [embed] } : {}) });
}
function killStream(S) {
  clearTimeout(S.timer); S.timer = null;
  if (S.proc) { for (const p of S.proc) { try { p.kill('SIGKILL'); } catch {} } S.proc = null; }
  if (S.token) { tokens.delete(S.token); S.token = null; }
}
function stopAll(S) { S.gen++; killStream(S); S.cur = null; send(S, { op: 'action', d: { act: 'stop' } }); }

function playNext(S, replyTo) {
  killStream(S);
  if (S.loop && S.cur) S.q.unshift(S.cur);
  S.cur = S.q.shift() || null;
  S.gen++;
  if (!S.cur) { send(S, { op: 'action', d: { act: 'stop' } }); return; }
  const token = crypto.randomBytes(12).toString('hex');
  S.token = token; tokens.set(token, { S, track: S.cur, gen: S.gen });
  send(S, { op: 'action', d: { act: 'play', url: `${PUBLIC}/s/${token}.mp3`, v: S.vol } });
  say(S, replyTo, '', {
    title: '🎶 Çalıyor', description: `**${S.cur.title}**`, color: 0x5865f2,
    thumbnail: S.cur.thumb ? { url: S.cur.thumb } : undefined,
    fields: [{ name: 'Süre', value: fmt(S.cur.dur), inline: true }, { name: 'Ekleyen', value: S.cur.req, inline: true }],
  });
}
// Şarkı bitince (süre + 2sn) sıradakine geç
function armTimer(S, gen) {
  clearTimeout(S.timer);
  if (S.cur && S.cur.dur) S.timer = setTimeout(() => { if (S.gen === gen) playNext(S, null); }, (S.cur.dur + 2) * 1000);
}

/* ---------- komutlar ---------- */
async function onCommand(S, id, name, opts, args, user) {
  const r = (c, e) => say(S, id, c, e);
  switch (name) {
    case 'cal': {
      const q = String(opts.sarki || (args || []).join(' ')).trim();
      if (!q) return r('Kullanım: /cal <şarkı adı veya link>');
      if (S.q.length >= MAXQ) return r('Sıra dolu.');
      r('🔎 Aranıyor: ' + q.slice(0, 100));
      let t;
      try { t = await search(q); } catch (e) { return r('⛔ ' + e.message); }
      t.req = user || 'biri';
      send(S, { op: 'action', d: { act: 'join', ch: opts.oda || '' } }); // oda boşsa ilk ses kanalı
      if (!S.cur) { S.q.push(t); playNext(S, id); }
      else { S.q.push(t); r(`➕ Sıraya eklendi: **${t.title}** (${fmt(t.dur)})`); }
      break;
    }
    case 'gec': if (!S.cur) return r('Çalan şarkı yok.'); r('⏭️ Geçildi.'); playNext(S, id); break;
    case 'dur': stopAll(S); S.q = []; r('⏹️ Durduruldu ve sıra temizlendi.'); break;
    case 'ses': {
      const v = Math.max(1, Math.min(100, +opts.seviye || +(args || [])[0] || 50));
      S.vol = v / 100; send(S, { op: 'action', d: { act: 'volume', v: S.vol } }); r(`🔊 Ses: %${v}`); break;
    }
    case 'dongu': S.loop = !S.loop; r(S.loop ? '🔁 Döngü açık.' : '➡️ Döngü kapalı.'); break;
    case 'simdi': r(S.cur ? `🎶 **${S.cur.title}** (${fmt(S.cur.dur)}) – ${S.cur.by}` : 'Şu an bir şey çalmıyor.'); break;
    case 'sira': {
      const l = S.q.slice(0, 10).map((t, i) => `${i + 1}. ${t.title} (${fmt(t.dur)})`).join('\n');
      r((S.cur ? `🎶 Şimdi: **${S.cur.title}**\n` : '') + (l || 'Sıra boş.')); break;
    }
    case 'cik': stopAll(S); S.q = []; send(S, { op: 'action', d: { act: 'leave' } }); r('👋 Çıkıldı.'); break;
  }
}

/* ---------- HTTP: ses akışı ---------- */
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const m = /^\/s\/([a-f0-9]{24})\.mp3$/.exec(req.url.split('?')[0]);
  if (!m) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('budd muzik botu calisiyor'); }
  const e = tokens.get(m[1]);
  if (!e || e.S.gen !== e.gen) { res.writeHead(404); return res.end(); }
  const S = e.S;
  if (S.proc) for (const p of S.proc) { try { p.kill('SIGKILL'); } catch {} } // yeniden istek: baştan başlat
  const y = spawn(YTDLP, ['-f', 'bestaudio/best', '--no-playlist', '--no-warnings', '-q', '-o', '-', '--', e.track.url], { stdio: ['ignore', 'pipe', 'ignore'] });
  const f = spawn(FFMPEG, ['-loglevel', 'error', '-i', 'pipe:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
  S.proc = [y, f];
  y.stdout.pipe(f.stdin); f.stdin.on('error', () => {}); y.on('error', () => {}); f.on('error', () => {});
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none' });
  let first = true;
  f.stdout.on('data', c => { if (first) { first = false; armTimer(S, e.gen); } res.write(c); });
  f.on('close', () => { res.end(); if (!e.track.dur && S.gen === e.gen) setTimeout(() => { if (S.gen === e.gen) playNext(S, null); }, 1500); });
  res.on('close', () => { try { y.kill('SIGKILL'); f.kill('SIGKILL'); } catch {} });
});

/* ---------- WebSocket gateway ---------- */
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  const S = { ws, q: [], cur: null, loop: false, vol: 0.6, gen: 0, timer: null, proc: null, token: null };
  sessions.set(ws, S);
  const ping = setInterval(() => send(S, { op: 'ping' }), 25000);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.op === 'identify') return send(S, { op: 'ready' });
    if (m.op !== 'interaction' || !m.d) return;
    const d = m.d;
    if (d.type === 'command' && d.data) {
      onCommand(S, d.id, d.data.name, d.data.options || {}, d.data.args || [], d.user && d.user.username)
        .catch(e => say(S, d.id, '⛔ ' + e.message));
    }
  });
  ws.on('close', () => { clearInterval(ping); killStream(S); sessions.delete(ws); });
});

server.listen(PORT, () => console.log(`Budd müzik botu :${PORT}  (public: ${PUBLIC})`));
process.on('unhandledRejection', e => console.error(e));
                                     
