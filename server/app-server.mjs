import http from "node:http";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildArbSnapshot, buildInitialArbSnapshot, loadArbSnapshot, saveArbSnapshot } from "./arb-service.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const CONFIG_PATH = path.join(ROOT_DIR, "src", "config.json");
const DATA_DIR = path.join(ROOT_DIR, "data");
const SHARED_STATE_PATH = path.join(DATA_DIR, "shared-state.json");
const ARB_SNAPSHOT_PATH = path.join(DATA_DIR, "arb-snapshot.json");
const INDEX_PATH = path.join(DIST_DIR, "index.html");

const PORT = Number(process.env.APP_PORT || process.env.PORT || 4173);
const PENDLE_API_BASE = (process.env.PENDLE_API_BASE || "http://127.0.0.1:8788").replace(/\/+$/, "");
const DEBANK_API_BASE = (process.env.DEBANK_API_BASE || "https://pro-openapi.debank.com").replace(/\/+$/, "");
const DEBANK_ACCESS_KEY = String(process.env.DEBANK_ACCESS_KEY || "").trim();
const DEBANK_PROTOCOL_CACHE_MS = 60_000;

const MIME_BY_EXT = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

let arbSnapshotCache = null;
let arbRefreshPromise = null;
let arbRefreshTimer = null;
let arbSnapshotSaveTimer = null;
const debankProtocolCache = new Map();

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
      if (raw.length > 2_000_000) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

async function loadDefaultSharedState() {
  const raw = await readFile(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

async function loadSharedState() {
  try {
    const raw = await readFile(SHARED_STATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return loadDefaultSharedState();
  }
}

async function saveSharedState(payload) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SHARED_STATE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function getArbRefreshMs(snapshot) {
  const raw = Number(snapshot?.settings?.refreshMs ?? 8000);
  if (!Number.isFinite(raw) || raw <= 0) return 8000;
  return Math.max(1000, raw);
}

function queueArbSnapshotSave(snapshot, delayMs = 250) {
  if (arbSnapshotSaveTimer) {
    clearTimeout(arbSnapshotSaveTimer);
  }
  arbSnapshotSaveTimer = setTimeout(() => {
    arbSnapshotSaveTimer = null;
    mkdir(DATA_DIR, { recursive: true })
      .then(() => saveArbSnapshot(ARB_SNAPSHOT_PATH, snapshot))
      .catch((error) => {
        console.error("Failed to persist Arb snapshot:", error);
      });
  }, delayMs);
}

function scheduleArbRefresh() {
  if (arbRefreshTimer) {
    clearTimeout(arbRefreshTimer);
    arbRefreshTimer = null;
  }
  const delayMs = getArbRefreshMs(arbSnapshotCache);
  arbRefreshTimer = setTimeout(() => {
    refreshArbSnapshot().catch((error) => {
      console.error("Arb snapshot refresh failed:", error);
      scheduleArbRefresh();
    });
  }, delayMs);
}

async function refreshArbSnapshot() {
  if (arbRefreshPromise) return arbRefreshPromise;
  arbRefreshPromise = (async () => {
    const snapshot = await buildArbSnapshot(CONFIG_PATH, {
      previousQuoteMap: arbSnapshotCache?.quoteMap ?? null,
      onUpdate(partialSnapshot) {
        arbSnapshotCache = partialSnapshot;
        queueArbSnapshotSave(partialSnapshot);
      },
    });
    if (arbSnapshotSaveTimer) {
      clearTimeout(arbSnapshotSaveTimer);
      arbSnapshotSaveTimer = null;
    }
    await mkdir(DATA_DIR, { recursive: true });
    await saveArbSnapshot(ARB_SNAPSHOT_PATH, snapshot);
    arbSnapshotCache = snapshot;
    scheduleArbRefresh();
    return snapshot;
  })();
  try {
    return await arbRefreshPromise;
  } finally {
    arbRefreshPromise = null;
  }
}

async function ensureArbSnapshot() {
  if (!arbSnapshotCache) {
    arbSnapshotCache = await loadArbSnapshot(ARB_SNAPSHOT_PATH);
  }
  if (!arbSnapshotCache) {
    arbSnapshotCache = await buildInitialArbSnapshot(CONFIG_PATH);
    refreshArbSnapshot().catch((error) => {
      console.error("Initial Arb snapshot refresh failed:", error);
    });
    return arbSnapshotCache;
  }
  const refreshMs = getArbRefreshMs(arbSnapshotCache);
  const updatedAt = Number(arbSnapshotCache.updatedAt ?? 0);
  const isStale = !Number.isFinite(updatedAt) || updatedAt <= 0 || Date.now() - updatedAt > refreshMs * 2;
  if (isStale) {
    refreshArbSnapshot().catch((error) => {
      console.error("Background Arb snapshot refresh failed:", error);
    });
  } else if (!arbRefreshTimer) {
    scheduleArbRefresh();
  }
  return arbSnapshotCache;
}

async function proxyPendle(req, res, pathname, search) {
  const upstreamUrl = `${PENDLE_API_BASE}${pathname}${search}`;
  const body =
    req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS"
      ? undefined
      : await readBody(req);

  const headers = new Headers();
  Object.entries(req.headers).forEach(([key, value]) => {
    if (!value) return;
    if (key.toLowerCase() === "host") return;
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(key, item));
      return;
    }
    headers.set(key, value);
  });

  const response = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body,
  });

  const responseBody = Buffer.from(await response.arrayBuffer());
  const responseHeaders = {};
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "transfer-encoding") return;
    responseHeaders[key] = value;
  });
  res.writeHead(response.status, responseHeaders);
  res.end(responseBody);
}

