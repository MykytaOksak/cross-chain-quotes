import { getJson, setJson } from "./store.mjs";

const ALERTS_KEY = "price-alerts:v1";
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_ALERTS_PER_USER = 100;
const MAX_TEXT_LEN = 3900;

function isUserId(value) {
  return /^[a-z0-9_-]{8,80}$/i.test(String(value ?? ""));
}

function isPairId(value) {
  return /^[a-z0-9-]{1,80}$/i.test(String(value ?? ""));
}

function isNetworkId(value) {
  return /^[a-z0-9-]{1,80}$/i.test(String(value ?? ""));
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeTelegram(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const chatId = String(raw.chatId ?? raw.chat_id ?? "").trim();
  return {
    chatId,
    username: String(raw.username ?? "").trim(),
    firstName: String(raw.firstName ?? raw.first_name ?? "").trim(),
    connectedAt: Number.isFinite(Number(raw.connectedAt)) ? Number(raw.connectedAt) : 0,
    enabled: Boolean(raw.enabled && chatId),
  };
}

export function sanitizeAlert(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pairId = String(value.pairId ?? "").trim();
  if (!isPairId(pairId)) return null;
  const side = value.side === "sell" ? "sell" : value.side === "buy" ? "buy" : null;
  if (!side) return null;
  const operator = value.operator === "below" ? "below" : value.operator === "above" ? "above" : null;
  if (!operator) return null;
  const price = Number(value.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const networks = Array.isArray(value.networks)
    ? Array.from(new Set(value.networks.map((item) => String(item ?? "").trim()).filter(isNetworkId)))
    : [];
  const cooldownMs = Number(value.cooldownMs);
  return {
    id: isPairId(value.id) ? String(value.id) : makeId(),
    pairId,
    side,
    operator,
    price,
    networks,
    enabled: Boolean(value.enabled),
    cooldownMs: Number.isFinite(cooldownMs) && cooldownMs >= 0 ? Math.min(cooldownMs, 24 * 60 * 60 * 1000) : DEFAULT_COOLDOWN_MS,
    lastTriggeredAt: Number.isFinite(Number(value.lastTriggeredAt)) ? Number(value.lastTriggeredAt) : 0,
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : Date.now(),
  };
}

function sanitizeUserRecord(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const alerts = Array.isArray(raw.alerts)
    ? raw.alerts.map(sanitizeAlert).filter(Boolean).slice(0, MAX_ALERTS_PER_USER)
    : [];
  return {
    telegram: sanitizeTelegram(raw.telegram),
    alerts,
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : Date.now(),
  };
}

function sanitizeStore(value) {
  const rawUsers = value?.users && typeof value.users === "object" && !Array.isArray(value.users) ? value.users : {};
  const users = {};
  Object.entries(rawUsers).forEach(([userId, record]) => {
    if (isUserId(userId)) users[userId] = sanitizeUserRecord(record);
  });
  return { users, updatedAt: Number.isFinite(Number(value?.updatedAt)) ? Number(value.updatedAt) : Date.now() };
}

export async function loadPriceAlertsStore() {
  return sanitizeStore((await getJson(ALERTS_KEY)) ?? {});
}

export async function savePriceAlertsStore(store) {
  await setJson(ALERTS_KEY, sanitizeStore({ ...store, updatedAt: Date.now() }));
}

export async function getUserPriceAlerts(userId) {
  if (!isUserId(userId)) return null;
  const store = await loadPriceAlertsStore();
  return store.users[userId] ?? { telegram: sanitizeTelegram({}), alerts: [], updatedAt: Date.now() };
}

export async function saveUserPriceAlerts(userId, payload) {
  if (!isUserId(userId)) {
    throw new Error("Invalid userId");
  }
  const store = await loadPriceAlertsStore();
  const previous = store.users[userId] ?? sanitizeUserRecord({});
  const next = sanitizeUserRecord({ ...payload, updatedAt: Date.now() });
  const incomingTelegram = sanitizeTelegram(payload?.telegram);
  store.users[userId] = sanitizeUserRecord({
    ...next,
    telegram: incomingTelegram.chatId ? incomingTelegram : previous.telegram,
    updatedAt: Date.now(),
  });
  await savePriceAlertsStore(store);
  return store.users[userId];
}

export async function connectUserTelegram(userId, chat) {
  if (!isUserId(userId)) {
    throw new Error("Invalid userId");
  }
  const chatId = String(chat?.id ?? chat?.chatId ?? chat?.chat_id ?? "").trim();
  if (!chatId) {
    throw new Error("Invalid Telegram chat");
  }
  const store = await loadPriceAlertsStore();
  const previous = store.users[userId] ?? sanitizeUserRecord({});
  store.users[userId] = sanitizeUserRecord({
    ...previous,
    telegram: {
      chatId,
      username: chat?.username ?? "",
      firstName: chat?.first_name ?? chat?.firstName ?? "",
      connectedAt: Date.now(),
      enabled: true,
    },
    updatedAt: Date.now(),
  });
  await savePriceAlertsStore(store);
  return store.users[userId];
}

export function getActiveAlertPairIds(store) {
  const ids = new Set();
  Object.values(store.users ?? {}).forEach((record) => {
    record.alerts?.forEach((alert) => {
      if (alert.enabled) ids.add(alert.pairId);
    });
  });
  return Array.from(ids).sort();
}

function getPairLabel(settings, pairId) {
  const pair = settings?.pairs?.find((item) => item.id === pairId);
  if (!pair) return pairId;
  const base = settings.tokens?.find((token) => token.id === pair.baseTokenId)?.symbol ?? pair.baseTokenId;
  const quote = settings.tokens?.find((token) => token.id === pair.quoteTokenId)?.symbol ?? pair.quoteTokenId;
  return `${base}/${quote}`;
}

function getNetworkName(settings, networkId) {
  return settings?.networks?.find((network) => network.chain === networkId)?.name ?? networkId;
}

function getQuotePrice(quote, side) {
  const raw = side === "buy" ? quote?.buy?.price : quote?.sell?.price;
  const price = Number(raw);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function isTriggered(price, alert) {
  return alert.operator === "above" ? price >= alert.price : price <= alert.price;
}

function formatPrice(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 8 });
}

async function sendTelegram(record, text) {
  const telegram = record.telegram ?? {};
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!telegram.enabled || !telegram.chatId || !botToken) return false;
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: telegram.chatId, text: text.slice(0, MAX_TEXT_LEN) }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Telegram HTTP ${response.status}: ${detail.slice(0, 160)}`);
  }
  return true;
}

export async function evaluatePriceAlerts(snapshot, store) {
  const now = Date.now();
  const nextStore = sanitizeStore(store);
  const sent = [];
  const errors = [];
  const quoteMap = snapshot?.quoteMap ?? {};
  const settings = snapshot?.settings ?? {};

  for (const [userId, record] of Object.entries(nextStore.users)) {
    for (const alert of record.alerts ?? []) {
      if (!alert.enabled) continue;
      if (alert.cooldownMs > 0 && now - Number(alert.lastTriggeredAt ?? 0) < alert.cooldownMs) continue;
      const byNetwork = quoteMap[alert.pairId] ?? {};
      const networkIds = alert.networks.length > 0 ? alert.networks : Object.keys(byNetwork);
      let alertSent = false;
      for (const networkId of networkIds) {
        const quotes = byNetwork[networkId] ?? [];
        for (const quote of quotes) {
          if (quote?.status !== "ok") continue;
          const price = getQuotePrice(quote, alert.side);
          if (price === null || !isTriggered(price, alert)) continue;
          const pairLabel = getPairLabel(settings, alert.pairId);
          const sideLabel = alert.side === "buy" ? "Buy price" : "Sell price";
          const message = [
            "🚨 Price Alert",
            "",
            `💱 ${pairLabel}`,
            `🌐 ${getNetworkName(settings, networkId)}`,
            `${alert.side === "buy" ? "📉" : "📈"} ${sideLabel}: ${formatPrice(price)}`,
            "",
            `🎯 Trigger: ${alert.operator} ${formatPrice(alert.price)}`,
          ].filter(Boolean).join("\n");
          try {
            const didSend = await sendTelegram(record, message);
            if (didSend) {
              alert.lastTriggeredAt = now;
              alert.updatedAt = now;
              sent.push({ userId, alertId: alert.id, pairId: alert.pairId, networkId, side: alert.side, price });
            }
          } catch (error) {
            errors.push({ userId, alertId: alert.id, error: error instanceof Error ? error.message : String(error) });
          }
          alertSent = true;
          break;
        }
        if (alertSent) break;
      }
    }
  }

  await savePriceAlertsStore(nextStore);
  return { sent, errors };
}
