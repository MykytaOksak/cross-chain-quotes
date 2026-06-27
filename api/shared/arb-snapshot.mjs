import { buildArbSnapshot, buildInitialArbSnapshot } from "../../server/arb-service.mjs";
import { CONFIG_PATH } from "../_lib/config.mjs";
import { sendJson } from "../_lib/http.mjs";
import { acquireLock, getJson, releaseLock, setJson } from "../_lib/store.mjs";

const SNAPSHOT_KEY = "arb:snapshot";
const LOCK_KEY = "arb:refresh:lock";
const HOSTED_REFRESH_MS = 120_000;
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

function getPairOverrides(req) {
  const url = new URL(req.url ?? "", `https://${req.headers.host || "localhost"}`);
  const raw = url.searchParams.get("overrides") ?? "";
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const overrides = {};
    Object.entries(parsed).forEach(([pairId, value]) => {
      if (!/^[a-z0-9-]+$/i.test(pairId) || !value || typeof value !== "object" || Array.isArray(value)) return;
      const item = {};
      const amount = String(value.amount ?? "").trim();
      if (amount && Number.isFinite(Number(amount)) && Number(amount) > 0) item.amount = amount;
      if (value.networks && typeof value.networks === "object" && !Array.isArray(value.networks)) {
        const networks = {};
        Object.entries(value.networks).forEach(([chain, enabled]) => {
          if (/^[a-z0-9-]+$/i.test(chain)) networks[chain] = Boolean(enabled);
        });
        if (Object.keys(networks).length > 0) item.networks = networks;
      }
      if (Object.keys(item).length > 0) overrides[pairId] = item;
    });
    return overrides;
  } catch {
    return {};
  }
}

function getOverridesKey(pairOverrides) {
  const raw = JSON.stringify(pairOverrides ?? {});
  if (raw === "{}") return "";
  return Buffer.from(raw).toString("base64url");
}

function getSnapshotKey(pairIds, pairOverrides) {
  const pairScope = pairIds.length > 0 ? `:${pairIds.join(",")}` : "";
  const overrideScope = getOverridesKey(pairOverrides);
  return overrideScope ? `${SNAPSHOT_KEY}${pairScope}:o:${overrideScope}` : `${SNAPSHOT_KEY}${pairScope}`;
}

function getLockKey(pairIds, pairOverrides) {
  const pairScope = pairIds.length > 0 ? `:${pairIds.join(",")}` : "";
  const overrideScope = getOverridesKey(pairOverrides);
  return overrideScope ? `${LOCK_KEY}${pairScope}:o:${overrideScope}` : `${LOCK_KEY}${pairScope}`;
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
  const pairOverrides = getPairOverrides(req);
  const snapshotKey = getSnapshotKey(pairIds, pairOverrides);
  let snapshot = await getJson(snapshotKey);
  if (!snapshot) {
    snapshot = await buildInitialArbSnapshot(CONFIG_PATH, { pairIds, pairOverrides });
    await setJson(snapshotKey, snapshot);
  }

  let stale = isSnapshotStale(snapshot);
  if (stale && pairIds.length > 0) {
    const lockKey = getLockKey(pairIds, pairOverrides);
    const lockToken = await acquireLock(lockKey, 240);
    if (lockToken) {
      try {
        snapshot = await buildArbSnapshot(CONFIG_PATH, {
          pairIds,
          pairOverrides,
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
