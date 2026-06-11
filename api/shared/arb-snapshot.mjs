import { buildArbSnapshot, buildInitialArbSnapshot } from "../../server/arb-service.mjs";
import { CONFIG_PATH } from "../_lib/config.mjs";
import { sendJson } from "../_lib/http.mjs";
import { acquireLock, getJson, releaseLock, setJson } from "../_lib/store.mjs";

const SNAPSHOT_KEY = "arb:snapshot";
const LOCK_KEY = "arb:refresh:lock";
const HOSTED_REFRESH_MS = 60_000;
const REFRESHING_TTL_MS = 240_000;

export const config = {
  maxDuration: 300,
};

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

function getSnapshotKey(pairIds) {
  return pairIds.length > 0 ? `${SNAPSHOT_KEY}:${pairIds.join(",")}` : SNAPSHOT_KEY;
}

function getLockKey(pairIds) {
  return pairIds.length > 0 ? `${LOCK_KEY}:${pairIds.join(",")}` : LOCK_KEY;
}

function hasResolvedQuote(snapshot) {
  const pairs = snapshot?.quoteMap && typeof snapshot.quoteMap === "object" ? Object.values(snapshot.quoteMap) : [];
  return pairs.some((byNetwork) => {
    if (!byNetwork || typeof byNetwork !== "object") return false;
    return Object.values(byNetwork).some((items) =>
      Array.isArray(items) && items.some((item) => item?.status === "ok" || item?.status === "error")
    );
  });
}

function isSnapshotStale(snapshot) {
  if (!hasResolvedQuote(snapshot)) return true;
  const updatedAt = Number(snapshot?.updatedAt ?? 0);
  return !Number.isFinite(updatedAt) || updatedAt <= 0 || Date.now() - updatedAt > HOSTED_REFRESH_MS;
}

function isSnapshotRefreshing(snapshot) {
  if (!snapshot?.refreshing) return false;
  const updatedAt = Number(snapshot?.updatedAt ?? 0);
  return Number.isFinite(updatedAt) && updatedAt > 0 && Date.now() - updatedAt < REFRESHING_TTL_MS;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const pairIds = getPairIds(req);
  const snapshotKey = getSnapshotKey(pairIds);
  let snapshot = await getJson(snapshotKey);
  if (!snapshot) {
    snapshot = await buildInitialArbSnapshot(CONFIG_PATH, { pairIds });
    await setJson(snapshotKey, snapshot);
  }

  let stale = isSnapshotStale(snapshot);
  if (stale && pairIds.length > 0) {
    const lockKey = getLockKey(pairIds);
    const lockToken = await acquireLock(lockKey, 240);
    if (lockToken) {
      try {
        snapshot = await buildArbSnapshot(CONFIG_PATH, {
          pairIds,
          previousQuoteMap: snapshot?.quoteMap ?? null,
          onUpdate: async (partial) => {
            await setJson(snapshotKey, { ...partial, refreshing: true });
          },
        });
        await setJson(snapshotKey, snapshot);
        stale = isSnapshotStale(snapshot);
      } finally {
        await releaseLock(lockKey, lockToken);
      }
    }
  }

  sendJson(res, 200, {
    ok: true,
    ...snapshot,
    refreshing: isSnapshotRefreshing(snapshot),
    stale,
  });
}
