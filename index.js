/**
 * Budd.io Müzik Botu (tek dosya, Node 18+)
 *
 * Nasıl çalışır: Budd, Gateway URL'ine WebSocket ile bağlanır. Komutu yazan kişiye
 * bot "ses odasına gir" ve "şu URL'yi çal" eylemlerini yollar. Bu dosya aynı portta
 * hem WebSocket gateway'i hem de şarkıyı yt-dlp + ffmpeg ile mp3 akışına çeviren
 * HTTP ucunu sunar. Tam şarkı çalar (YouTube / SoundCloud), isimle arar.
 *
 * YENİ:
 *  - /cal <şarkı adı> yazınca ilk 5 sonuç liste olarak çıkar, 1-5 butonlarından birini seçersin.
 *    "YouTube'da ara" / "SoundCloud'da ara" butonlarıyla kaynak değiştirilir. (Sadece sen görürsün.)
 *    Link yapıştırırsan liste çıkmaz, direkt çalar.
 *  - Bot sesli odaya girince adı ve profiliyle odada görünür, kendini otomatik sessize + sağırlaştırır.
 *  - /duraklat, /duraklat off (ya da /devam) ile duraklatma. "Çalıyor" mesajında kontrol butonları var.
 *
 * Gereksinim:  npm i ws        +  sistemde  yt-dlp  ve  ffmpeg
 * Çalıştır:    PUBLIC_URL=https://botun.alanadin.com node budd-muzik-bot.js
 *   (PUBLIC_URL, bu sunucuya HTTPS ile dışarıdan erişilen adres olmalı; Budd https
 *    olduğu için http://ip:port çalışmaz. Cloudflare Tunnel / Caddy / nginx kullan.)
 * Budd Portal > Genel Bilgi > Gateway URL:  wss://botun.alanadin.com
 *
 * Komutlar (Portal > Komutlar'a eklersen / yazınca öneri çıkar; eklemesen de çalışır):
 *   cal [sarki]  gec  dur  duraklat [on|off]  devam  ses [1-100]  dongu  simdi  sira  cik
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
let FFMPEG_OK = true;
(function () { try { const r = require('child_process').spawnSync(FFMPEG, ['-version']); FFMPEG_OK = r.status === 0; } catch { FFMPEG_OK = false; }
  console.log(FFMPEG_OK ? 'ffmpeg bulundu' : 'UYARI: ffmpeg yok -> ham webm akıtılacak (npm i ffmpeg-static önerilir)'); })();
const MAXQ = 50;
const SHOW = 5; // arama sonucu sayısı

const fmt = s => { s = Math.floor(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtP = s => { s = Math.floor(s || 0); if (!s) return '--:--'; return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const ALLOWED = /^https?:\/\/([\w-]+\.)?(youtube\.com|youtu\.be|soundcloud\.com|music\.youtube\.com)\//i;
const SRC = { yt: { name: 'YouTube', pre: 'ytsearch' }, sc: { name: 'SoundCloud', pre: 'scsearch' } };

/* ---------- yt-dlp ---------- */
const YT_ARGS = ['--extractor-args', 'youtube:player_client=tv,android,web'];
function runYtdlp(args, timeout = 40000) {
  return new Promise((ok, no) => {
    execFile(YTDLP, args, { maxBuffer: 30 << 20, timeout }, (err, out, errout) => {
      if (err) {
        const msg = String(errout || err.message).trim().split('\n').pop().slice(0, 200);
        console.error('yt-dlp hata:', msg);
        return no(new Error(msg));
      }
      ok(String(out));
    });
  });
}
const toTrack = j => ({
  title: j.title || 'Adsız',
  url: j.webpage_url || j.original_url || (/^https?:/i.test(j.url || '') ? j.url : (j.id && j.ie_key === 'Youtube' ? 'https://www.youtube.com/watch?v=' + j.id : '')),
  dur: j.duration || 0,
  by: j.uploader || j.channel || '',
  thumb: j.thumbnail || (Array.isArray(j.thumbnails) && j.thumbnails.length ? j.thumbnails[j.thumbnails.length - 1].url : '') || '',
});
// Tek şarkının tam bilgisi (link verilince ya da süre/kapak eksikse)
async function ytdlpJson(target) {
  const out = await runYtdlp(['--no-playlist', '--no-warnings', '-j', '--skip-download', ...YT_ARGS, '--', target]);
  try { return toTrack(JSON.parse(out.trim().split('\n')[0])); } catch { throw new Error('Çözümlenemedi'); }
}
// Arama listesi (ilk SHOW sonuç)
async function searchList(src, q) {
  const out = await runYtdlp(['--no-warnings', '--flat-playlist', '-j', '--skip-download', ...YT_ARGS, '--', `${SRC[src].pre}${SHOW}:${q}`]);
  const list = [];
  for (const line of out.trim().split('\n')) {
    try { const t = toTrack(JSON.parse(line)); if (t.url && ALLOWED.test(t.url)) list.push(t); } catch {}
  }
  if (!list.length) throw new Error('sonuç yok');
  return list.slice(0, SHOW);
}
// Kaynak seçilmediyse sırayla dene: YouTube -> SoundCloud (Render gibi IP'lerde YouTube engelleyebilir)
async function smartSearch(q) {
  let last;
  for (const src of ['yt', 'sc']) { try { return { src, items: await searchList(src, q) }; } catch (e) { last = e; } }
  throw new Error('Şarkı bulunamadı (' + ((last && last.message) || '?') + ')');
}

