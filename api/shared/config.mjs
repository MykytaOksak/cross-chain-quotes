import { readAppConfig, sanitizeHostedConfig } from "../_lib/config.mjs";
import { sendJson } from "../_lib/http.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }
  const config = await readAppConfig();
  sendJson(res, 200, sanitizeHostedConfig(config));
}
