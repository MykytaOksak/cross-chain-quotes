import http from "node:http";
import { URL } from "node:url";
import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers";

const PORT = Number(process.env.PENDLE_WORKER_PORT || 8788);
const PRIVATE_KEY = (process.env.PENDLE_PRIVATE_KEY || "").trim();

const PENDLE_CORE_API = "https://api-v2.pendle.finance/core";
const PENDLE_LIMIT_API = "https://api-v2.pendle.finance/limit-order";
const DEFAULT_PENDLE_LIMIT_ROUTER = "0x000000000000c9b3e2c3ec88b1b4c0cd853f4321";

const LIMIT_ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "orderType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "YT", type: "address" },
    { name: "maker", type: "address" },
    { name: "receiver", type: "address" },
    { name: "makingAmount", type: "uint256" },
    { name: "lnImpliedRate", type: "uint256" },
    { name: "failSafeRate", type: "uint256" },
    { name: "permit", type: "bytes" },
  ],
};

const LIMIT_ROUTER_ABI = [
  "function cancelBatch((uint256 salt,uint256 expiry,uint256 nonce,uint8 orderType,address token,address YT,address maker,address receiver,uint256 makingAmount,uint256 lnImpliedRate,uint256 failSafeRate,bytes permit)[] orders)",
];

const ERC20_ABI = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
];

const LIMIT_ORDER_TYPE_TOKEN_FOR_YT = 2;
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const PENDLE_API_MIN_INTERVAL_MS = 650;
const PENDLE_API_429_COOLDOWN_MS = 10_000;
let pendleApiQueue = Promise.resolve();
let pendleApiNextAllowedAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sameAddress(a, b) {
  try {
    return getAddress(String(a || "")) === getAddress(String(b || ""));
  } catch {
    return false;
  }
}

function requirePrivateKey() {
  if (!PRIVATE_KEY) {
    throw new Error("PENDLE_PRIVATE_KEY is not set in worker environment");
  }
  return PRIVATE_KEY;
}

function makerAddress() {
  return new Wallet(requirePrivateKey()).address;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
      if (raw.length > 1_000_000) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function parseRetryAfterMs(retryAfter) {
  if (!retryAfter) return null;
  const asNumber = Number(retryAfter);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.max(0, Math.floor(asNumber * 1000));
  }
  const asDate = Date.parse(retryAfter);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, asDate - Date.now());
}