/* ---------- oturumlar (her Budd bağlantısı bir oturum) ---------- */
const sessions = new Map(); // ws -> S
const tokens = new Map();   // token -> { S, track, gen }

function send(S, o) { if (S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); }
function say(S, replyTo, content, embed, extra) {
  send(S, { op: 'message', d: Object.assign({ reply_to: replyTo, content: content || '' }, embed ? { embeds: [embed] } : {}, extra || {}) });
}
function killStream(S) {
  clearTimeout(S.timer); S.timer = null;
  if (S.proc) { for (const p of S.proc) { try { p.kill('SIGKILL'); } catch {} } S.proc = null; }
  if (S.token) { tokens.delete(S.token); S.token = null; }
}
function stopAll(S) { S.gen++; S.paused = false; killStream(S); S.cur = null; send(S, { op: 'action', d: { act: 'stop' } }); }

// "Çalıyor" mesajının altındaki kontrol butonları
const CTL = [{ type: 1, components: [
  { type: 2, style: 1, label: 'Duraklat', emoji: '⏸', custom_id: 'ctl:pause' },
  { type: 2, style: 1, label: 'Geç', emoji: '⏭', custom_id: 'ctl:skip' },
  { type: 2, style: 1, label: 'Durdur', emoji: '⏹', custom_id: 'ctl:stop' },
  { type: 2, style: 1, label: 'Döngü', emoji: '🔁', custom_id: 'ctl:loop' },
] }];

function playNext(S, replyTo) {
  killStream(S);
  if (S.loop && S.cur) S.q.unshift(S.cur);
  S.cur = S.q.shift() || null;
  S.gen++; S.paused = false; S.left = null;
  if (!S.cur) { send(S, { op: 'action', d: { act: 'stop' } }); return; }
  const token = crypto.randomBytes(12).toString('hex');
  S.token = token; tokens.set(token, { S, track: S.cur, gen: S.gen });
  send(S, { op: 'action', d: { act: 'play', url: `${PUBLIC}/s/${token}.mp3`, v: S.vol } });
  say(S, replyTo, '', {
    title: '🎶 Çalıyor', description: `**${S.cur.title}**`, color: 0x5865f2,
    thumbnail: S.cur.thumb ? { url: S.cur.thumb } : undefined,
    fields: [{ name: 'Süre', value: fmt(S.cur.dur), inline: true }, { name: 'Ekleyen', value: S.cur.req, inline: true }],
  }, { components: CTL });
}
// Şarkı bitince (süre + 2sn) sıradakine geç. Duraklatılırsa kalan süre saklanır.
function armTimer(S, gen) {
  clearTimeout(S.timer);
  if (!(S.cur && S.cur.dur)) return;
  S.left = (S.cur.dur + 2) * 1000; S.t0 = Date.now();
  if (S.paused) return;
  S.timer = setTimeout(() => { if (S.gen === gen) playNext(S, null); }, S.left);
}
function pauseOn(S) {
  if (S.paused) return false;
  S.paused = true;
  if (S.timer) { clearTimeout(S.timer); S.timer = null; S.left = Math.max(0, S.left - (Date.now() - S.t0)); }
  send(S, { op: 'action', d: { act: 'pause' } });
  return true;
}
function pauseOff(S) {
  if (!S.paused) return false;
  S.paused = false;
  if (S.left != null && S.cur && S.cur.dur) {
    const gen = S.gen; S.t0 = Date.now();
    S.timer = setTimeout(() => { if (S.gen === gen) playNext(S, null); }, S.left);
  }
  send(S, { op: 'action', d: { act: 'resume' } });
  return true;
}

