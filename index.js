
const http = require("http");
const crypto = require("crypto");

// ==========================================
// ERENSI BOT
// Budd.io | Node.js | e! Prefix
// ==========================================

const PORT = process.env.PORT || 3000;
const SECRET_PATH = process.env.BOT_SECRET_PATH || "/erensi";
const APP_ID = process.env.BUDD_APP_ID || "";

const PREFIX = "e!";

// Geçici veriler. Sunucu yeniden başlatılınca sıfırlanır.
const afk = new Map();
const notes = new Map();
const polls = new Map();

// ==========================================
// KOMUT KATEGORİLERİ
// ==========================================

const categories = {
  security: {
    title: "🛡️ Güvenlik",
    commands: [
      "antinuke", "antiraid", "kanalkoruma",
      "rolkoruma", "botkoruma", "banlimit",
      "kicklimit", "reklamengel", "küfürengel"
    ]
  },

  moderation: {
    title: "🔨 Moderasyon",
    commands: [
      "ban", "kick", "timeout", "unban",
      "uyar", "uyarılar", "temizle", "slowmode"
    ]
  },

  roles: {
    title: "🎭 Rol Yönetimi",
    commands: [
      "otorol", "rolver", "rolal",
      "emojirol", "rolpanel", "rolbilgi"
    ]
  },

  level: {
    title: "📊 Seviye Sistemi",
    commands: [
      "rank", "level", "top", "xp"
    ]
  },

  fun: {
    title: "🎉 Eğlence",
    commands: [
      "zar", "yazıtura", "8ball",
      "rastgele", "ters", "anket"
    ]
  },

  utility: {
    title: "⚙️ Araçlar",
    commands: [
      "ping", "yardım", "sunucubilgi",
      "kullanıcıbilgi", "hesapla", "wiki",
      "afk", "not", "notum", "nottemizle"
    ]
  },

  music: {
    title: "🎵 Müzik",
    commands: [
      "katıl", "ayrıl", "çal", "durdur", "ses"
    ]
  }
};

// ==========================================
// YARDIMCI FONKSİYONLAR
// ==========================================

function reply(content, extra = {}) {
  return { content, ...extra };
}

function clean(value) {
  return String(value || "").trim();
}

function getUserId(user) {
  return String(user?.id || "unknown");
}

function randomNumber(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function safeText(value, max = 1500) {
  return clean(value).slice(0, max);
}

function unavailable(command) {
  return reply(
    `⚙️ **${PREFIX}${command}** komutu tanımlı ancak bu işlem için ` +
    "Budd.io'nun ilgili sunucu yönetim API'si henüz mevcut değil."
  );
}

// ==========================================
// HESAP MAKİNESİ
// ==========================================

function calculate(input) {
  input = clean(input);

  if (!input || input.length > 100) return null;

  if (!/^[0-9+\-*/().%\s]+$/.test(input)) return null;

  const tokens = input.match(/\d+(?:\.\d+)?|[()+\-*/%]/g);

  if (!tokens || tokens.join("") !== input.replace(/\s/g, "")) {
    return null;
  }

  let pos = 0;

  function factor() {
    const token = tokens[pos++];

    if (token === "(") {
      const result = expression();

      if (tokens[pos++] !== ")") throw Error("Parantez");

      return result;
    }

    if (token === "-") return -factor();
    if (token === "+") return factor();

    const number = Number(token);

    if (!Number.isFinite(number)) throw Error("Sayı");

    return number;
  }

  function term() {
    let value = factor();

    while (["*", "/", "%"].includes(tokens[pos])) {
      const op = tokens[pos++];
      const right = factor();

      if ((op === "/" || op === "%") && right === 0) {
        throw Error("Sıfıra bölme");
      }

      if (op === "*") value *= right;
      if (op === "/") value /= right;
      if (op === "%") value %= right;
    }

    return value;
  }

  function expression() {
    let value = term();

    while (["+", "-"].includes(tokens[pos])) {
      const op = tokens[pos++];
      const right = term();

      value = op === "+" ? value + right : value - right;
    }

    return value;
  }

  try {
    const result = expression();

    if (pos !== tokens.length || !Number.isFinite(result)) {
      return null;
    }

    return Number(result.toFixed(8));
  } catch {
    return null;
  }
}

// ==========================================
// YARDIM MENÜSÜ
// ==========================================

function helpMenu() {
  return reply(
    "**ERENSİ | KOMUT MERKEZİ**\n\n" +
    "Merhaba! Erensi komut merkezine hoş geldin.\n" +
    "Bir kategori seçerek komutları görüntüleyebilirsin.\n\n" +
    "Prefix: `e!`",
    {
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              label: "Güvenlik",
              custom_id: "help:security"
            },
            {
              type: 2,
              style: 1,
              label: "Moderasyon",
              custom_id: "help:moderation"
            },
            {
              type: 2,
              style: 1,
              label: "Roller",
              custom_id: "help:roles"
            }
          ]
        },
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 2,
              label: "Seviye",
              custom_id: "help:level"
            },
            {
              type: 2,
              style: 2,
              label: "Eğlence",
              custom_id: "help:fun"
            },
            {
              type: 2,
              style: 2,
              label: "Araçlar",
              custom_id: "help:utility"
            },
            {
              type: 2,
              style: 2,
              label: "Müzik",
              custom_id: "help:music"
            }
          ]
        }
      ]
    }
  );
}

