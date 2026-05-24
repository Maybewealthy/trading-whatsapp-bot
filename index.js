const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const axios = require("axios");
const cron = require("node-cron");
const Anthropic = require("@anthropic-ai/sdk");
const express = require("express");
const fs = require("fs");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const GROUP_ID = process.env.WHATSAPP_GROUP_ID;
const BOT_NUMBER = process.env.BOT_PHONE_NUMBER; // ej: 573001234567 sin + ni espacios

let sock = null;
let isConnected = false;
let pairingCode = null;
let groups = [];

// ─── PÁGINA WEB ──────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  if (isConnected) {
    const groupList = groups.map(g => `<li><b>${g.name}</b> — <code>${g.id}</code></li>`).join("");
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#fff">
        <h1>✅ Bot conectado a WhatsApp</h1>
        <p>El bot está activo y enviando mensajes al grupo.</p>
        ${groupList ? `<h2>Tus grupos:</h2><ul style="text-align:left;display:inline-block">${groupList}</ul><p>Copia el ID de tu grupo y ponlo en <b>WHATSAPP_GROUP_ID</b> en Railway.</p>` : ""}
      </body></html>
    `);
  }

  if (pairingCode) {
    return res.send(`
      <html><head><meta http-equiv="refresh" content="10"></head>
      <body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#fff">
        <h1>📱 Código de emparejamiento</h1>
        <p>Abre WhatsApp en el número del bot → <b>Ajustes → Dispositivos vinculados → Vincular con número de teléfono</b></p>
        <div style="font-size:64px;font-weight:bold;letter-spacing:12px;color:#25D366;margin:30px">${pairingCode}</div>
        <p style="color:#aaa">Ingresa este código en WhatsApp. La página se actualiza automáticamente.</p>
      </body></html>
    `);
  }

  return res.send(`
    <html><head><meta http-equiv="refresh" content="5"></head>
    <body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#fff">
      <h1>⏳ Iniciando bot...</h1>
      <p>Espera unos segundos y recarga la página.</p>
    </body></html>
  `);
});

// ─── CONEXIÓN WHATSAPP ────────────────────────────────────────────────────────

async function connectToWhatsApp() {
  // Limpia sesión si CLEAR_SESSION=true
  if (process.env.CLEAR_SESSION === "true" && fs.existsSync("auth_info")) {
    fs.rmSync("auth_info", { recursive: true, force: true });
    console.log("🧹 Sesión anterior borrada");
  }

  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    browser: ["Trading Bot", "Chrome", "22.0"],
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 2000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, isNewLogin } = update;

    // Solicita código de emparejamiento si no está registrado
    if (isNewLogin && BOT_NUMBER && !sock.authState.creds.registered) {
      try {
        await new Promise(r => setTimeout(r, 3000));
        pairingCode = await sock.requestPairingCode(BOT_NUMBER);
        console.log(`\n📱 CÓDIGO DE EMPAREJAMIENTO: ${pairingCode}\n`);
        console.log("Abre la URL pública de Railway para ver el código.\n");
      } catch (e) {
        console.error("Error solicitando código:", e.message);
      }
    }

    if (connection === "close") {
      isConnected = false;
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log("Conexión cerrada, código:", code, "| Reconectando:", shouldReconnect);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000);
      }
    }

    if (connection === "open") {
      isConnected = true;
      pairingCode = null;
      console.log("✅ Bot conectado a WhatsApp!");

      // Lista grupos
      try {
        const allGroups = await sock.groupFetchAllParticipating();
        groups = Object.values(allGroups).map(g => ({ id: g.id, name: g.subject }));
        console.log("\n📋 GRUPOS DISPONIBLES:");
        groups.forEach(g => console.log(`  → "${g.name}" | ID: ${g.id}`));
        console.log("\nAbre la URL pública de Railway para ver la lista.\n");
      } catch (e) {
        console.error("Error listando grupos:", e.message);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid !== GROUP_ID) continue;

      const body = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text || ""
      ).toLowerCase().trim();

      let reply = "";

      if (body === "noticias" || body === "news") {
        const news = await getNewsFromFinnhub();
        const headlines = news.map(n => `- ${n.headline}`).join("\n");
        reply = await analyzeWithClaude(`Resume estas noticias para traders:\n${headlines}`);
      } else if (body === "calendario" || body === "eventos") {
        const calendar = await getEconomicCalendar();
        if (!calendar.length) {
          reply = "📅 No hay eventos económicos registrados para hoy.";
        } else {
          reply = `📅 *Eventos económicos de hoy:*\n\n` +
            calendar.map(e => `• ${e.time || "?"} | *${e.event}* | ${e.country} | Impacto: ${e.impact || "?"}`).join("\n");
        }
      } else if (body === "motivacion" || body === "motivación") {
        const list = [
          "El mercado premia la paciencia. No operes por emoción. 💪",
          "Los mejores traders no predicen el mercado, se adaptan. 🎯",
          "Disciplina hoy, libertad financiera mañana. 🚀",
        ];
        reply = `💡 *"${list[Math.floor(Math.random() * list.length)]}"*`;
      } else if (body === "menu" || body === "menú" || body === "ayuda") {
        reply = `🤖 *Comandos:*\n\n📰 *noticias*\n📅 *calendario*\n💡 *motivacion*\n❓ *ayuda*`;
      }

      if (reply) await sock.sendMessage(GROUP_ID, { text: reply });
    }
  });
}

// ─── UTILIDADES ──────────────────────────────────────────────────────────────

async function sendToGroup(message) {
  if (!GROUP_ID || !sock || !isConnected) return console.log("⚠️ Bot no listo aún.");
  try {
    await sock.sendMessage(GROUP_ID, { text: message });
    console.log("✅ Mensaje enviado");
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

async function getNewsFromFinnhub() {
  try {
    const res = await axios.get("https://finnhub.io/api/v1/news", {
      params: { category: "forex", token: process.env.FINNHUB_API_KEY },
    });
    return res.data.slice(0, 5);
  } catch { return []; }
}

async function getEconomicCalendar() {
  try {
    const today = new Date().toISOString().split("T")[0];
    const res = await axios.get("https://finnhub.io/api/v1/calendar/economic", {
      params: { from: today, to: today, token: process.env.FINNHUB_API_KEY },
    });
    return (res.data.economicCalendar || []).slice(0, 8);
  } catch { return []; }
}

async function analyzeWithClaude(prompt) {
  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      system: `Informador de noticias económicas para traders. 
