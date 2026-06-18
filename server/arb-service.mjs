import { AbiCoder } from "ethers";
import { readFile, writeFile } from "node:fs/promises";

const BASE_REQUEST_GAP_MS = 0;
const DEFAULT_TARGET_RPS = 2;
const MAX_DYNAMIC_WORKERS = 6;
const MIN_DYNAMIC_WORKERS = 1;
const QUOTE_REQUEST_TIMEOUT_MS = 20_000;
const RATE_LIMIT_COOLDOWN_MS = 5_000;
const NEAR_RATE_LIMIT_RETRY_MS = 3_000;
const NEAR_REQUEST_GAP_MS = 900;
const REUSD_MINT_ABI_TYPE = "tuple(uint256,uint256,uint256,bytes)[][]";
const ROUND_TRIP_TOLERANCE_PCT = 0.0001;
const ETHEREUM_PUBLIC_RPC = "https://ethereum-rpc.publicnode.com";
const PLASMA_LST_SELL_FEE_PCT = 0.07;
const MEGAETH_USDC_USDT_BUY_FEE_PCT = 0.04;
const MEGAETH_USDE_SELL_FEE_PCT = 0.04;
const EISEN_API_BASE_URL = "https://api.hetz-01.eisenfinance.com";
const EISEN_KATANA_CHAIN_ID = 747474;
const ENSO_API_BASE_URL = "https://api.enso.finance/api/v1";
const ENSO_INK_CHAIN_ID = 57073;
const ENSO_REQUEST_GAP_MS = 1_150;
const ENSO_RATE_LIMIT_RETRY_MS = 1_500;
const AVALANCHE_PUBLIC_RPC = "https://api.avax.network/ext/bc/C/rpc";
const FLUENT_PUBLIC_RPC = "https://rpc.fluent.xyz";
const FLUXFLOW_QUOTER_ADDRESS = "0x4cfc01cE8bcEEC0371e4C03223F9d1E46622b4Ec";
const FLUXFLOW_USDNR_SUSDNR_FEE = 500;
const NERONA_SUSDNR_VAULT_ADDRESS = "0x50AE83DBDC44208eDa1Ef722F87Bab0FFB195Eea";
const PLASMA_USDT_PROXY_RATE_CHAIN = "arbitrum";
const PLASMA_USDT_PROXY_RATE_LABEL = "Binance USDC/USDT";
const PLASMA_USDT_PROXY_RATE_MIN = 0.97;
const PLASMA_USDT_PROXY_RATE_MAX = 1.03;
const BINANCE_USDC_USDT_PRICE_URLS = [
  "https://api.binance.com/api/v3/ticker/price?symbol=USDCUSDT",
  "https://data-api.binance.vision/api/v3/ticker/price?symbol=USDCUSDT",
];
const MOVEMENT_SAVUSD_ADDRESS = "0xde6eb2598d91fd43c432ba7f0bca56158525a74ac0841b749ce17bf984cf5642";
const MOVEMENT_USDCX_ADDRESS = "0xba11833544a2f99eec743f41a228ca6ffa7f13c3b6b04681d5a79a8b75ff225e";
const MOVEMENT_USDTE_ADDRESS = "0x447721a30109c662dde9c73a0c2c9c9c459fb5e5a9c92f03c50fa69737f5d08d";
const MOVEMENT_SAVUSD_USDCX_PAIR =
  "0x932df3126dd2220e8e6a169eaf11175c7ce8115412c3b403ca6a40f98472aa15";
const MOVEMENT_USDCX_USDTE_PAIR =
  "0xd2591ee1296e58ebdda370ab56306fcae78d358d36eaee81c3d9dc9d0b907f42";
const MOVEMENT_SAVUSD_DEXSCREENER_PAIR_URL = `https://api.dexscreener.com/latest/dex/pairs/movement/${MOVEMENT_SAVUSD_USDCX_PAIR}`;
const MOVEMENT_USDC_USDT_DEXSCREENER_PAIR_URL = `https://api.dexscreener.com/latest/dex/pairs/movement/${MOVEMENT_USDCX_USDTE_PAIR}`;
const MOVEMENT_DEXSCREENER_FEE_PCT = 0.05;
const AVALANCHE_SAVUSD_REDEEM_FEE_BPS = 5n;
const BPS_DENOMINATOR = 10_000n;
const SELECTOR_PREVIEW_DEPOSIT = "0xef8b30f7";
const SELECTOR_PREVIEW_REDEEM = "0x4cdad506";
const SELECTOR_FLUXFLOW_QUOTE_EXACT_INPUT_SINGLE = "0xc6a5026a";
const SELECTOR_NERONA_PREVIEW_DEPOSIT = "0xb8f82b26";
const SELECTOR_NERONA_PREVIEW_REDEMPTION = "0xb4db4be8";

let dynamicGapMs = BASE_REQUEST_GAP_MS;
let nextRequestAt = 0;
let requestQueue = Promise.resolve();
let observedTargetRps = DEFAULT_TARGET_RPS;
let avgRequestLatencyMs = 700;
let adaptiveWorkerCap = 2;
let last429At = 0;
let lastCapIncreaseAt = 0;
let nextNearRequestAt = 0;
let nextEnsoRequestAt = 0;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "Unknown error");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumericAmount(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function isGreaterAmount(a, b) {
  return toNumericAmount(a) > toNumericAmount(b);
}

function shouldApplyPlasmaLstSellFee(pairId, chain) {
  return chain === "plasma" && (pairId === "wsteth-weth" || pairId === "weeth-weth");
}

function getBuyReceiveFeePct(pairId, chain) {
  if (chain === "megaeth" && pairId === "usdc-usdt") return MEGAETH_USDC_USDT_BUY_FEE_PCT;
  return 0;
}

function getSellReceiveFeePct(pairId, chain) {
  if (shouldApplyPlasmaLstSellFee(pairId, chain)) return PLASMA_LST_SELL_FEE_PCT;
  if (chain === "megaeth" && pairId === "usde-usdc") return MEGAETH_USDE_SELL_FEE_PCT;
  return 0;
}

function applyBuyReceiveFee(pairId, chain, quote, raw, outDecimals) {
  const buyReceiveFeePct = getBuyReceiveFeePct(pairId, chain);
  if (buyReceiveFeePct <= 0) return { quote, raw };
  const outAmountValue = Number(quote.outAmount);
  if (!Number.isFinite(outAmountValue) || outAmountValue <= 0) return { quote, raw };
  const adjustedOutAmount = String(outAmountValue * (1 - buyReceiveFeePct / 100));
  return {
    quote: {
      ...quote,
      outAmount: adjustedOutAmount,
      outAmountAtomic: toAtomicAmount(adjustedOutAmount, outDecimals),
    },
    raw: {
      ...raw,
      preFeeOutAmount: quote.outAmount,
      buyReceiveFeePct,
    },
  };
}

function toAtomicAmount(amount, decimals) {
  const normalized = String(amount ?? "").trim();
  if (!normalized) return "0";
  const [wholeRaw = "", fractionRaw = ""] = normalized.split(".");
  const whole = wholeRaw.replace(/\D/g, "") || "0";
  const fractionDigits = fractionRaw.replace(/\D/g, "");
  const paddedFraction = (fractionDigits + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${paddedFraction}`.replace(/^0+(?=\d)/, "");
  return combined || "0";
}

function fromAtomicAmount(amount, decimals) {
  const sanitized = String(amount ?? "").replace(/\D/g, "");
  if (!sanitized) return "0";
  if (decimals <= 0) return sanitized;
  const pad = sanitized.padStart(decimals + 1, "0");
  const whole = pad.slice(0, -decimals);
  const fraction = pad.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function parseHeaderNumbers(headers, names) {
  const combined = names
    .map((name) => headers.get(name))
    .filter(Boolean)
    .join(",");
  if (!combined) return [];
  return combined
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isFinite(value));
}

function normalizeResetSeconds(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const nowSec = Date.now() / 1000;
  if (raw > nowSec + 1) {
    const delta = raw - nowSec;
    return delta > 0 ? delta : null;
  }
  return raw;
}

function estimateHeaderRpsCap(headers) {
  const limits = parseHeaderNumbers(headers, ["ratelimit-limit", "x-ratelimit-limit"]);
  const remaining = parseHeaderNumbers(headers, ["ratelimit-remaining", "x-ratelimit-remaining"]);
  const resets = parseHeaderNumbers(headers, [
    "ratelimit-reset",
    "x-ratelimit-reset-after",
    "x-ratelimit-reset",
  ])
    .map((value) => normalizeResetSeconds(value))
    .filter((value) => value !== null && value > 0);
  if (resets.length === 0) return null;
  const fallbackReset = resets[0];
  const candidates = [];
  const len = Math.max(limits.length, remaining.length, resets.length);
  for (let index = 0; index < len; index += 1) {
    const reset = resets[index] ?? fallbackReset;
    if (!Number.isFinite(reset) || reset <= 0) continue;
    const limit = limits[index];
    const rem = remaining[index];
    if (Number.isFinite(limit) && limit > 0) {
      candidates.push(limit / reset);
    }
    if (Number.isFinite(rem) && rem > 0) {
      candidates.push(rem / reset);
    }
  }
  if (candidates.length === 0) return null;
  return Math.max(0.05, Math.min(...candidates));
}

function computeAdaptiveGap(headers) {
  const limits = parseHeaderNumbers(headers, ["ratelimit-limit", "x-ratelimit-limit"]);
  const remaining = parseHeaderNumbers(headers, ["ratelimit-remaining", "x-ratelimit-remaining"]);
  const resets = parseHeaderNumbers(headers, [
    "ratelimit-reset",
    "x-ratelimit-reset-after",
    "x-ratelimit-reset",
  ])
    .map((value) => normalizeResetSeconds(value))
    .filter((value) => value !== null);
  if (resets.length === 0) return BASE_REQUEST_GAP_MS;

  const fallbackReset = resets[0];
  const fallbackLimit = limits[0];
  const fallbackRemaining = remaining[0];
  let gapMs = BASE_REQUEST_GAP_MS;
  const len = Math.max(limits.length, remaining.length, resets.length);
  for (let index = 0; index < len; index += 1) {
    const reset = resets[index] ?? fallbackReset;
    const limit = limits[index] ?? fallbackLimit;
    const rem = remaining[index] ?? fallbackRemaining;
    if (!Number.isFinite(reset) || reset <= 0) continue;
    if (Number.isFinite(limit) && limit > 0) {
      gapMs = Math.max(gapMs, (reset / limit) * 1000);
    }
    if (Number.isFinite(rem)) {
      gapMs = Math.max(gapMs, (reset / Math.max(rem, 1)) * 1000);
    }
  }
  return Math.max(BASE_REQUEST_GAP_MS, gapMs);
}

function getAdaptiveWorkerCount(taskCount) {
  if (taskCount <= 0) return 1;
  const latencySec = Math.max(0.2, avgRequestLatencyMs / 1000);
  const desiredByRate = Math.ceil(observedTargetRps * latencySec);
  const bounded = Math.min(
    taskCount,
    MAX_DYNAMIC_WORKERS,
    Math.max(MIN_DYNAMIC_WORKERS, adaptiveWorkerCap),
    Math.max(MIN_DYNAMIC_WORKERS, desiredByRate)
  );
  return Math.max(MIN_DYNAMIC_WORKERS, bounded);
}

async function fetchWithRateLimit(url, init) {
  const schedule = async () => {
    const now = Date.now();
    const waitMs = Math.max(0, nextRequestAt - now);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    nextRequestAt = Date.now() + dynamicGapMs;
  };

  const scheduled = requestQueue.then(schedule, schedule);
  requestQueue = scheduled.then(
    () => undefined,
    () => undefined
  );

  await scheduled;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error("Quote request timed out")), QUOTE_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timed out after ${QUOTE_REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
  const latencyMs = Date.now() - startedAt;
  avgRequestLatencyMs = avgRequestLatencyMs * 0.8 + latencyMs * 0.2;
  const text = await response.text();
  dynamicGapMs = computeAdaptiveGap(response.headers);
  const headerRpsCap = estimateHeaderRpsCap(response.headers);
  observedTargetRps =
    typeof headerRpsCap === "number" && Number.isFinite(headerRpsCap)
      ? headerRpsCap
      : dynamicGapMs > 0
      ? Math.max(0.05, 1000 / dynamicGapMs)
      : DEFAULT_TARGET_RPS;
  const now = Date.now();
  if (response.status === 429) {
    last429At = now;
    adaptiveWorkerCap = Math.max(1, Math.floor(adaptiveWorkerCap / 2));
  } else if (
    now - last429At > 30_000 &&
    now - lastCapIncreaseAt > 10_000 &&
    adaptiveWorkerCap < MAX_DYNAMIC_WORKERS
  ) {
    adaptiveWorkerCap += 1;
    lastCapIncreaseAt = now;
  }
  const nextSlot = Date.now() + dynamicGapMs;
  if (nextSlot > nextRequestAt) {
    nextRequestAt = nextSlot;
  }
  return { response, text };
}

async function scheduleNearSlot() {
  const waitMs = Math.max(0, nextNearRequestAt - Date.now());
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  nextNearRequestAt = Date.now() + NEAR_REQUEST_GAP_MS;
}

async function scheduleEnsoSlot() {
  const waitMs = Math.max(0, nextEnsoRequestAt - Date.now());
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  nextEnsoRequestAt = Date.now() + ENSO_REQUEST_GAP_MS;
}

function collectMarketQuotes(payload, requireName) {
  const stack = [payload];
  const results = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (typeof current === "object") {
      const record = current;
      const outAmount = record.outAmount;
      const name = record.market || record.name || record.dex || record.source;
      if ((typeof outAmount === "string" || typeof outAmount === "number") && (!requireName || name)) {
        results.push({ name: name ?? "unknown", outAmount: String(outAmount) });
      }
      Object.values(record).forEach((value) => stack.push(value));
    }
  }
  return results;
}

function readDirectOutAmount(payload) {
  const data = typeof payload === "object" && payload && "data" in payload ? payload.data : payload;
  const outAmount = data?.outAmount ?? data?.amountOut ?? data?.result?.outAmount ?? data?.result?.amountOut;
  if (typeof outAmount !== "string" && typeof outAmount !== "number") return null;
  const name = data?.market || data?.name || data?.dex || data?.source || data?.result?.market || data?.result?.name;
  return { name: name ?? "direct", outAmount: String(outAmount) };
}

function findBestOutAmount(payload) {
  const direct = readDirectOutAmount(payload);
  if (direct) return direct;

  const data = typeof payload === "object" && payload && "data" in payload ? payload.data : payload;
  const namedCandidates = collectMarketQuotes(data, true);
  const candidates = namedCandidates.length > 0 ? namedCandidates : collectMarketQuotes(data, false);
  if (candidates.length === 0) {
    const outAmount = data?.outAmount;
    if (typeof outAmount === "string" || typeof outAmount === "number") {
      return { name: "direct", outAmount: String(outAmount) };
    }
    throw new Error("outAmount not found in response");
  }
  return candidates.reduce((best, current) =>
    isGreaterAmount(current.outAmount, best.outAmount) ? current : best
  );
}

function getMarketNameFromEndpoint(endpoint) {
  const match = String(endpoint ?? "").match(/\/market\/([^/]+)\/swap_quote/i);
  return match?.[1] ?? "";
}

function normalizePlasmaUsdtProxyRate(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < PLASMA_USDT_PROXY_RATE_MIN || value > PLASMA_USDT_PROXY_RATE_MAX) return null;
  return value;
}

async function fetchBinanceUsdcUsdtProxyRateFromUrl(url) {
  const { response, text } = await fetchWithRateLimit(url, { method: "GET" });
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid Binance ${response.status} response`);
  }
  if (!response.ok) {
    throw new Error(payload?.msg || `Binance HTTP ${response.status}`);
  }
  const usdtPerUsdc = Number(payload?.price);
  const usdcPerUsdt = usdtPerUsdc > 0 ? 1 / usdtPerUsdc : null;
  const normalized = normalizePlasmaUsdtProxyRate(usdcPerUsdt);
  if (!normalized) {
    const detail = Number.isFinite(usdtPerUsdc) ? ` (USDCUSDT ${usdtPerUsdc.toFixed(6)})` : "";
    throw new Error(`Unrealistic ${PLASMA_USDT_PROXY_RATE_LABEL} rate${detail}`);
  }
  return normalized;
}

