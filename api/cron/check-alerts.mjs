import { buildArbSnapshot } from "../../server/arb-service.mjs";
import { CONFIG_PATH } from "../_lib/config.mjs";
import { evaluatePriceAlerts, getActiveAlertPairIds, loadPriceAlertsStore } from "../_lib/price-alerts.mjs";
import { sendJson } from "../_lib/http.mjs";
import { acquireLock, releaseLock, setJson } from "../_lib/store.mjs";

export const config = {
  maxDuration: 300,
};

const SNAPSHOT_KEY = "arb:snapshot";
const LOCK_KEY = "price-alerts:check:lock";

function isAuthorized(req) {
  const expected = String(process.env.ALERTS_CRON_SECRET ?? process.env.CRON_SECRET ?? "").trim();
  if (!expected) return true;
  const url = new URL(req.url ?? "", `https://${req.headers.host || "localhost"}`);
  const header = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  const query = String(url.searchParams.get("secret") ?? "").trim();
  return header === expected || query === expected;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }
  if (!isAuthorized(req)) {
    sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  const lockToken = await acquireLock(LOCK_KEY, 240);
  if (!lockToken) {
    sendJson(res, 202, { ok: true, skipped: true, reason: "alert check already running" });
    return;
  }

  try {
    const store = await loadPriceAlertsStore();
    const pairIds = getActiveAlertPairIds(store);
    if (pairIds.length === 0) {
      sendJson(res, 200, { ok: true, checked: 0, sent: 0, errors: [] });
      return;
    }
    const snapshot = await buildArbSnapshot(CONFIG_PATH, { pairIds });
    await setJson(`${SNAPSHOT_KEY}:alerts`, snapshot);
    const result = await evaluatePriceAlerts(snapshot, store);
    sendJson(res, 200, {
      ok: true,
      checked: pairIds.length,
      updatedAt: snapshot.updatedAt,
      sent: result.sent.length,
      errors: result.errors,
    });
  } finally {
    await releaseLock(LOCK_KEY, lockToken);
  }
}
