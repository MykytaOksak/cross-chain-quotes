import { getUserPriceAlerts } from "../_lib/price-alerts.mjs";
import { sendJson } from "../_lib/http.mjs";

const BOT_CACHE_MS = 10 * 60 * 1000;
let cachedBot = null;

function getUserId(req) {
  const url = new URL(req.url ?? "", `https://${req.headers.host || "localhost"}`);
  return String(url.searchParams.get("userId") ?? "").trim();
}

async function getBotInfo() {
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }
  if (cachedBot && Date.now() - cachedBot.loadedAt < BOT_CACHE_MS) return cachedBot;
  const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
  const payload = await response.json().catch(async () => ({ description: await response.text() }));
  if (!response.ok || !payload?.ok || !payload?.result?.username) {
    throw new Error(payload?.description ?? `Telegram getMe HTTP ${response.status}`);
  }
  cachedBot = { username: payload.result.username, loadedAt: Date.now() };
  return cachedBot;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const userId = getUserId(req);
  const record = await getUserPriceAlerts(userId);
  if (!record) {
    sendJson(res, 400, { ok: false, error: "Invalid userId" });
    return;
  }

  try {
    const bot = await getBotInfo();
    sendJson(res, 200, {
      ok: true,
      userId,
      botUsername: bot.username,
      startUrl: `https://t.me/${bot.username}?start=${encodeURIComponent(userId)}`,
      connected: Boolean(record.telegram?.enabled && record.telegram?.chatId),
      telegram: record.telegram,
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Telegram connect is not configured",
    });
  }
}