function categoryMenu(id) {
  const category = categories[id];

  if (!category) {
    return reply("Bu kategori bulunamadı.");
  }

  const commandList = category.commands
    .map(command => `\`${PREFIX}${command}\``)
    .join("\n");

  return reply(
    `**ERENSİ | ${category.title}**\n\n${commandList}`,
    { update: true }
  );
}

// ==========================================
// WIKI ARAMA
// ==========================================

async function wikiSearch(query) {
  if (!query) return reply("🔎 Aramak istediğin konuyu yaz.");

  try {
    const url =
      "https://tr.wikipedia.org/api/rest_v1/page/summary/" +
      encodeURIComponent(query.replace(/ /g, "_"));

    const response = await fetch(url);
    if (!response.ok) return reply("Arama sonucu bulunamadı.");

    const data = await response.json();

    if (!data.extract) {
      return reply("Bu konu hakkında bilgi bulunamadı.");
    }

    return reply(
      `**${data.title || query}**\n\n` +
      safeText(data.extract, 1700) +
      (data.content_urls?.desktop?.page
        ? `\n\n[Kaynağı görüntüle](${data.content_urls.desktop.page})`
        : "")
    );
  } catch {
    return reply("Wiki servisine şu anda ulaşılamıyor.");
  }
}

// ==========================================
// ANKET SİSTEMİ
// ==========================================

function renderPoll(id) {
  const poll = polls.get(id);

  if (!poll) return reply("Anket bulunamadı.");

  const total = [...poll.votes.values()].length;

  const content =
    `📊 **${poll.question}**\n\n` +
    `👍 Evet: **${[...poll.votes.values()].filter(v => v === "yes").length}**\n` +
    `👎 Hayır: **${[...poll.votes.values()].filter(v => v === "no").length}**\n` +
    `👥 Toplam oy: **${total}**`;

  return reply(content, {
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "Evet",
            emoji: "👍",
            custom_id: `poll:${id}:yes`
          },
          {
            type: 2,
            style: 4,
            label: "Hayır",
            emoji: "👎",
            custom_id: `poll:${id}:no`
          }
        ]
      }
    ]
  });
}

// ==========================================
// KOMUT İŞLEME
// ==========================================

