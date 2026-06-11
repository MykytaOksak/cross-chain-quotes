import { buildArbSnapshot } from "../../server/arb-service.mjs";
import { CONFIG_PATH } from "../_lib/config.mjs";
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

function getScopedKey(baseKey, pairIds, pairOverrides) {
  const pairScope = pairIds.length > 0 ? `:${pairIds.join(",")}` : "";
  const overrideScope = getOverridesKey(pairOverrides);
  return overrideScope ? `${baseKey}${pairScope}:o:${overrideScope}` : `${baseKey}${pairScope}`;
}

function writeSnapshot(res, payload) {
  res.write(`${JSON.stringify({ ok: true, ...payload })}\n`);
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  res.statusCode = 200;
  res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("x-accel-buffering", "no");

  const pairIds = getPairIds(req);
  const pairOverrides = getPairOverrides(req);
  const snapshotKey = getScopedKey(SNAPSHOT_KEY, pairIds, pairOverrides);
  const lockKey = getScopedKey(LOCK_KEY, pairIds, pairOverrides);
  const lockToken = await acquireLock(lockKey, 240);
  if (!lockToken) {
    const snapshot = await getJson(snapshotKey);
    writeSnapshot(res, {
      ...(snapshot ?? {}),
      refreshing: true,
      skipped: true,
      reason: "refresh already running",
    });
    res.end();
    return;
  }

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  try {
    const previous = await getJson(snapshotKey);
    const snapshot = await buildArbSnapshot(CONFIG_PATH, {
      pairIds,
      pairOverrides,
      previousQuoteMap: previous?.quoteMap ?? null,
      onUpdate: async (partial) => {
        const next = { ...partial, refreshing: true };
        await setJson(snapshotKey, next);
        if (!closed) {
          writeSnapshot(res, next);
        }
      },
    });
    await setJson(snapshotKey, snapshot);
    if (!closed) {
      writeSnapshot(res, { ...snapshot, refreshing: false, stale: false });
    }
  } catch (error) {
    if (!closed) {
      writeSnapshot(res, {
        error: error instanceof Error ? error.message : "Failed to refresh Arb quotes",
        refreshing: false,
      });
    }
  } finally {
    await releaseLock(lockKey, lockToken);
    if (!closed) {
      res.end();
    }
  }
}