function enqueuePendleRequest(fn) {
  const run = pendleApiQueue.then(fn, fn);
  pendleApiQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function pendleApiFetch(url, init) {
  return enqueuePendleRequest(async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const waitMs = Math.max(0, pendleApiNextAllowedAt - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      pendleApiNextAllowedAt = Date.now() + PENDLE_API_MIN_INTERVAL_MS;
      const response = await fetch(url, init);
      if (response.status !== 429) return response;
      const retryAfterMs =
        parseRetryAfterMs(response.headers.get("retry-after")) ??
        PENDLE_API_429_COOLDOWN_MS;
      pendleApiNextAllowedAt = Math.max(
        pendleApiNextAllowedAt,
        Date.now() + retryAfterMs
      );
      if (attempt === 1) return response;
    }
    throw new Error("Pendle API request failed");
  });
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function parsePrefixedAddress(value) {
  const parts = String(value || "").split("-");
  const maybeAddress = parts.length > 1 ? parts[1] : parts[0];
  return getAddress(maybeAddress || "");
}

async function fetchPendleMarketInfo(chainId, marketAddress) {
  const marketId = `${chainId}-${marketAddress.toLowerCase()}`;
  const url = `${PENDLE_CORE_API}/v1/markets/all?ids=${encodeURIComponent(marketId)}`;
  const response = await pendleApiFetch(url);
  const json = await readJsonSafe(response);
  if (!response.ok) throw new Error(json.message || `HTTP ${response.status}`);
  const market = json.markets?.[0];
  if (!market) throw new Error("Market not found");
  const details = market.details ?? {};
  return {
    name: String(market.name ?? "Unknown market"),
    address: getAddress(String(market.address ?? marketAddress)),
    chainId: Number(market.chainId ?? chainId),
    expiry: String(market.expiry ?? ""),
    ytAddress: parsePrefixedAddress(String(market.yt ?? "")),
    underlyingAssetAddress: parsePrefixedAddress(String(market.underlyingAsset ?? "")),
    impliedApy: Number(details.impliedApy ?? 0),
  };
}

async function fetchPendleMarketData(chainId, marketAddress) {
  const url = `${PENDLE_CORE_API}/v2/${chainId}/markets/${marketAddress}/data`;
  const response = await pendleApiFetch(url);
  const json = await readJsonSafe(response);
  if (!response.ok) throw new Error(json.message || `HTTP ${response.status}`);
  return { impliedApy: Number(json.impliedApy ?? 0), timestamp: json.timestamp };
}

async function fetchMakerActiveOrders(chainId, maker, ytAddress) {
  const params = new URLSearchParams({
    skip: "0",
    limit: "100",
    chainId: String(chainId),
    maker,
    yt: ytAddress,
    type: String(LIMIT_ORDER_TYPE_TOKEN_FOR_YT),
    isActive: "true",
  });
  const url = `${PENDLE_LIMIT_API}/v1/makers/limit-orders?${params.toString()}`;
  const response = await pendleApiFetch(url);
  const json = await readJsonSafe(response);
  if (!response.ok) throw new Error(json.message || `HTTP ${response.status}`);
  return Array.isArray(json.results) ? json.results : [];
}

async function generateLimitOrderData(payload) {
  const response = await pendleApiFetch(`${PENDLE_LIMIT_API}/v1/makers/generate-limit-order-data`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await readJsonSafe(response);
  if (!response.ok) throw new Error(json.message || `HTTP ${response.status}`);
  return json;
}

async function signGeneratedLimitOrder(order, chainId, verifyingContract) {
  const wallet = new Wallet(requirePrivateKey());
  return wallet.signTypedData(
    { name: "Pendle Limit Order Protocol", version: "1", chainId, verifyingContract },
    LIMIT_ORDER_TYPES,
    order
  );
}

async function postLimitOrder(order, signature) {
  const requestBody = {
    ...order,
    yt: order.YT,
    type: order.orderType,
    signature,
  };
  const response = await pendleApiFetch(`${PENDLE_LIMIT_API}/v1/makers/limit-orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const json = await readJsonSafe(response);
  if (!response.ok) throw new Error(json.message || `HTTP ${response.status}`);
}

function isBenignCancelError(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
  return (
    message.includes("lop: already filled") ||
    message.includes("already filled") ||
    message.includes("already cancelled") ||
    message.includes("already canceled")
  );
}

async function cancelOrders(rpcUrl, verifyingContract, orders) {
  if (!orders.length) return;
  const wallet = new Wallet(requirePrivateKey(), new JsonRpcProvider(rpcUrl));
  const contract = new Contract(verifyingContract, LIMIT_ROUTER_ABI, wallet);
  const cancelBatch = contract.getFunction("cancelBatch");
  const payload = orders.map((order) => ({
    salt: order.salt,
    expiry: order.expiry,
    nonce: order.nonce,
    orderType: order.type,
    token: order.token,
    YT: order.yt,
    maker: order.maker,
    receiver: order.receiver,
    makingAmount: order.makingAmount,
    lnImpliedRate: order.lnImpliedRate,
    failSafeRate: order.failSafeRate,
    permit: order.permit,
  }));
  try {
    const tx = await cancelBatch(payload);
    await tx.wait();
    return;
  } catch (batchError) {
    if (!isBenignCancelError(batchError)) throw batchError;
  }
  for (const order of payload) {
    try {
      const tx = await cancelBatch([order]);
      await tx.wait();
    } catch (singleError) {
      if (isBenignCancelError(singleError)) continue;
      throw singleError;
    }
  }
}

async function ensureTokenAllowance(rpcUrl, tokenAddress, spender, requiredAmount) {
  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(requirePrivateKey(), provider);
  const token = new Contract(tokenAddress, ERC20_ABI, wallet);
  const allowanceFn = token.getFunction("allowance");
  const currentAllowance = BigInt(await allowanceFn(wallet.address, spender));
  const needed = BigInt(requiredAmount);
  if (currentAllowance >= needed) return;
  const approveFn = token.getFunction("approve");
  const tx = await approveFn(spender, (1n << 256n) - 1n);
  await tx.wait();
}

async function getTokenBalance(rpcUrl, tokenAddress, owner) {
  const provider = new JsonRpcProvider(rpcUrl);
  const token = new Contract(tokenAddress, ERC20_ABI, provider);
  const balanceFn = token.getFunction("balanceOf");
  return BigInt(await balanceFn(owner));
}

function decodeLnImpliedRateToApy(lnImpliedRate) {
  const ln = Number(lnImpliedRate) / 1e18;
  if (!Number.isFinite(ln)) return NaN;
  const value = Math.exp(ln) - 1;
  return Number.isFinite(value) ? value : NaN;
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
  const raw = String(amount ?? "").replace(/\D/g, "");
  if (!raw) return "0";
  if (decimals <= 0) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function buildRows(orders, currentApy, underlyingDecimals) {
  return orders.map((order) => {
    const orderApy = decodeLnImpliedRateToApy(order.lnImpliedRate);
    const discountPct =
      Number.isFinite(orderApy) && Number.isFinite(currentApy) && currentApy > 0
        ? ((currentApy - orderApy) / currentApy) * 100
        : null;
    const amountRaw = order.currentMakingAmount || order.makingAmount || "0";
    return {
      id: order.id,
      createdAt: order.createdAt,
      expiresAt: order.expiry,
      amount: fromAtomicAmount(amountRaw, underlyingDecimals),
      orderApy: Number.isFinite(orderApy) ? orderApy : null,
      discountPct,
    };
  });
}

async function retryFetch(fn, attempts = 3) {
  let lastError = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error ?? "");
      if (!/failed to fetch/i.test(message) || i === attempts) break;
      await sleep(800 * i);
    }
  }
  throw lastError;
}

async function runCycle(payload) {
  const chainId = Number(payload.chainId);
  const marketAddress = String(payload.marketAddress || "").trim();
  const amount = String(payload.amount || "").trim();
  const targetDiscountPct = Number(payload.targetDiscountPct);
  const replaceLowerThresholdPct = Number(payload.replaceLowerThresholdPct);
  const replaceThresholdPct = Number(payload.replaceThresholdPct);
  const orderExpiryMinutes = Number(payload.orderExpiryMinutes);
  const rpcUrl = String(payload.rpcUrl || "").trim();
  const limitOrderContract = String(payload.limitOrderContract || "").trim() || DEFAULT_PENDLE_LIMIT_ROUTER;
  const orderTokenAddressRaw = String(payload.orderTokenAddress || "").trim();
  const orderTokenDecimals = Math.max(0, Number(payload.orderTokenDecimals ?? 18));

  if (!Number.isFinite(chainId) || chainId <= 0) throw new Error("Invalid chainId");
  if (!EVM_ADDRESS_RE.test(marketAddress)) throw new Error("Invalid marketAddress");
  if (!amount || Number(amount) <= 0) throw new Error("Amount must be greater than 0");
  if (!rpcUrl) throw new Error("RPC URL is required");
  if (!EVM_ADDRESS_RE.test(limitOrderContract)) throw new Error("Invalid limit order contract");

  const maker = makerAddress();
  const market = await fetchPendleMarketInfo(chainId, marketAddress);
  const orderTokenAddress = orderTokenAddressRaw
    ? getAddress(orderTokenAddressRaw)
    : market.underlyingAssetAddress;
  const targetMakingAmount = BigInt(toAtomicAmount(amount, orderTokenDecimals));
  const latest = await retryFetch(() => fetchPendleMarketData(chainId, market.address), 3);
  const currentApy = Number(latest.impliedApy ?? 0);
  if (!Number.isFinite(currentApy) || currentApy <= 0) {
    throw new Error("Invalid implied APY");
  }

  let orders = await retryFetch(
    () => fetchMakerActiveOrders(chainId, maker, market.ytAddress),
    3
  );

  const hasPartialFill = orders.some((order) => {
    try {
      const rawAmount = order.currentMakingAmount || order.makingAmount || "0";
      const openAmount = BigInt(rawAmount);
      return openAmount > 0n && openAmount < targetMakingAmount;
    } catch {
      return false;
    }
  });
  if (hasPartialFill) {
    if (orders.length > 0) {
      await cancelOrders(rpcUrl, limitOrderContract, orders);
      orders = await retryFetch(() => fetchMakerActiveOrders(chainId, maker, market.ytAddress), 3);
    }
    return {
      maker,
      currentApy,
      orders,
      rows: buildRows(orders, currentApy, orderTokenDecimals),
      stopStrategy: true,
      stopReason: "Order was partially filled below configured amount. Active orders were canceled and strategy stopped.",
    };
  }

  const tokenBalance = await getTokenBalance(rpcUrl, orderTokenAddress, maker);
  if (orders.length === 0 && tokenBalance < targetMakingAmount) {
    return {
      maker,
      currentApy,
      orders,
      rows: buildRows(orders, currentApy, orderTokenDecimals),
      stopStrategy: true,
      stopReason: "Token balance is below configured amount after fill. Strategy stopped.",
    };
  }

  const needsReplace =
    orders.length !== 1 ||
    orders.some((order) => {
      if (!sameAddress(order.token, orderTokenAddress)) return true;
      const orderApy = decodeLnImpliedRateToApy(order.lnImpliedRate);
      if (!Number.isFinite(orderApy) || currentApy <= 0) return true;
      const discount = ((currentApy - orderApy) / currentApy) * 100;
      return discount > replaceThresholdPct || discount < replaceLowerThresholdPct;
    });

  if (needsReplace) {
    if (orders.length > 0) {
      await cancelOrders(rpcUrl, limitOrderContract, orders);
      for (let i = 0; i < 8; i += 1) {
        const check = await retryFetch(() => fetchMakerActiveOrders(chainId, maker, market.ytAddress), 3);
        if (check.length === 0) break;
        if (i === 7) throw new Error(`Cancel requested, but ${check.length} active order(s) remain`);
        await sleep(1200);
      }
    }
    const targetApy = Math.max(0.0000001, currentApy * (1 - targetDiscountPct / 100));
    const makingAmount = targetMakingAmount.toString();
    await ensureTokenAllowance(rpcUrl, orderTokenAddress, limitOrderContract, makingAmount);
    const expiry = String(Math.floor(Date.now() / 1000) + Math.max(60, Math.floor(orderExpiryMinutes * 60)));
    const generated = await retryFetch(
      () =>
        generateLimitOrderData({
          chainId,
          YT: market.ytAddress,
          orderType: LIMIT_ORDER_TYPE_TOKEN_FOR_YT,
          token: orderTokenAddress,
          maker,
          makingAmount,
          impliedApy: targetApy,
          expiry,
        }),
      3
    );
    // Pendle API can return market underlying token here; force selected token into signed payload.
    generated.token = orderTokenAddress;
    const signature = await signGeneratedLimitOrder(generated, chainId, limitOrderContract);
    await retryFetch(() => postLimitOrder(generated, signature), 5);
  }

  orders = await retryFetch(() => fetchMakerActiveOrders(chainId, maker, market.ytAddress), 3);
  if (orders.length > 1) {
    const sorted = [...orders].sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""));
    const keepId = sorted[0]?.id;
    const duplicates = keepId ? orders.filter((o) => o.id !== keepId) : orders.slice(1);
    if (duplicates.length > 0) {
      await cancelOrders(rpcUrl, limitOrderContract, duplicates);
      orders = await retryFetch(() => fetchMakerActiveOrders(chainId, maker, market.ytAddress), 3);
    }
  }

  return {
    maker,
    currentApy,
    orders,
    rows: buildRows(orders, currentApy, orderTokenDecimals),
  };
}

async function snapshot(payload) {
  const chainId = Number(payload.chainId);
  const marketAddress = String(payload.marketAddress || "").trim();
  const orderTokenDecimals = Math.max(0, Number(payload.orderTokenDecimals ?? 18));
  if (!Number.isFinite(chainId) || chainId <= 0) throw new Error("Invalid chainId");
  if (!EVM_ADDRESS_RE.test(marketAddress)) throw new Error("Invalid marketAddress");
  const maker = makerAddress();
  const market = await fetchPendleMarketInfo(chainId, marketAddress);
  const latest = await retryFetch(() => fetchPendleMarketData(chainId, market.address), 3);
  const currentApy = Number(latest.impliedApy ?? 0);
  const orders = await retryFetch(() => fetchMakerActiveOrders(chainId, maker, market.ytAddress), 3);
  return { maker, currentApy, orders, rows: buildRows(orders, currentApy, orderTokenDecimals) };
}

async function cancelAllActiveOrders(payload) {
  const chainId = Number(payload.chainId);
  const marketAddress = String(payload.marketAddress || "").trim();
  const rpcUrl = String(payload.rpcUrl || "").trim();
  const limitOrderContract = String(payload.limitOrderContract || "").trim() || DEFAULT_PENDLE_LIMIT_ROUTER;
  const orderTokenDecimals = Math.max(0, Number(payload.orderTokenDecimals ?? 18));

  if (!Number.isFinite(chainId) || chainId <= 0) throw new Error("Invalid chainId");
  if (!EVM_ADDRESS_RE.test(marketAddress)) throw new Error("Invalid marketAddress");
  if (!rpcUrl) throw new Error("RPC URL is required");
  if (!EVM_ADDRESS_RE.test(limitOrderContract)) throw new Error("Invalid limit order contract");

  const maker = makerAddress();
  const market = await fetchPendleMarketInfo(chainId, marketAddress);
  let orders = await retryFetch(() => fetchMakerActiveOrders(chainId, maker, market.ytAddress), 3);
  const canceledCount = orders.length;
  if (orders.length > 0) {
    await cancelOrders(rpcUrl, limitOrderContract, orders);
    orders = await retryFetch(() => fetchMakerActiveOrders(chainId, maker, market.ytAddress), 3);
  }

  let currentApy = Number.NaN;
  try {
    const latest = await retryFetch(() => fetchPendleMarketData(chainId, market.address), 3);
    currentApy = Number(latest.impliedApy ?? 0);
  } catch {
    // keep NaN; rows will still render with null discount
  }

  return {
    maker,
    currentApy: Number.isFinite(currentApy) ? currentApy : null,
    orders,
    rows: buildRows(orders, currentApy, orderTokenDecimals),
    canceledCount,
  };
}

const server = http.createServer(async (req, res) => {
  if (!req.url) return sendJson(res, 404, { ok: false, error: "Not found" });
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });

  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/pendle/health") {
      return sendJson(res, 200, { ok: true, maker: PRIVATE_KEY ? makerAddress() : null });
    }
    if (req.method === "POST" && url.pathname === "/api/pendle/orders") {
      const body = await readBody(req);
      const data = await snapshot(body);
      return sendJson(res, 200, { ok: true, ...data });
    }
    if (req.method === "POST" && url.pathname === "/api/pendle/run-cycle") {
      const body = await readBody(req);
      const data = await runCycle(body);
      return sendJson(res, 200, { ok: true, ...data });
    }
    if (req.method === "POST" && url.pathname === "/api/pendle/cancel-all") {
      const body = await readBody(req);
      const data = await cancelAllActiveOrders(body);
      return sendJson(res, 200, { ok: true, ...data });
    }
    return sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker error";
    return sendJson(res, 500, { ok: false, error: message });
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Pendle worker listening on http://localhost:${PORT}`);
});