async function runCommand(command, args, body) {
  const user = body.user || {};
  const guild = body.guild || {};
  const username = safeText(user.username || "Kullanıcı", 50);
  const userId = getUserId(user);

  command = clean(command).toLowerCase();

  switch (command) {

    // ARAÇLAR

    case "yardım":
    case "yardim":
    case "help":
    case "komutlar":
      return helpMenu();

    case "ping":
      return reply("🏓 Pong! **Erensi aktif.**");

    case "sunucubilgi":
      return reply(
        `**${guild.name || "Budd Sunucusu"}**\n\n` +
        `Sunucu ID: \`${guild.id || "Bilinmiyor"}\`\n` +
        `Kanal: ${body.channel?.name || "Bilinmiyor"}`
      );

    case "kullanıcıbilgi":
      return reply(
        `**Kullanıcı Bilgisi**\n\n` +
        `İsim: ${username}\n` +
        `ID: \`${userId}\``
      );

    case "hesapla": {
      const result = calculate(args.join(" "));

      if (result === null) {
        return reply("❌ Geçerli bir işlem gir.\nÖrnek: `e!hesapla 25 * 4`");
      }

      return reply(`🧮 Sonuç: **${result}**`);
    }

    case "wiki":
      return await wikiSearch(args.join(" "));

    case "afk": {
      const reason = safeText(args.join(" ") || "Belirtilmedi", 200);
      afk.set(userId, reason);

      return reply(`💤 **${username}** artık AFK.\nSebep: ${reason}`);
    }

    case "not": {
      const note = safeText(args.join(" "), 1000);

      if (!note) return reply("Kaydedilecek notu yaz.");

      notes.set(userId, note);

      return reply("📝 Notun kaydedildi.");
    }

    case "notum":
      return reply(
        notes.has(userId)
          ? `📝 Notun:\n${notes.get(userId)}`
          : "Henüz kayıtlı bir notun yok."
      );

    case "nottemizle":
      notes.delete(userId);
      return reply("🗑️ Notun silindi.");

    // EĞLENCE

    case "zar": {
      const sides = Number(args[0]) || 6;

      if (!Number.isInteger(sides) || sides < 2 || sides > 1000) {
        return reply("Zar yüzü 2-1000 arasında olmalı.");
      }

      return reply(
        `🎲 **${username}** zar attı!\nSonuç: **${randomNumber(1, sides)}**`
      );
    }

    case "yazıtura":
      return reply(
        `🪙 Sonuç: **${Math.random() < 0.5 ? "Yazı" : "Tura"}**`
      );

    case "8ball": {
      if (!args.length) return reply("Bir soru sormalısın.");

      const answers = [
        "Kesinlikle!",
        "Bence evet.",
        "Olabilir.",
        "Pek sanmıyorum.",
        "Hayır.",
        "Bunu zaman gösterecek.",
        "Tekrar sor."
      ];

      return reply(`🎱 ${answers[randomNumber(0, answers.length - 1)]}`);
    }

    case "rastgele": {
      const options = args.join(" ").split("|")
        .map(x => clean(x))
        .filter(Boolean);

      if (options.length < 2) {
        return reply("Örnek: `e!rastgele Elma | Armut | Muz`");
      }

      return reply(
        `🎯 Seçimim: **${options[randomNumber(0, options.length - 1)]}**`
      );
    }

    case "ters":
      return reply(args.join(" ").split("").reverse().join(""));

    case "anket": {
      const question = safeText(args.join(" "), 300);

      if (!question) return reply("Anket sorusunu yaz.");

      const id = crypto.randomUUID().slice(0, 12);

      polls.set(id, {
        question,
        votes: new Map()
      });

      return renderPoll(id);
    }

    // MÜZİK

    case "katıl": {
      const channel = args.join(" ");

      if (!channel) {
        return reply("Katılınacak ses kanalının adını yaz.");
      }

      return reply("🎵 Ses kanalına katılma isteği gönderildi.", {
        actions: [{ act: "join", ch: channel }]
      });
    }

    case "ayrıl":
      return reply("Ses kanalından ayrılma isteği gönderildi.", {
        actions: [{ act: "leave" }]
      });

    case "durdur":
      return reply("Müzik durdurma isteği gönderildi.", {
        actions: [{ act: "stop" }]
      });

    case "çal": {
      const url = args[0];

      if (!url || !/^https:\/\//i.test(url)) {
        return reply("Geçerli bir HTTPS ses bağlantısı gir.");
      }

      return reply("🎵 Çalma isteği gönderildi.", {
        actions: [{ act: "play", url, v: 0.8 }]
      });
    }

    case "ses": {
      const volume = Number(args[0]);

      if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
        return reply("Ses seviyesini 0-100 arasında belirt.");
      }

      return reply(`🔊 Ses seviyesi: ${volume}`, {
        actions: [{ act: "volume", v: volume / 100 }]
      });
    }
  }

  // YÖNETİM VE KORUMA MODÜLLERİ
  // Bunlar için Budd yönetim API'si gerekiyor.

  const protectedCommands = [
    "antinuke", "antiraid", "kanalkoruma",
    "rolkoruma", "botkoruma", "banlimit",
    "kicklimit", "reklamengel", "küfürengel"
  ];

  const moderationCommands = [
    "ban", "kick", "timeout", "unban",
    "uyar", "uyarılar", "temizle", "slowmode"
  ];

  const roleCommands = [
    "otorol", "rolver", "rolal",
    "emojirol", "rolpanel", "rolbilgi"
  ];

  const levelCommands = [
    "rank", "level", "top", "xp"
  ];

  const otherCommands = [
    ...protectedCommands,
    ...moderationCommands,
    ...roleCommands,
    ...levelCommands
  ];

  if (otherCommands.includes(command)) {
    return unavailable(command);
  }

  return reply(
    `❓ **${PREFIX}${command}** diye bir komut bulamadım.\n` +
    `Komut listesi için \`${PREFIX}yardım\` yaz.`
  );
}

