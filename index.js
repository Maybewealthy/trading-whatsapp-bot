const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const axios = require("axios");
const cron = require("node-cron");
const Anthropic = require("@anthropic-ai/sdk");
const express = require("express");
const qrcode = require("qrcode");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const GROUP_ID = process.env.WHATSAPP_GROUP_ID;

let sock = null;
let currentQR = null;
let isConnected = false;

// ─── PÁGINA WEB CON EL QR ────────────────────────────────────────────────────

app.get("/", async (req, res) => {
  if (isConnected) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#fff">
        <h1>✅ Bot conectado a WhatsApp</h1>
        <p>El bot está activo y enviando mensajes al grupo.</p>
      </body></html>
    `);
  }

  if (!currentQR) {
    return res.send(`
      <html><head><meta http-equiv="refresh" content="3"></head>
      <body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#fff">
        <h1>⏳ Generando QR...</h1>
        <p>Espera unos segundos y recarga la página.</p>
      </body></html>
    `);
  }

  try {
    const qrImage = await qrcode.toDataURL(currentQR);
    res.send(`
      <html><head><meta http-equiv="refresh" content="30"></head>
      <body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#fff">
        <h1>📱 Escanea este QR con el número del bot</h1>
        <p style="color:#aaa">Abre WhatsApp en el número nuevo → Ajustes → Dispositivos vinculados → Vincular dispositivo</p>
        <img src="${qrImage}" style="width:300px;height:300px;border:4px solid #fff;border-radius:12px;margin:20px"/>
        <p style="color:#666;font-size:12px">La página se actualiza automáticamente cada 30 segundos</p>
      </body></html>
    `);
  } catch (e) {
    res.send("<h1>Error generando QR. Recarga la página.</h1>");
  }
});

// ─── CONEXIÓN WHATSAPP ────────────────────────────────────────────────────────

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  sock = makeWASocket({ auth: state });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      console.log("📱 QR generado — abre la URL pública de Railway en el navegador para escanearlo");
    }

    if (connection === "close") {
      isConnected = false;
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) connectToWhatsApp();
    }

    if (connection === "open") {
      isConnected = true;
      currentQR = null;
      console.log("✅ Bot conectado a WhatsApp!");

      const groups = await sock.groupFetchAllParticipating();
      console.log("\n📋 GRUPOS DISPONIBLES:");
      Object.values(groups).forEach(g => {
        console.log(`  → "${g.subject}" | ID: ${g.id}`);
      });
      console.log("\nCopia el ID de tu grupo y pégalo en WHATSAPP_GROUP_ID en Railway.\n");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid !== GROUP_ID) continue;

      const body = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        ""
      ).toLowerCase().trim();

      let reply = "";

      if (body === "noticias" || body === "news") {
        const news = await getNewsFromFinnhub();
        const headlines = news.map(n => `- ${n.headline}`).join("\n");
        reply = await analyzeWithClaude(`Resume estas noticias para traders:\n${headlines}`);

      } else if (body === "calendario" || body === "eventos") {
        const calendar = await getEconomicCalendar();
        if (calendar.length === 0) {
          reply = "📅 No hay eventos económicos registrados para hoy.";
        } else {
          const lista = calendar.map(e =>
            `• ${e.time || "?"} | *${e.event}* | ${e.country} | Impacto: ${e.impact || "?"}`
          ).join("\n");
          reply = `📅 *Eventos económicos de hoy:*\n\n${lista}`;
        }

      } else if (body === "motivacion" || body === "motivación") {
        const motivations = [
          "El mercado premia la paciencia. No operes por emoción, opera por análisis. 💪",
          "Los mejores traders no predicen el mercado, se adaptan a él. 🎯",
          "Disciplina hoy, libertad financiera mañana. 🚀",
          "Gestiona el riesgo primero, las ganancias vienen solas. 🎯",
        ];
        reply = `💡 *"${motivations[Math.floor(Math.random() * motivations.length)]}"*`;

      } else if (body === "menu" || body === "menú" || body === "ayuda") {
        reply =
          `🤖 *Comandos disponibles:*\n\n` +
          `📰 *noticias* — Últimas noticias del mercado\n` +
          `📅 *calendario* — Eventos económicos de hoy\n` +
          `💡 *motivacion* — Frase motivacional\n` +
          `❓ *ayuda* — Ver este menú`;
      }

      if (reply) {
        await sock.sendMessage(GROUP_ID, { text: reply });
      }
    }
  });
}

// ─── UTILIDADES ──────────────────────────────────────────────────────────────

async function sendToGroup(message) {
  if (!GROUP_ID || !sock || !isConnected) {
    console.log("⚠️ Bot no conectado o GROUP_ID no configurado.");
    return;
  }
  try {
    await sock.sendMessage(GROUP_ID, { text: message });
    console.log("✅ Mensaje enviado al grupo");
  } catch (err) {
    console.error("❌ Error enviando:", err.message);
  }
}

async function getNewsFromFinnhub() {
  try {
    const res = await axios.get("https://finnhub.io/api/v1/news", {
      params: { category: "forex", token: process.env.FINNHUB_API_KEY },
    });
    return res.data.slice(0, 5);
  } catch (err) {
    console.error("Error Finnhub noticias:", err.message);
    return [];
  }
}

async function getEconomicCalendar() {
  try {
    const today = new Date().toISOString().split("T")[0];
    const res = await axios.get("https://finnhub.io/api/v1/calendar/economic", {
      params: { from: today, to: today, token: process.env.FINNHUB_API_KEY },
    });
    return (res.data.economicCalendar || []).slice(0, 8);
  } catch (err) {
    console.error("Error Finnhub calendario:", err.message);
    return [];
  }
}

async function analyzeWithClaude(prompt) {
  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      system: `Eres un informador de noticias económicas para un grupo de traders.
Explicas eventos del mercado de forma clara, educativa y concisa.
NO das señales de compra, venta ni recomendaciones de inversión.
Solo informas contexto, impacto potencial y datos relevantes.
Respondes siempre en español. Usa emojis. Máximo 250 palabras.`,
      messages: [{ role: "user", content: prompt }],
    });
    return msg.content[0].text;
  } catch (err) {
    console.error("Error Claude:", err.message);
    return "⚠️ No se pudo obtener el análisis en este momento.";
  }
}

// ─── MENSAJES AUTOMÁTICOS ─────────────────────────────────────────────────────

cron.schedule("0 7 * * *", async () => {
  const motivations = [
    "El mercado premia la paciencia. No operes por emoción, opera por análisis. 💪",
    "Una pérdida controlada hoy es capital para mañana. El riesgo se gestiona, no se evita. 🧠",
    "Los mejores traders no predicen el mercado, se adaptan a él. 🎯",
    "Disciplina hoy, libertad financiera mañana. 🚀",
    "El stop loss no es derrota, es inteligencia aplicada al trading. ⚡",
    "Cada día es una nueva oportunidad de aprender y mejorar. 📈",
    "El éxito en trading es un maratón, no un sprint. 🏆",
  ];
  const frase = motivations[Math.floor(Math.random() * motivations.length)];
  await sendToGroup(`🌅 *¡Buenos días, equipo!*\n\n💡 *Motivación del día:*\n_"${frase}"_\n\n¡A estudiar el mercado con cabeza fría! 📊`);
}, { timezone: "America/Bogota" });

cron.schedule("30 7 * * 1-5", async () => {
  const [news, calendar] = await Promise.all([getNewsFromFinnhub(), getEconomicCalendar()]);
  let prompt = "Resume el panorama económico de hoy para traders.\n\n";
  if (calendar.length > 0) {
    prompt += "CALENDARIO HOY:\n";
    calendar.forEach(e => { prompt += `- ${e.time || "?"} | ${e.event} | ${e.country} | Impacto: ${e.impact || "?"}\n`; });
    prompt += "\n";
  }
  if (news.length > 0) {
    prompt += "NOTICIAS:\n";
    news.forEach(n => { prompt += `- ${n.headline}\n`; });
  }
  prompt += "\nDestaca los eventos más importantes y a qué hora son.";
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
    const eventTime = new Date();
    eventTime.setHours(h, m, 0, 0);
    const diff = (eventTime - now) / 60000;
    if (diff > 25 && diff <= 35) {
      const prompt = `Explica brevemente qué es este evento y por qué importa al mercado:
Evento: ${event.event} | País: ${event.country} | Hora: ${event.time}
Pronóstico: ${event.estimate || "N/A"} | Anterior: ${event.prev || "N/A"}`;
      const contexto = await analyzeWithClaude(prompt);
      await sendToGroup(`🚨 *ALERTA — EVENTO ALTO IMPACTO EN 30 MIN*\n\n📅 *${event.event}*\n🕐 ${event.time} | 🌍 ${event.country}\n\n${contexto}`);
    }
  }
}, { timezone: "America/Bogota" });

cron.schedule("0 12 * * 1-5", async () => {
  const news = await getNewsFromFinnhub();
  if (!news.length) return;
  const headlines = news.map(n => `- ${n.headline}`).join("\n");
  const resumen = await analyzeWithClaude(`Resumen de mediodía para traders:\n${headlines}`);
  await sendToGroup(`📊 *RESUMEN MEDIODÍA*\n\n${resumen}`);
}, { timezone: "America/Bogota" });

cron.schedule("0 18 * * 1-5", async () => {
  const news = await getNewsFromFinnhub();
  const headlines = news.map(n => `- ${n.headline}`).join("\n");
  const resumen = await analyzeWithClaude(`Resumen del cierre de mercado hoy:\n${headlines}\nTermina con frase motivadora para mañana.`);
  await sendToGroup(`🌙 *CIERRE DE MERCADO*\n\n${resumen}\n\n_¡Hasta mañana equipo! 💪_`);
}, { timezone: "America/Bogota" });

// ─── ARRANQUE ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));

connectToWhatsApp();