/* ---------- arama sonucu mesajı (butonlu liste) ---------- */
function pickerMsg(S, sid) {
  const s = S.searches.get(sid);
  const lines = s.items.map((t, i) => `${i + 1}. ${cut(t.title, 70)} (${fmtP(t.dur)})`).join('\n');
  const nums = s.items.map((_, i) => ({ type: 2, style: 1, label: String(i + 1), custom_id: `pick:${sid}:${i}` }));
  return {
    id: 's_' + sid, flags: 64,
    embeds: [{
      description: `${SRC[s.src].name} sonuçları gösteriliyor. Aşağıdaki butonlardan bir şarkı seç.\n\n${lines}`,
      color: 0x2ec4b6,
      footer: { text: 'Kaynak: ' + (s.auto ? 'Akıllı Arama' : SRC[s.src].name) },
    }],
    components: [
      { type: 1, components: nums },
      { type: 1, components: [
        { type: 2, style: 1, label: "YouTube'da ara", custom_id: `src:${sid}:yt` },
        { type: 2, style: 1, label: "SoundCloud'da ara", custom_id: `src:${sid}:sc` },
      ] },
    ],
  };
}
function rememberSearch(S, s) {
  const sid = crypto.randomBytes(4).toString('hex');
  S.searches.set(sid, s);
  while (S.searches.size > 20) S.searches.delete(S.searches.keys().next().value);
  return sid;
}

/* ---------- şarkıyı sıraya ekle / çal ---------- */
async function addTrack(S, replyTo, track, user, chName) {
  if (S.q.length >= MAXQ) return say(S, replyTo, 'Sıra dolu.');
  if (!ALLOWED.test(track.url || '')) return say(S, replyTo, '⛔ Bu bağlantı desteklenmiyor.');
  // süre/kapak eksikse tam bilgiyi çek
  if (!track.dur || !track.thumb) { try { const f = await ytdlpJson(track.url); track = Object.assign({}, f, { title: track.title || f.title }); } catch {} }
  track.req = user || 'biri';
  // Bot sesli odaya girer: adı + profiliyle görünür, kendini sessize alır, sağırlaştırır (oda boşsa ilk ses kanalı)
  send(S, { op: 'action', d: { act: 'join', ch: chName || '', mute: true, deaf: true } });
  S.q.push(track);
  if (!S.cur) playNext(S, replyTo);
  else say(S, replyTo, `➕ Sıraya eklendi: **${track.title}** (${fmt(track.dur)})`);
}

