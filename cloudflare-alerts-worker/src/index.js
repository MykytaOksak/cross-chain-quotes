async function triggerAlertCheck(env, source) {
  const endpoint = String(env.ALERTS_ENDPOINT || "").trim();
  if (!endpoint) {
    throw new Error("ALERTS_ENDPOINT is not configured");
  }

  const headers = new Headers({
    "content-type": "application/json",
    "user-agent": "cross-quotes-alert-cron/1.0",
  });
  const secret = String(env.ALERTS_CRON_SECRET || "").trim();
  if (secret) {
    headers.set("authorization", `Bearer ${secret}`);
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source,
      triggeredAt: new Date().toISOString(),
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Alert check failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  return {
    status: response.status,
    body: text,
  };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      triggerAlertCheck(env, "cloudflare-cron").then((result) => {
        console.log("Alert check completed", result);
      }),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, scheduler: "cloudflare-worker" });
    }
    if (url.pathname === "/run" && (request.method === "POST" || request.method === "GET")) {
      const result = await triggerAlertCheck(env, "cloudflare-manual");
      return Response.json({ ok: true, result });
    }
    return Response.json(
      {
        ok: true,
        routes: ["/health", "/run"],
      },
      { status: 200 },
    );
  },
};
