import { sendJson } from "../_lib/http.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    mode: "vercel-hosted",
  });
}
