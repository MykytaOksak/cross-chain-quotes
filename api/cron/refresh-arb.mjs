import { buildArbSnapshot } from "../../server/arb-service.mjs";
import { CONFIG_PATH } from "../_lib/config.mjs";
import { sendJson } from "../_lib/http.mjs";
import { acquireLock, getJson, releaseLock, setJson } from "../_lib/store.mjs";

export const config = {
  maxDuration: 300,
};

const SNAPSHOT_KEY = "arb:snapshot";
const LOCK_KEY = "arb:refresh:lock";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const lockToken = await acquireLock(LOCK_KEY, 240);
  if (!lockToken) {
    sendJson(res, 202, { ok: true, skipped: true, reason: "refresh already running" });
    return;
  }

  try {
    const previous = await getJson(SNAPSHOT_KEY);
    const snapshot = await buildArbSnapshot(CONFIG_PATH, {
      previousQuoteMap: previous?.quoteMap ?? null,
    });
    await setJson(SNAPSHOT_KEY, snapshot);
    sendJson(res, 200, {
      ok: true,
      updatedAt: snapshot.updatedAt,
      pairs: snapshot.settings?.pairs?.length ?? 0,
    });
  } finally {
    await releaseLock(LOCK_KEY, lockToken);
  }
}