async function fetchBinanceUsdcUsdtProxyRate() {
  const errors = [];
  for (const url of BINANCE_USDC_USDT_PRICE_URLS) {
    try {
      return await fetchBinanceUsdcUsdtProxyRateFromUrl(url);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error ?? "Unknown error"));
    }
  }
  throw new Error(errors.join("; ") || `Missing ${PLASMA_USDT_PROXY_RATE_LABEL} rate`);
}

function isUnrealisticStableSellQuote(pair, fromAmount, receiveAmount) {
  if (!isProxyRatePair(pair)) return false;
  const from = Number(fromAmount);
  const receive = Number(receiveAmount);
  if (!Number.isFinite(from) || !Number.isFinite(receive) || from <= 0 || receive <= 0) return true;
  return !normalizePlasmaUsdtProxyRate(receive / from);
}

function buildStableSellFallbackFromBuy(pair, buyFromAmount, buyReceiveAmount, sellFromAmount) {
  if (!isProxyRatePair(pair)) return null;
  const buyFrom = Number(buyFromAmount);
  const buyReceive = Number(buyReceiveAmount);
  const sellFrom = Number(sellFromAmount);
  if (!Number.isFinite(buyFrom) || !Number.isFinite(buyReceive) || !Number.isFinite(sellFrom)) return null;
  if (buyFrom <= 0 || buyReceive <= 0 || sellFrom <= 0) return null;
  const impliedSellPrice = buyFrom / buyReceive;
  if (!normalizePlasmaUsdtProxyRate(impliedSellPrice)) return null;
  return String(sellFrom * impliedSellPrice);
}

