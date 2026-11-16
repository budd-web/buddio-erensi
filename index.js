// Budd · Akinator botu (HTTP Endpoint yöntemi) — düzeltilmiş sürüm
// Kurulum:  npm i express cors aki-api   ·   package.json içine  "type": "module"  ekle
// Çalıştır: node index.js
// Ortam değişkenleri (hepsi isteğe bağlı):
//   PORT=3000            dinlenecek port
//   BOT_PATH=/           endpoint yolu (gizli bir yol kullan: /budd-x7k2p9)
//   APP_ID=...           doluysa X-Budd-App-Id başlığı kontrol edilir (ping hariç)
//   AKI_REGION=tr        akinator dili (tr, en, de, fr, es, ...)

import express from "express";
import cors from "cors";
import * as akiMod from "aki-api";

// aki-api CommonJS: hem named hem default import biçimlerinde çalışsın
const Aki = akiMod.Aki ?? akiMod.default?.Aki ?? akiMod.default?.default?.Aki;
if (!Aki) throw new Error("aki-api yüklenemedi. `npm i aki-api` çalıştırdın mı?");

const PORT = Number(process.env.PORT) || 3000;
const BOT_PATH = process.env.BOT_PATH || "/";
const APP_ID = process.env.APP_ID || "";
const REGION = process.env.AKI_REGION || "tr";
const TTL = 15 * 60 * 1000;   // 15 dk işlem yapılmayan oyun silinir
const GUESS_AT = 85;          // ilerleme % bu değere gelince tahmin eder
const MAX_STEP = 78;          // bu soruda zorunlu tahmin
const COLOR = 5793266;
const NET_TIMEOUT = 6000;     // Budd isteği 15 sn'de keser; tek ağ çağrısına 6 sn

/** oyunlar: oyunId -> oturum (kanal/sunucu bilgisine bağımlı değil) */
const games = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, g] of games) if (now - g.t > TTL) games.delete(k);
}, 60 * 1000).unref();

// ---------- yardımcılar ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(p, ms = NET_TIMEOUT) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error("Akinator sunucusu zamanında yanıt vermedi")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

// Sadece güvenli (tekrarı zararsız) çağrılar için: start, win
async function retry(fn, tries = 2) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await withTimeout(fn()); }
    catch (e) { err = e; await sleep(300); }
  }
  throw err;
}

const newId = () => Math.random().toString(36).slice(2, 8);
const ephemeral = (content) => ({ content, flags: 64 });

// ---------- görünümler ----------
const btn = (label, id, style) => ({ type: 2, style, label, custom_id: id });
const row = (...c) => ({ type: 1, components: c });
const cid = (g, x) => `aki:${g.id}:${g.owner}:${x}`;

function questionView(g) {
  const a = g.aki;
  return {
    embeds: [{
      title: "🧞 Akinator",
      description: `**Soru ${(a.currentStep ?? 0) + 1}**\n${a.question}`,
      color: COLOR,
      footer: { text: `İlerleme %${Math.round(a.progress || 0)} · Oyuncu: ${g.name}` },
    }],
    components: [
      row(btn("Evet", cid(g, "a0"), 3), btn("Hayır", cid(g, "a1"), 4), btn("Bilmiyorum", cid(g, "a2"), 2)),
      row(btn("Muhtemelen", cid(g, "a3"), 1), btn("Muhtemelen değil", cid(g, "a4"), 1)),
      row(btn("↩ Geri", cid(g, "back"), 2), btn("Bitir", cid(g, "stop"), 2)),
    ],
  };
}

function guessView(g) {
  const p = g.guesses[g.gi];
  const embed = {
    title: "🧞 Aklındaki kişi/karakter bu mu?",
    description: `**${p.name}**\n${p.description || ""}`,
    color: COLOR,
    footer: { text: `Oyuncu: ${g.name}` },
  };
  if (p.absolute_picture_path) embed.image = { url: p.absolute_picture_path };
  return {
    embeds: [embed],
    components: [row(btn("Evet, bu!", cid(g, "yes"), 3), btn("Hayır", cid(g, "no"), 4))],
  };
}

const currentView = (g) => (g.guessing ? guessView(g) : questionView(g));

function endView(title, text, img) {
  const embed = { title, description: text, color: COLOR };
  if (img) embed.image = { url: img };
  return { embeds: [embed], components: [] };
}

// ---------- oyun mantığı ----------
async function maybeGuess(g) {
  const a = g.aki;
  if ((a.progress || 0) < g.threshold && (a.currentStep ?? 0) < MAX_STEP) return questionView(g);
  await retry(() => a.win());
  g.guesses = Array.isArray(a.answers) ? a.answers.slice(0, 3) : [];
  g.gi = 0;
  if (!g.guesses.length) return lose(g);
  g.guessing = true;
  return guessView(g);
}