// ==========================================
// PREFIX MESAJLARI
// ==========================================

async function handleMessage(body) {
  const content = clean(body.data?.content);

  if (!content.startsWith(PREFIX)) return {};

  const userId = getUserId(body.user);
  const userName = body.user?.username || "Kullanıcı";

  // AFK durumunu kaldır
  if (afk.has(userId)) {
    afk.delete(userId);
  }

  const input = content.slice(PREFIX.length).trim();

  if (!input) return reply("Bir komut yazmalısın.");

  const parts = input.split(/\s+/);
  const command = parts.shift().toLowerCase();
  const args = parts;

  return await runCommand(command, args, body);
}

// ==========================================
// BUTON İŞLEMLERİ
// ==========================================

function handleComponent(body) {
  const id = clean(body.data?.custom_id);
  const userId = getUserId(body.user);

  if (id.startsWith("help:")) {
    return categoryMenu(id.split(":")[1]);
  }

  if (id.startsWith("poll:")) {
    const [, pollId, choice] = id.split(":");

    const poll = polls.get(pollId);

    if (!poll || !["yes", "no"].includes(choice)) {
      return reply("Bu anket artık mevcut değil.", { flags: 64 });
    }

    poll.votes.set(userId, choice);

    return {
      ...renderPoll(pollId),
      update: true
    };
  }

  return reply("Geçersiz etkileşim.", { flags: 64 });
}

// ==========================================
// SLASH KOMUT DESTEĞİ
// ==========================================

async function handleSlash(body) {
  const data = body.data || {};
  const name = clean(data.name).toLowerCase();

  const args = [];

  if (data.options && typeof data.options === "object") {
    for (const value of Object.values(data.options)) {
      if (typeof value === "string" || typeof value === "number") {
        args.push(String(value));
      }
    }
  }

  return await runCommand(name, args, body);
}

// ==========================================
// ANA EVENT ROUTER
// ==========================================

async function handleEvent(body) {
  switch (body.type) {
    case "ping":
      return { type: "ping" };

    case "command":
      return await handleSlash(body);

    case "message_create":
      return await handleMessage(body);

    case "component":
      return handleComponent(body);

    default:
      return {};
  }
}

// ==========================================
// HTTP SERVER
// ==========================================

const server = http.createServer((req, res) => {

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Budd-App-Id"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8"
    });

    return res.end("Erensi is online.");
  }

  if (req.method !== "POST" || req.url !== SECRET_PATH) {
    res.writeHead(404);
    return res.end("Not found");
  }

  let raw = "";
  let oversized = false;

  req.on("data", chunk => {
    raw += chunk;

    if (raw.length > 1024 * 1024) {
      oversized = true;
      res.writeHead(413);
      res.end("Payload too large");
      req.destroy();
    }
  });

  req.on("end", async () => {
    if (oversized) return;

    try {
      const body = JSON.parse(raw || "{}");

      if (
        APP_ID &&
        req.headers["x-budd-app-id"] !== APP_ID
      ) {
        res.writeHead(403);
        return res.end(JSON.stringify({
          error: "Invalid application"
        }));
      }

      const result = await handleEvent(body);

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8"
      });

      res.end(JSON.stringify(result || {}));

    } catch (error) {
      console.error("Erensi error:", error);

      if (!res.headersSent) {
        res.writeHead(500, {
          "Content-Type": "application/json"
        });

        res.end(JSON.stringify({
          error: "Internal server error"
        }));
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("--------------------------------");
  console.log("       ERENSI BOT");
  console.log("--------------------------------");
  console.log("Prefix: " + PREFIX);
  console.log("Port: " + PORT);
  console.log("Endpoint: " + SECRET_PATH);
  console.log("Status: ONLINE");
  console.log("--------------------------------");
});
      