async function fetchNearQuote(tokenIn, tokenOut, amount, srcDecimals, dstDecimals) {
  const amountIn = toAtomicAmount(amount, srcDecimals);
  const url = new URL("https://smartx.rhea.finance/swapMultiDexPath");
  url.searchParams.set("amountIn", amountIn);
  url.searchParams.set("tokenIn", tokenIn);
  url.searchParams.set("tokenOut", tokenOut);
  url.searchParams.set("slippage", "0.0001");
  url.searchParams.set("pathDeep", "3");
  url.searchParams.set("chainId", "0");
  url.searchParams.set("routerCount", "1");
  url.searchParams.set("skipUnwrapNativeToken", "false");
  url.searchParams.set("user", "sdraste.near");
  url.searchParams.set("receiveUser", "sdraste.near");
  let response;
  let text = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await scheduleNearSlot();
    ({ response, text } = await fetchWithRateLimit(url.toString(), {
      method: "GET",
      headers: { accept: "*/*" },
    }));
    if (response.status !== 429 || attempt === 3) break;
    await sleep(NEAR_RATE_LIMIT_RETRY_MS * (attempt + 1));
  }
  if (!response.ok) {
    throw new HttpError(response.status, `HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  const payload = JSON.parse(text);
  const resultCode = payload.result_code ?? payload.resultCode ?? payload.code;
  if (typeof resultCode === "number" && resultCode !== 0) {
    throw new Error(payload.result_message || payload.resultMessage || "NEAR quote request failed");
  }
  const result = payload.result_data ?? payload.resultData ?? payload.data;
  const outRaw = result?.amount_out ?? result?.amountOut ?? result?.output_amount;
  if (typeof outRaw !== "string" && typeof outRaw !== "number") {
    throw new Error("amount_out not found in response");
  }
  return { name: "rhea", outAmount: fromAtomicAmount(String(outRaw), dstDecimals) };
}

function toSolanaSlippageBps(slippageValue) {
  if (!Number.isFinite(slippageValue) || slippageValue <= 0) return 100;
  return Math.max(1, Math.round(slippageValue * 100));
}

async function fetchSolanaQuote(tokenIn, tokenOut, amount, srcDecimals, dstDecimals, slippageBps) {
  const amountIn = toAtomicAmount(amount, srcDecimals);
  const ultraParams = new URLSearchParams({
    inputMint: tokenIn,
    outputMint: tokenOut,
    amount: amountIn,
    swapMode: "ExactIn",
    slippageBps: String(slippageBps),
    broadcastFeeType: "maxCap",
    priorityFeeLamports: "1000000",
    useWsol: "true",
    excludeDexes: "",
  });
  const ultraUrl = `https://ultra-api.jup.ag/order?${ultraParams.toString()}`;
  const { response: ultraResponse, text: ultraText } = await fetchWithRateLimit(ultraUrl, {
    method: "GET",
  });
  if (ultraResponse.ok) {
    const ultraPayload = JSON.parse(ultraText);
    const outRaw =
      ultraPayload.outAmount ??
      ultraPayload.result?.outAmount ??
      ultraPayload.data?.outAmount;
    if (typeof outRaw === "string" || typeof outRaw === "number") {
      const outAtomic = String(outRaw);
      return {
        name: "jupiter",
        outAmount: fromAtomicAmount(outAtomic, dstDecimals),
        outAmountAtomic: outAtomic,
      };
    }
  }

  const quoteParams = new URLSearchParams({
    inputMint: tokenIn,
    outputMint: tokenOut,
    amount: amountIn,
    swapMode: "ExactIn",
    slippageBps: String(slippageBps),
  });
  const quoteUrl = `https://lite-api.jup.ag/swap/v1/quote?${quoteParams.toString()}`;
  const { response, text } = await fetchWithRateLimit(quoteUrl, { method: "GET" });
  if (!response.ok) {
    throw new HttpError(
      response.status,
      `HTTP ${response.status}: ${text.slice(0, 140)}; ultra fallback: ${ultraText.slice(0, 140)}`
    );
  }
  const payload = JSON.parse(text);
  const errorText = payload.error ?? payload.message;
  if (errorText) throw new Error(errorText);
  const outRaw = payload.outAmount ?? payload.result?.outAmount ?? payload.data?.outAmount;
  if (typeof outRaw !== "string" && typeof outRaw !== "number") {
    throw new Error("outAmount not found in response");
  }
  const outAtomic = String(outRaw);
  return {
    name: "jupiter",
    outAmount: fromAtomicAmount(outAtomic, dstDecimals),
    outAmountAtomic: outAtomic,
  };
}

async function fetchKyberQuote(chain, tokenIn, tokenOut, amountInAtomic, outDecimals) {
  const url = new URL(`https://aggregator-api.kyberswap.com/${chain}/api/v1/routes`);
  url.searchParams.set("tokenIn", tokenIn);
  url.searchParams.set("tokenOut", tokenOut);
  url.searchParams.set("amountIn", amountInAtomic);
  const { response, text } = await fetchWithRateLimit(url.toString(), {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-client-id": "cross-chain-arb-server",
    },
  });
  if (!response.ok) {
    throw new HttpError(response.status, `HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  const payload = JSON.parse(text);
  const data = payload.data;
  const routeSummary = data?.routeSummary;
  const outRaw = routeSummary?.amountOut ?? data?.routes?.[0]?.routeSummary?.amountOut;
  if (typeof outRaw !== "string" && typeof outRaw !== "number") {
    throw new Error("amountOut not found in Kyber response");
  }
  const outAtomic = String(outRaw);
  return {
    name: "kyberswap",
    outAmount: fromAtomicAmount(outAtomic, outDecimals),
    outAmountAtomic: outAtomic,
  };
}

async function fetchEisenQuote(tokenIn, tokenOut, amountInAtomic, outDecimals, account) {
  const { response, text } = await fetchWithRateLimit(
    `${EISEN_API_BASE_URL}/v1/chains/${EISEN_KATANA_CHAIN_ID}/v2/quote`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tokenInAddr: tokenIn,
        tokenOutAddr: tokenOut,
        from: account,
        amount: amountInAtomic,
        maxEdge: "3",
        maxSplit: "5",
        withCycle: false,
        dexIdFilter: [],
        customTokens: [],
      }),
    }
  );
  if (!response.ok) {
    throw new HttpError(response.status, `HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  const payload = JSON.parse(text);
  if (payload.result?.isSwapPathExists === false) {
    throw new Error("No Eisen route found");
  }
  const outRaw =
    payload.result?.dexAgg?.expectedAmountOut ??
    payload.result?.singleDexes?.find((quote) => quote?.expectedAmountOut)?.expectedAmountOut;
  if (typeof outRaw !== "string" && typeof outRaw !== "number") {
    throw new Error("expectedAmountOut not found in Eisen response");
  }
  const outAtomic = String(outRaw);
  return {
    name: payload.result?.dexAgg?.splitInfos?.[0]?.swapInfo?.dexId ?? "eisen",
    outAmount: fromAtomicAmount(outAtomic, outDecimals),
    outAmountAtomic: outAtomic,
  };
}

async function fetchEisenSplitQuote(tokenIn, tokenOut, amountInAtomic, outDecimals, account) {
  const total = BigInt(String(amountInAtomic));
  const splitSizes = [2, 3, 4, 8, 16];
  const errors = [];
  for (const parts of splitSizes) {
    const partCount = BigInt(parts);
    const baseChunk = total / partCount;
    const remainder = total % partCount;
    if (baseChunk <= 0n) continue;
    let outTotal = 0n;
    const names = new Set();
    try {
      for (let index = 0; index < parts; index += 1) {
        const chunk = baseChunk + (BigInt(index) < remainder ? 1n : 0n);
        const quote = await fetchEisenQuote(tokenIn, tokenOut, chunk.toString(), outDecimals, account);
        outTotal += BigInt(quote.outAmountAtomic ?? toAtomicAmount(quote.outAmount, outDecimals));
        if (quote.name) names.add(quote.name);
      }
      const nameList = [...names];
      return {
        name: `${nameList.length > 0 ? nameList.join("+") : "eisen"} split`,
        outAmount: fromAtomicAmount(outTotal.toString(), outDecimals),
        outAmountAtomic: outTotal.toString(),
      };
    } catch (error) {
      errors.push(`${parts} parts: ${getErrorMessage(error)}`);
    }
  }
  throw new Error(`Split Eisen quote failed (${errors.join(" | ")})`);
}

async function fetchEnsoQuote(tokenIn, tokenOut, amountInAtomic, outDecimals, account, slippage) {
  const body = JSON.stringify({
    chainId: ENSO_INK_CHAIN_ID,
    fromAddress: account,
    receiver: account,
    amountIn: [amountInAtomic],
    tokenIn: [tokenIn],
    tokenOut: [tokenOut],
    slippage: String(toSolanaSlippageBps(Number(slippage))),
    routingStrategy: "router",
  });
  let response;
  let text = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await scheduleEnsoSlot();
    ({ response, text } = await fetchWithRateLimit(`${ENSO_API_BASE_URL}/shortcuts/route`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body,
    }));
    if (response.status !== 429 || attempt === 3) break;
    await sleep(ENSO_RATE_LIMIT_RETRY_MS * (attempt + 1));
  }
  if (!response.ok) {
    throw new HttpError(response.status, `HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  const payload = JSON.parse(text);
  const outRaw = payload.amountOut;
  if (typeof outRaw !== "string" && typeof outRaw !== "number") {
    throw new Error("amountOut not found in Enso response");
  }
  const outAtomic = String(outRaw);
  return {
    name: payload.route?.[0]?.protocol ?? "enso",
    outAmount: fromAtomicAmount(outAtomic, outDecimals),
    outAmountAtomic: outAtomic,
  };
}

async function fetchCanoeQuote(endpoint, chain, account, tokenIn, tokenOut, amountInHuman, slippage) {
  const { response, text } = await fetchWithRateLimit(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chain,
      account,
      inTokenAddress: tokenIn,
      outTokenAddress: tokenOut,
      isExactIn: true,
      slippage,
      inTokenAmount: amountInHuman,
    }),
  });
  if (!response.ok) {
    throw new HttpError(response.status, `HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  const quote = findBestOutAmount(JSON.parse(text));
  const endpointMarket = getMarketNameFromEndpoint(endpoint);
  if (endpointMarket && (!quote.name || quote.name === "direct" || quote.name === "unknown")) {
    return { ...quote, name: endpointMarket };
  }
  return quote;
}

async function fetchOpenOceanQuote(chain, tokenIn, tokenOut, amountInHuman, outDecimals, account, slippage) {
  const url = new URL(`https://open-api.openocean.finance/v4/${chain}/quote`);
  url.searchParams.set("inTokenAddress", tokenIn);
  url.searchParams.set("outTokenAddress", tokenOut);
  url.searchParams.set("amount", amountInHuman);
  url.searchParams.set("slippage", String(slippage ?? 1));
  url.searchParams.set("gasPrice", chain === "mantle" ? "0.02" : "1");
  if (account) url.searchParams.set("account", account);
  const { response, text } = await fetchWithRateLimit(url.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new HttpError(response.status, `HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  const payload = JSON.parse(text);
  if (payload.code && Number(payload.code) !== 200) {
    throw new Error(payload.error || payload.message || `OpenOcean code ${payload.code}`);
  }
  const outRaw = payload.data?.outAmount;
  if (typeof outRaw !== "string" && typeof outRaw !== "number") {
    throw new Error("outAmount not found in OpenOcean response");
  }
  const outAtomic = String(outRaw);
  return {
    name: payload.data?.exchange ?? "openocean",
    outAmount: fromAtomicAmount(outAtomic, outDecimals),
    outAmountAtomic: outAtomic,
  };
}

async function fetchCanoeQuoteWithKyberFallback({
  endpoint,
  chain,
  account,
  tokenIn,
  tokenOut,
  amountInHuman,
  inDecimals,
  outDecimals,
  slippage,
}) {
  try {
    return await fetchCanoeQuote(endpoint, chain, account, tokenIn, tokenOut, amountInHuman, slippage);
  } catch (canoeError) {
    const market = getMarketNameFromEndpoint(endpoint);
    if (market === "openocean") {
      try {
        return await fetchOpenOceanQuote(chain, tokenIn, tokenOut, amountInHuman, outDecimals, account, slippage);
      } catch (openOceanError) {
        try {
          const amountInAtomic = toAtomicAmount(amountInHuman, inDecimals);
          return await fetchKyberQuote(chain, tokenIn, tokenOut, amountInAtomic, outDecimals);
        } catch (kyberError) {
          const canoeMessage = getErrorMessage(canoeError);
          const openOceanMessage = getErrorMessage(openOceanError);
          const kyberMessage = getErrorMessage(kyberError);
          throw new Error(`${canoeMessage}; openocean fallback: ${openOceanMessage}; kyberswap fallback: ${kyberMessage}`);
        }
      }
    }
    try {
      const amountInAtomic = toAtomicAmount(amountInHuman, inDecimals);
      return await fetchKyberQuote(chain, tokenIn, tokenOut, amountInAtomic, outDecimals);
    } catch (kyberError) {
      const canoeMessage = getErrorMessage(canoeError);
      const kyberMessage = getErrorMessage(kyberError);
      throw new Error(`${canoeMessage}; kyberswap fallback: ${kyberMessage}`);
    }
  }
}

function normalizeTokenAddress(address) {
  return String(address ?? "").trim().toLowerCase();
}

function movementPairSupports(tokenIn, tokenOut, baseAddress, quoteAddress) {
  const inAddress = normalizeTokenAddress(tokenIn);
  const outAddress = normalizeTokenAddress(tokenOut);
  return (
    (inAddress === baseAddress && outAddress === quoteAddress) ||
    (inAddress === quoteAddress && outAddress === baseAddress)
  );
}

async function fetchMovementDexScreenerQuote({
  tokenIn,
  tokenOut,
  amountInHuman,
  baseAddress,
  quoteAddress,
  pairUrl,
  routeLabel,
}) {
  if (!movementPairSupports(tokenIn, tokenOut, baseAddress, quoteAddress)) {
    throw new Error(`Unsupported Movement ${routeLabel} route`);
  }
  const amountIn = Number(amountInHuman);
  if (!Number.isFinite(amountIn) || amountIn <= 0) {
    throw new Error("Invalid Movement quote amount");
  }

  const response = await fetch(pairUrl, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new HttpError(response.status, `DexScreener HTTP ${response.status}`);
  }
  const payload = await response.json();
  const pair = payload?.pair ?? payload?.pairs?.[0];
  if (!pair) {
    throw new Error(`Movement ${routeLabel} pool not found`);
  }

  const price = Number(pair.priceNative);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Movement ${routeLabel} pool price unavailable`);
  }

  const feeMultiplier = 1 - MOVEMENT_DEXSCREENER_FEE_PCT / 100;
  const tokenInIsQuote = normalizeTokenAddress(tokenIn) === quoteAddress;
  const outAmount = tokenInIsQuote ? (amountIn / price) * feeMultiplier : amountIn * price * feeMultiplier;
  if (!Number.isFinite(outAmount) || outAmount <= 0) {
    throw new Error(`Movement ${routeLabel} quote unavailable`);
  }

  const inputLiquidity = tokenInIsQuote ? Number(pair.liquidity?.quote) : Number(pair.liquidity?.base);
  const liquidityUsd = Number(pair.liquidity?.usd);
  const dexName = pair.dexId ? `${pair.dexId} (dexscreener)` : "dexscreener";
  return {
    name: dexName,
    outAmount: String(outAmount),
    raw: {
      source: "dexscreener",
      dex: pair.dexId,
      pairAddress: pair.pairAddress,
      priceNative: pair.priceNative,
      liquidityUsd: Number.isFinite(liquidityUsd) ? liquidityUsd : undefined,
      inputLiquidity: Number.isFinite(inputLiquidity) ? inputLiquidity : undefined,
      estimatedFeePct: MOVEMENT_DEXSCREENER_FEE_PCT,
    },
  };
}

async function fetchMovementSavUsdQuote(tokenIn, tokenOut, amountInHuman) {
  return fetchMovementDexScreenerQuote({
    tokenIn,
    tokenOut,
    amountInHuman,
    baseAddress: MOVEMENT_SAVUSD_ADDRESS,
    quoteAddress: MOVEMENT_USDCX_ADDRESS,
    pairUrl: MOVEMENT_SAVUSD_DEXSCREENER_PAIR_URL,
    routeLabel: "savUSD",
  });
}

async function fetchMovementUsdcUsdtQuote(tokenIn, tokenOut, amountInHuman) {
  return fetchMovementDexScreenerQuote({
    tokenIn,
    tokenOut,
    amountInHuman,
    baseAddress: MOVEMENT_USDCX_ADDRESS,
    quoteAddress: MOVEMENT_USDTE_ADDRESS,
    pairUrl: MOVEMENT_USDC_USDT_DEXSCREENER_PAIR_URL,
    routeLabel: "USDC/USDT",
  });
}

async function fetchKatanaQuote(settings, tokenIn, tokenOut, amountHuman, inDecimals, outDecimals) {
  const amountAtomic = toAtomicAmount(amountHuman, inDecimals);
  const errors = [];
  try {
    return {
      quote: await fetchEisenQuote(tokenIn, tokenOut, amountAtomic, outDecimals, settings.quoteApi?.account),
      amountIn: amountAtomic,
    };
  } catch (error) {
    errors.push(`eisen: ${getErrorMessage(error)}`);
  }

  try {
    return {
      quote: await fetchEisenSplitQuote(tokenIn, tokenOut, amountAtomic, outDecimals, settings.quoteApi?.account),
      amountIn: amountAtomic,
    };
  } catch (error) {
    errors.push(`eisen split: ${getErrorMessage(error)}`);
  }

  const endpoint = settings.quoteApi?.endpointsByNetwork?.katana ?? settings.quoteApi?.endpoint;
  if (endpoint) {
    try {
      return {
        quote: await fetchCanoeQuote(
          endpoint,
          "katana",
          settings.quoteApi?.account,
          tokenIn,
          tokenOut,
          amountHuman,
          settings.quoteApi?.slippage
        ),
        amountIn: amountHuman,
      };
    } catch (error) {
      errors.push(`canoe: ${getErrorMessage(error)}`);
    }
  }

  try {
    return {
      quote: await fetchKyberQuote("katana", tokenIn, tokenOut, amountAtomic, outDecimals),
      amountIn: amountAtomic,
    };
  } catch (error) {
    errors.push(`kyberswap: ${getErrorMessage(error)}`);
  }

  throw new Error(`Katana quote failed (${errors.join(" | ")})`);
}

async function fetchInkQuote(settings, tokenIn, tokenOut, amountHuman, inDecimals, outDecimals) {
  const amountAtomic = toAtomicAmount(amountHuman, inDecimals);
  const errors = [];
  try {
    return {
      quote: await fetchEnsoQuote(
        tokenIn,
        tokenOut,
        amountAtomic,
        outDecimals,
        settings.quoteApi?.account,
        settings.quoteApi?.slippage
      ),
      amountIn: amountAtomic,
    };
  } catch (error) {
    errors.push(`enso: ${getErrorMessage(error)}`);
  }

  const endpoint = settings.quoteApi?.endpointsByNetwork?.ink;
  if (endpoint) {
    try {
      return {
        quote: await fetchCanoeQuote(
          endpoint,
          "ink",
          settings.quoteApi?.account,
          tokenIn,
          tokenOut,
          amountHuman,
          settings.quoteApi?.slippage
        ),
        amountIn: amountHuman,
      };
    } catch (error) {
      errors.push(`canoe: ${getErrorMessage(error)}`);
    }
  }

  try {
    return {
      quote: await fetchKyberQuote("ink", tokenIn, tokenOut, amountAtomic, outDecimals),
      amountIn: amountAtomic,
    };
  } catch (error) {
    errors.push(`kyberswap: ${getErrorMessage(error)}`);
  }

  throw new Error(`Ink quote failed (${errors.join(" | ")})`);
}

function stripHexPrefix(value) {
  return String(value ?? "").startsWith("0x") ? String(value).slice(2) : String(value ?? "");
}

function toHexPadded(value, bytes = 32) {
  return value.toString(16).padStart(bytes * 2, "0");
}

function encodeAddressArg(address) {
  return stripHexPrefix(address).toLowerCase().padStart(64, "0");
}

function encodeUintArg(value) {
  return toHexPadded(value, 32);
}

function parseWord(data, index) {
  const clean = stripHexPrefix(data);
  const start = index * 64;
  return clean.slice(start, start + 64).padEnd(64, "0");
}

function wordToBigInt(word) {
  return BigInt(`0x${word || "0"}`);
}

function isSusdnrUsdnrPair(pair) {
  return pair.baseTokenId === "susdnr" && pair.quoteTokenId === "usdnr";
}

function getNativeRouteLabel(pair, network) {
  if (network.chain === "fluent" && isSusdnrUsdnrPair(pair)) return "Stake/Unstake";
  return "Mint/Redeem";
}

async function rpcCall(rpcUrl, method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  const payload = JSON.parse(text);
  if (payload.error) {
    throw new Error(payload.error.message || "RPC error");
  }
  if (typeof payload.result === "undefined") {
    throw new Error("RPC result is empty");
  }
  return payload.result;
}

async function fetchFluxFlowQuote(tokenIn, tokenOut, amount, inDecimals, outDecimals) {
  const amountAtomic = BigInt(toAtomicAmount(amount, inDecimals));
  if (amountAtomic <= 0n) {
    throw new Error("Invalid amount for FluxFlow quote");
  }
  const encodedParams = AbiCoder.defaultAbiCoder().encode(
    ["tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)"],
    [[tokenIn, tokenOut, amountAtomic, FLUXFLOW_USDNR_SUSDNR_FEE, 0n]]
  );
  const data = `${SELECTOR_FLUXFLOW_QUOTE_EXACT_INPUT_SINGLE}${stripHexPrefix(encodedParams)}`;
  const raw = await rpcCall(FLUENT_PUBLIC_RPC, "eth_call", [{ to: FLUXFLOW_QUOTER_ADDRESS, data }, "latest"]);
  const outAmountAtomic = wordToBigInt(parseWord(raw, 0));
  if (outAmountAtomic <= 0n) {
    throw new Error("Invalid FluxFlow quote output amount");
  }
  return {
    name: "FluxFlow",
    outAmount: fromAtomicAmount(outAmountAtomic.toString(), outDecimals),
    outAmountAtomic: outAmountAtomic.toString(),
    raw: {
      source: "fluxflow",
      amountIn: amountAtomic.toString(),
      outAmountRaw: outAmountAtomic.toString(),
      fee: FLUXFLOW_USDNR_SUSDNR_FEE,
      quoter: FLUXFLOW_QUOTER_ADDRESS,
    },
  };
}

function parseReusdMintAmount(raw) {
  try {
    const decoded = AbiCoder.defaultAbiCoder().decode([REUSD_MINT_ABI_TYPE], raw);
    const outer = decoded[0];
    if (!Array.isArray(outer) || outer.length === 0) return null;
    const firstGroup = outer[0];
    if (!Array.isArray(firstGroup) || firstGroup.length === 0) return null;
    const firstTuple = firstGroup[0];
    if (!Array.isArray(firstTuple) || firstTuple.length === 0) return null;
    const amount = firstTuple[0];
    if (typeof amount === "bigint" && amount > 0n) return amount;
    const asBigInt = BigInt(String(amount ?? "0"));
    return asBigInt > 0n ? asBigInt : null;
  } catch {
    return null;
  }
}

async function fetchReusdMintAmount(settings, quoteAmountHuman, quoteDecimals) {
  const config = settings.quoteApi?.reusdMint ?? {};
  const rpcUrl = config.rpcUrl?.trim() || ETHEREUM_PUBLIC_RPC;
  const callTo = config.callTo?.trim();
  const callData = config.callData?.trim();
  const sampleResponse = config.sampleResponse?.trim();
  const sampleInputAmount = Number(config.sampleInputAmount ?? quoteAmountHuman);
  const convertFromSharesContract =
    config.convertFromSharesContract?.trim() || "0x4691C475bE804Fa85f91c2D6D0aDf03114de3093";
  const convertFromSharesToken =
    config.convertFromSharesToken?.trim() || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const sharesDecimals = Number.isFinite(Number(config.sharesDecimals))
    ? Math.max(0, Number(config.sharesDecimals))
    : 18;
  const evmAddressRe = /^0x[a-fA-F0-9]{40}$/;

  if (rpcUrl && evmAddressRe.test(convertFromSharesContract) && evmAddressRe.test(convertFromSharesToken)) {
    try {
      const sharesAtomic = BigInt(toAtomicAmount(quoteAmountHuman, sharesDecimals));
      const quoteAmountAtomic = BigInt(toAtomicAmount(quoteAmountHuman, quoteDecimals));
      const convertFromSharesData =
        `0x2b38e266${encodeAddressArg(convertFromSharesToken)}${encodeUintArg(sharesAtomic)}`;
      const raw = await rpcCall(rpcUrl, "eth_call", [{ to: convertFromSharesContract, data: convertFromSharesData }, "latest"]);
      const usdcForSharesAtomic = wordToBigInt(parseWord(raw, 0));
      if (usdcForSharesAtomic > 0n && quoteAmountAtomic > 0n && sharesAtomic > 0n) {
        const mintAmountAtomic = (quoteAmountAtomic * sharesAtomic) / usdcForSharesAtomic;
        if (mintAmountAtomic > 0n) {
          return { mintAmountAtomic: mintAmountAtomic.toString(), source: "reusd-convertFromShares" };
        }
      }
    } catch {
      // Fall through.
    }
  }

  if (rpcUrl && callTo && callData) {
    try {
      const raw = await rpcCall(rpcUrl, "eth_call", [{ to: callTo, data: callData }, "latest"]);
      const parsed = parseReusdMintAmount(raw);
      if (parsed && parsed > 0n) {
        return { mintAmountAtomic: parsed.toString(), source: "reusd-mint-rpc" };
      }
    } catch {
      // Fall through.
    }
  }

  if (!sampleResponse) {
    throw new Error("reUSD mint response sample is not configured");
  }
  const sampleAtomic = parseReusdMintAmount(sampleResponse);
  if (!sampleAtomic || sampleAtomic <= 0n) {
    throw new Error("Failed to decode reUSD mint response sample");
  }
  const amountIn = Number(quoteAmountHuman);
  if (!Number.isFinite(amountIn) || amountIn <= 0) {
    throw new Error("Invalid amount for reUSD mint quote");
  }
  const referenceIn = Number.isFinite(sampleInputAmount) && sampleInputAmount > 0 ? sampleInputAmount : amountIn;
  const amountInAtomic = toAtomicAmount(quoteAmountHuman, quoteDecimals);
  const referenceInAtomic = toAtomicAmount(String(referenceIn), quoteDecimals);
  const referenceAtomic = BigInt(referenceInAtomic);
  if (referenceAtomic <= 0n) {
    throw new Error("Invalid reUSD mint reference amount");
  }
  const scaledAtomic = (BigInt(amountInAtomic) * sampleAtomic) / referenceAtomic;
  return { mintAmountAtomic: scaledAtomic.toString(), source: "reusd-mint-sample" };
}

async function fetchReusdMintRedeemQuote(settings, network, pair, baseVariant, quoteVariant, baseSymbol, quoteSymbol, amount) {
  if (network.chain !== "ethereum") {
    throw new Error("reUSD mint/redeem route is only supported on Ethereum");
  }
  const mint = await fetchReusdMintAmount(settings, amount, quoteVariant.decimals);
  const mintReceiveAmount = fromAtomicAmount(mint.mintAmountAtomic, baseVariant.decimals);
  const mintReceiveValue = Number(mintReceiveAmount);
  if (!Number.isFinite(mintReceiveValue) || mintReceiveValue <= 0) {
    throw new Error("Invalid reUSD mint output amount");
  }

  const redeemFeePctRaw = Number(settings.quoteApi?.reusdMint?.redeemFeePct ?? 0.16);
  const redeemFeePct = Number.isFinite(redeemFeePctRaw) ? Math.max(0, redeemFeePctRaw) : 0.16;
  const redeemMultiplier = Math.max(0, 1 - redeemFeePct / 100);

  const buyFrom = Number(amount);
  const buyReceive = mintReceiveValue;
  const sellFrom = mintReceiveValue;
  const buyPrice = buyReceive > 0 ? buyFrom / buyReceive : Number.NaN;
  const targetSellPrice = Number.isFinite(buyPrice) && buyPrice > 0 ? buyPrice * redeemMultiplier : Number.NaN;
  const redeemReceiveValue = Number.isFinite(targetSellPrice) && targetSellPrice > 0
    ? sellFrom * targetSellPrice
    : mintReceiveValue * redeemMultiplier;
  const redeemReceiveAmount = String(redeemReceiveValue);
  const sellPrice = Number.isFinite(targetSellPrice) && targetSellPrice > 0
    ? targetSellPrice
    : sellFrom > 0
    ? redeemReceiveValue / sellFrom
    : Number.NaN;
  const roundTripPct = Number.isFinite(buyFrom) && buyFrom > 0
    ? ((redeemReceiveValue - buyFrom) / buyFrom) * 100
    : Number.NEGATIVE_INFINITY;

  return {
    id: `${pair.id}-${network.chain}-${baseVariant.id}-${quoteVariant.id}-mint-redeem`,
    networkId: network.chain,
    status: "ok",
    routeLabel: "Mint/Redeem",
    baseVariant,
    quoteVariant,
    buy: {
      fromAmount: amount,
      receiveAmount: mintReceiveAmount,
      price: Number.isFinite(buyPrice) ? buyPrice.toFixed(6) : "—",
      fromSymbol: quoteSymbol,
      receiveSymbol: baseSymbol,
      fromVariantLabel: quoteVariant.label,
      receiveVariantLabel: baseVariant.label,
      market: "reUSD mint",
      raw: {
        source: mint.source,
        mintAmountAtomic: mint.mintAmountAtomic,
      },
    },
    sell: {
      fromAmount: mintReceiveAmount,
      receiveAmount: redeemReceiveAmount,
      price: Number.isFinite(sellPrice) ? sellPrice.toFixed(6) : "—",
      fromSymbol: baseSymbol,
      receiveSymbol: quoteSymbol,
      fromVariantLabel: baseVariant.label,
      receiveVariantLabel: quoteVariant.label,
      market: "reUSD redeem",
      raw: { redeemFeePct },
    },
    roundTripPct,
    excludeFromArb: false,
    updatedAt: Date.now(),
  };
}

async function fetchSavusdNativeMintRedeemQuote(settings, network, pair, baseVariant, quoteVariant, baseSymbol, quoteSymbol, amount) {
  if (network.chain !== "avalanche") {
    throw new Error("savUSD native mint/redeem route is only supported on Avalanche");
  }
  if (pair.baseTokenId !== "savusd" || pair.quoteTokenId !== "usdc") {
    throw new Error("savUSD native mint/redeem route requires savUSD/USDC");
  }

  const rpcUrl = settings.quoteApi?.savusdNative?.rpcUrl?.trim() || AVALANCHE_PUBLIC_RPC;
  const quoteAmountAtomic = BigInt(toAtomicAmount(amount, quoteVariant.decimals));
  if (quoteAmountAtomic <= 0n) {
    throw new Error("Invalid amount for savUSD native mint quote");
  }

  const avUsdAmountAtomic = BigInt(toAtomicAmount(amount, 18));
  const previewDepositData = `${SELECTOR_PREVIEW_DEPOSIT}${encodeUintArg(avUsdAmountAtomic)}`;
  const savUsdAtomic = wordToBigInt(
    parseWord(await rpcCall(rpcUrl, "eth_call", [{ to: baseVariant.address, data: previewDepositData }, "latest"]), 0)
  );
  if (savUsdAtomic <= 0n) {
    throw new Error("Invalid savUSD stake output amount");
  }

  const previewRedeemData = `${SELECTOR_PREVIEW_REDEEM}${encodeUintArg(savUsdAtomic)}`;
  const redeemedAvUsdAtomic = wordToBigInt(
    parseWord(await rpcCall(rpcUrl, "eth_call", [{ to: baseVariant.address, data: previewRedeemData }, "latest"]), 0)
  );
  if (redeemedAvUsdAtomic <= 0n) {
    throw new Error("Invalid savUSD redeem output amount");
  }

  const redeemedAfterFeeAtomic =
    (redeemedAvUsdAtomic * (BPS_DENOMINATOR - AVALANCHE_SAVUSD_REDEEM_FEE_BPS)) / BPS_DENOMINATOR;
  const mintReceiveAmount = fromAtomicAmount(savUsdAtomic.toString(), baseVariant.decimals);
  const redeemReceiveAmount = fromAtomicAmount(redeemedAfterFeeAtomic.toString(), 18);
  const buyFrom = Number(amount);
  const buyReceive = Number(mintReceiveAmount);
  const sellFrom = buyReceive;
  const sellReceive = Number(redeemReceiveAmount);
  const buyPrice = buyReceive > 0 ? buyFrom / buyReceive : Number.NaN;
  const sellPrice = sellFrom > 0 ? sellReceive / sellFrom : Number.NaN;
  const roundTripPct =
    Number.isFinite(buyFrom) && buyFrom > 0 && Number.isFinite(sellReceive)
      ? ((sellReceive - buyFrom) / buyFrom) * 100
      : Number.NEGATIVE_INFINITY;

  return {
    id: `${pair.id}-${network.chain}-${baseVariant.id}-${quoteVariant.id}-mint-redeem`,
    networkId: network.chain,
    status: "ok",
    routeLabel: "Mint/Redeem",
    baseVariant,
    quoteVariant,
    buy: {
      fromAmount: amount,
      receiveAmount: mintReceiveAmount,
      price: Number.isFinite(buyPrice) ? buyPrice.toFixed(6) : "—",
      fromSymbol: quoteSymbol,
      receiveSymbol: baseSymbol,
      fromVariantLabel: quoteVariant.label,
      receiveVariantLabel: baseVariant.label,
      market: "Avant mint/stake",
      raw: {
        source: "avant-native",
        mintedAvUsdAtomic: avUsdAmountAtomic.toString(),
        stakedSavUsdAtomic: savUsdAtomic.toString(),
      },
    },
    sell: {
      fromAmount: mintReceiveAmount,
      receiveAmount: redeemReceiveAmount,
      price: Number.isFinite(sellPrice) ? sellPrice.toFixed(6) : "—",
      fromSymbol: baseSymbol,
      receiveSymbol: quoteSymbol,
      fromVariantLabel: baseVariant.label,
      receiveVariantLabel: quoteVariant.label,
      market: "Avant unstake/redeem",
      raw: {
        source: "avant-native",
        grossRedeemedAvUsdAtomic: redeemedAvUsdAtomic.toString(),
        redeemedAvUsdAtomic: redeemedAfterFeeAtomic.toString(),
        redeemFeePct: Number(AVALANCHE_SAVUSD_REDEEM_FEE_BPS) / 100,
        cooldownDays: 7,
      },
    },
    roundTripPct,
    excludeFromArb: false,
    updatedAt: Date.now(),
  };
}

async function fetchNeronaStakeUnstakeQuote(settings, network, pair, baseVariant, quoteVariant, baseSymbol, quoteSymbol, amount) {
  if (network.chain !== "fluent") {
    throw new Error("Nerona stake/unstake route is only supported on Fluent");
  }
  if (!isSusdnrUsdnrPair(pair)) {
    throw new Error("Nerona stake/unstake route requires sUSDnr/USDnr");
  }

  const rpcUrl = settings.quoteApi?.nerona?.rpcUrl?.trim() || FLUENT_PUBLIC_RPC;
  const quoteAmountAtomic = BigInt(toAtomicAmount(amount, quoteVariant.decimals));
  if (quoteAmountAtomic <= 0n) {
    throw new Error("Invalid amount for Nerona stake quote");
  }

  const previewDepositData =
    `${SELECTOR_NERONA_PREVIEW_DEPOSIT}${encodeAddressArg(quoteVariant.address)}${encodeUintArg(quoteAmountAtomic)}`;
  const depositRaw = await rpcCall(
    rpcUrl,
    "eth_call",
    [{ to: NERONA_SUSDNR_VAULT_ADDRESS, data: previewDepositData }, "latest"]
  );
  const stakedSUsdNrAtomic = wordToBigInt(parseWord(depositRaw, 0));
  if (stakedSUsdNrAtomic <= 0n) {
    throw new Error("Invalid Nerona stake output amount");
  }

  const previewRedemptionData =
    `${SELECTOR_NERONA_PREVIEW_REDEMPTION}${encodeUintArg(stakedSUsdNrAtomic)}${encodeUintArg(0n)}`;
  const redemptionRaw = await rpcCall(
    rpcUrl,
    "eth_call",
    [{ to: NERONA_SUSDNR_VAULT_ADDRESS, data: previewRedemptionData }, "latest"]
  );
  const grossUnstakeUsdNrAtomic = wordToBigInt(parseWord(redemptionRaw, 0));
  const unstakeUsdNrAtomic = wordToBigInt(parseWord(redemptionRaw, 1));
  if (unstakeUsdNrAtomic <= 0n) {
    throw new Error("Invalid Nerona unstake output amount");
  }

  const stakeReceiveAmount = fromAtomicAmount(stakedSUsdNrAtomic.toString(), baseVariant.decimals);
  const unstakeReceiveAmount = fromAtomicAmount(unstakeUsdNrAtomic.toString(), quoteVariant.decimals);
  const buyFrom = Number(amount);
  const buyReceive = Number(stakeReceiveAmount);
  const sellReceive = Number(unstakeReceiveAmount);
  const buyPrice = buyReceive > 0 ? buyFrom / buyReceive : Number.NaN;
  const sellPrice = buyReceive > 0 ? sellReceive / buyReceive : Number.NaN;
  const roundTripPct =
    Number.isFinite(buyFrom) && buyFrom > 0 && Number.isFinite(sellReceive)
      ? ((sellReceive - buyFrom) / buyFrom) * 100
      : Number.NEGATIVE_INFINITY;

  return {
    id: `${pair.id}-${network.chain}-${baseVariant.id}-${quoteVariant.id}-mint-redeem`,
    networkId: network.chain,
    status: "ok",
    routeLabel: "Stake/Unstake",
    baseVariant,
    quoteVariant,
    buy: {
      fromAmount: amount,
      receiveAmount: stakeReceiveAmount,
      price: Number.isFinite(buyPrice) ? buyPrice.toFixed(6) : "—",
      fromSymbol: quoteSymbol,
      receiveSymbol: baseSymbol,
      fromVariantLabel: quoteVariant.label,
      receiveVariantLabel: baseVariant.label,
      market: "Nerona stake",
      raw: {
        source: "nerona",
        vault: NERONA_SUSDNR_VAULT_ADDRESS,
        stakedSUsdNrAtomic: stakedSUsdNrAtomic.toString(),
      },
    },
    sell: {
      fromAmount: stakeReceiveAmount,
      receiveAmount: unstakeReceiveAmount,
      price: Number.isFinite(sellPrice) ? sellPrice.toFixed(6) : "—",
      fromSymbol: baseSymbol,
      receiveSymbol: quoteSymbol,
      fromVariantLabel: baseVariant.label,
      receiveVariantLabel: quoteVariant.label,
      market: "Nerona unstake",
      raw: {
        source: "nerona",
        vault: NERONA_SUSDNR_VAULT_ADDRESS,
        grossUnstakeUsdNrAtomic: grossUnstakeUsdNrAtomic.toString(),
        unstakeUsdNrAtomic: unstakeUsdNrAtomic.toString(),
        instant: false,
      },
    },
    roundTripPct,
    excludeFromArb: false,
    updatedAt: Date.now(),
  };
}

async function fetchMintRedeemQuote(settings, network, pair, baseVariant, quoteVariant, baseSymbol, quoteSymbol, amount) {
  if (pair.baseTokenId === "reusd" && pair.quoteTokenId === "usdc") {
    return fetchReusdMintRedeemQuote(settings, network, pair, baseVariant, quoteVariant, baseSymbol, quoteSymbol, amount);
  }
  if (pair.baseTokenId === "savusd" && pair.quoteTokenId === "usdc") {
    return fetchSavusdNativeMintRedeemQuote(
      settings,
      network,
      pair,
      baseVariant,
      quoteVariant,
      baseSymbol,
      quoteSymbol,
      amount
    );
  }
  if (isSusdnrUsdnrPair(pair)) {
    return fetchNeronaStakeUnstakeQuote(
      settings,
      network,
      pair,
      baseVariant,
      quoteVariant,
      baseSymbol,
      quoteSymbol,
      amount
    );
  }
  throw new Error("Mint/redeem route is not supported for this pair");
}

async function fetchQuoteForVariant(settings, network, pair, baseVariant, quoteVariant, baseSymbol, quoteSymbol, amount, usdcUsdtRate) {
  const needsUsdcProxy =
    network.chain === "plasma" &&
    (baseVariant.proxyTokenId === "usdt" || quoteVariant.proxyTokenId === "usdt");
  const proxyRate = normalizePlasmaUsdtProxyRate(usdcUsdtRate);
  if (needsUsdcProxy && (!proxyRate || !Number.isFinite(proxyRate) || proxyRate <= 0)) {
    const receivedRate = Number(usdcUsdtRate);
    const detail = Number.isFinite(receivedRate) ? ` (got ${receivedRate.toFixed(6)})` : "";
    throw new Error(
      `Missing or unrealistic ${PLASMA_USDT_PROXY_RATE_LABEL} rate${detail}; refusing Plasma proxy quote`
    );
  }
  const toUsdt = (value) => (proxyRate ? value / proxyRate : value);
  const toUsdc = (value) => (proxyRate ? value * proxyRate : value);
  const amountValue = Number(amount);
  const buyRequestAmountHuman =
    needsUsdcProxy && quoteVariant.proxyTokenId === "usdt" && Number.isFinite(amountValue)
      ? String(toUsdt(amountValue))
      : amount;

  const loadAttempt = async () => {
    let buyBest;
    let sellBest;
    let buyRaw = {};
    let sellRaw = {};
    let sellFallbackExcludeFromArb = false;
    const solanaSlippageBps = toSolanaSlippageBps(Number(settings.quoteApi?.slippage));

    if (network.chain === "solana") {
      buyBest = await fetchSolanaQuote(
        quoteVariant.address,
        baseVariant.address,
        amount,
        quoteVariant.decimals,
        baseVariant.decimals,
        solanaSlippageBps
      );
      sellBest = await fetchSolanaQuote(
        baseVariant.address,
        quoteVariant.address,
        buyBest.outAmount,
        baseVariant.decimals,
        quoteVariant.decimals,
        solanaSlippageBps
      );
      buyRaw = { source: "jupiter", outAmount: buyBest.outAmount, outAmountRaw: buyBest.outAmountAtomic };
      sellRaw = { source: "jupiter", outAmount: sellBest.outAmount, outAmountRaw: sellBest.outAmountAtomic };
    } else if (network.chain === "near") {
      buyBest = await fetchNearQuote(
        quoteVariant.address,
        baseVariant.address,
        amount,
        quoteVariant.decimals,
        baseVariant.decimals
      );
      sellBest = await fetchNearQuote(
        baseVariant.address,
        quoteVariant.address,
        String(buyBest.outAmount),
        baseVariant.decimals,
        quoteVariant.decimals
      );
      buyRaw = { source: "near", outAmount: buyBest.outAmount };
      sellRaw = { source: "near", outAmount: sellBest.outAmount };
    } else if (network.chain === "movement" && pair.id === "usdc-usdt") {
      buyBest = await fetchMovementUsdcUsdtQuote(
        quoteVariant.address,
        baseVariant.address,
        buyRequestAmountHuman
      );
      sellBest = await fetchMovementUsdcUsdtQuote(
        baseVariant.address,
        quoteVariant.address,
        String(buyBest.outAmount)
      );
      buyRaw = { source: buyBest.name, amountIn: buyRequestAmountHuman, outAmount: buyBest.outAmount, ...buyBest.raw };
      sellRaw = { source: sellBest.name, amountIn: buyBest.outAmount, outAmount: sellBest.outAmount, ...sellBest.raw };
    } else if (network.chain === "movement" && pair.id === "savusd-usdc") {
      buyBest = await fetchMovementSavUsdQuote(
        quoteVariant.address,
        baseVariant.address,
        buyRequestAmountHuman
      );
      sellBest = await fetchMovementSavUsdQuote(
        baseVariant.address,
        quoteVariant.address,
        String(buyBest.outAmount)
      );
      buyRaw = { source: buyBest.name, amountIn: buyRequestAmountHuman, outAmount: buyBest.outAmount, ...buyBest.raw };
      sellRaw = { source: sellBest.name, amountIn: buyBest.outAmount, outAmount: sellBest.outAmount, ...sellBest.raw };
    } else if (network.chain === "fluent" && pair.id === "susdnr-usdnr") {
      buyBest = await fetchFluxFlowQuote(
        quoteVariant.address,
        baseVariant.address,
        buyRequestAmountHuman,
        quoteVariant.decimals,
        baseVariant.decimals
      );
      sellBest = await fetchFluxFlowQuote(
        baseVariant.address,
        quoteVariant.address,
        String(buyBest.outAmount),
        baseVariant.decimals,
        quoteVariant.decimals
      );
      buyRaw = { source: buyBest.name, amountIn: buyRequestAmountHuman, outAmount: buyBest.outAmount, ...buyBest.raw };
      sellRaw = { source: sellBest.name, amountIn: buyBest.outAmount, outAmount: sellBest.outAmount, ...sellBest.raw };
    } else if (network.chain === "katana") {
      const buyQuote = await fetchKatanaQuote(
        settings,
        quoteVariant.address,
        baseVariant.address,
        buyRequestAmountHuman,
        quoteVariant.decimals,
        baseVariant.decimals
      );
      buyBest = buyQuote.quote;
      buyRaw = { source: buyBest.name, amountIn: buyQuote.amountIn, outAmount: buyBest.outAmount };
      const sellAmountHuman = String(buyBest.outAmount);
      const sellQuote = await fetchKatanaQuote(
        settings,
        baseVariant.address,
        quoteVariant.address,
        sellAmountHuman,
        baseVariant.decimals,
        quoteVariant.decimals
      );
      sellBest = sellQuote.quote;
      sellRaw = { source: sellBest.name, amountIn: sellQuote.amountIn, outAmount: sellBest.outAmount };
    } else if (network.chain === "ink") {
      const buyQuote = await fetchInkQuote(
        settings,
        quoteVariant.address,
        baseVariant.address,
        buyRequestAmountHuman,
        quoteVariant.decimals,
        baseVariant.decimals
      );
      buyBest = buyQuote.quote;
      buyRaw = { source: buyBest.name, amountIn: buyQuote.amountIn, outAmount: buyBest.outAmount };
      const sellAmountHuman = String(buyBest.outAmount);
      const sellQuote = await fetchInkQuote(
        settings,
        baseVariant.address,
        quoteVariant.address,
        sellAmountHuman,
        baseVariant.decimals,
        quoteVariant.decimals
      );
      sellBest = sellQuote.quote;
      sellRaw = { source: sellBest.name, amountIn: sellQuote.amountIn, outAmount: sellBest.outAmount };
    } else {
      const endpointOverride = settings.quoteApi?.endpointsByNetwork?.[network.chain];
      const useCanoe = network.chain === "plasma" || Boolean(endpointOverride);
      if (useCanoe) {
        const endpoint = endpointOverride ?? settings.quoteApi?.endpoint;
        buyBest = await fetchCanoeQuoteWithKyberFallback({
          endpoint,
          chain: network.chain,
          account: settings.quoteApi?.account,
          tokenIn: quoteVariant.address,
          tokenOut: baseVariant.address,
          amountInHuman: buyRequestAmountHuman,
          inDecimals: quoteVariant.decimals,
          outDecimals: baseVariant.decimals,
          slippage: settings.quoteApi?.slippage,
        });
        buyRaw = { source: buyBest.name, amountIn: buyRequestAmountHuman, outAmount: buyBest.outAmount };
        const sellAmountHuman = String(buyBest.outAmount);
        sellBest = await fetchCanoeQuoteWithKyberFallback({
          endpoint,
          chain: network.chain,
          account: settings.quoteApi?.account,
          tokenIn: baseVariant.address,
          tokenOut: quoteVariant.address,
          amountInHuman: sellAmountHuman,
          inDecimals: baseVariant.decimals,
          outDecimals: quoteVariant.decimals,
          slippage: settings.quoteApi?.slippage,
        });
        sellRaw = { source: sellBest.name, amountIn: sellAmountHuman, outAmount: sellBest.outAmount };
      } else {
        const buyAmountAtomic = toAtomicAmount(buyRequestAmountHuman, quoteVariant.decimals);
        buyBest = await fetchKyberQuote(
          network.chain,
          quoteVariant.address,
          baseVariant.address,
          buyAmountAtomic,
          baseVariant.decimals
        );
        buyRaw = { source: "kyberswap", amountIn: buyAmountAtomic, outAmount: buyBest.outAmount };
        ({ quote: buyBest, raw: buyRaw } = applyBuyReceiveFee(
          pair.id,
          network.chain,
          buyBest,
          buyRaw,
          baseVariant.decimals
        ));
        const sellAmountAtomic = buyBest.outAmountAtomic ?? toAtomicAmount(buyBest.outAmount, baseVariant.decimals);
        sellBest = await fetchKyberQuote(
          network.chain,
          baseVariant.address,
          quoteVariant.address,
          sellAmountAtomic,
          quoteVariant.decimals
        );
        sellRaw = { source: "kyberswap", amountIn: sellAmountAtomic, outAmount: sellBest.outAmount };
      }
    }

    let buyReceiveAmount = String(buyBest.outAmount);
    let sellReceiveAmount = String(sellBest.outAmount);
    if (needsUsdcProxy && baseVariant.proxyTokenId === "usdt") {
      const converted = toUsdc(Number(buyReceiveAmount));
      buyReceiveAmount = Number.isFinite(converted) ? String(converted) : buyReceiveAmount;
    }
    if (needsUsdcProxy && quoteVariant.proxyTokenId === "usdt") {
      const converted = toUsdc(Number(sellReceiveAmount));
      sellReceiveAmount = Number.isFinite(converted) ? String(converted) : sellReceiveAmount;
    }
    const sellReceiveFeePct = getSellReceiveFeePct(pair.id, network.chain);
    if (sellReceiveFeePct > 0) {
      const sellReceiveValue = Number(sellReceiveAmount);
      if (Number.isFinite(sellReceiveValue) && sellReceiveValue > 0) {
        sellRaw = {
          ...sellRaw,
          preFeeOutAmount: sellReceiveAmount,
          sellReceiveFeePct,
        };
        sellReceiveAmount = String(sellReceiveValue * (1 - sellReceiveFeePct / 100));
      }
    }
    if (isUnrealisticStableSellQuote(pair, buyReceiveAmount, sellReceiveAmount)) {
      const rejectedSellBest = sellBest;
      const rejectedSellRaw = sellRaw;
      let fallbackSellBest = null;
      if (network.chain !== "plasma" && settings.quoteApi?.endpoint) {
        try {
          fallbackSellBest = await fetchCanoeQuote(
            settings.quoteApi.endpoint,
            network.chain,
            settings.quoteApi?.account,
            baseVariant.address,
            quoteVariant.address,
            String(buyBest.outAmount),
            settings.quoteApi?.slippage
          );
        } catch {
          fallbackSellBest = null;
        }
      }

      if (
        fallbackSellBest &&
        !isUnrealisticStableSellQuote(pair, buyReceiveAmount, fallbackSellBest.outAmount)
      ) {
        sellBest = fallbackSellBest;
        sellReceiveAmount = String(fallbackSellBest.outAmount);
        sellRaw = {
          source: fallbackSellBest.name,
          amountIn: String(buyBest.outAmount),
          outAmount: fallbackSellBest.outAmount,
          replacedUnrealisticQuote: {
            source: rejectedSellBest.name,
            ...rejectedSellRaw,
          },
        };
      } else {
        const fallbackReceive = buildStableSellFallbackFromBuy(pair, amount, buyReceiveAmount, buyReceiveAmount);
        if (fallbackReceive) {
          sellBest = { name: `${rejectedSellBest.name} guarded`, outAmount: fallbackReceive };
          sellReceiveAmount = fallbackReceive;
          sellRaw = {
            source: "buy-rate-fallback",
            amountIn: buyReceiveAmount,
            outAmount: fallbackReceive,
            replacedUnrealisticQuote: {
              source: rejectedSellBest.name,
              ...rejectedSellRaw,
            },
          };
          sellFallbackExcludeFromArb = true;
        }
      }
    }
    return { buyBest, sellBest, buyRaw, sellRaw, buyReceiveAmount, sellReceiveAmount, sellFallbackExcludeFromArb };
  };

  const calcRoundTripPct = (buyFromAmount, sellReceiveAmount) => {
    const start = Number(buyFromAmount);
    const end = Number(sellReceiveAmount);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0) return Number.NEGATIVE_INFINITY;
    return ((end - start) / start) * 100;
  };

  let attempt = await loadAttempt();
  let roundTripPct = calcRoundTripPct(amount, attempt.sellReceiveAmount);
  let excludeFromArb = attempt.sellFallbackExcludeFromArb;
  if (roundTripPct > ROUND_TRIP_TOLERANCE_PCT) {
    attempt = await loadAttempt();
    roundTripPct = calcRoundTripPct(amount, attempt.sellReceiveAmount);
    excludeFromArb = attempt.sellFallbackExcludeFromArb || roundTripPct > ROUND_TRIP_TOLERANCE_PCT;
  }

  const { buyBest, sellBest, buyRaw, sellRaw, buyReceiveAmount, sellReceiveAmount } = attempt;
  const buyFrom = Number(amount);
  const buyReceive = Number(buyReceiveAmount);
  const sellFromDisplay = buyReceiveAmount;
  const sellFrom = Number(sellFromDisplay);
  const sellReceive = Number(sellReceiveAmount);
  const buyPrice = buyReceive > 0 ? buyFrom / buyReceive : Number.NaN;
  const sellPrice = sellFrom > 0 ? sellReceive / sellFrom : Number.NaN;

  return {
    id: `${pair.id}-${network.chain}-${baseVariant.id}-${quoteVariant.id}`,
    networkId: network.chain,
    status: "ok",
    baseVariant,
    quoteVariant,
    buy: {
      fromAmount: amount,
      receiveAmount: buyReceiveAmount,
      price: Number.isFinite(buyPrice) ? buyPrice.toFixed(6) : "—",
      fromSymbol: quoteSymbol,
      fromVariantLabel: quoteVariant.label,
      receiveSymbol: baseSymbol,
      receiveVariantLabel: baseVariant.label,
      market: buyBest.name,
      raw: buyRaw,
    },
    sell: {
      fromAmount: sellFromDisplay,
      receiveAmount: sellReceiveAmount,
      price: Number.isFinite(sellPrice) ? sellPrice.toFixed(6) : "—",
      fromSymbol: baseSymbol,
      fromVariantLabel: baseVariant.label,
      receiveSymbol: quoteSymbol,
      receiveVariantLabel: quoteVariant.label,
      market: sellBest.name,
      raw: sellRaw,
    },
    roundTripPct,
    excludeFromArb,
    updatedAt: Date.now(),
  };
}

function buildPublicArbSettings(settings) {
  return {
    defaultAmount: settings.defaultAmount,
    refreshMs: settings.refreshMs,
    minProfitPct: settings.minProfitPct,
    arbitrageRules: Array.isArray(settings.arbitrageRules) ? settings.arbitrageRules : [],
    tokens: Array.isArray(settings.tokens) ? settings.tokens : [],
    pairs: Array.isArray(settings.pairs) ? settings.pairs : [],
    networks: Array.isArray(settings.networks) ? settings.networks : [],
  };
}

function createTokensById(settings) {
  const map = {};
  (settings.tokens ?? []).forEach((token) => {
    map[token.id] = token;
  });
  return map;
}

function getNetworksForPair(settings, pair) {
  return (settings.networks ?? []).filter((net) => pair.networks?.[net.chain]);
}

function buildTokenVariants(tokensById, token, chain) {
  const variants = [];
  const baseDecimals = token.decimalsByNetwork?.[chain] ?? 18;
  const mainAddress = typeof token.addresses?.[chain] === "string" ? token.addresses[chain].trim() : "";
  const usdtToken = tokensById.usdt;
  const proxyUsdt = token.id === "usdc" && chain === "plasma" && !mainAddress && usdtToken?.addresses?.[chain];
  const proxyAddress = usdtToken?.addresses?.[chain];
  const selectedAddress = mainAddress || (proxyUsdt ? proxyAddress : undefined);
  if (selectedAddress) {
    variants.push({
      id: "main",
      label: token.symbol,
      address: selectedAddress,
      decimals: baseDecimals,
      proxyTokenId: proxyUsdt ? "usdt" : undefined,
    });
  }
  const extra = token.variantsByNetwork?.[chain] ?? [];
  extra.forEach((variant, index) => {
    if (!variant?.address) return;
    const label = variant.label?.trim() || variant.id?.trim() || token.symbol;
    variants.push({
      id: variant.id?.trim() || `v${index + 1}`,
      label,
      address: variant.address,
      decimals: variant.decimals ?? baseDecimals,
    });
  });
  return variants;
}

function buildVariantCombos(tokensById, pair, network) {
  const base = tokensById[pair.baseTokenId];
  const quote = tokensById[pair.quoteTokenId];
  if (!base || !quote) {
    return {
      combos: [],
      error: "Missing token mapping",
      baseSymbol: base?.symbol ?? pair.baseTokenId,
      quoteSymbol: quote?.symbol ?? pair.quoteTokenId,
    };
  }
  const baseVariants = buildTokenVariants(tokensById, base, network.chain);
  const quoteVariants = buildTokenVariants(tokensById, quote, network.chain);
  if (baseVariants.length === 0 || quoteVariants.length === 0) {
    return {
      combos: [],
      error: "Missing token addresses for this network",
      baseSymbol: base.symbol,
      quoteSymbol: quote.symbol,
    };
  }
  const combos = baseVariants.flatMap((baseVariant) =>
    quoteVariants.map((quoteVariant) => ({
      id: `${baseVariant.id}-${quoteVariant.id}`,
      baseVariant,
      quoteVariant,
    }))
  );
  return {
    combos,
    baseSymbol: base.symbol,
    quoteSymbol: quote.symbol,
  };
}

function buildErrorVariantItem(pair, network, baseSymbol, quoteSymbol, message) {
  return {
    id: `${pair.id}-${network.chain}-error`,
    networkId: network.chain,
    status: "error",
    baseVariant: { id: "base", label: baseSymbol, address: "", decimals: 0 },
    quoteVariant: { id: "quote", label: quoteSymbol, address: "", decimals: 0 },
    error: message,
    updatedAt: Date.now(),
  };
}

function buildLoadingVariantItem(pair, network, combo, routeLabel) {
  return {
    id: routeLabel
      ? `${pair.id}-${network.chain}-${combo.id}-mint-redeem`
      : `${pair.id}-${network.chain}-${combo.id}`,
    networkId: network.chain,
    status: "loading",
    routeLabel,
    baseVariant: combo.baseVariant,
    quoteVariant: combo.quoteVariant,
    updatedAt: Date.now(),
  };
}

function buildLoadingVariantItems(pair, network, combos, includeMintRedeem, previousItems = [], nativeRouteLabel = "Mint/Redeem") {
  const placeholders = combos.map((combo) => buildLoadingVariantItem(pair, network, combo));
  if (includeMintRedeem && combos[0]) {
    placeholders.push(buildLoadingVariantItem(pair, network, combos[0], nativeRouteLabel));
  }

  return placeholders.map((placeholder) => {
    const previousItem = Array.isArray(previousItems)
      ? previousItems.find((item) => item.id === placeholder.id)
      : null;
    if (!previousItem?.buy && !previousItem?.sell) {
      return placeholder;
    }
    const { error: _error, ...previousWithoutError } = previousItem;
    return {
      ...previousWithoutError,
      ...placeholder,
      buy: previousItem.buy,
      sell: previousItem.sell,
      updatedAt: previousItem.updatedAt ?? placeholder.updatedAt,
      roundTripPct: previousItem.roundTripPct,
      excludeFromArb: previousItem.excludeFromArb,
    };
  });
}

function buildPreservedVariantItems(pair, network, combos, includeMintRedeem, previousItems = [], nativeRouteLabel = "Mint/Redeem") {
  const placeholders = combos.map((combo) => buildLoadingVariantItem(pair, network, combo));
  if (includeMintRedeem && combos[0]) {
    placeholders.push(buildLoadingVariantItem(pair, network, combos[0], nativeRouteLabel));
  }

  return placeholders.map((placeholder) => {
    const previousItem = Array.isArray(previousItems)
      ? previousItems.find((item) => item.id === placeholder.id)
      : null;
    if (!previousItem) {
      return placeholder;
    }
    return {
      ...placeholder,
      ...previousItem,
      id: placeholder.id,
      networkId: network.chain,
      routeLabel: placeholder.routeLabel,
      baseVariant: placeholder.baseVariant,
      quoteVariant: placeholder.quoteVariant,
    };
  });
}

function getPairAmount(settings, pair) {
  return pair.amount?.trim() ? pair.amount : settings.defaultAmount;
}

function computeUsdcUsdtRateFromQuotes(pair, quotes) {
  const candidates = quotes.filter((item) => item.status === "ok" && (item.buy || item.sell));
  const rates = [];

  for (const candidate of candidates) {
    if (pair.baseTokenId === "usdc" && pair.quoteTokenId === "usdt") {
      const buyRate = candidate.buy
        ? Number(candidate.buy.receiveAmount) / Number(candidate.buy.fromAmount)
        : null;
      const sellRate = candidate.sell
        ? Number(candidate.sell.fromAmount) / Number(candidate.sell.receiveAmount)
        : null;
      const normalizedBuyRate = normalizePlasmaUsdtProxyRate(buyRate);
      const normalizedSellRate = normalizePlasmaUsdtProxyRate(sellRate);
      if (normalizedBuyRate) rates.push(normalizedBuyRate);
      if (normalizedSellRate) rates.push(normalizedSellRate);
    } else {
      const buyRate = candidate.buy
        ? Number(candidate.buy.fromAmount) / Number(candidate.buy.receiveAmount)
        : null;
      const sellRate = candidate.sell
        ? Number(candidate.sell.receiveAmount) / Number(candidate.sell.fromAmount)
        : null;
      const normalizedBuyRate = normalizePlasmaUsdtProxyRate(buyRate);
      const normalizedSellRate = normalizePlasmaUsdtProxyRate(sellRate);
      if (normalizedBuyRate) rates.push(normalizedBuyRate);
      if (normalizedSellRate) rates.push(normalizedSellRate);
    }
  }

  if (rates.length === 0) return null;
  return normalizePlasmaUsdtProxyRate(rates.reduce((sum, value) => sum + value, 0) / rates.length);
}

function isProxyRatePair(pair) {
  return (
    (pair.baseTokenId === "usdc" && pair.quoteTokenId === "usdt") ||
    (pair.baseTokenId === "usdt" && pair.quoteTokenId === "usdc")
  );
}

function sortTasksForDependency(tasks) {
  return [...tasks].sort((a, b) => {
    const aPriority = isProxyRatePair(a.pair) && a.net.chain === PLASMA_USDT_PROXY_RATE_CHAIN ? 0 : 1;
    const bPriority = isProxyRatePair(b.pair) && b.net.chain === PLASMA_USDT_PROXY_RATE_CHAIN ? 0 : 1;
    return aPriority - bPriority;
  });
}

async function readConfigJson(configPath) {
  const raw = await readFile(configPath, "utf8");
  return JSON.parse(raw);
}

function createSnapshotPayload(settings, quoteMap) {
  return {
    settings: buildPublicArbSettings(settings),
    quoteMap,
    updatedAt: Date.now(),
  };
}

function filterSettingsForPairIds(settings, pairIds) {
  if (!Array.isArray(pairIds) || pairIds.length === 0) return settings;
  const allowedPairIds = new Set(pairIds.map((id) => String(id ?? "").trim()).filter(Boolean));
  if (allowedPairIds.size === 0) return settings;
  return {
    ...settings,
    pairs: (Array.isArray(settings.pairs) ? settings.pairs : []).filter((pair) => allowedPairIds.has(pair.id)),
  };
}

function applyPairOverrides(settings, pairOverrides) {
  if (!pairOverrides || typeof pairOverrides !== "object") return settings;
  const networkKeys = new Set((Array.isArray(settings.networks) ? settings.networks : []).map((net) => net.chain));
  return {
    ...settings,
    pairs: (Array.isArray(settings.pairs) ? settings.pairs : []).map((pair) => {
      const override = pairOverrides[pair.id];
      if (!override || typeof override !== "object") return pair;
      const next = { ...pair };
      const amount = String(override.amount ?? "").trim();
      if (amount && Number.isFinite(Number(amount)) && Number(amount) > 0) {
        next.amount = amount;
      }
      if (override.networks && typeof override.networks === "object") {
        const networks = { ...pair.networks };
        Object.entries(override.networks).forEach(([chain, enabled]) => {
          if (networkKeys.has(chain)) {
            networks[chain] = Boolean(enabled);
          }
        });
        next.networks = networks;
      }
      return next;
    }),
  };
}

function prepareSettings(settings, options = {}) {
  return applyPairOverrides(filterSettingsForPairIds(settings, options.pairIds), options.pairOverrides);
}

function prepareArbSnapshotState(settings, previousQuoteMap = null) {
  const tokensById = createTokensById(settings);
  const quoteMap = {};
  const pairs = Array.isArray(settings.pairs) ? settings.pairs : [];
  const tasks = sortTasksForDependency(
    pairs.flatMap((pair) =>
      getNetworksForPair(settings, pair).map((net) => {
        const comboState = buildVariantCombos(tokensById, pair, net);
        return {
          pair,
          net,
          ...comboState,
          includeMintRedeem:
            ((net.chain === "ethereum" && pair.baseTokenId === "reusd" && pair.quoteTokenId === "usdc") ||
              (net.chain === "avalanche" && pair.baseTokenId === "savusd" && pair.quoteTokenId === "usdc") ||
              (net.chain === "fluent" && isSusdnrUsdnrPair(pair))) &&
            Boolean(comboState.combos[0]),
          nativeRouteLabel: getNativeRouteLabel(pair, net),
        };
      })
    )
  );

  tasks.forEach((task) => {
    const { pair, net, combos, error, baseSymbol, quoteSymbol, includeMintRedeem, nativeRouteLabel } = task;
    if (!quoteMap[pair.id]) {
      quoteMap[pair.id] = {};
    }
    if (error) {
      quoteMap[pair.id][net.chain] = [buildErrorVariantItem(pair, net, baseSymbol, quoteSymbol, error)];
      return;
    }

    const previousItems = previousQuoteMap?.[pair.id]?.[net.chain];
    quoteMap[pair.id][net.chain] = buildPreservedVariantItems(
      pair,
      net,
      combos,
      includeMintRedeem,
      previousItems,
      nativeRouteLabel
    );
  });

  return { quoteMap, tasks };
}

export async function buildInitialArbSnapshot(configPath, options = {}) {
  const settings = prepareSettings(await readConfigJson(configPath), options);
  const { quoteMap } = prepareArbSnapshotState(settings);
  return createSnapshotPayload(settings, quoteMap);
}

export async function buildArbSnapshot(configPath, options = {}) {
  const settings = prepareSettings(await readConfigJson(configPath), options);
  const { onUpdate, previousQuoteMap = null } = options;
  const { quoteMap, tasks } = prepareArbSnapshotState(settings, previousQuoteMap);
  const publishSnapshot = () => {
    if (!onUpdate) return;
    void Promise.resolve(onUpdate(createSnapshotPayload(settings, quoteMap))).catch(() => undefined);
  };

  publishSnapshot();

  let usdcUsdtRate = null;
  let usdcUsdtRateError = null;
  try {
    usdcUsdtRate = await fetchBinanceUsdcUsdtProxyRate();
  } catch (error) {
    usdcUsdtRate = null;
    usdcUsdtRateError = error instanceof Error ? error.message : String(error ?? "Unknown error");
  }
  const processTask = async (task) => {
    const { pair, net, combos, error, baseSymbol, quoteSymbol, includeMintRedeem, nativeRouteLabel } = task;
    if (error) {
      quoteMap[pair.id][net.chain] = [buildErrorVariantItem(pair, net, baseSymbol, quoteSymbol, error)];
      publishSnapshot();
      return;
    }

    const amount = getPairAmount(settings, pair);
    const needsProxyRate =
      net.chain === "plasma" &&
      combos.some((combo) => combo.baseVariant.proxyTokenId === "usdt" || combo.quoteVariant.proxyTokenId === "usdt");
    let results = buildLoadingVariantItems(
      pair,
      net,
      combos,
      includeMintRedeem,
      quoteMap[pair.id]?.[net.chain],
      nativeRouteLabel
    );
    quoteMap[pair.id][net.chain] = results;
    publishSnapshot();
    const replaceResult = (item) => {
      const existingIndex = results.findIndex((entry) => entry.id === item.id);
      if (existingIndex === -1) {
        results = [...results, item];
      } else {
        results = [...results];
        results[existingIndex] = item;
      }
      quoteMap[pair.id][net.chain] = results;
      publishSnapshot();
    };
    if (needsProxyRate && (!usdcUsdtRate || !Number.isFinite(usdcUsdtRate))) {
      quoteMap[pair.id][net.chain] = results.map((item) => ({
        ...item,
        status: "error",
        error: usdcUsdtRateError
          ? `Missing ${PLASMA_USDT_PROXY_RATE_LABEL} rate: ${usdcUsdtRateError}`
          : `Missing ${PLASMA_USDT_PROXY_RATE_LABEL} rate`,
        updatedAt: Date.now(),
      }));
      publishSnapshot();
      return;
    }

    for (const combo of combos) {
      try {
        const item = await fetchQuoteForVariant(
          settings,
          net,
          pair,
          combo.baseVariant,
          combo.quoteVariant,
          baseSymbol,
          quoteSymbol,
          amount,
          usdcUsdtRate
        );
        replaceResult(item);
      } catch (errorValue) {
        replaceResult({
          id: `${pair.id}-${net.chain}-${combo.id}`,
          networkId: net.chain,
          status: "error",
          baseVariant: combo.baseVariant,
          quoteVariant: combo.quoteVariant,
          error: errorValue instanceof Error ? errorValue.message : "Error",
          updatedAt: Date.now(),
        });
      }
    }

    if (includeMintRedeem && combos[0]) {
      try {
        const mintRedeemQuote = await fetchMintRedeemQuote(
          settings,
          net,
          pair,
          combos[0].baseVariant,
          combos[0].quoteVariant,
          baseSymbol,
          quoteSymbol,
          amount
        );
        replaceResult(mintRedeemQuote);
      } catch (errorValue) {
        replaceResult({
          id: `${pair.id}-${net.chain}-${combos[0].id}-mint-redeem`,
          networkId: net.chain,
          status: "error",
          routeLabel: nativeRouteLabel,
          baseVariant: combos[0].baseVariant,
          quoteVariant: combos[0].quoteVariant,
          error: errorValue instanceof Error ? errorValue.message : "Error",
          updatedAt: Date.now(),
        });
      }
    }

    if (!usdcUsdtRate && isProxyRatePair(pair) && net.chain === PLASMA_USDT_PROXY_RATE_CHAIN) {
      const rate = computeUsdcUsdtRateFromQuotes(pair, results);
      if (rate && Number.isFinite(rate)) {
        usdcUsdtRate = rate;
      }
    }
  };

  const initialProxyTasks = tasks.filter(
    (task) => isProxyRatePair(task.pair) && task.net.chain === PLASMA_USDT_PROXY_RATE_CHAIN
  );
  for (const task of initialProxyTasks) {
    await processTask(task);
  }

  const remainingTasks = tasks.filter(
    (task) => !(isProxyRatePair(task.pair) && task.net.chain === PLASMA_USDT_PROXY_RATE_CHAIN)
  );
  let currentIndex = 0;
  const workerCount = getAdaptiveWorkerCount(remainingTasks.length);
  const workers = Array.from({ length: Math.min(workerCount, remainingTasks.length) }, async () => {
    while (true) {
      const task = remainingTasks[currentIndex];
      currentIndex += 1;
      if (!task) return;
      await processTask(task);
    }
  });
  await Promise.all(workers);

  return createSnapshotPayload(settings, quoteMap);
}

export async function loadArbSnapshot(snapshotPath) {
  try {
    const raw = await readFile(snapshotPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveArbSnapshot(snapshotPath, payload) {
  await writeFile(snapshotPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