function lose(g) {
  games.delete(g.id);
  return endView("🧞 Bu sefer bilemedim", "Beni yendin! Tekrar denemek için `/akinator` yaz.");
}

async function start(b) {
  const aki = new Aki({ region: REGION });
  await retry(() => aki.start());
  const g = {
    id: newId(), owner: b.user.id, name: b.user.username, aki,
    threshold: GUESS_AT, guessing: false, guesses: [], gi: 0, t: Date.now(), busy: false,
  };
  games.set(g.id, g);
  return questionView(g);
}

async function onComponent(b) {
  const [, gameId, owner, act] = String(b.data?.custom_id || "").split(":");

  if (b.user?.id !== owner)
    return ephemeral("Bu oyun sana ait değil. Kendi oyununu `/akinator` ile başlat.");

  const g = games.get(gameId);
  if (!g) return { update: true, ...endView("🧞 Oyun sona erdi", "Süre doldu ya da bot yeniden başladı. Yeni oyun için `/akinator` yaz.") };

  // Aynı anda gelen çift tıklamayı yoksay (Akinator adımları sıralı olmalı)
  if (g.busy) return { update: true, ...currentView(g) };
  g.busy = true;
  g.t = Date.now();

  try {
    if (act === "stop") {
      games.delete(g.id);
      return { update: true, ...endView("🧞 Oyun bitirildi", "Tekrar oynamak için `/akinator` yaz.") };
    }

    if (g.guessing) {
      if (act === "yes") {
        const p = g.guesses[g.gi];
        games.delete(g.id);
        return { update: true, ...endView("🧞 Yine bildim! 🎉", `**${p.name}**\n${p.description || ""}`, p.absolute_picture_path) };
      }
      if (act === "no") {
        g.gi++;
        if (g.gi < g.guesses.length) return { update: true, ...guessView(g) };
        if ((g.aki.currentStep ?? 0) >= MAX_STEP) return { update: true, ...lose(g) };
        g.guessing = false;           // devam et, daha emin olunca tekrar tahmin eder
        g.threshold = 95;
        return { update: true, ...questionView(g) };
      }
      return { update: true, ...guessView(g) };
    }

    if (act === "back") {
      if ((g.aki.currentStep ?? 0) > 0) await withTimeout(g.aki.back());
      return { update: true, ...questionView(g) };
    }

    const n = /^a([0-4])$/.exec(act || "");
    if (!n) return { update: true, ...questionView(g) };
    await withTimeout(g.aki.step(Number(n[1])));
    return { update: true, ...(await maybeGuess(g)) };
  } finally {
    g.busy = false;
  }
}

// ---------- sunucu ----------
const app = express();
app.use(cors(), express.json({ limit: "1mb" }));

app.get("/", (_q, r) => r.send("Akinator botu çalışıyor."));
app.get("/health", (_q, r) => r.json({ ok: true, games: games.size }));
if (BOT_PATH !== "/") app.get(BOT_PATH, (_q, r) => r.send("Akinator botu çalışıyor (endpoint hazır, POST bekliyor)."));

app.post(BOT_PATH, async (req, res) => {
  const b = req.body || {};
  console.log("İstek:", b.type, b.data?.name || b.data?.custom_id || "");

  // ping her zaman cevaplanır (URL doğrulaması header taşımayabilir)
  if (b.type === "ping") return res.json({ type: "ping" });

  if (APP_ID && req.get("X-Budd-App-Id") !== APP_ID) return res.status(401).json({});

  try {
    if (b.type === "command" && ["akinator", "aki"].includes(b.data?.name)) {
      if (!b.user?.id) return res.json(ephemeral("Kullanıcı bilgisi alınamadı."));
      return res.json(await start(b));
    }

    if (b.type === "component" && String(b.data?.custom_id || "").startsWith("aki:"))
      return res.json(await onComponent(b));

    res.json({});
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 250);
    console.error("Hata:", e?.stack || msg);
    // Oyunu silme: geçici ağ hatasında kullanıcı tekrar tıklayabilsin
    res.json(ephemeral(
      "Akinator şu an yanıt veremedi, birkaç saniye sonra tekrar dene.\n" +
      "Sürekli oluyorsa sunucu IP'si Akinator tarafından engelleniyor olabilir.\n`" + msg + "`"
    ));
  }
});

// Beklenmeyen hatalar botu düşürmesin
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

app.listen(PORT, () => console.log(`Akinator botu :${PORT}${BOT_PATH} üzerinde hazır`));
  
