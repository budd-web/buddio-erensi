// Budd · Akinator botu (HTTP Endpoint) — akinator-client sürümü
// Kurulum:  npm i express cors akinator-client   ·   Node 18+   ·   package.json'da "type": "module"
// Çalıştır: node index.js
// Ortam değişkenleri (hepsi isteğe bağlı):
//   PORT=3000          dinlenecek port
//   BOT_PATH=/         endpoint yolu (gizli bir yol kullan: /budd-x7k2p9)
//   APP_ID=...         doluysa X-Budd-App-Id başlığı kontrol edilir (ping hariç)
//   AKI_REGION=tr      akinator dili (tr, en, de, fr, es, ...); olmazsa otomatik en'e düşer
//   PROXY_URL=...      Cloudflare engellerse: http://kullanici:sifre@host:port

import express from "express";
import cors from "cors";
import * as mod from "akinator-client";

const AkinatorClient = mod.AkinatorClient ?? mod.default?.AkinatorClient;
const Answers = mod.Answers ?? mod.default?.Answers ?? {};
if (!AkinatorClient) throw new Error("akinator-client yüklenemedi. `npm i akinator-client` çalıştırdın mı?");

const PORT = Number(process.env.PORT) || 3000;
const BOT_PATH = process.env.BOT_PATH || "/";
const APP_ID = process.env.APP_ID || "";
const REGION = (process.env.AKI_REGION || "tr").toLowerCase();
const PROXY_URL = process.env.PROXY_URL || undefined;
const TTL = 15 * 60 * 1000;   // 15 dk işlem yapılmayan oyun silinir
const COLOR = 5793266;
const START_TIMEOUT = 6500;   // Budd isteği 15 sn'de keser; dil yedeği için iki deneme sığsın
const CALL_TIMEOUT = 12000;

// 0..4 -> Evet, Hayır, Bilmiyorum, Muhtemelen, Muhtemelen değil
const ANSWER_MAP = [Answers.Yes, Answers.No, Answers.IDontKnow, Answers.Probably, Answers.ProbablyNot]
  .map((v, i) => v ?? i);

/** oyunlar: oyunId -> oturum */
const games = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, g] of games) if (now - g.t > TTL) games.delete(k);
}, 60 * 1000).unref();

// ---------- yardımcılar ----------
function withTimeout(p, ms = CALL_TIMEOUT) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error("Akinator sunucusu zamanında yanıt vermedi")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

const newId = () => Math.random().toString(36).slice(2, 8);
const ephemeral = (content) => ({ content, flags: 64 });

// ---------- görünümler ----------
const btn = (label, id, style) => ({ type: 2, style, label, custom_id: id });
const row = (...c) => ({ type: 1, components: c });
const cid = (g, x) => `aki:${g.id}:${g.owner}:${x}`;

function questionView(g) {
  const c = g.client;
  return {
    embeds: [{
      title: "🧞 Akinator",
      description: `**Soru ${g.n + 1}**\n${c.question}`,
      color: COLOR,
      footer: { text: `İlerleme %${Math.round(c.progression || 0)} · Oyuncu: ${g.name}` },
    }],
    components: [
      row(btn("Evet", cid(g, "a0"), 3), btn("Hayır", cid(g, "a1"), 4), btn("Bilmiyorum", cid(g, "a2"), 2)),
      row(btn("Muhtemelen", cid(g, "a3"), 1), btn("Muhtemelen değil", cid(g, "a4"), 1)),
      row(btn("↩ Geri", cid(g, "back"), 2), btn("Bitir", cid(g, "stop"), 2)),
    ],
  };
}

function guessView(g) {
  const p = g.win || {};
  const embed = {
    title: "🧞 Aklındaki kişi/karakter bu mu?",
    description: `**${p.name || "?"}**\n${p.description || ""}`,
    color: COLOR,
    footer: { text: `Oyuncu: ${g.name}` },
  };
  if (p.pictureUrl) embed.image = { url: p.pictureUrl };
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

function lose(g) {
  games.delete(g.id);
  return endView("🧞 Bu sefer bilemedim", "Beni yendin! Tekrar denemek için `/akinator` yaz.");
}

// ---------- oyun mantığı ----------
async function start(b) {
  const langs = [...new Set([REGION, "en"])];
  let client, used, lastErr;
  for (const lang of langs) {
    try {
      const c = new AkinatorClient({ language: lang, proxy: PROXY_URL });
      await withTimeout(c.start(), START_TIMEOUT);
      client = c; used = lang;
      break;
    } catch (e) {
      lastErr = e;
      console.error(`start(${lang}) başarısız:`, e?.message || e);
    }
  }
  if (!client) throw lastErr || new Error("Akinator başlatılamadı");

  const g = {
    id: newId(), owner: b.user.id, name: b.user.username, client, lang: used,
    n: 0, guessing: false, win: null, t: Date.now(), busy: false,
  };
  games.set(g.id, g);
  return questionView(g);
}

// Cevap sonrası: tahmin mi, pes mi, yoksa yeni soru mu?
function afterAnswer(g, r) {
  const c = g.client;
  if (c.ko || r?.ko) return lose(g);
  if ((c.won || r?.won) && c.winResult) {
    g.guessing = true;
    g.win = c.winResult;
    return guessView(g);
  }
  return questionView(g);
}

async function onComponent(b) {
  const [, gameId, owner, act] = String(b.data?.custom_id || "").split(":");

  if (b.user?.id !== owner)
    return ephemeral("Bu oyun sana ait değil. Kendi oyununu `/akinator` ile başlat.");

  const g = games.get(gameId);
  if (!g) return { update: true, ...endView("🧞 Oyun sona erdi", "Süre doldu ya da bot yeniden başladı. Yeni oyun için `/akinator` yaz.") };

  // Aynı anda gelen çift tıklamayı yoksay
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
        const p = g.win || {};
        games.delete(g.id);
        withTimeout(g.client.submitWin(), 5000).catch(() => {});   // en iyi çaba, sonucu beklenmez
        return { update: true, ...endView("🧞 Yine bildim! 🎉", `**${p.name || "?"}**\n${p.description || ""}`, p.pictureUrl) };
      }
      if (act === "no") {
        try {
          const r = await withTimeout(g.client.continue());
          g.guessing = false;
          g.win = null;
          return { update: true, ...afterAnswer(g, r) };
        } catch (e) {
          // continue() bazı ortamlarda anti-bot yüzünden çalışmaz: oyunu düzgünce bitir
          console.error("continue() başarısız:", e?.message || e);
          return { update: true, ...lose(g) };
        }
      }
      return { update: true, ...guessView(g) };
    }

    if (act === "back") {
      if (g.n > 0) {
        await withTimeout(g.client.back());
        g.n--;
      }
      return { update: true, ...questionView(g) };
    }

    const m = /^a([0-4])$/.exec(act || "");
    if (!m) return { update: true, ...questionView(g) };
    const r = await withTimeout(g.client.answer(ANSWER_MAP[Number(m[1])]));
    g.n++;
    return { update: true, ...afterAnswer(g, r) };
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

  // ping her zaman cevaplanır
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
    // Oyunu silme: geçici hatada kullanıcı tekrar tıklayabilsin
    res.json(ephemeral(
      "Akinator şu an yanıt veremedi, birkaç saniye sonra tekrar dene.\n`" + msg + "`"
    ));
  }
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

app.listen(PORT, () => console.log(`Akinator botu :${PORT}${BOT_PATH} üzerinde hazır`));
    
