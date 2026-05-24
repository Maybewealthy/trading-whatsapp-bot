const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const axios = require("axios");
const cron = require("node-cron");
const Anthropic = require("@anthropic-ai/sdk");
const express = require("express");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ID del grupo — se obtiene automáticamente al arrancar (ver logs)
const GROUP_ID = process.env.WHATSAPP_GROUP_ID;

// ─── CLIENTE WHATSAPP ────────────────────────────────────────────────────────

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
    ],
  },
});

// Muestra el QR en consola para escanear
client.on("qr", (qr) => {
  console.log("\n📱 ESCANEA ESTE QR CON EL NÚMERO DEL BOT:\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", async () => {
  console.log("✅ Bot conectado y listo!");

  // Lista todos los grupos para que copies el ID correcto
  const chats = await client.getChats();
  const groups = chats.filter(c => c.isGroup);
  console.log("\n📋 GRUPOS DISPONIBLES (copia el ID de tu grupo):");
  groups.forEach(g => console.log(`  → "${g.name}" | ID: ${g.id._serialized}`));
  console.log("\nPega el ID en la variable WHATSAPP_GROUP_ID en Railway.\n");
});

client.on("auth_failure", () => console.error("❌ Error de autenticación"));
client.on("disconnected", (r) => console.log("⚠️ Desconectado:", r));

// ─── UTILIDADES ─────────────────────────────────────────────────────────────

async function sendToGroup(message) {
  if (!GROUP_ID) {
    console.log("⚠️ GROUP_ID no configurado. Revisa los logs para obtenerlo.");
    return;
  }
  try {
    await client.sendMessage(GROUP_ID, message);
    console.log("✅ Mensaje enviado al grupo");
  } catch (err) {
    console.error("❌ Error enviando al grupo:", err.message);
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
Respondes siempre en español. Usa emojis para hacerlo visual. Máximo 250 palabras.`,
      messages: [{ role: "user", content: prompt }],
    });
    return msg.content[0].text;
  } catch (err) {
    console.error("Error Claude:", err.message);
    return "⚠️ No se pudo obtener el análisis en este momento.";
  }
}

// ─── MENSAJES AUTOMÁTICOS ────────────────────────────────────────────────────

// 🌅 7:00 AM — Motivación diaria
cron.schedule("0 7 * * *", async () => {
  const motivations = [
    "El mercado premia la paciencia. No operes por emoción, opera por análisis. 💪",
    "Una pérdida controlada hoy es capital para mañana. El riesgo se gestiona, no se evita. 🧠",
    "Los mejores traders no predicen el mercado, se adaptan a él. 🎯",
    "Disciplina hoy, libertad financiera mañana. 🚀",
    "El stop loss no es derrota, es inteligencia aplicada al trading. ⚡",
    "Cada día es una nueva oportunidad de aprender y mejorar. 📈",
    "El éxito en trading es un maratón, no un sprint. 🏆",
    "Gestiona el riesgo primero, las ganancias vienen solas. 🎯",
  ];
  const frase = motivations[Math.floor(Math.random() * motivations.length)];
  await sendToGroup(`🌅 *¡Buenos días, equipo!*\n\n💡 *Motivación del día:*\n_"${frase}"_\n\n¡A estudiar el mercado con cabeza fría! 📊`);
}, { timezone: "America/Bogota" });

// 📰 7:30 AM — Resumen de noticias y calendario (lunes a viernes)
cron.schedule("30 7 * * 1-5", async () => {
  const [news, calendar] = await Promise.all([getNewsFromFinnhub(), getEconomicCalendar()]);

  let prompt = "Resume el panorama económico de hoy para traders.\n\n";

  if (calendar.length > 0) {
    prompt += "CALENDARIO ECONÓMICO HOY:\n";
    calendar.forEach(e => {
      prompt += `- ${e.time || "?"} | ${e.event} | País: ${e.country} | Impacto: ${e.impact || "?"}\n`;
    });
    prompt += "\n";
  }

  if (news.length > 0) {
    prompt += "NOTICIAS RECIENTES:\n";
    news.forEach(n => { prompt += `- ${n.headline}\n`; });
  }

  prompt += "\nDestaca los eventos más importantes del día y a qué hora son.";

  const resumen = await analyzeWithClaude(prompt);
  const fecha = new Date().toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" }).toUpperCase();
  await sendToGroup(`📰 *NOTICIAS DEL DÍA — ${fecha}*\n\n${resumen}`);
}, { timezone: "America/Bogota" });

// 🔔 Cada 15 min — Alerta de eventos de alto impacto en 30 min
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
      const prompt = `Explica brevemente qué es este evento económico y por qué es relevante:
Evento: ${event.event}
País: ${event.country}
Hora: ${event.time}
Pronóstico: ${event.estimate || "N/A"}
Anterior: ${event.prev || "N/A"}`;

      const contexto = await analyzeWithClaude(prompt);
      await sendToGroup(`🚨 *ALERTA — EVENTO ALTO IMPACTO EN 30 MIN*\n\n📅 *${event.event}*\n🕐 Hora: ${event.time}\n🌍 País: ${event.country}\n\n${contexto}`);
    }
  }
}, { timezone: "America/Bogota" });

// 📊 12:00 PM — Resumen mediodía
cron.schedule("0 12 * * 1-5", async () => {
  const news = await getNewsFromFinnhub();
  if (news.length === 0) return;
  const headlines = news.map(n => `- ${n.headline}`).join("\n");
  const resumen = await analyzeWithClaude(`Haz un breve resumen de mediodía con las noticias más relevantes para traders:\n${headlines}`);
  await sendToGroup(`📊 *RESUMEN MEDIODÍA*\n\n${resumen}`);
}, { timezone: "America/Bogota" });

// 🌙 6:00 PM — Cierre del mercado
cron.schedule("0 18 * * 1-5", async () => {
  const news = await getNewsFromFinnhub();
  const headlines = news.map(n => `- ${n.headline}`).join("\n");
  const resumen = await analyzeWithClaude(`Haz un resumen del cierre de mercado de hoy:\n${headlines}\n\nTermina con una frase motivadora para mañana.`);
  await sendToGroup(`🌙 *CIERRE DE MERCADO*\n\n${resumen}\n\n_¡Hasta mañana equipo! 💪_`);
}, { timezone: "America/Bogota" });

// ─── RESPONDE MENSAJES DEL GRUPO ─────────────────────────────────────────────

client.on("message", async (msg) => {
  // Solo responde mensajes del grupo configurado
  if (msg.from !== GROUP_ID) return;
  // No responde a sí mismo
  if (msg.fromMe) return;

  const body = msg.body.toLowerCase().trim();

  if (body === "noticias" || body === "news") {
    const news = await getNewsFromFinnhub();
    const headlines = news.map(n => `- ${n.headline}`).join("\n");
    const resumen = await analyzeWithClaude(`Resume estas noticias para traders:\n${headlines}`);
    await msg.reply(resumen);

  } else if (body === "calendario" || body === "eventos") {
    const calendar = await getEconomicCalendar();
    if (calendar.length === 0) {
      await msg.reply("📅 No hay eventos económicos registrados para hoy.");
    } else {
      const lista = calendar.map(e =>
        `• ${e.time || "?"} | *${e.event}* | ${e.country} | Impacto: ${e.impact || "?"}`
      ).join("\n");
      await msg.reply(`📅 *Eventos económicos de hoy:*\n\n${lista}`);
    }

  } else if (body === "motivacion" || body === "motivación") {
    const motivations = [
      "El mercado premia la paciencia. No operes por emoción, opera por análisis. 💪",
      "Los mejores traders no predicen el mercado, se adaptan a él. 🎯",
      "Disciplina hoy, libertad financiera mañana. 🚀",
      "Gestiona el riesgo primero, las ganancias vienen solas. 🎯",
    ];
    const frase = motivations[Math.floor(Math.random() * motivations.length)];
    await msg.reply(`💡 *"${frase}"*`);

  } else if (body === "menu" || body === "menú" || body === "ayuda") {
    await msg.reply(
      `🤖 *Comandos disponibles:*\n\n` +
      `📰 *noticias* — Últimas noticias del mercado\n` +
      `📅 *calendario* — Eventos económicos de hoy\n` +
      `💡 *motivacion* — Frase motivacional\n` +
      `❓ *ayuda* — Ver este menú`
    );
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({ status: "✅ Trading Bot activo", time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));

client.initialize();
