import { readJsonBody, sendJson } from "../_lib/http.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const payload = await readJsonBody(req);
  const botToken = String(payload.botToken ?? "").trim();
  const chatId = String(payload.chat_id ?? payload.chatId ?? "").trim();
  const text = String(payload.text ?? "").trim();

  if (!botToken || !chatId || !text) {
    sendJson(res, 400, { ok: false, error: "Missing botToken, chat_id, or text" });
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });
  const result = await response.json().catch(async () => ({ description: await response.text() }));
  sendJson(res, response.ok ? 200 : response.status, result);
}
