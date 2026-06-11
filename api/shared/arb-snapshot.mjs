import { buildArbSnapshot, buildInitialArbSnapshot } from "../../server/arb-service.mjs";
import { CONFIG_PATH } from "../_lib/config.mjs";
import { sendJson } from "../_lib/http.mjs";
import { acquireLock, getJson, releaseLock, setJson } from "../_lib/store.mjs";

const SNAPSHOT_KEY = "arb:snapshot";
const LOCK_KEY = "arb:refresh:lock";
const HOSTED_REFRESH_MS = 60_000;

export const config = {
  maxDuration: 300,
};

function isSnapshotStale(snapshot) {
  const updatedAt = Number(snapshot?.updatedAt ?? 0);
  return !Number.isFinite(updatedAt) || updatedAt <= 0 || Date.now() - updatedAt > HOSTED_REFRESH_MS;
}

async function refreshSnapshot(previous) {
  const lockToken = await acquireLock(LOCK_KEY, 240);
  if (!lockToken) return null;
  try {
    const snapshot = await buildArbSnapshot(CONFIG_PATH, {
      previousQuoteMap: previous?.quoteMap ?? null,
    });
    await setJson(SNAPSHOT_KEY, snapshot);
    return snapshot;
  } finally {
    await releaseLock(LOCK_KEY, lockToken);
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  let snapshot = await getJson(SNAPSHOT_KEY);
  let refreshing = false;
  if (!snapshot || isSnapshotStale(snapshot)) {
    const refreshed = await refreshSnapshot(snapshot);
    if (refreshed) {
      snapshot = refreshed;
    } else {
      refreshing = true;
    }
  }
  snapshot ??= await buildInitialArbSnapshot(CONFIG_PATH);
  sendJson(res, 200, {
    ok: true,
    ...snapshot,
    refreshing,
  });
}
