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
const ALLOWED = /^https?:\/\/([\w-]+\.)?(soundcloud\.com|snd\.sc)\//i;
const SRC = { sc: { name: 'SoundCloud', pre: 'scsearch' } };

/* ---------- yt-dlp ---------- */
const YT_ARGS = [];
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
async function smartSearch(q) { return { src: 'sc', items: await searchList('sc', q) }; }

/* ---------- oturumlar (her Budd bağlantısı bir oturum) ---------- */
const sessions = new Map(); // ws -> S
const guilds = new Map();   // sunucu(guild) id -> S  (sunucu modunda oturum, Budd sekmesi kapansa da yaşar)
const tokens = new Map();   // token -> { S, track, gen }

function send(S, o) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); }

/* ---------- SUNUCU MODU: bot sesli odaya gerçek üye gibi girer ----------
 * Budd, her komutla Firebase adresini ve sunucu bilgisini yollar. Bot burada:
 *  - Firebase'e "bot_<id>" üyesi olarak yazılır (ad, profil, durum) ve her 15 sn tazelenir,
 *  - şarkıyı BİR kez çözüp herkese ortak canlı mp3 yayını yapar, adresini /bplay'e yazar,
 *  - odadaki herkes bu yayını dinler; kimse olmasa da şarkılar sırayla akmaya devam eder,
 *  - komutu veren kişi odadan çıksa, Budd sekmesini kapatsa da bot çalmayı sürdürür. */
const okFb = u => process.env.ALLOW_ANY_FB === '1' || /^https:\/\/[\w.-]+\.(firebaseio\.com|firebasedatabase\.app)\/?$/i.test(String(u || ''));
function fbw(S, p, method, body) {
  if (!S.fb || !S.gid) return;
  fetch(`${S.fb}/budd/${encodeURIComponent(S.gid)}${p}.json`, { method, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => {});
}
function pickCh(S) {
  const v = (S.chans || []).filter(c => c.type === 'voice');
  const want = String(S.oda || '').replace(/^#/, '').toLowerCase();
  return (want && (v.find(c => c.id === S.oda || String(c.name).toLowerCase() === want) || {}).id)
    || (v.find(c => c.id === S.uvc) || {}).id || (v[0] || {}).id || '';
}
function presence(S) {
  if (!S.ch || !S.joined) return;
  const b = S.bot || {};
  fbw(S, `/voice/${S.ch}/bot_${b.id}`, 'PUT', { n: cut(b.name || 'Bot', 32), ts: Date.now(), bot: 1, mu: S.cur && !S.pa ? 0 : 1, c: b.color || '', im: b.img || '' });
}
function bplayPut(S) {
  if (!S.ch || !S.play) return;
  fbw(S, `/bplay/${S.ch}`, 'PUT', { url: S.play.url, v: S.vol, ts: S.play.ts, by: cut((S.bot || {}).name, 20), bid: (S.bot || {}).id, live: 1, pa: S.pa ? Date.now() : 0 });
}
function srvJoin(S) {
  const ch = pickCh(S);
  if (!ch) return false;
  if (S.joined && S.ch && S.ch !== ch) srvLeave(S, true);
  S.ch = ch; S.joined = true;
  presence(S);
  if (!S.hb) S.hb = setInterval(() => { presence(S); bplayPut(S); }, 15000);
  return true;
}
function srvLeave(S, keepSession) {
  if (S.ch) { fbw(S, `/bplay/${S.ch}`, 'DELETE'); fbw(S, `/voice/${S.ch}/bot_${(S.bot || {}).id}`, 'DELETE'); }
  clearInterval(S.hb); S.hb = null; S.joined = false; S.play = null; S.pa = false;
  if (!keepSession) S.ch = '';
}
function sigProc(S, sig) { if (S.proc) for (const p of S.proc) { try { p.kill(sig); } catch {} } }
function endClients(S) { if (S.clients) { for (const r of S.clients) { try { r.end(); } catch {} } S.clients.clear(); } }
// Eylemler: sunucu modunda Firebase'e, eski modda Budd'a (tarayıcıda çalan) gider
function act(S, d) {
  if (!S.srv) return send(S, { op: 'action', d });
  switch (d.act) {
    case 'join': srvJoin(S); break;
    case 'stop': S.play = null; S.pa = false; if (S.ch) fbw(S, `/bplay/${S.ch}`, 'DELETE'); presence(S); if (!S.ws && !S.q.length) { clearTimeout(S.idle); S.idle = setTimeout(() => { if (!S.ws && !S.cur && !S.q.length) { srvLeave(S); guilds.delete(S.gid); } }, 600000); } break;
    case 'leave': srvLeave(S); break;
    case 'pause': sigProc(S, 'SIGSTOP'); presence(S); bplayPut(S); break;
    case 'resume': sigProc(S, 'SIGCONT'); presence(S); bplayPut(S); break;
    case 'volume': bplayPut(S); break;
  }
}
function say(S, replyTo, content, embed, extra) {
  send(S, { op: 'message', d: Object.assign({ reply_to: replyTo, content: content || '' }, embed ? { embeds: [embed] } : {}, extra || {}) });
}
function killStream(S) {
  clearTimeout(S.timer); S.timer = null; endClients(S);
  if (S.proc) { for (const p of S.proc) { try { p.kill('SIGKILL'); } catch {} } S.proc = null; }
  if (S.token) { tokens.delete(S.token); S.token = null; }
}
function stopAll(S) { S.gen++; S.paused = false; killStream(S); S.cur = null; act(S, { act: 'stop' }); }

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
  S.gen++; S.paused = false; S.pa = false; S.left = null;
  if (!S.cur) { act(S, { act: 'stop' }); return; }
  const token = crypto.randomBytes(12).toString('hex');
  S.token = token; const ent = { S, track: S.cur, gen: S.gen }; tokens.set(token, ent);
  if (S.srv) {
    S.play = { url: `${PUBLIC}/s/${token}.mp3`, ts: Date.now() };
    startLive(S, ent); bplayPut(S); presence(S);
  } else send(S, { op: 'action', d: { act: 'play', url: `${PUBLIC}/s/${token}.mp3`, v: S.vol } });
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
  S.paused = true; S.pa = true;
  if (S.timer) { clearTimeout(S.timer); S.timer = null; S.left = Math.max(0, S.left - (Date.now() - S.t0)); }
  act(S, { act: 'pause' });
  return true;
}
function pauseOff(S) {
  if (!S.paused) return false;
  S.paused = false; S.pa = false;
  if (S.left != null && S.cur && S.cur.dur) {
    const gen = S.gen; S.t0 = Date.now();
    S.timer = setTimeout(() => { if (S.gen === gen) playNext(S, null); }, S.left);
  }
  act(S, { act: 'resume' });
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
      footer: { text: 'Kaynak: SoundCloud' },
    }],
    components: [
      { type: 1, components: nums },
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
  track.req = user || 'biri';
  // Bot sesli odaya girer: adı + profiliyle görünür, kendini sessize alır, sağırlaştırır (oda boşsa ilk ses kanalı)
  S.oda = chName || S.oda; act(S, { act: 'join', ch: chName || '', mute: true, deaf: true });
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
        const t = { title: q.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 80), url: q, dur: 0, by: '', thumb: '' };
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
      S.vol = v / 100; act(S, { act: 'volume', v: S.vol }); r(`🔊 Ses: %${v}`); break;
    }
    case 'dongu': S.loop = !S.loop; r(S.loop ? '🔁 Döngü açık.' : '➡️ Döngü kapalı.'); break;
    case 'simdi': r(S.cur ? `🎶 **${S.cur.title}** (${fmt(S.cur.dur)}) – ${S.cur.by}` : 'Şu an bir şey çalmıyor.'); break;
    case 'sira': {
      const l = S.q.slice(0, 10).map((t, i) => `${i + 1}. ${t.title} (${fmt(t.dur)})`).join('\n');
      r((S.cur ? `🎶 Şimdi: **${S.cur.title}**\n` : '') + (l || 'Sıra boş.')); break;
    }
    case 'cik': stopAll(S); S.q = []; act(S, { act: 'leave' }); r('👋 Çıkıldı.'); break;
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
  // Şarkı seç
  if (kind === 'pick') {
    const t = s.items[+b];
    if (!t) return;
    edit({ content: '✅ Seçildi: **' + cut(t.title, 80) + '**', embeds: [], components: [] });
    S.searches.delete(a);
    return addTrack(S, id, Object.assign({}, t), user, S.oda);
  }
}

