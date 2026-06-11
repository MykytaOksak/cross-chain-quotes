import { buildInitialArbSnapshot } from "../../server/arb-service.mjs";
import { CONFIG_PATH } from "../_lib/config.mjs";
import { sendJson } from "../_lib/http.mjs";
import { getJson, setJson } from "../_lib/store.mjs";

const SNAPSHOT_KEY = "arb:snapshot";
const HOSTED_REFRESH_MS = 60_000;
const REFRESHING_TTL_MS = 240_000;

export const config = {
  maxDuration: 300,
};

function isSnapshotStale(snapshot) {
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

  let snapshot = await getJson(SNAPSHOT_KEY);
  if (!snapshot) {
    snapshot = await buildInitialArbSnapshot(CONFIG_PATH);
    await setJson(SNAPSHOT_KEY, snapshot);
  }

  const stale = isSnapshotStale(snapshot);

  sendJson(res, 200, {
    ok: true,
    ...snapshot,
    refreshing: isSnapshotRefreshing(snapshot),
    stale,
  });
}
