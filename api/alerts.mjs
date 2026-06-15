import { getUserPriceAlerts, saveUserPriceAlerts } from "./_lib/price-alerts.mjs";
import { readJsonBody, sendJson } from "./_lib/http.mjs";

function getUserId(req, payload = null) {
  const url = new URL(req.url ?? "", `https://${req.headers.host || "localhost"}`);
  return String(payload?.userId ?? url.searchParams.get("userId") ?? "").trim();
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const userId = getUserId(req);
    const record = await getUserPriceAlerts(userId);
    if (!record) {
      sendJson(res, 400, { ok: false, error: "Invalid userId" });
      return;
    }
    sendJson(res, 200, { ok: true, userId, ...record });
    return;
  }

  if (req.method === "PUT" || req.method === "POST") {
    const payload = await readJsonBody(req);
    const userId = getUserId(req, payload);
    try {
      const record = await saveUserPriceAlerts(userId, payload);
      sendJson(res, 200, { ok: true, userId, ...record });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : "Invalid alerts payload" });
    }
    return;
  }

  sendJson(res, 405, { ok: false, error: "Method not allowed" });
}
