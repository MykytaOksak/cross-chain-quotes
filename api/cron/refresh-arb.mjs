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

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const pairIds = getPairIds(req);
  const pairOverrides = getPairOverrides(req);
  const snapshotKey = getScopedKey(SNAPSHOT_KEY, pairIds, pairOverrides);
  const lockKey = getScopedKey(LOCK_KEY, pairIds, pairOverrides);
  const lockToken = await acquireLock(lockKey, 240);
  if (!lockToken) {
    sendJson(res, 202, { ok: true, skipped: true, reason: "refresh already running" });
    return;
  }

  try {
    const previous = await getJson(snapshotKey);
    const snapshot = await buildArbSnapshot(CONFIG_PATH, {
      pairIds,
      pairOverrides,
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
