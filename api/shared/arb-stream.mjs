import { buildArbSnapshot } from "../../server/arb-service.mjs";
import { CONFIG_PATH } from "../_lib/config.mjs";
import { acquireLock, getJson, releaseLock, setJson } from "../_lib/store.mjs";

export const config = {
  maxDuration: 300,
};

const SNAPSHOT_KEY = "arb:snapshot";
const LOCK_KEY = "arb:refresh:lock";

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

  const lockToken = await acquireLock(LOCK_KEY, 240);
  if (!lockToken) {
    const snapshot = await getJson(SNAPSHOT_KEY);
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
    const previous = await getJson(SNAPSHOT_KEY);
    const snapshot = await buildArbSnapshot(CONFIG_PATH, {
      previousQuoteMap: previous?.quoteMap ?? null,
      onUpdate: async (partial) => {
        const next = { ...partial, refreshing: true };
        await setJson(SNAPSHOT_KEY, next);
        if (!closed) {
          writeSnapshot(res, next);
        }
      },
    });
    await setJson(SNAPSHOT_KEY, snapshot);
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
    await releaseLock(LOCK_KEY, lockToken);
    if (!closed) {
      res.end();
    }
  }
}
