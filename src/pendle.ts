import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers";

const PENDLE_CORE_API = "https://api-v2.pendle.finance/core";
const PENDLE_LIMIT_API = "https://api-v2.pendle.finance/limit-order";
const PENDLE_API_MIN_INTERVAL_MS = 650;
const PENDLE_API_429_COOLDOWN_MS = 10_000;

let pendleApiQueue: Promise<void> = Promise.resolve();
let pendleApiNextAllowedAt = 0;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseRetryAfterMs(retryAfter: string | null): number | null {
  if (!retryAfter) return null;
  const asNumber = Number(retryAfter);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.max(0, Math.floor(asNumber * 1000));
  }
  const asDate = Date.parse(retryAfter);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, asDate - Date.now());
}

function enqueuePendleRequest<T>(fn: () => Promise<T>): Promise<T> {
  const run = pendleApiQueue.then(fn, fn);
  pendleApiQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function pendleApiFetch(url: string, init?: RequestInit): Promise<Response> {
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

async function readJsonSafe<T>(response: Response): Promise<T & { message?: string }> {
  const text = await response.text();
  if (!text.trim()) return {} as T & { message?: string };
  try {
    return JSON.parse(text) as T & { message?: string };
  } catch {
    return { message: text } as T & { message?: string };
  }
}

const LIMIT_ORDER_TYPES: Record<string, Array<{ name: string; type: string }>> = {
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
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
];

export const LIMIT_ORDER_TYPE_TOKEN_FOR_YT = 2;

export type PendleMarketInfo = {
  name: string;
  address: string;
  chainId: number;
  expiry?: string;
  ytAddress: string;
  underlyingAssetAddress: string;
  impliedApy: number;
  liquidity?: number;
  totalTvl?: number;
};

export type PendleMakerOrder = {
  id: string;
  signature: string;
  chainId: number;
  salt: string;
  expiry: string;
  nonce: string;
  type: number;
  token: string;
  yt: string;
  maker: string;
  receiver: string;
  makingAmount: string;
  currentMakingAmount?: string;
  lnImpliedRate: string;
  failSafeRate: string;
  permit: string;
  isActive?: boolean;
  createdAt?: string;
};

type LimitOrdersResponse = {
  results: PendleMakerOrder[];
};

export type GenerateLimitOrderDataRequest = {
  chainId: number;
  YT: string;
  orderType: number;
  token: string;
  maker: string;
  makingAmount: string;
  impliedApy: number;
  expiry: string;
};

export type GeneratedLimitOrderData = GenerateLimitOrderDataRequest & {
  salt: string;
  nonce: string;
  failSafeRate: string;
  receiver: string;
  lnImpliedRate: string;
  permit: string;
};

type CreateLimitOrderRequest = Omit<GeneratedLimitOrderData, "YT" | "orderType"> & {
  yt: string;
  type: number;
  signature: string;
};

export function getMakerFromPrivateKey(privateKey: string): string {
  return new Wallet(privateKey.trim()).address;
}

export function parsePrefixedAddress(value: string): string {
  const parts = value.split("-");
  const maybeAddress = parts.length > 1 ? parts[1] : parts[0];
  return getAddress(maybeAddress ?? "");
}

export async function fetchPendleMarketInfo(
  chainId: number,
  marketAddress: string
): Promise<PendleMarketInfo> {
  const marketId = `${chainId}-${marketAddress.toLowerCase()}`;
  const url = `${PENDLE_CORE_API}/v1/markets/all?ids=${encodeURIComponent(marketId)}`;
  const response = await pendleApiFetch(url);
  const json = (await readJsonSafe<{ markets?: Array<Record<string, unknown>> }>(
    response
  )) as { markets?: Array<Record<string, unknown>>; message?: string };
  if (!response.ok) {
    throw new Error(json.message || `HTTP ${response.status}`);
  }
  const market = json.markets?.[0];
  if (!market) {
    throw new Error("Market not found");
  }
  const details = (market.details ?? {}) as Record<string, unknown>;
  return {
    name: String(market.name ?? "Unknown market"),
    address: getAddress(String(market.address ?? marketAddress)),
    chainId: Number(market.chainId ?? chainId),
    expiry: String(market.expiry ?? ""),
    ytAddress: parsePrefixedAddress(String(market.yt ?? "")),
    underlyingAssetAddress: parsePrefixedAddress(String(market.underlyingAsset ?? "")),
    impliedApy: Number(details.impliedApy ?? 0),
    liquidity: Number(details.liquidity ?? 0),
    totalTvl: Number(details.totalTvl ?? 0),
  };
}

export async function fetchPendleMarketData(
  chainId: number,
  marketAddress: string
): Promise<{ impliedApy: number; timestamp?: string }> {
  const url = `${PENDLE_CORE_API}/v2/${chainId}/markets/${marketAddress}/data`;
  const response = await pendleApiFetch(url);
  const json = (await readJsonSafe<{ impliedApy?: number; timestamp?: string }>(
    response
  )) as { impliedApy?: number; timestamp?: string; message?: string };
  if (!response.ok) {
    throw new Error(json.message || `HTTP ${response.status}`);
  }
  return {
    impliedApy: Number(json.impliedApy ?? 0),
    timestamp: json.timestamp,
  };
}

export async function fetchMakerActiveOrders(
  chainId: number,
  maker: string,
  ytAddress: string
): Promise<PendleMakerOrder[]> {
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
  const json = (await readJsonSafe<LimitOrdersResponse>(response)) as LimitOrdersResponse & {
    message?: string;
  };
  if (!response.ok) {
    throw new Error(json.message || `HTTP ${response.status}`);
  }
  return Array.isArray(json.results) ? json.results : [];
}

export async function generateLimitOrderData(
  payload: GenerateLimitOrderDataRequest
): Promise<GeneratedLimitOrderData> {
  const response = await pendleApiFetch(`${PENDLE_LIMIT_API}/v1/makers/generate-limit-order-data`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await readJsonSafe<GeneratedLimitOrderData>(response)) as GeneratedLimitOrderData & {
    message?: string;
  };
  if (!response.ok) {
    throw new Error(json.message || `HTTP ${response.status}`);
  }
  return json;
}

export async function signGeneratedLimitOrder(
  order: GeneratedLimitOrderData,
  privateKey: string,
  chainId: number,
  verifyingContract: string
): Promise<string> {
  const wallet = new Wallet(privateKey.trim());
  return wallet.signTypedData(
    {
      name: "Pendle Limit Order Protocol",
      version: "1",
      chainId,
      verifyingContract,
    },
    LIMIT_ORDER_TYPES,
    order
  );
}

export async function postLimitOrder(order: GeneratedLimitOrderData, signature: string): Promise<void> {
  const requestBody: CreateLimitOrderRequest = {
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
  const json = (await readJsonSafe<Record<string, never>>(response)) as { message?: string };
  if (!response.ok) {
    throw new Error(json.message || `HTTP ${response.status}`);
  }
}

export async function cancelOrders(
  privateKey: string,
  rpcUrl: string,
  verifyingContract: string,
  orders: PendleMakerOrder[]
): Promise<void> {
  if (orders.length === 0) return;
  const wallet = new Wallet(privateKey.trim(), new JsonRpcProvider(rpcUrl));
  const contract = new Contract(verifyingContract, LIMIT_ROUTER_ABI, wallet);
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
  const cancelBatch = contract.getFunction("cancelBatch");
  const isBenignCancelError = (error: unknown) => {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
    return (
      message.includes("lop: already filled") ||
      message.includes("already filled") ||
      message.includes("already cancelled") ||
      message.includes("already canceled")
    );
  };
  try {
    const tx = await cancelBatch(payload);
    await tx.wait();
    return;
  } catch (batchError) {
    // Pendle API can lag and still return orders that are already filled/cancelled.
    // Retry one-by-one to cancel what is still truly active.
    if (!isBenignCancelError(batchError)) {
      throw batchError;
    }
  }

  const hardFailures: Array<{ orderId: string; reason: string }> = [];
  for (const order of orders) {
    const one = {
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
    };
    try {
      const tx = await cancelBatch([one]);
      await tx.wait();
    } catch (singleError) {
      if (isBenignCancelError(singleError)) continue;
      hardFailures.push({
        orderId: order.id,
        reason: singleError instanceof Error ? singleError.message : String(singleError ?? "Unknown error"),
      });
    }
  }
  if (hardFailures.length > 0) {
    throw new Error(
      `Failed to cancel ${hardFailures.length} order(s): ${hardFailures
        .map((f) => `${f.orderId}: ${f.reason}`)
        .join(" | ")}`
    );
  }
}

export function decodeLnImpliedRateToApy(lnImpliedRate: string): number {
  const ln = Number(lnImpliedRate) / 1e18;
  if (!Number.isFinite(ln)) return NaN;
  const value = Math.exp(ln) - 1;
  return Number.isFinite(value) ? value : NaN;
}

export function toAtomicAmount(amount: string, decimals: number): string {
  const normalized = amount.trim();
  if (!normalized) return "0";
  const [wholeRaw = "", fractionRaw = ""] = normalized.split(".");
  const whole = wholeRaw.replace(/\D/g, "") || "0";
  const fractionDigits = fractionRaw.replace(/\D/g, "");
  const paddedFraction = (fractionDigits + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${paddedFraction}`.replace(/^0+(?=\d)/, "");
  return combined || "0";
}

export async function fetchTokenMeta(
  rpcUrl: string,
  tokenAddress: string
): Promise<{ symbol: string; decimals: number }> {
  const provider = new JsonRpcProvider(rpcUrl);
  const contract = new Contract(tokenAddress, ERC20_ABI, provider);
  const symbolFn = contract.getFunction("symbol");
  const decimalsFn = contract.getFunction("decimals");
  const [symbol, decimals] = await Promise.all([symbolFn(), decimalsFn()]);
  return {
    symbol: String(symbol),
    decimals: Number(decimals),
  };
}

export async function ensureTokenAllowance(
  privateKey: string,
  rpcUrl: string,
  tokenAddress: string,
  spender: string,
  requiredAmount: string
): Promise<void> {
  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(privateKey.trim(), provider);
  const token = new Contract(tokenAddress, ERC20_ABI, wallet);
  const owner = wallet.address;
  const allowanceFn = token.getFunction("allowance");
  const currentAllowance = BigInt(await allowanceFn(owner, spender));
  const needed = BigInt(requiredAmount);
  if (currentAllowance >= needed) return;
  const approveFn = token.getFunction("approve");
  const tx = await approveFn(spender, (1n << 256n) - 1n);
  await tx.wait();
}
