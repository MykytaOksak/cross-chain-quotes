import { buildArbSnapshot } from "../../server/arb-service.mjs";
import { CONFIG_PATH } from "../_lib/config.mjs";
import { sendJson } from "../_lib/http.mjs";
import { acquireLock, getJson, releaseLock, setJson } from "../_lib/store.mjs";

export const config = {
  maxDuration: 300,
};

const SNAPSHOT_KEY = "arb:snapshot";
const LOCK_KEY = "arb:refresh:lock";

function getPairIds(req) {
  const url = new URL(req.url ?? "", `https://${req.headers.host || "localhost"}`);
  const raw = url.searchParams.get("pairs") ?? "";
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((id) => id.trim())
        .filter((id) => /^[a-z0-9-]+$/i.test(id))
    )
  ).sort();
}

function getScopedKey(baseKey, pairIds) {
  return pairIds.length > 0 ? `${baseKey}:${pairIds.join(",")}` : baseKey;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const pairIds = getPairIds(req);
  const snapshotKey = getScopedKey(SNAPSHOT_KEY, pairIds);
  const lockKey = getScopedKey(LOCK_KEY, pairIds);
  const lockToken = await acquireLock(lockKey, 240);
  if (!lockToken) {
    sendJson(res, 202, { ok: true, skipped: true, reason: "refresh already running" });
    return;
  }

  try {
    const previous = await getJson(snapshotKey);
    const snapshot = await buildArbSnapshot(CONFIG_PATH, {
      pairIds,
      previousQuoteMap: previous?.quoteMap ?? null,
      onUpdate: async (partial) => {
        await setJson(snapshotKey, { ...partial, refreshing: true });
      },
    });
    await setJson(snapshotKey, snapshot);
    sendJson(res, 200, {
      ok: true,
      updatedAt: snapshot.updatedAt,
      pairs: snapshot.settings?.pairs?.length ?? 0,
    });
  } finally {
    await releaseLock(lockKey, lockToken);
  }
}
