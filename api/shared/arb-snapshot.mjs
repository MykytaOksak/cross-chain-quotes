import { buildInitialArbSnapshot } from "../../server/arb-service.mjs";
import { CONFIG_PATH } from "../_lib/config.mjs";
import { sendJson } from "../_lib/http.mjs";
import { getJson } from "../_lib/store.mjs";

const SNAPSHOT_KEY = "arb:snapshot";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const snapshot = (await getJson(SNAPSHOT_KEY)) ?? (await buildInitialArbSnapshot(CONFIG_PATH));
  sendJson(res, 200, {
    ok: true,
    ...snapshot,
    refreshing: false,
  });
}