function sanitizeDebankProtocol(protocol) {
  if (!protocol || typeof protocol !== "object") return null;
  const id = String(protocol.id ?? "").trim();
  const chain = String(protocol.chain ?? protocol.chain_id ?? "").trim();
  const name = String(protocol.name ?? "").trim();
  if (!chain) return null;
  return { id, chain, name };
}

async function fetchDebankProtocols(wallet) {
  if (!DEBANK_ACCESS_KEY) {
    return { available: false, protocols: [], reason: "DEBANK_ACCESS_KEY is not configured" };
  }
  const normalizedWallet = String(wallet || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalizedWallet)) {
    return { available: false, protocols: [], reason: "Wallet is not an EVM address" };
  }
  const cached = debankProtocolCache.get(normalizedWallet);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const response = await fetch(
    `${DEBANK_API_BASE}/v1/user/all_complex_protocol_list?id=${encodeURIComponent(normalizedWallet)}`,
    {
      headers: {
        AccessKey: DEBANK_ACCESS_KEY,
        accept: "application/json",
      },
    }
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`DeBank HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  const raw = JSON.parse(text);
  const protocols = (Array.isArray(raw) ? raw : [])
    .map(sanitizeDebankProtocol)
    .filter(Boolean);
  const value = { available: true, protocols };
  debankProtocolCache.set(normalizedWallet, {
    value,
    expiresAt: Date.now() + DEBANK_PROTOCOL_CACHE_MS,
  });
  return value;
}

async function serveFile(res, filePath) {
  const fileStat = await stat(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_BY_EXT[ext] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": String(fileStat.size),
  });
  createReadStream(filePath).pipe(res);
}

async function safeResolveStaticPath(urlPathname) {
  const decoded = decodeURIComponent(urlPathname);
  const relative = decoded.replace(/^\/+/, "");
  const filePath = path.resolve(DIST_DIR, relative);
  if (!filePath.startsWith(DIST_DIR)) return null;
  return filePath;
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 404, { ok: false, error: "Not found" });
    return;
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/shared/health") {
      sendJson(res, 200, {
        ok: true,
        appPort: PORT,
        pendleApiBase: PENDLE_API_BASE,
        mode: "hosting-foundation",
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/shared/config") {
      const raw = await readFile(CONFIG_PATH, "utf8");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(raw);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/shared/arb-snapshot") {
      const payload = await ensureArbSnapshot();
      sendJson(res, 200, {
        ok: true,
        ...payload,
        refreshing: Boolean(arbRefreshPromise),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/shared/debank-protocols") {
      const wallet = String(url.searchParams.get("wallet") || "").trim();
      const payload = await fetchDebankProtocols(wallet);
      sendJson(res, 200, { ok: true, ...payload });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/shared/state") {
      const payload = await loadSharedState();
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/shared/state") {
      const rawBody = await readBody(req);
      const payload = rawBody.trim() ? JSON.parse(rawBody) : {};
      await saveSharedState(payload);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/telegram/send-message") {
      const rawBody = await readBody(req);
      const payload = rawBody.trim() ? JSON.parse(rawBody) : {};
      const botToken = String(payload.botToken ?? "").trim();
      const chatId = String(payload.chat_id ?? payload.chatId ?? "").trim();
      const text = String(payload.text ?? "").trim();
      if (!botToken || !chatId || !text) {
        sendJson(res, 400, { ok: false, error: "Missing botToken, chat_id, or text" });
        return;
      }
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      const result = await response.json().catch(async () => ({ description: await response.text() }));
      sendJson(res, response.status, result);
      return;
    }

    if (url.pathname.startsWith("/api/pendle")) {
      await proxyPendle(req, res, url.pathname, url.search);
      return;
    }

    const requestedPath = url.pathname === "/" ? INDEX_PATH : await safeResolveStaticPath(url.pathname);
    if (requestedPath) {
      try {
        await access(requestedPath);
        await serveFile(res, requestedPath);
        return;
      } catch {
        // fall through to SPA index
      }
    }

    await serveFile(res, INDEX_PATH);
  } catch (error) {
    sendText(res, 500, error instanceof Error ? error.message : "Server error");
  }
});

server.listen(PORT, () => {
  console.log(`App server listening on http://localhost:${PORT}`);
});

ensureArbSnapshot().catch((error) => {
  console.error("Initial Arb snapshot refresh failed:", error);
});