NO das señales de compra/venta. Solo contexto educativo.
Español, emojis, máximo 250 palabras.`,
      messages: [{ role: "user", content: prompt }],
    });
    return msg.content[0].text;
  } catch { return "⚠️ No se pudo obtener el análisis."; }
}

// ─── MENSAJES AUTOMÁTICOS ─────────────────────────────────────────────────────

cron.schedule("0 7 * * *", async () => {
  const list = [
    "El mercado premia la paciencia. No operes por emoción. 💪",
    "Los mejores traders no predicen el mercado, se adaptan. 🎯",
    "Disciplina hoy, libertad financiera mañana. 🚀",
    "Una pérdida controlada hoy es capital para mañana. 🧠",
    "El éxito en trading es un maratón, no un sprint. 🏆",
  ];
  const frase = list[Math.floor(Math.random() * list.length)];
  await sendToGroup(`🌅 *¡Buenos días, equipo!*\n\n💡 *Motivación del día:*\n_"${frase}"_\n\n¡A estudiar el mercado con cabeza fría! 📊`);
}, { timezone: "America/Bogota" });

cron.schedule("30 7 * * 1-5", async () => {
  const [news, calendar] = await Promise.all([getNewsFromFinnhub(), getEconomicCalendar()]);
  let prompt = "Resume el panorama económico de hoy para traders.\n\n";
  if (calendar.length) { prompt += "CALENDARIO:\n"; calendar.forEach(e => { prompt += `- ${e.time || "?"} | ${e.event} | ${e.country} | Impacto: ${e.impact || "?"}\n`; }); }
  if (news.length) { prompt += "\nNOTICIAS:\n"; news.forEach(n => { prompt += `- ${n.headline}\n`; }); }
  const resumen = await analyzeWithClaude(prompt);
  const fecha = new Date().toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" }).toUpperCase();
  await sendToGroup(`📰 *NOTICIAS DEL DÍA — ${fecha}*\n\n${resumen}`);
}, { timezone: "America/Bogota" });

cron.schedule("*/15 8-17 * * 1-5", async () => {
  const calendar = await getEconomicCalendar();
  const now = new Date();
  for (const event of calendar) {
    if (!event.time || event.impact !== "high") continue;
    const [h, m] = event.time.split(":").map(Number);
    const eventTime = new Date(); eventTime.setHours(h, m, 0, 0);
    const diff = (eventTime - now) / 60000;
    if (diff > 25 && diff <= 35) {
      const contexto = await analyzeWithClaude(`Explica este evento económico:\nEvento: ${event.event} | País: ${event.country} | Hora: ${event.time} | Pronóstico: ${event.estimate || "N/A"} | Anterior: ${event.prev || "N/A"}`);
      await sendToGroup(`🚨 *ALERTA — ALTO IMPACTO EN 30 MIN*\n\n📅 *${event.event}*\n🕐 ${event.time} | 🌍 ${event.country}\n\n${contexto}`);
    }
  }
}, { timezone: "America/Bogota" });

cron.schedule("0 12 * * 1-5", async () => {
  const news = await getNewsFromFinnhub();
  if (!news.length) return;
  const resumen = await analyzeWithClaude(`Resumen mediodía:\n${news.map(n => `- ${n.headline}`).join("\n")}`);
  await sendToGroup(`📊 *RESUMEN MEDIODÍA*\n\n${resumen}`);
}, { timezone: "America/Bogota" });

cron.schedule("0 18 * * 1-5", async () => {
  const news = await getNewsFromFinnhub();
  const resumen = await analyzeWithClaude(`Cierre de mercado hoy:\n${news.map(n => `- ${n.headline}`).join("\n")}\nTermina con frase motivadora.`);
  await sendToGroup(`🌙 *CIERRE DE MERCADO*\n\n${resumen}\n\n_¡Hasta mañana equipo! 💪_`);
}, { timezone: "America/Bogota" });

// ─── ARRANQUE ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
connectToWhatsApp();
