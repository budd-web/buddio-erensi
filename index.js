// Budd · Akinator botu (HTTP Endpoint yöntemi)
// Kurulum:  npm i express cors aki-api   ·   package.json içine  "type": "module"  ekle
// Çalıştır: node index.js
// Ortam değişkenleri (hepsi isteğe bağlı):
//   PORT=3000            dinlenecek port
//   BOT_PATH=/           endpoint yolu (gizli bir yol kullan: /budd-x7k2p9)
//   APP_ID=...           doluysa X-Budd-App-Id başlığı kontrol edilir
//   AKI_REGION=tr        akinator dili (tr, en, de, fr, es, ...)

import express from "express";
import cors from "cors";
import { Aki } from "aki-api";

const PORT = Number(process.env.PORT) || 3000;
const BOT_PATH = process.env.BOT_PATH || "/";
const APP_ID = process.env.APP_ID || "";
const REGION = process.env.AKI_REGION || "tr";
const TTL = 15 * 60 * 1000;   // 15 dk işlem yapılmayan oyun silinir
const GUESS_AT = 85;          // ilerleme % bu değere gelince tahmin eder
const MAX_STEP = 78;          // bu soruda zorunlu tahmin
const COLOR = 5793266;

/** oyunlar: guild:channel:user -> oturum */
const games = new Map();
const key = (b) => `${b.guild?.id || "dm"}:${b.channel?.id || "-"}:${b.user.id}`;

setInterval(() => {
  const now = Date.now();
  for (const [k, g] of games) if (now - g.t > TTL) games.delete(k);
}, 60 * 1000).unref();

// ---------- görünümler ----------
const btn = (label, id, style) => ({ type: 2, style, label, custom_id: id });
const row = (...c) => ({ type: 1, components: c });

function questionView(g) {
  const a = g.aki;
  const id = (x) => `aki:${g.owner}:${x}`;
  return {
    embeds: [{
      title: "🧞 Akinator",
      description: `**Soru ${a.currentStep + 1}**\n${a.question}`,
      color: COLOR,
      footer: { text: `İlerleme %${Math.round(a.progress)} · Oyuncu: ${g.name}` },
    }],
    components: [
      row(btn("Evet", id("a0"), 3), btn("Hayır", id("a1"), 4), btn("Bilmiyorum", id("a2"), 2)),
      row(btn("Muhtemelen", id("a3"), 1), btn("Muhtemelen değil", id("a4"), 1)),
      row(btn("↩ Geri", id("back"), 2), btn("Bitir", id("stop"), 2)),
    ],
  };
}

function guessView(g) {
  const p = g.guesses[g.gi];
  const id = (x) => `aki:${g.owner}:${x}`;
  return {
    embeds: [{
      title: "🧞 Aklındaki kişi/karakter bu mu?",
      description: `**${p.name}**\n${p.description || ""}`,
      color: COLOR,
      image: p.absolute_picture_path ? { url: p.absolute_picture_path } : undefined,
      footer: { text: `Oyuncu: ${g.name}` },
    }],
    components: [row(btn("Evet, bu!", id("yes"), 3), btn("Hayır", id("no"), 4))],
  };
}

const endView = (title, text, img) => ({
  embeds: [{ title, description: text, color: COLOR, image: img ? { url: img } : undefined }],
  components: [],
});

// ---------- oyun mantığı ----------
async function maybeGuess(g) {
  const a = g.aki;
  if (a.progress < g.threshold && a.currentStep < MAX_STEP) return questionView(g);
  await a.win();
  g.guesses = Array.isArray(a.answers) ? a.answers.slice(0, 3) : [];
  g.gi = 0;
  if (!g.guesses.length) return lose(g);
  g.guessing = true;
  return guessView(g);
}

function lose(g) {
  games.delete(g.k);
  return endView("🧞 Bu sefer bilemedim", "Beni yendin! Tekrar denemek için `/akinator` yaz.");
}

async function start(b) {
  const aki = new Aki({ region: REGION });
  await aki.start();
  const g = {
    k: key(b), owner: b.user.id, name: b.user.username, aki,
    threshold: GUESS_AT, guessing: false, guesses: [], gi: 0, t: Date.now(),
  };
  games.set(g.k, g);
  return questionView(g);
}

async function onComponent(b) {
  const [, owner, act] = String(b.data.custom_id || "").split(":");
  if (b.user.id !== owner)
    return { content: "Bu oyun sana ait değil. Kendi oyununu `/akinator` ile başlat.", flags: 64 };

  const g = games.get(key(b));
  if (!g) return { update: true, ...endView("🧞 Oyun sona erdi", "Süre doldu. Yeni oyun için `/akinator` yaz.") };
  g.t = Date.now();

  if (act === "stop") { games.delete(g.k); return { update: true, ...endView("🧞 Oyun bitirildi", "Tekrar oynamak için `/akinator` yaz.") }; }

  if (g.guessing) {
    if (act === "yes") {
      const p = g.guesses[g.gi];
      games.delete(g.k);
      return { update: true, ...endView("🧞 Yine bildim! 🎉", `**${p.name}**\n${p.description || ""}`, p.absolute_picture_path) };
    }
    if (act === "no") {
      g.gi++;
      if (g.gi < g.guesses.length) return { update: true, ...guessView(g) };
      if (g.aki.currentStep >= MAX_STEP) return { update: true, ...lose(g) };
      g.guessing = false;           // devam et, daha emin olunca tekrar tahmin eder
      g.threshold = 95;
      return { update: true, ...questionView(g) };
    }
    return { update: true, ...guessView(g) };
  }

  if (act === "back") {
    if (g.aki.currentStep > 0) await g.aki.back();
    return { update: true, ...questionView(g) };
  }
  const n = /^a([0-4])$/.exec(act || "");
  if (!n) return { update: true, ...questionView(g) };
  await g.aki.step(Number(n[1]));
  return { update: true, ...(await maybeGuess(g)) };
}

// ---------- sunucu ----------
const app = express();
app.use(cors(), express.json());

app.get("/", (_q, r) => r.send("Akinator botu çalışıyor."));

app.post(BOT_PATH, async (req, res) => {
  const b = req.body || {};
  if (APP_ID && req.get("X-Budd-App-Id") !== APP_ID) return res.status(401).json({});
  try {
    if (b.type === "ping") return res.json({ type: "ping" });

    if (b.type === "command" && ["akinator", "aki"].includes(b.data?.name))
      return res.json(await start(b));

    if (b.type === "component" && String(b.data?.custom_id || "").startsWith("aki:"))
      return res.json(await onComponent(b));

    res.json({});
  } catch (e) {
    console.error("Hata:", e?.message || e);
    if (b.user) games.delete(key(b));
    res.json({
      content: "Akinator şu an cevap vermiyor (bağlantı hatası). Birazdan tekrar dene.",
      flags: 64,
    });
  }
});

app.listen(PORT, () => console.log(`Akinator botu :${PORT}${BOT_PATH} üzerinde hazır`));
        
