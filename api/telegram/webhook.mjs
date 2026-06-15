import { connectUserTelegram, getUserPriceAlerts } from "../_lib/price-alerts.mjs";
import { readJsonBody, sendJson } from "../_lib/http.mjs";

function isAuthorized(req) {
  const expected = String(process.env.TELEGRAM_WEBHOOK_SECRET ?? "").trim();
  if (!expected) return true;
  const url = new URL(req.url ?? "", `https://${req.headers.host || "localhost"}`);
  const header = String(req.headers["x-telegram-bot-api-secret-token"] ?? "").trim();
  const query = String(url.searchParams.get("secret") ?? "").trim();
  return header === expected || query === expected;
}

function extractStartUserId(text) {
  const match = String(text ?? "").trim().match(/^\/start(?:@\w+)?\s+([a-z0-9_-]{8,80})$/i);
  return match?.[1] ?? "";
}

async function sendTelegramText(chatId, text) {
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!botToken || !chatId || !text) return;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => undefined);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }
  if (!isAuthorized(req)) {
    sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  const update = await readJsonBody(req);
  const message = update?.message ?? update?.edited_message ?? null;
  const userId = extractStartUserId(message?.text);
  if (!userId || !message?.chat?.id) {
    sendJson(res, 200, { ok: true, ignored: true });
    return;
  }

  try {
    const record = await connectUserTelegram(userId, message.chat);
    await sendTelegramText(
      record.telegram.chatId,
      "Telegram connected. Price alerts from Cross-chain Quotes will be sent here."
    );
    sendJson(res, 200, { ok: true, userId, connected: Boolean((await getUserPriceAlerts(userId))?.telegram?.enabled) });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : "Failed to connect Telegram" });
  }
}
