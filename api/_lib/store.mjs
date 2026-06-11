import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const UPSTASH_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const FALLBACK_PATH = path.join(os.tmpdir(), "cross-chain-arb-hosted-store.json");

function hasRedis() {
  return Boolean(UPSTASH_URL && UPSTASH_TOKEN);
}

async function redisCommand(command) {
  const response = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${UPSTASH_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? `Redis HTTP ${response.status}`);
  }
  return payload.result;
}

async function readFallbackStore() {
  try {
    return JSON.parse(await readFile(FALLBACK_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function writeFallbackStore(store) {
  await mkdir(path.dirname(FALLBACK_PATH), { recursive: true });
  await writeFile(FALLBACK_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export async function getJson(key) {
  if (hasRedis()) {
    const value = await redisCommand(["GET", key]);
    if (!value) return null;
    return typeof value === "string" ? JSON.parse(value) : value;
  }
  const store = await readFallbackStore();
  return store[key] ?? null;
}

export async function setJson(key, value) {
  if (hasRedis()) {
    await redisCommand(["SET", key, JSON.stringify(value)]);
    return;
  }
  const store = await readFallbackStore();
  store[key] = value;
  await writeFallbackStore(store);
}

export async function acquireLock(key, seconds) {
  const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  if (hasRedis()) {
    const result = await redisCommand(["SET", key, token, "NX", "EX", String(seconds)]);
    return result === "OK" ? token : null;
  }
  const store = await readFallbackStore();
  const existing = store[key];
  if (existing?.expiresAt && existing.expiresAt > Date.now()) return null;
  store[key] = { token, expiresAt: Date.now() + seconds * 1000 };
  await writeFallbackStore(store);
  return token;
}

export async function releaseLock(key, token) {
  if (!token) return;
  if (hasRedis()) {
    const current = await redisCommand(["GET", key]);
    if (current === token) {
      await redisCommand(["DEL", key]);
    }
    return;
  }
  const store = await readFallbackStore();
  if (store[key]?.token === token) {
    delete store[key];
    await writeFallbackStore(store);
  }
}
