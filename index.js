// Budd moderasyon botu — HTTP endpoint, bağımlılık YOK (Node 18+)
// Çalıştır:  MODS="SenAdin,DigerYetkili" PORT=3000 node modbot.js
// Portal → Genel Bilgi → Endpoint URL: https://SUNUCUN/   (https + CORS şart, aşağıda CORS hazır)
// Portal → Bot → "Mesaj İçeriği Intent'i" AÇIK olmalı (otomatik moderasyon için)
// Önek: "/"  (Genel Bilgi → Komut öneki)

const http = require('http');
const fs = require('fs');

const PORT = +process.env.PORT || 3000;
const MODS = (process.env.MODS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const DB_FILE = process.env.DB || './modbot-data.json';
const MAX_WARN = 3;

// ---------- kalıcı veri (sunucu başına) ----------
let DB = {};
try { DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
const save = () => { try { fs.writeFileSync(DB_FILE, JSON.stringify(DB)); } catch (e) { console.error('kayıt hatası', e.message); } };
const G = id => DB[id] || (DB[id] = { warns: {}, words: [], auto: true, links: false, log: [] });

const norm = s => String(s || '').trim().replace(/^@/, '').toLowerCase();
const isMod = u => !!u && MODS.includes(String(u.username || '').toLowerCase());
const spam = {}; // "guild:user" -> [zaman damgaları]

// ---------- yardımcılar ----------
const msg = (content, extra) => Object.assign({ content }, extra || {});
const embed = (title, description, color, fields) => ({ embeds: [{ title, description, color: color || 0x5865f2, fields: fields || [] }] });
const priv = m => Object.assign(m, { flags: 64 }); // sadece komutu yazan görür

function addWarn(g, who, reason, by) {
  const k = norm(who), a = g.warns[k] = g.warns[k] || [];
  a.push({ r: String(reason || 'Sebep yok').slice(0, 200), by, t: Date.now() });
  g.log.push({ t: Date.now(), who: k, r: reason, by }); g.log = g.log.slice(-200);
  save();
  return a.length;
}
function warnText(who, n, reason) {
  let t = `⚠️ **${who}** uyarıldı (${n}/${MAX_WARN}). Sebep: ${reason}`;
  if (n >= MAX_WARN) t += `\n🚨 ${who} ${MAX_WARN} uyarıya ulaştı. Yetkililer lütfen işlem yapsın (sustur/at/yasakla).`;
  return msg(t);
}

// ---------- komutlar ----------
const HELP = [
  ['/yardim', 'Bu listeyi gösterir'],
  ['/ping', 'Bot çalışıyor mu?'],
  ['/kurallar', 'Sunucu kurallarını gösterir'],
  ['/bilgi <kullanıcı>', 'Kullanıcının uyarı özeti'],
  ['/uyarilar <kullanıcı>', 'Uyarı listesi'],
  ['/uyar <kullanıcı> <sebep>', '[YETKİLİ] Uyarı ver'],
  ['/uyarisil <kullanıcı>', '[YETKİLİ] Uyarıları sıfırla'],
  ['/kelime ekle|sil|liste <kelime>', '[YETKİLİ] Yasaklı kelime listesi'],
  ['/automod ac|kapat|link-ac|link-kapat|durum', '[YETKİLİ] Otomatik moderasyon ayarları'],
  ['/kayit', '[YETKİLİ] Son moderasyon kayıtları']
];

function command(body) {
  const { data, user, guild } = body, g = G(guild && guild.id || 'x'), a = data.args || [], name = data.name;
  const need = () => !isMod(user) && priv(msg('⛔ Bu komut için yetkili olman gerekir.'));

  switch (name) {
    case 'ping': return msg('🏓 Pong! ' + (user && user.username || ''));
    case 'yardim': case 'help':
      return embed('Moderasyon botu', HELP.map(h => '`' + h[0] + '` — ' + h[1]).join('\n'));
    case 'kurallar':
      return embed('📜 Sunucu kuralları', '1. Saygılı ol.\n2. Spam yapma.\n3. Küfür ve hakaret yasak.\n4. Reklam/link paylaşma.\n5. Yetkililerin kararına uy.', 0xf0b232);
    case 'uyar': {
      const d = need(); if (d) return d;
      if (!a[0]) return priv(msg('Kullanım: /uyar <kullanıcı> <sebep>'));
      const reason = a.slice(1).join(' ') || 'Sebep belirtilmedi';
      return warnText(a[0].replace(/^@/, ''), addWarn(g, a[0], reason, user.username), reason);
    }
    case 'uyarilar': case 'bilgi': {
      const who = a[0] || user.username, w = g.warns[norm(who)] || [];
      if (!w.length) return msg(`✅ **${who}** için uyarı yok.`);
      return embed(`${who} — ${w.length}/${MAX_WARN} uyarı`, w.slice(-10).map((x, i) =>
        `**${i + 1}.** ${x.r} _(${x.by}, ${new Date(x.t).toLocaleString('tr-TR')})_`).join('\n'), 0xed4245);
    }
    case 'uyarisil': {
      const d = need(); if (d) return d;
      if (!a[0]) return priv(msg('Kullanım: /uyarisil <kullanıcı>'));
      delete g.warns[norm(a[0])]; save();
      return msg(`🧹 **${a[0]}** kullanıcısının uyarıları silindi.`);
    }
    case 'kelime': {
      const d = need(); if (d) return d;
      const act = (a[0] || '').toLowerCase(), w = norm(a.slice(1).join(' '));
      if (act === 'liste') return priv(msg(g.words.length ? 'Yasaklı: ' + g.words.map(x => '`' + x + '`').join(', ') : 'Liste boş.'));
      if (!w) return priv(msg('Kullanım: /kelime ekle|sil|liste <kelime>'));
      if (act === 'ekle') { if (!g.words.includes(w)) g.words.push(w); save(); return priv(msg('➕ Eklendi: `' + w + '`')); }
      if (act === 'sil') { g.words = g.words.filter(x => x !== w); save(); return priv(msg('➖ Silindi: `' + w + '`')); }
      return priv(msg('Kullanım: /kelime ekle|sil|liste <kelime>'));
    }
    case 'automod': {
      const d = need(); if (d) return d;
      const s = (a[0] || 'durum').toLowerCase();
      if (s === 'ac') g.auto = true; else if (s === 'kapat') g.auto = false;
      else if (s === 'link-ac') g.links = true; else if (s === 'link-kapat') g.links = false;
      save();
      return priv(msg(`Otomatik moderasyon: **${g.auto ? 'AÇIK' : 'KAPALI'}** · Link engeli: **${g.links ? 'AÇIK' : 'KAPALI'}**`));
    }
    case 'kayit': {
      const d = need(); if (d) return d;
      return priv(msg(g.log.slice(-10).map(l => `• ${new Date(l.t).toLocaleTimeString('tr-TR')} ${l.who}: ${l.r}`).join('\n') || 'Kayıt yok.'));
    }
    default: return priv(msg('Bilinmeyen komut: `' + name + '`. `/yardim` yaz.'));
  }
}

// ---------- otomatik moderasyon (message_create) ----------
function automod(body) {
  const { data, user, guild } = body, text = String(data.content || ''), g = G(guild && guild.id || 'x');
  if (!g.auto || !user || isMod(user) || !text) return {};
  const who = user.username, low = text.toLowerCase();
  let reason = '';

  const bad = g.words.find(w => low.includes(w));
  if (bad) reason = 'Yasaklı kelime kullanımı';
  else if (g.links && /(https?:\/\/|www\.|discord\.gg\/)/i.test(text)) reason = 'Link paylaşımı yasak';
  else if (text.length >= 12 && (text.replace(/[^A-ZÇĞİÖŞÜ]/g, '').length / text.replace(/[^A-Za-zÇĞİÖŞÜçğıöşü]/g, '').length || 0) > 0.7) reason = 'Aşırı büyük harf';
  else if ((text.match(/@/g) || []).length >= 5) reason = 'Toplu etiketleme';
  else {
    const k = (guild && guild.id) + ':' + who, now = Date.now(), t = (spam[k] = (spam[k] || []).filter(x => now - x < 5000));
    t.push(now);
    if (t.length >= 6) { reason = 'Spam'; spam[k] = []; }
  }
  if (!reason) return {};
  return warnText(who, addWarn(g, who, reason + ' (otomatik)', 'AutoMod'), reason);
}

// ---------- HTTP sunucu ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Budd-App-Id',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '86400'
};
const send = (res, code, obj) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS)); res.end(obj == null ? '' : JSON.stringify(obj)); };

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204);
  if (req.method !== 'POST') return send(res, 200, { ok: true, bot: 'modbot' });
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', () => {
    let b; try { b = JSON.parse(raw); } catch (e) { return send(res, 400, { error: 'json' }); }
    try {
      if (b.type === 'ping') return send(res, 200, { type: 'ping' });
      if (b.type === 'command') return send(res, 200, command(b));
      if (b.type === 'message_create') return send(res, 200, automod(b));
      send(res, 200, {});
    } catch (e) { console.error(e); send(res, 200, priv(msg('⚠️ Bot hatası: ' + e.message))); }
  });
}).listen(PORT, () => console.log('Modbot hazır: http://localhost:' + PORT + '  (yetkililer: ' + (MODS.join(', ') || 'YOK — MODS ayarla') + ')'));
      