/* ---------- komutlar ---------- */
async function onCommand(S, id, name, opts, args, user) {
  const r = (c, e) => say(S, id, c, e);
  switch (name) {
    case 'cal': {
      const q = String(opts.sarki || (args || []).join(' ')).trim();
      if (!q) return r('Kullanım: /cal <şarkı adı veya link>');
      if (S.q.length >= MAXQ) return r('Sıra dolu.');
      S.oda = opts.oda || '';
      // Link verildiyse liste göstermeden direkt çal
      if (ALLOWED.test(q)) {
        say(S, id, '🔎 Bağlantı çözülüyor…', null, { id: 'l_' + id, flags: 64 });
        let t;
        try { t = await ytdlpJson(q); } catch (e) { return say(S, id, '⛔ ' + e.message, null, { edit: 'l_' + id, flags: 64 }); }
        say(S, id, '✅ Bulundu: **' + cut(t.title, 80) + '**', null, { edit: 'l_' + id, flags: 64 });
        return addTrack(S, id, t, user, S.oda);
      }
      // Aksi halde butonlu sonuç listesi (sadece komutu yazan görür)
      const tmp = crypto.randomBytes(4).toString('hex');
      say(S, id, '🔎 Aranıyor: ' + cut(q, 100), null, { id: 's_' + tmp, flags: 64 });
      let res;
      try { res = await smartSearch(q); } catch (e) { return say(S, id, '⛔ ' + e.message, null, { edit: 's_' + tmp, flags: 64 }); }
      const sid = rememberSearch(S, { q, src: res.src, items: res.items, auto: true, user: user || '' });
      const m = pickerMsg(S, sid);
      m.edit = 's_' + tmp; delete m.id; // "Aranıyor" mesajını listeye çevir
      send(S, { op: 'message', d: Object.assign({ reply_to: id, content: '' }, m) });
      // Buton tıklamaları mesaj kimliğiyle gelir; listeyi doğru bulmak için kimliği eşle
      S.searches.get(sid).mid = 's_' + tmp;
      break;
    }
    case 'gec': if (!S.cur) return r('Çalan şarkı yok.'); r('⏭️ Geçildi.'); playNext(S, id); break;
    case 'dur': stopAll(S); S.q = []; r('⏹️ Durduruldu ve sıra temizlendi.'); break;
    case 'duraklat': {
      const a = String((opts.durum || (args || [])[0] || 'on')).toLowerCase();
      if (!S.cur) return r('Çalan şarkı yok.');
      if (a === 'off' || a === 'kapat' || a === 'devam') return r(pauseOff(S) ? '▶️ Devam ediyor.' : 'Oynatıcı zaten duraklatılmamış.');
      return r(pauseOn(S) ? 'Oynatıcı duraklatıldı. `/duraklat off` komutuyla devam ettirebilirsin.' : 'Oynatıcı zaten duraklatılmış.');
    }
    case 'devam': if (!S.cur) return r('Çalan şarkı yok.'); r(pauseOff(S) ? '▶️ Devam ediyor.' : 'Oynatıcı zaten duraklatılmamış.'); break;
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

/* ---------- buton tıklamaları ---------- */
async function onComponent(S, id, data, user) {
  const cid = String(data.custom_id || '');
  const [kind, a, b] = cid.split(':');
  // Çalıyor mesajındaki kontrol butonları
  if (kind === 'ctl') {
    if (a === 'pause') {
      if (!S.cur) return say(S, id, 'Çalan şarkı yok.', null, { flags: 64 });
      return say(S, id, pauseOn(S) ? '⏸️ Duraklatıldı.' : (pauseOff(S) ? '▶️ Devam ediyor.' : ''));
    }
    if (a === 'skip') return onCommand(S, id, 'gec', {}, [], user);
    if (a === 'stop') return onCommand(S, id, 'dur', {}, [], user);
    if (a === 'loop') return onCommand(S, id, 'dongu', {}, [], user);
    return;
  }
  const s = S.searches.get(a);
  const mid = data.message_id || (s && s.mid) || ('s_' + a);
  if (!s) return say(S, id, 'Bu arama süresi doldu, /cal ile tekrar ara.', null, { flags: 64 });
  const edit = (extra) => send(S, { op: 'message', d: Object.assign({ reply_to: id, content: '', edit: mid, flags: 64 }, extra) });
  // Kaynak değiştir (YouTube / SoundCloud)
  if (kind === 'src') {
    if (!SRC[b]) return;
    edit({ content: '🔎 ' + SRC[b].name + "'da aranıyor…", embeds: [], components: [] });
    try { s.items = await searchList(b, s.q); s.src = b; s.auto = false; }
    catch (e) { s.items = s.items || []; return edit({ content: '⛔ ' + SRC[b].name + ' sonuç vermedi (' + e.message + ').', embeds: [], components: [] }); }
    const m = pickerMsg(S, a);
    return edit({ embeds: m.embeds, components: m.components });
  }
  // Şarkı seç
  if (kind === 'pick') {
    const t = s.items[+b];
    if (!t) return;
    edit({ content: '✅ Seçildi: **' + cut(t.title, 80) + '**', embeds: [], components: [] });
    S.searches.delete(a);
    return addTrack(S, id, Object.assign({}, t), user, S.oda);
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
  const T0 = Date.now();
  let errY = '', errF = '', bytes = 0, closed = false, ffOk = true;
  // ffmpeg var mı? Yoksa ham ses (webm/opus) akıtılır; tarayıcılar bunu çalabilir.
  const y = spawn(YTDLP, ['-f', ffOk && FFMPEG_OK ? 'bestaudio/best' : 'bestaudio[ext=webm]/bestaudio', '--no-playlist', '--no-warnings', '-q', ...YT_ARGS, '-o', '-', '--', e.track.url], { stdio: ['ignore', 'pipe', 'pipe'] });
  y.stderr.on('data', d => { errY += d; if (errY.length > 600) errY = errY.slice(-600); });
  y.on('error', er => { errY += 'yt-dlp başlatılamadı: ' + er.message; });
  let out = y.stdout, f = null;
  if (FFMPEG_OK) {
    f = spawn(FFMPEG, ['-loglevel', 'error', '-i', 'pipe:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    f.stderr.on('data', d => { errF += d; if (errF.length > 600) errF = errF.slice(-600); });
    f.on('error', er => { errF += 'ffmpeg başlatılamadı: ' + er.message; });
    y.stdout.pipe(f.stdin); f.stdin.on('error', () => {});
    out = f.stdout;
  }
  y.stdout.on('error', () => {});
  S.proc = f ? [y, f] : [y];
  res.writeHead(200, { 'Content-Type': FFMPEG_OK ? 'audio/mpeg' : 'audio/webm', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none' });
  let first = true;
  out.on('data', c => { bytes += c.length; if (first) { first = false; console.log('akış başladı', Date.now() - T0, 'ms'); armTimer(S, e.gen); } res.write(c); });
  const done = () => {
    if (closed) return; closed = true; res.end();
    if (!bytes && S.gen === e.gen) {
      const why = (errY + ' ' + errF).trim().split('\n').pop() || 'bilinmeyen hata';
      console.error('akış boş döndü:', errY, errF);
      say(S, null, '⛔ Ses akışı alınamadı: ' + cut(why, 180));
    } else if (!e.track.dur && S.gen === e.gen) setTimeout(() => { if (S.gen === e.gen) playNext(S, null); }, 1500);
  };
  (f || y).on('close', done);
  res.on('close', () => { try { y.kill('SIGKILL'); if (f) f.kill('SIGKILL'); } catch {} });
});

/* ---------- WebSocket gateway ---------- */
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  const S = { ws, q: [], cur: null, loop: false, vol: 0.6, gen: 0, timer: null, proc: null, token: null,
    paused: false, left: null, t0: 0, searches: new Map(), oda: '' };
  sessions.set(ws, S);
  const ping = setInterval(() => send(S, { op: 'ping' }), 25000);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.op === 'identify') return send(S, { op: 'ready' });
    if (m.op !== 'interaction' || !m.d) return;
    const d = m.d;
    const user = d.user && d.user.username;
    if (d.type === 'command' && d.data) {
      onCommand(S, d.id, d.data.name, d.data.options || {}, d.data.args || [], user)
        .catch(e => say(S, d.id, '⛔ ' + e.message));
    } else if (d.type === 'component' && d.data) {
      onComponent(S, d.id, d.data, user)
        .catch(e => say(S, d.id, '⛔ ' + e.message, null, { flags: 64 }));
    }
  });
  ws.on('close', () => { clearInterval(ping); killStream(S); sessions.delete(ws); });
});

server.listen(PORT, () => console.log(`Budd müzik botu :${PORT}  (public: ${PUBLIC})`));
process.on('unhandledRejection', e => console.error(e));