/* ---------- sunucu modu: ortak canlı yayın (bir yt-dlp + bir ffmpeg, herkese dağıtılır) ---------- */
function startLive(S, e) {
  S.clients = S.clients || new Set();
  if (!FFMPEG_OK) { say(S, null, '⛔ Sunucu modu için sunucuda ffmpeg gerekli (npm i ffmpeg-static).'); return; }
  let bytes = 0, errY = '', errF = '';
  const y = spawn(YTDLP, ['-f', 'bestaudio/best', '--no-playlist', '--no-warnings', '-q', '-o', '-', '--', e.track.url], { stdio: ['ignore', 'pipe', 'pipe'] });
  const f = spawn(FFMPEG, ['-loglevel', 'error', '-re', '-fflags', 'nobuffer', '-probesize', '32768', '-analyzeduration', '0', '-i', 'pipe:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-flush_packets', '1', '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  y.stderr.on('data', d => { errY = (errY + d).slice(-600); }); f.stderr.on('data', d => { errF = (errF + d).slice(-600); });
  y.on('error', er => { errY += 'yt-dlp başlatılamadı: ' + er.message; }); f.on('error', er => { errF += 'ffmpeg başlatılamadı: ' + er.message; });
  y.stdout.on('error', () => {}); f.stdin.on('error', () => {}); y.stdout.pipe(f.stdin);
  S.proc = [y, f];
  f.stdout.on('data', c => {
    bytes += c.length;
    for (const r of S.clients) { if (r.writableLength < (1 << 20)) r.write(c); }
  });
  f.on('close', () => {
    if (S.gen !== e.gen) return; // geçildi/durduruldu
    if (!bytes) {
      const why = errY.trim().split('\n').pop() || errF.trim().split('\n').pop() || 'bilinmeyen hata';
      console.error('akış boş:', errY, errF);
      say(S, null, '⛔ Ses akışı alınamadı: ' + cut(why, 180));
    }
    playNext(S, null); // şarkı bitti (ya da hata): sıradakine geç
  });
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
  if (S.srv) { // ortak canlı yayına katıl
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none' });
    S.clients = S.clients || new Set(); S.clients.add(res); res.on('close', () => S.clients.delete(res)); return;
  }
  if (S.proc) for (const p of S.proc) { try { p.kill('SIGKILL'); } catch {} } // yeniden istek: baştan başlat
  const T0 = Date.now();
  let bytes = 0, closed = false, attempt = 0;
  res.writeHead(200, { 'Content-Type': FFMPEG_OK ? 'audio/mpeg'
