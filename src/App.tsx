import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AbiCoder, getAddress } from "ethers";
import baseConfig from "./config.json";
import arbitrumLogoUrl from "./assets/networks/arbitrum.svg";
import avalancheLogoUrl from "./assets/networks/avalanche.svg";
import baseLogoUrl from "./assets/networks/base.svg";
import bscLogoUrl from "./assets/networks/bsc.svg";
import ethereumLogoUrl from "./assets/networks/ethereum.svg";
import hyperevmLogoUrl from "./assets/networks/hyperevm.svg";
import inkLogoUrl from "./assets/networks/ink.svg";
import lineaLogoUrl from "./assets/networks/linea.svg";
import mantleLogoUrl from "./assets/networks/mantle.svg";
import monadLogoUrl from "./assets/networks/monad.svg";
import optimismLogoUrl from "./assets/networks/optimism.svg";
import nearLogoUrl from "./assets/networks/near.svg";
import plasmaLogoUrl from "./assets/networks/plasma.svg";
import polygonLogoUrl from "./assets/networks/polygon.svg";
import solanaLogoUrl from "./assets/networks/solana.svg";
import sonicLogoUrl from "./assets/networks/sonic.svg";
import unichainLogoUrl from "./assets/networks/unichain.svg";
import { IS_HOSTED_MODE } from "./modes";
import type { PendleMakerOrder, PendleMarketInfo } from "./pendle";

type NetworkConfig = {
  name: string;
  chain: string;
};

type QuoteApiConfig = {
  endpoint: string;
  endpointsByNetwork?: Record<string, string>;
  account: string;
  slippage: number;
  reusdMint?: {
    rpcUrl?: string;
    sampleResponse?: string;
    sampleInputAmount?: string;
    redeemFeePct?: number;
    callTo?: string;
    callData?: string;
    convertFromSharesContract?: string;
    convertFromSharesToken?: string;
    sharesDecimals?: number;
  };
};

type TokenConfig = {
  id: string;
  symbol: string;
  decimalsByNetwork: Record<string, number>;
  addresses: Record<string, string>;
  variantsByNetwork?: Record<string, TokenVariantConfig[]>;
};

type TokenVariantConfig = {
  id?: string;
  label?: string;
  address: string;
  decimals?: number;
};

type PairConfig = {
  id: string;
  amount?: string;
  baseTokenId: string;
  quoteTokenId: string;
  networks: Record<string, boolean>;
  allowSameChainArb?: boolean;
  sameChainRequiresDifferentMarkets?: boolean;
};

type ArbitrageRule = {
  id?: string;
  side?: "buy" | "sell";
  network?: string;
  tokenId?: string;
  tokenSymbol?: string;
  tokenSide?: "base" | "quote";
  minProfitPct: number;
  tag?: string;
};

type NotificationRule = {
  pairId: string;
  minProfitPct: number;
  networks?: Record<string, number>;
};

type NotificationsConfig = {
  enabled: boolean;
  minAmountChangePct?: number;
  telegram: {
    botToken: string;
    chatId: string;
  };
  pairs: NotificationRule[];
};

type PortfolioPositionConfig = {
  id: string;
  title?: string;
  protocol: string;
  chain: string;
  rpcUrl: string;
  tokenId: string;
  poolId?: string;
  walletAddress?: string;
  walletTag?: string;
  feeLabel?: string;
  factoryAddress?: string;
  positionManagerAddress?: string;
  stateViewAddress?: string;
  sourceMode?: PortfolioDiscoverySource["mode"];
};

type PortfolioWalletConfig = {
  address: string;
  tag?: string;
};

type PortfolioConfig = {
  refreshMs: number;
  notificationsEnabled: boolean;
  walletAddress?: string;
  walletTag?: string;
  wallets?: PortfolioWalletConfig[];
  ignoredEmptyPositionIds?: string[];
  positions: PortfolioPositionConfig[];
};

type PendleStrategyConfig = {
  id: string;
  enabled: boolean;
  chainId: number;
  marketAddress: string;
  amount: string;
  orderTokenAddress?: string;
  orderTokenSymbol?: string;
  orderTokenDecimals?: number;
  checkIntervalMs: number;
  targetDiscountPct: number;
  replaceLowerThresholdPct: number;
  replaceThresholdPct: number;
  orderExpiryMinutes: number;
};

type PendleConfig = {
  strategies: PendleStrategyConfig[];
  notificationsEnabled?: boolean;
  underlyingSymbol?: string;
  underlyingDecimals?: number;
  rpcByChainId: Record<string, string>;
  limitOrderContractByChainId: Record<string, string>;
};

type Settings = {
  defaultAmount: string;
  refreshMs: number;
  minProfitPct: number;
  arbitrageRules?: ArbitrageRule[];
  notifications?: NotificationsConfig;
  tokens: TokenConfig[];
  pairs: PairConfig[];
  networks: NetworkConfig[];
  quoteApi: QuoteApiConfig;
  portfolio?: PortfolioConfig;
  pendle?: PendleConfig;
};

type ArbSettings = Pick<
  Settings,
  "defaultAmount" | "refreshMs" | "minProfitPct" | "arbitrageRules" | "tokens" | "pairs" | "networks"
>;

type QuoteSide = {
  fromAmount: string;
  receiveAmount: string;
  price: string;
  fromSymbol: string;
  fromVariantLabel?: string;
  receiveSymbol: string;
  receiveVariantLabel?: string;
  market: string;
  raw: Record<string, unknown>;
};

type TokenVariant = {
  id: string;
  label: string;
  address: string;
  decimals: number;
  proxyTokenId?: string;
};

type VariantQuote = {
  id: string;
  networkId: string;
  status: "idle" | "loading" | "ok" | "error";
  baseVariant: TokenVariant;
  quoteVariant: TokenVariant;
  routeLabel?: string;
  buy?: QuoteSide;
  sell?: QuoteSide;
  error?: string;
  updatedAt?: number;
  roundTripPct?: number;
  excludeFromArb?: boolean;
};

type QuoteMap = Record<string, Record<string, VariantQuote[]>>;

function mergeLoadingQuoteMap(previous: QuoteMap, incoming: QuoteMap): QuoteMap {
  const merged: QuoteMap = {};
  Object.entries(incoming).forEach(([pairId, networks]) => {
    const mergedNetworks: Record<string, VariantQuote[]> = {};
    merged[pairId] = mergedNetworks;
    Object.entries(networks).forEach(([networkId, quotes]) => {
      const previousQuotes = previous[pairId]?.[networkId] ?? [];
      mergedNetworks[networkId] = quotes.map((quote) => {
        if (quote.status !== "loading") return quote;
        const previousQuote = previousQuotes.find((item) => item.id === quote.id);
        if (!previousQuote?.buy && !previousQuote?.sell) return quote;
        return {
          ...previousQuote,
          ...quote,
          buy: quote.buy ?? previousQuote.buy,
          sell: quote.sell ?? previousQuote.sell,
          updatedAt: quote.updatedAt ?? previousQuote.updatedAt,
          roundTripPct: quote.roundTripPct ?? previousQuote.roundTripPct,
        };
      });
    });
  });
  return merged;
}

function markQuoteMapRefreshing(previous: QuoteMap, activePairs: PairConfig[]): QuoteMap {
  const activePairIds = new Set(activePairs.map((pair) => pair.id));
  const merged: QuoteMap = {};
  Object.entries(previous).forEach(([pairId, networks]) => {
    const isActivePair = activePairIds.has(pairId);
    const mergedNetworks: Record<string, VariantQuote[]> = {};
    merged[pairId] = mergedNetworks;
    Object.entries(networks).forEach(([networkId, quotes]) => {
      mergedNetworks[networkId] = quotes.map((quote) => {
        if (!isActivePair || quote.status === "loading" || quote.status === "idle") {
          return quote;
        }
        const { error: _error, ...quoteWithoutError } = quote;
        return {
          ...quoteWithoutError,
          status: "loading",
        };
      });
    });
  });
  return merged;
}

type ArbSnapshotResponse = {
  ok: boolean;
  settings: ArbSettings;
  quoteMap: QuoteMap;
  updatedAt: number;
  refreshing?: boolean;
  stale?: boolean;
};

type PairSortColumn = "buyPrice" | "sellPrice";
type PairSortDirection = "asc" | "desc";
type PairSortState = {
  column: PairSortColumn;
  direction: PairSortDirection;
};

type ArbitrageOpportunity = {
  buyNet: string;
  sellNet: string;
  buyChain: string;
  sellChain: string;
  profit: number;
  profitTotal: number;
  profitPct: number;
  minProfitThreshold: number;
  buyPrice: number;
  sellPrice: number;
  amount: number;
  buyVariant?: string;
  sellVariant?: string;
  buyFromVariant?: string;
  buyToVariant?: string;
  sellFromVariant?: string;
  sellToVariant?: string;
  buyBaseVariant: TokenVariant;
  buyQuoteVariant: TokenVariant;
  sellBaseVariant: TokenVariant;
  sellQuoteVariant: TokenVariant;
  buyRouteLabel?: string;
  sellRouteLabel?: string;
  routeTags?: string[];
};

type PortfolioPositionSnapshot = {
  id: string;
  title: string;
  protocol: string;
  chain: string;
  tokenId: string;
  status: "loading" | "ok" | "error";
  inRange?: boolean;
  rangeText?: string;
  rangeMinText?: string;
  rangeMaxText?: string;
  currentPriceText?: string;
  balanceText?: string;
  exposureText?: string;
  positionValueText?: string;
  token0Symbol?: string;
  token1Symbol?: string;
  feeLabel?: string;
  hasBalance?: boolean;
  error?: string;
  updatedAt?: number;
};

type PortfolioDiscoverySource = {
  id: string;
  label: string;
  protocol: string;
  chain: string;
  rpcUrl: string;
  positionManagerAddress?: string;
  factoryAddress?: string;
  stateViewAddress?: string;
  sugarAddress?: string;
  voterAddress?: string;
  explorerApiUrl?: string;
  indexerUrl?: string;
  apiUrl?: string;
  contractAddress?: string;
  mode: "erc721" | "sugar" | "yuzu" | "initia";
};

type PortfolioDiscoveryProgressEvent = {
  type: "source-start" | "source-complete" | "source-error";
  source: PortfolioDiscoverySource;
  owner: string;
  tokenIds?: string[];
  error?: string;
};

type YuzuTokenMeta = {
  metadata: string;
  symbol: string;
  decimals: number;
};

type YuzuPoolMeta = {
  poolAddr: string;
  currentSqrtPrice: string;
  currentTick: number;
  feeRate: string;
  token0: string;
  token0Decimals: number;
  token1: string;
  token1Decimals: number;
};

type YuzuRawPosition = {
  id: string;
  liquidity: string;
  tick_lower: number;
  tick_upper: number;
  tokens_owed_0?: string;
  tokens_owed_1?: string;
};

type YuzuDiscoveredPosition = {
  tokenId: string;
  poolId: string;
};

type PortfolioScanStatus = {
  phase: "idle" | "scanning" | "refreshing";
  current: string;
  logLines: string[];
  activeSources: string[];
  scannedSources: number;
  totalSources: number;
  walletCount: number;
  foundByChain: Record<string, number>;
  foundTotal: number;
  updatedAt: number | null;
  nextUpdateAt: number | null;
  errors: string[];
  sourceStates: Record<string, "idle" | "scanning" | "done" | "error">;
};

type PendleOrderSnapshot = {
  id: string;
  createdAt?: string;
  expiresAt?: string;
  amount: string;
  orderApy: number | null;
  discountPct: number | null;
};

type PendleStrategyRuntime = {
  marketInfo: PendleMarketInfo | null;
  tokenMeta: { symbol: string; decimals: number } | null;
  currentApy: number | null;
  orders: PendleMakerOrder[];
  orderRows: PendleOrderSnapshot[];
  marketLoading: boolean;
  marketError: string | null;
  cycleError: string | null;
  cycleWarning: string | null;
  isRunning: boolean;
  lastCheckedAt: number | null;
  nextCycleAt: number | null;
};

const STORAGE_KEY = "cca.settings.v1";
const THEME_STORAGE_KEY = "cca.theme.v1";
const TAB_STORAGE_KEY = "cca.tab.v1";
const NOTIFICATIONS_STORAGE_KEY = "cca.notifications.v1";
const PORTFOLIO_STATUS_STORAGE_KEY = "cca.portfolio.rangeStatus.v1";
const HOSTED_ENABLED_PAIRS_STORAGE_KEY = "cca.hosted.enabledPairs.v1";
const HOSTED_PAIR_OVERRIDES_STORAGE_KEY = "cca.hosted.pairOverrides.v1";
const HOSTED_USER_ID_STORAGE_KEY = "cca.hosted.userId.v1";
const HOSTED_PRICE_ALERTS_STORAGE_KEY = "cca.hosted.priceAlerts.v1";
const HOSTED_DEFAULT_ENABLED_PAIR_IDS = ["usde-usdc"];
const DEFAULT_PRICE_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
type HostedPairOverride = {
  amount?: string;
  networks?: Record<string, boolean>;
};
type HostedPairOverrides = Record<string, HostedPairOverride>;
type HostedPriceAlertSide = "buy" | "sell";
type HostedPriceAlertOperator = "above" | "below";
type HostedPriceAlert = {
  id: string;
  pairId: string;
  side: HostedPriceAlertSide;
  operator: HostedPriceAlertOperator;
  price: number;
  networks: string[];
  enabled: boolean;
  cooldownMs: number;
  lastTriggeredAt?: number;
  createdAt?: number;
  updatedAt?: number;
};
type HostedTelegramAlertSettings = {
  chatId: string;
  username: string;
  firstName: string;
  connectedAt: number;
  enabled: boolean;
};
type HostedPriceAlertsState = {
  telegram: HostedTelegramAlertSettings;
  alerts: HostedPriceAlert[];
};
type HostedTelegramConnectState = {
  loading: boolean;
  error: string | null;
  botUsername: string;
  startUrl: string;
};
type ThemeMode = "system" | "dark" | "light";
type TabId = "arb" | "arb-new" | "portfolio" | "pendle";
const BASE_SETTINGS = baseConfig as unknown as Settings;
const ARB_SNAPSHOT_ENDPOINT = "/api/shared/arb-snapshot";
const ARB_REFRESH_ENDPOINT = "/api/cron/refresh-arb";
const ARB_STREAM_ENDPOINT = "/api/shared/arb-stream";
let pendleModulePromise: Promise<typeof import("./pendle")> | null = null;
const BASE_ARB_SETTINGS: ArbSettings = {
  defaultAmount: BASE_SETTINGS.defaultAmount,
  refreshMs: BASE_SETTINGS.refreshMs,
  minProfitPct: BASE_SETTINGS.minProfitPct,
  arbitrageRules: BASE_SETTINGS.arbitrageRules ?? [],
  tokens: BASE_SETTINGS.tokens,
  pairs: BASE_SETTINGS.pairs,
  networks: BASE_SETTINGS.networks,
};

function loadPendleModule() {
  if (IS_HOSTED_MODE) {
    return Promise.reject(new Error("Pendle is disabled in hosted mode"));
  }
  pendleModulePromise ??= import("./pendle");
  return pendleModulePromise;
}

function normalizeArbSettings(partial?: Partial<ArbSettings> | null): ArbSettings {
  return {
    defaultAmount: partial?.defaultAmount ?? BASE_ARB_SETTINGS.defaultAmount,
    refreshMs: partial?.refreshMs ?? BASE_ARB_SETTINGS.refreshMs,
    minProfitPct: partial?.minProfitPct ?? BASE_ARB_SETTINGS.minProfitPct,
    arbitrageRules: partial?.arbitrageRules ?? BASE_ARB_SETTINGS.arbitrageRules ?? [],
    tokens: partial?.tokens ?? BASE_ARB_SETTINGS.tokens,
    pairs: partial?.pairs ?? BASE_ARB_SETTINGS.pairs,
    networks: partial?.networks ?? BASE_ARB_SETTINGS.networks,
  };
}

function isMovementUsdcUsdtSourceDeal(pairId: string, sourceChain: string) {
  return pairId === "usdc-usdt" && sourceChain === "movement";
}

function isAvalancheSavusdRedeemSellDeal(pairId: string, sellChain: string, sellRouteLabel?: string) {
  return (
    pairId === "savusd-usdc" &&
    sellChain === "avalanche" &&
    /mint\s*\/\s*redeem/i.test(String(sellRouteLabel ?? ""))
  );
}

function getArbThresholdMultiplier(pairId: string, sourceChain: string, sellChain: string, sellRouteLabel?: string) {
  if (isAvalancheSavusdRedeemSellDeal(pairId, sellChain, sellRouteLabel)) {
    return 7;
  }
  if (isMovementUsdcUsdtSourceDeal(pairId, sourceChain)) {
    return 4;
  }
  if ((pairId === "weeth-weth" || pairId === "wsteth-weth") && (sourceChain === "base" || sourceChain === "arbitrum" || sourceChain === "optimism")) {
    return 25;
  }
  return 1;
}

function createPendleStrategyId(chainId: number, marketAddress: string, index = 0): string {
  const chain = Number.isFinite(chainId) && chainId > 0 ? chainId : 42161;
  const shortMarket = (marketAddress || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "market";
  return `pendle-${chain}-${shortMarket}-${index}`;
}

function createPendleRuntimeState(): PendleStrategyRuntime {
  return {
    marketInfo: null,
    tokenMeta: null,
    currentApy: null,
    orders: [],
    orderRows: [],
    marketLoading: false,
    marketError: null,
    cycleError: null,
    cycleWarning: null,
    isRunning: false,
    lastCheckedAt: null,
    nextCycleAt: null,
  };
}

function loadThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const raw = localStorage.getItem(THEME_STORAGE_KEY);
  if (raw === "dark" || raw === "light" || raw === "system") return raw;
  return "system";
}

function formatDefaultWalletTag(address: string): string {
  if (/^init1[0-9a-z]+$/i.test(address)) return `init...${address.slice(-3).toLowerCase()}`;
  return `0x...${address.slice(-3).toUpperCase()}`;
}

function normalizePortfolioWalletAddress(address: string): string {
  const trimmed = String(address ?? "").trim();
  if (/^init1[0-9a-z]+$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^0x[a-fA-F0-9]{64}$/.test(trimmed)) return trimmed.toLowerCase();
  return getAddress(trimmed);
}

function getDefaultPortfolioWallet(): PortfolioWalletConfig {
  return {
    address: DEFAULT_PORTFOLIO_WALLET_ADDRESS,
    tag: formatDefaultWalletTag(DEFAULT_PORTFOLIO_WALLET_ADDRESS),
  };
}

function resolveThemeMode(themeMode: ThemeMode): "dark" | "light" {
  if (themeMode !== "system") return themeMode;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function loadActiveTab(): TabId {
  if (typeof window === "undefined") return "arb";
  const raw = localStorage.getItem(TAB_STORAGE_KEY);
  if (IS_HOSTED_MODE) {
    return raw === "portfolio" ? "portfolio" : "arb";
  }
  if (raw === "portfolio" || raw === "pendle") return raw;
  return "arb";
}

function loadHostedEnabledPairIds(): string[] {
  if (!IS_HOSTED_MODE || typeof window === "undefined") return HOSTED_DEFAULT_ENABLED_PAIR_IDS;
  try {
    const raw = localStorage.getItem(HOSTED_ENABLED_PAIRS_STORAGE_KEY);
    if (!raw) return HOSTED_DEFAULT_ENABLED_PAIR_IDS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return HOSTED_DEFAULT_ENABLED_PAIR_IDS;
    const normalized = parsed.map((id) => String(id ?? "").trim()).filter(Boolean);
    return normalized.length > 0 ? Array.from(new Set(normalized)) : HOSTED_DEFAULT_ENABLED_PAIR_IDS;
  } catch {
    return HOSTED_DEFAULT_ENABLED_PAIR_IDS;
  }
}

function sanitizeHostedPairOverrides(value: unknown): HostedPairOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const overrides: HostedPairOverrides = {};
  Object.entries(value as Record<string, unknown>).forEach(([pairId, rawOverride]) => {
    if (!/^[a-z0-9-]+$/i.test(pairId) || !rawOverride || typeof rawOverride !== "object" || Array.isArray(rawOverride)) {
      return;
    }
    const override = rawOverride as HostedPairOverride;
    const next: HostedPairOverride = {};
    const amount = String(override.amount ?? "").trim();
    if (amount && Number.isFinite(Number(amount)) && Number(amount) > 0) {
      next.amount = amount;
    }
    if (override.networks && typeof override.networks === "object" && !Array.isArray(override.networks)) {
      const networks: Record<string, boolean> = {};
      Object.entries(override.networks).forEach(([chain, enabled]) => {
        if (/^[a-z0-9-]+$/i.test(chain)) networks[chain] = Boolean(enabled);
      });
      if (Object.keys(networks).length > 0) next.networks = networks;
    }
    if (Object.keys(next).length > 0) overrides[pairId] = next;
  });
  return overrides;
}

function loadHostedPairOverrides(): HostedPairOverrides {
  if (!IS_HOSTED_MODE || typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(HOSTED_PAIR_OVERRIDES_STORAGE_KEY);
    if (!raw) return {};
    return sanitizeHostedPairOverrides(JSON.parse(raw));
  } catch {
    return {};
  }
}

function createHostedUserId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `u_${crypto.randomUUID()}`;
  }
  return `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function loadHostedUserId() {
  if (!IS_HOSTED_MODE || typeof window === "undefined") return "";
  const existing = localStorage.getItem(HOSTED_USER_ID_STORAGE_KEY);
  if (existing && /^[a-z0-9_-]{8,80}$/i.test(existing)) return existing;
  const next = createHostedUserId();
  localStorage.setItem(HOSTED_USER_ID_STORAGE_KEY, next);
  return next;
}

function sanitizeHostedPriceAlert(value: unknown): HostedPriceAlert | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<HostedPriceAlert>;
  const pairId = String(raw.pairId ?? "").trim();
  if (!/^[a-z0-9-]+$/i.test(pairId)) return null;
  const side = raw.side === "sell" ? "sell" : raw.side === "buy" ? "buy" : null;
  if (!side) return null;
  const operator = raw.operator === "below" ? "below" : raw.operator === "above" ? "above" : null;
  if (!operator) return null;
  const price = Number(raw.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    id: /^[a-z0-9-]+$/i.test(String(raw.id ?? "")) ? String(raw.id) : `${pairId}-${side}`,
    pairId,
    side,
    operator,
    price,
    networks: Array.isArray(raw.networks)
      ? Array.from(new Set(raw.networks.map((item) => String(item ?? "").trim()).filter((item) => /^[a-z0-9-]+$/i.test(item))))
      : [],
    enabled: Boolean(raw.enabled),
    cooldownMs: Number.isFinite(Number(raw.cooldownMs)) && Number(raw.cooldownMs) >= 0 ? Number(raw.cooldownMs) : DEFAULT_PRICE_ALERT_COOLDOWN_MS,
    lastTriggeredAt: Number.isFinite(Number(raw.lastTriggeredAt)) ? Number(raw.lastTriggeredAt) : undefined,
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : undefined,
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : undefined,
  };
}

function sanitizeHostedPriceAlertsState(value: unknown): HostedPriceAlertsState {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<HostedPriceAlertsState> : {};
  const telegram = raw.telegram && typeof raw.telegram === "object" && !Array.isArray(raw.telegram) ? raw.telegram : {};
  const telegramChatId = String((telegram as Partial<HostedTelegramAlertSettings>).chatId ?? "").trim();
  return {
    telegram: {
      chatId: telegramChatId,
      username: String((telegram as Partial<HostedTelegramAlertSettings>).username ?? "").trim(),
      firstName: String((telegram as Partial<HostedTelegramAlertSettings>).firstName ?? "").trim(),
      connectedAt: Number.isFinite(Number((telegram as Partial<HostedTelegramAlertSettings>).connectedAt))
        ? Number((telegram as Partial<HostedTelegramAlertSettings>).connectedAt)
        : 0,
      enabled: Boolean((telegram as Partial<HostedTelegramAlertSettings>).enabled && telegramChatId),
    },
    alerts: Array.isArray(raw.alerts) ? raw.alerts.map(sanitizeHostedPriceAlert).filter(Boolean) as HostedPriceAlert[] : [],
  };
}

function loadHostedPriceAlertsState(): HostedPriceAlertsState {
  if (!IS_HOSTED_MODE || typeof window === "undefined") {
    return { telegram: { chatId: "", username: "", firstName: "", connectedAt: 0, enabled: false }, alerts: [] };
  }
  try {
    const raw = localStorage.getItem(HOSTED_PRICE_ALERTS_STORAGE_KEY);
    return sanitizeHostedPriceAlertsState(raw ? JSON.parse(raw) : {});
  } catch {
    return { telegram: { chatId: "", username: "", firstName: "", connectedAt: 0, enabled: false }, alerts: [] };
  }
}

function loadPortfolioRangeStatus(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(PORTFOLIO_STATUS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.entries(parsed).reduce<Record<string, boolean>>((statuses, [id, value]) => {
      if (typeof value === "boolean") statuses[id] = value;
      return statuses;
    }, {});
  } catch {
    return {};
  }
}

function persistPortfolioRangeStatus(statuses: Record<string, boolean>) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PORTFOLIO_STATUS_STORAGE_KEY, JSON.stringify(statuses));
  } catch {
    // Best effort only; the in-memory ref still handles the current session.
  }
}

function applyHostedPairOverridesToPairs(pairs: PairConfig[], overrides: HostedPairOverrides): PairConfig[] {
  if (!IS_HOSTED_MODE || Object.keys(overrides).length === 0) return pairs;
  return pairs.map((pair) => {
    const override = overrides[pair.id];
    if (!override) return pair;
    return {
      ...pair,
      amount: override.amount ?? pair.amount,
      networks: override.networks ? { ...pair.networks, ...override.networks } : pair.networks,
    };
  });
}

type PersistedNotifications = {
  notifications?: NotificationsConfig;
  portfolioNotificationsEnabled?: boolean;
  pendleNotificationsEnabled?: boolean;
};

function loadPersistedNotifications(): PersistedNotifications | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedNotifications;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function loadSettings(): Settings {
  if (typeof window === "undefined") {
    return BASE_SETTINGS;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return BASE_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return normalizeSettings(parsed);
  } catch {
    return BASE_SETTINGS;
  }
}

function normalizeSettings(partial: Partial<Settings>): Settings {
  const base = BASE_SETTINGS;
  const normalizeNetworkKey = (value?: string) => {
    if (!value) return "";
    const key = value.toLowerCase();
    if (key === "bnb") return "bsc";
    return key;
  };

  const normalizeKeyedMap = <T,>(map: Record<string, T>) => {
    const next: Record<string, T> = {};
    Object.entries(map).forEach(([key, value]) => {
      const normalized = normalizeNetworkKey(key);
      if (normalized) {
        next[normalized] = value;
      }
    });
    return next;
  };

  const savedNetworks = partial.networks ?? [];
  const networks = base.networks.map((net) => {
    const saved = savedNetworks.find(
      (item) => normalizeNetworkKey((item as { chain?: string; id?: string }).chain ?? (item as { id?: string }).id) === net.chain
    );
    return {
      ...net,
      ...saved,
      chain: net.chain,
    };
  });

  const networkKeys = networks.map((net) => net.chain);
  const legacyEnabled: Record<string, boolean> = {};
  base.networks.forEach((net) => {
    const enabled = (net as { enabled?: boolean }).enabled;
    if (typeof enabled === "boolean") {
      legacyEnabled[net.chain] = enabled;
    }
  });
  savedNetworks.forEach((net) => {
    const key = normalizeNetworkKey((net as { chain?: string; id?: string }).chain ?? (net as { id?: string }).id);
    const enabled = (net as { enabled?: boolean }).enabled;
    if (key && typeof enabled === "boolean") {
      legacyEnabled[key] = enabled;
    }
  });

  const tokenMap = new Map<string, TokenConfig>();
  const tokenOrder: string[] = [];
  let tokenCounter = 1;
  const slugifyTokenId = (value: string) => value.trim().toLowerCase().replace(/\s+/g, "-");
  const resolveTokenId = (value?: string) => {
    const raw = (value ?? "").trim();
    if (raw) return slugifyTokenId(raw);
    return `token-${tokenCounter++}`;
  };

  const upsertToken = (token?: Partial<TokenConfig>, fallback?: TokenConfig): string => {
    const id = resolveTokenId(token?.id ?? fallback?.id ?? token?.symbol ?? fallback?.symbol);
    const existing = tokenMap.get(id);
    const mergeVariants = (value?: Record<string, TokenVariantConfig[]>) => {
      if (!value) return {};
      const next: Record<string, TokenVariantConfig[]> = {};
      Object.entries(value).forEach(([key, list]) => {
        const normalized = normalizeNetworkKey(key);
        if (!normalized) return;
        next[normalized] = Array.isArray(list) ? list : [];
      });
      return next;
    };
    const variantsByNetwork = {
      ...(existing?.variantsByNetwork ?? fallback?.variantsByNetwork ?? {}),
      ...mergeVariants(token?.variantsByNetwork),
    };
    const merged: TokenConfig = {
      id,
      symbol: token?.symbol ?? existing?.symbol ?? fallback?.symbol ?? id.toUpperCase(),
      addresses: normalizeKeyedMap({
        ...(existing?.addresses ?? fallback?.addresses ?? {}),
        ...(token?.addresses ?? {}),
      }),
      decimalsByNetwork: normalizeKeyedMap({
        ...(existing?.decimalsByNetwork ?? fallback?.decimalsByNetwork ?? {}),
        ...(token?.decimalsByNetwork ?? {}),
      }),
      variantsByNetwork,
    };
    if (!existing) {
      tokenOrder.push(id);
    }
    tokenMap.set(id, merged);
    return id;
  };

  const baseTokens = base.tokens ?? [];
  baseTokens.forEach((token) => {
    upsertToken(token);
  });

  const savedTokensRaw = partial.tokens;
  if (Array.isArray(savedTokensRaw)) {
    savedTokensRaw.forEach((token) => {
      if (!token) return;
      const fallback = baseTokens.find((item) => item.id === token.id);
      upsertToken(token, fallback);
    });
  } else if (
    savedTokensRaw &&
    typeof savedTokensRaw === "object" &&
    ("base" in savedTokensRaw || "quote" in savedTokensRaw)
  ) {
    const legacyTokens = savedTokensRaw as { base?: Partial<TokenConfig>; quote?: Partial<TokenConfig> };
    if (legacyTokens.base) upsertToken(legacyTokens.base);
    if (legacyTokens.quote) upsertToken(legacyTokens.quote);
  }

  const ensureTokenId = (tokenId: string, label: string) => {
    if (tokenId) return tokenId;
    return upsertToken({ id: `token-${label}`, symbol: label.toUpperCase() });
  };

  const normalizePairNetworks = (
    savedMap?: Record<string, boolean>,
    baseMap?: Record<string, boolean>
  ) => {
    const next: Record<string, boolean> = {};
    networkKeys.forEach((chain) => {
      const normalized = normalizeNetworkKey(chain);
      const baseValue = baseMap?.[chain] ?? baseMap?.[normalized];
      const savedValue = savedMap?.[chain] ?? savedMap?.[normalized];
      if (typeof baseValue === "boolean") {
        // Config is authoritative for what can be enabled.
        next[chain] = baseValue && (typeof savedValue === "boolean" ? savedValue : true);
        return;
      }
      // Fallback for legacy/custom pairs that do not exist in config.
      next[chain] = Boolean(savedValue ?? legacyEnabled[chain] ?? false);
    });
    return next;
  };

  const normalizeNotificationNetworks = (map?: Record<string, number>) => {
    const next: Record<string, number> = {};
    if (!map) return next;
    Object.entries(map).forEach(([key, value]) => {
      const normalized = normalizeNetworkKey(key);
      if (!normalized) return;
      if (Number.isFinite(Number(value))) {
        next[normalized] = Number(value);
      }
    });
    return next;
  };

  const baseNotifications = base.notifications ?? {
    enabled: false,
    minAmountChangePct: 30,
    telegram: { botToken: "", chatId: "" },
    pairs: [],
  };
  const savedNotifications = (partial.notifications ?? {}) as Partial<NotificationsConfig>;
  const notificationsPairs = (savedNotifications.pairs ?? []).filter(Boolean) as NotificationRule[];
  const baseNotificationPairs = (baseNotifications.pairs ?? []).filter(Boolean) as NotificationRule[];
  const notifications: NotificationsConfig = {
    enabled: savedNotifications.enabled ?? baseNotifications.enabled ?? false,
    minAmountChangePct:
      Number.isFinite(Number(savedNotifications.minAmountChangePct))
        ? Number(savedNotifications.minAmountChangePct)
        : Number.isFinite(Number(baseNotifications.minAmountChangePct))
        ? Number(baseNotifications.minAmountChangePct)
        : 30,
    telegram: {
      botToken: savedNotifications.telegram?.botToken ?? baseNotifications.telegram?.botToken ?? "",
      chatId: savedNotifications.telegram?.chatId ?? baseNotifications.telegram?.chatId ?? "",
    },
    pairs: (partial.pairs ?? base.pairs).map((pair) => {
      const savedRule = notificationsPairs.find((rule) => rule.pairId === pair.id);
      const baseRule = baseNotificationPairs.find((rule) => rule.pairId === pair.id);
      const minProfit = savedRule?.minProfitPct ?? baseRule?.minProfitPct ?? base.minProfitPct;
      return {
        pairId: pair.id,
        minProfitPct: Number.isFinite(Number(minProfit)) ? Number(minProfit) : base.minProfitPct,
        networks: normalizeNotificationNetworks(savedRule?.networks ?? baseRule?.networks),
      };
    }),
  };
  if (IS_HOSTED_MODE) {
    notifications.telegram = {
      botToken: savedNotifications.telegram?.botToken ?? "",
      chatId: savedNotifications.telegram?.chatId ?? "",
    };
  }

  const basePortfolio = base.portfolio ?? {
    refreshMs: PORTFOLIO_REFRESH_MS,
    notificationsEnabled: false,
    walletAddress: getDefaultPortfolioWallet().address,
    walletTag: getDefaultPortfolioWallet().tag,
    wallets: [getDefaultPortfolioWallet()],
    ignoredEmptyPositionIds: [],
    positions: [],
  };
  const savedPortfolio = (partial.portfolio ?? {}) as Partial<PortfolioConfig>;
  const normalizePortfolioWallets = (wallets?: PortfolioWalletConfig[], options?: { allowEmpty?: boolean }) => {
    const deduped = new Map<string, PortfolioWalletConfig>();
    (wallets ?? []).forEach((wallet) => {
      try {
        const address = normalizePortfolioWalletAddress(String(wallet.address ?? "").trim());
        deduped.set(address.toLowerCase(), {
          address,
          tag: String(wallet.tag ?? "").trim() || formatDefaultWalletTag(address),
        });
      } catch {
        // Ignore invalid wallet rows.
      }
    });
    if (deduped.size === 0 && !options?.allowEmpty) {
      const fallback = getDefaultPortfolioWallet();
      deduped.set(fallback.address.toLowerCase(), fallback);
    }
    return Array.from(deduped.values());
  };
  const portfolioWallets = Array.isArray(savedPortfolio.wallets)
    ? normalizePortfolioWallets(
        [...((basePortfolio.wallets ?? []) as PortfolioWalletConfig[]), ...(savedPortfolio.wallets as PortfolioWalletConfig[])],
        { allowEmpty: true }
      )
    : normalizePortfolioWallets((basePortfolio.wallets ?? []) as PortfolioWalletConfig[]);
  const basePositions = Array.isArray(basePortfolio.positions) ? basePortfolio.positions : [];
  const savedPositions = Array.isArray(savedPortfolio.positions) ? savedPortfolio.positions : [];
  const ignoredEmptyPositionIds = Array.from(
    new Set(
      (Array.isArray(savedPortfolio.ignoredEmptyPositionIds) ? savedPortfolio.ignoredEmptyPositionIds : [])
        .map((id) => String(id ?? "").trim())
        .filter(Boolean)
    )
  );
  const basePositionById = new Map(basePositions.map((item) => [item.id, item]));
  const mergedPortfolioPositions: PortfolioPositionConfig[] = basePositions.map((item) => {
    const saved = savedPositions.find((entry) => entry.id === item.id);
    return {
      ...item,
      ...saved,
      id: item.id,
      // Config is authoritative for built-in positions so updates are not blocked by stale localStorage.
      protocol: item.protocol ?? saved?.protocol,
      chain: item.chain ?? saved?.chain,
      rpcUrl: item.rpcUrl ?? saved?.rpcUrl ?? "",
      tokenId: item.tokenId ?? saved?.tokenId ?? "",
      factoryAddress: item.factoryAddress ?? saved?.factoryAddress,
      positionManagerAddress: item.positionManagerAddress ?? saved?.positionManagerAddress,
      stateViewAddress: item.stateViewAddress ?? saved?.stateViewAddress,
    };
  });
  savedPositions
    .filter((item) => !basePositionById.has(item.id))
    .forEach((item) => {
      if (!item.id || !item.tokenId || !item.rpcUrl) return;
      mergedPortfolioPositions.push({
        id: item.id,
        title: item.title,
        protocol: item.protocol ?? "Uniswap v3",
        chain: item.chain ?? "Ethereum",
        rpcUrl: item.rpcUrl,
      tokenId: item.tokenId,
      poolId: item.poolId,
      walletAddress: item.walletAddress,
      walletTag: item.walletTag,
      feeLabel: item.feeLabel,
      factoryAddress: item.factoryAddress,
      positionManagerAddress: item.positionManagerAddress,
      stateViewAddress: item.stateViewAddress,
      sourceMode: item.sourceMode,
      });
    });
  const portfolio: PortfolioConfig = {
    refreshMs:
      Number.isFinite(Number(savedPortfolio.refreshMs)) && Number(savedPortfolio.refreshMs) > 1000
        ? Math.max(PORTFOLIO_REFRESH_MS, Number(savedPortfolio.refreshMs))
        : basePortfolio.refreshMs,
    notificationsEnabled:
      typeof savedPortfolio.notificationsEnabled === "boolean"
        ? savedPortfolio.notificationsEnabled
        : basePortfolio.notificationsEnabled,
    walletAddress:
      typeof savedPortfolio.walletAddress === "string"
        ? savedPortfolio.walletAddress
        : portfolioWallets[0]?.address ?? basePortfolio.walletAddress ?? "",
    walletTag:
      typeof savedPortfolio.walletTag === "string"
        ? savedPortfolio.walletTag
        : portfolioWallets[0]?.tag ?? basePortfolio.walletTag ?? "",
    wallets: portfolioWallets,
    ignoredEmptyPositionIds,
    positions: mergedPortfolioPositions,
  };
  if (IS_HOSTED_MODE) {
    portfolio.notificationsEnabled = false;
    portfolio.walletAddress = "";
    portfolio.walletTag = "";
    portfolio.wallets = [];
    portfolio.ignoredEmptyPositionIds = [];
    portfolio.positions = [];
  }

  const normalizeStringMap = (map?: Record<string, string>) => {
    const next: Record<string, string> = {};
    if (!map) return next;
    Object.entries(map).forEach(([key, value]) => {
      if (typeof value !== "string") return;
      const trimmed = value.trim();
      if (!trimmed) return;
      next[String(key)] = trimmed;
    });
    return next;
  };

  const basePendleRaw = (base.pendle ?? {}) as
    | (Partial<PendleConfig> & Partial<PendleStrategyConfig> & { strategies?: Partial<PendleStrategyConfig>[] })
    | undefined;
  const baseLegacyStrategy: PendleStrategyConfig = {
    id: createPendleStrategyId(
      Number(basePendleRaw?.chainId ?? 42161),
      String(basePendleRaw?.marketAddress ?? ""),
      0
    ),
    enabled: typeof basePendleRaw?.enabled === "boolean" ? basePendleRaw.enabled : false,
    chainId:
      Number.isFinite(Number(basePendleRaw?.chainId)) && Number(basePendleRaw?.chainId) > 0
        ? Number(basePendleRaw?.chainId)
        : 42161,
    marketAddress: String(basePendleRaw?.marketAddress ?? ""),
    amount: String(basePendleRaw?.amount ?? "1000"),
    orderTokenAddress: String(basePendleRaw?.orderTokenAddress ?? ""),
    orderTokenSymbol: String(basePendleRaw?.orderTokenSymbol ?? "TOKEN"),
    orderTokenDecimals:
      Number.isFinite(Number(basePendleRaw?.orderTokenDecimals)) && Number(basePendleRaw?.orderTokenDecimals) >= 0
        ? Number(basePendleRaw?.orderTokenDecimals)
        : 18,
    checkIntervalMs:
      Number.isFinite(Number(basePendleRaw?.checkIntervalMs)) && Number(basePendleRaw?.checkIntervalMs) >= 1_000
        ? Number(basePendleRaw?.checkIntervalMs)
        : 15_000,
    targetDiscountPct:
      Number.isFinite(Number(basePendleRaw?.targetDiscountPct)) && Number(basePendleRaw?.targetDiscountPct) > 0
        ? Number(basePendleRaw?.targetDiscountPct)
        : 9,
    replaceLowerThresholdPct:
      Number.isFinite(Number(basePendleRaw?.replaceLowerThresholdPct)) &&
      Number(basePendleRaw?.replaceLowerThresholdPct) >= 0
        ? Number(basePendleRaw?.replaceLowerThresholdPct)
        : 4.5,
    replaceThresholdPct:
      Number.isFinite(Number(basePendleRaw?.replaceThresholdPct)) && Number(basePendleRaw?.replaceThresholdPct) >= 0
        ? Number(basePendleRaw?.replaceThresholdPct)
        : 4.98,
    orderExpiryMinutes:
      Number.isFinite(Number(basePendleRaw?.orderExpiryMinutes)) && Number(basePendleRaw?.orderExpiryMinutes) > 0
        ? Number(basePendleRaw?.orderExpiryMinutes)
        : 1440,
  };
  const normalizePendleStrategy = (
    source: Partial<PendleStrategyConfig> | undefined,
    fallback: PendleStrategyConfig,
    index: number
  ): PendleStrategyConfig => {
    const chainId =
      Number.isFinite(Number(source?.chainId)) && Number(source?.chainId) > 0
        ? Number(source?.chainId)
        : fallback.chainId;
    const marketAddress =
      typeof source?.marketAddress === "string"
        ? source.marketAddress
        : fallback.marketAddress;
    return {
      id:
        typeof source?.id === "string" && source.id.trim()
          ? source.id.trim()
          : createPendleStrategyId(chainId, marketAddress, index),
      enabled: typeof source?.enabled === "boolean" ? source.enabled : fallback.enabled,
      chainId,
      marketAddress,
      amount: typeof source?.amount === "string" ? source.amount : fallback.amount,
      orderTokenAddress:
        typeof source?.orderTokenAddress === "string" ? source.orderTokenAddress : fallback.orderTokenAddress,
      orderTokenSymbol:
        typeof source?.orderTokenSymbol === "string" && source.orderTokenSymbol.trim()
          ? source.orderTokenSymbol
          : fallback.orderTokenSymbol,
      orderTokenDecimals:
        Number.isFinite(Number(source?.orderTokenDecimals)) && Number(source?.orderTokenDecimals) >= 0
          ? Number(source?.orderTokenDecimals)
          : fallback.orderTokenDecimals,
      checkIntervalMs:
        Number.isFinite(Number(source?.checkIntervalMs)) && Number(source?.checkIntervalMs) >= 1_000
          ? Number(source?.checkIntervalMs)
          : fallback.checkIntervalMs,
      targetDiscountPct:
        Number.isFinite(Number(source?.targetDiscountPct)) && Number(source?.targetDiscountPct) > 0
          ? Number(source?.targetDiscountPct)
          : fallback.targetDiscountPct,
      replaceLowerThresholdPct:
        Number.isFinite(Number(source?.replaceLowerThresholdPct)) && Number(source?.replaceLowerThresholdPct) >= 0
          ? Number(source?.replaceLowerThresholdPct)
          : fallback.replaceLowerThresholdPct,
      replaceThresholdPct:
        Number.isFinite(Number(source?.replaceThresholdPct)) && Number(source?.replaceThresholdPct) >= 0
          ? Number(source?.replaceThresholdPct)
          : fallback.replaceThresholdPct,
      orderExpiryMinutes:
        Number.isFinite(Number(source?.orderExpiryMinutes)) && Number(source?.orderExpiryMinutes) > 0
          ? Number(source?.orderExpiryMinutes)
          : fallback.orderExpiryMinutes,
    };
  };
  const baseStrategies = Array.isArray(basePendleRaw?.strategies) && basePendleRaw?.strategies.length > 0
    ? basePendleRaw.strategies.map((item, index) =>
        normalizePendleStrategy(item, baseLegacyStrategy, index)
      )
    : [baseLegacyStrategy];

  const savedPendle = (partial.pendle ?? {}) as
    | (Partial<PendleConfig> & Partial<PendleStrategyConfig> & { strategies?: Partial<PendleStrategyConfig>[] })
    | undefined;

  const savedLegacyStrategy: Partial<PendleStrategyConfig> = {
    enabled: savedPendle?.enabled,
    chainId: savedPendle?.chainId,
    marketAddress: savedPendle?.marketAddress,
    amount: savedPendle?.amount,
    orderTokenAddress: savedPendle?.orderTokenAddress,
    orderTokenSymbol: savedPendle?.orderTokenSymbol,
    orderTokenDecimals: savedPendle?.orderTokenDecimals,
    checkIntervalMs: savedPendle?.checkIntervalMs,
    targetDiscountPct: savedPendle?.targetDiscountPct,
    replaceLowerThresholdPct: savedPendle?.replaceLowerThresholdPct,
    replaceThresholdPct: savedPendle?.replaceThresholdPct,
    orderExpiryMinutes: savedPendle?.orderExpiryMinutes,
  };
  const savedStrategiesRaw = Array.isArray(savedPendle?.strategies)
    ? savedPendle?.strategies
    : undefined;
  const pendingStrategies = savedStrategiesRaw && savedStrategiesRaw.length > 0
    ? savedStrategiesRaw
    : [savedLegacyStrategy];
  const strategies = pendingStrategies
    .map((item, index) =>
      normalizePendleStrategy(item, baseStrategies[Math.min(index, baseStrategies.length - 1)] ?? baseLegacyStrategy, index)
    )
    .filter((item, index, arr) => arr.findIndex((other) => other.id === item.id) === index);

  const pendle: PendleConfig = {
    strategies: strategies.length > 0 ? strategies : [baseLegacyStrategy],
    notificationsEnabled:
      typeof savedPendle?.notificationsEnabled === "boolean"
        ? savedPendle.notificationsEnabled
        : typeof basePendleRaw?.notificationsEnabled === "boolean"
        ? basePendleRaw.notificationsEnabled
        : false,
    underlyingSymbol:
      (savedPendle?.underlyingSymbol as string | undefined) ??
      (basePendleRaw?.underlyingSymbol as string | undefined) ??
      "TOKEN",
    underlyingDecimals:
      Number.isFinite(Number(savedPendle?.underlyingDecimals)) && Number(savedPendle?.underlyingDecimals) >= 0
        ? Number(savedPendle?.underlyingDecimals)
        : Number.isFinite(Number(basePendleRaw?.underlyingDecimals))
        ? Number(basePendleRaw?.underlyingDecimals)
        : 18,
    rpcByChainId: {
      ...normalizeStringMap(basePendleRaw?.rpcByChainId),
      ...normalizeStringMap(savedPendle?.rpcByChainId),
    },
    limitOrderContractByChainId: {
      ...normalizeStringMap(basePendleRaw?.limitOrderContractByChainId),
      ...normalizeStringMap(savedPendle?.limitOrderContractByChainId),
    },
  };
  if (IS_HOSTED_MODE) {
    pendle.notificationsEnabled = false;
    pendle.strategies = [];
  }

  const normalizePair = (
    basePair?: PairConfig,
    savedPair?: Partial<PairConfig> & { base?: Partial<TokenConfig>; quote?: Partial<TokenConfig> }
  ): PairConfig => {
    const legacyBase = savedPair?.base ?? (basePair as { base?: Partial<TokenConfig> } | undefined)?.base;
    const legacyQuote = savedPair?.quote ?? (basePair as { quote?: Partial<TokenConfig> } | undefined)?.quote;
    const baseTokenId =
      savedPair?.baseTokenId ??
      basePair?.baseTokenId ??
      (legacyBase ? upsertToken(legacyBase) : "");
    const quoteTokenId =
      savedPair?.quoteTokenId ??
      basePair?.quoteTokenId ??
      (legacyQuote ? upsertToken(legacyQuote) : "");
    const id =
      savedPair?.id ??
      basePair?.id ??
      `${baseTokenId || "base"}-${quoteTokenId || "quote"}`;
    return {
      id,
      amount: savedPair?.amount ?? basePair?.amount ?? base.defaultAmount,
      baseTokenId: ensureTokenId(baseTokenId, "base"),
      quoteTokenId: ensureTokenId(quoteTokenId, "quote"),
      networks: normalizePairNetworks(savedPair?.networks, basePair?.networks),
      allowSameChainArb:
        typeof savedPair?.allowSameChainArb === "boolean"
          ? savedPair.allowSameChainArb
          : Boolean(basePair?.allowSameChainArb),
      sameChainRequiresDifferentMarkets:
        typeof savedPair?.sameChainRequiresDifferentMarkets === "boolean"
          ? savedPair.sameChainRequiresDifferentMarkets
          : typeof basePair?.sameChainRequiresDifferentMarkets === "boolean"
          ? basePair.sameChainRequiresDifferentMarkets
          : true,
    };
  };

  const savedPairs = Array.isArray(partial.pairs) ? partial.pairs : [];
  const basePairs = base.pairs ?? [];
  const pairIds = new Set(basePairs.map((pair) => pair.id));
  const mergedPairs = basePairs.map((pair) => {
    const saved = savedPairs.find((item) => item.id === pair.id);
    return normalizePair(pair, saved);
  });
  const extraPairs = savedPairs
    .filter((pair) => !pairIds.has(pair.id ?? ""))
    .map((pair) => normalizePair(undefined, pair));

  const legacyTokens = !Array.isArray(partial.tokens) && partial.tokens && typeof partial.tokens === "object"
    ? (partial.tokens as { base?: Partial<TokenConfig>; quote?: Partial<TokenConfig> })
    : null;
  const legacyPair = legacyTokens
    ? {
        id: `${legacyTokens.base?.symbol ?? "base"}-${legacyTokens.quote?.symbol ?? "quote"}`.toLowerCase(),
        amount: (partial as { baseAmount?: string }).baseAmount ?? base.defaultAmount,
        base: legacyTokens.base,
        quote: legacyTokens.quote,
      }
    : null;
  if (legacyPair) {
    if (savedPairs.length === 0 && mergedPairs.length > 0) {
      mergedPairs[0] = normalizePair(basePairs[0], legacyPair);
    } else if (mergedPairs.length === 0) {
      mergedPairs.push(normalizePair(undefined, legacyPair));
    }
  }

  const pairs = [...mergedPairs, ...extraPairs];
  const tokens = tokenOrder.map((id) => tokenMap.get(id)).filter(Boolean) as TokenConfig[];

  const quoteApi = {
    ...base.quoteApi,
    ...(partial.quoteApi ?? {}),
    // Always respect the config file endpoint to avoid stale localStorage values.
    endpoint: base.quoteApi.endpoint,
    endpointsByNetwork: normalizeKeyedMap({
      ...(((base.quoteApi as { endpointsByNetwork?: Record<string, string> }).endpointsByNetwork) ?? {}),
      ...(((partial.quoteApi as { endpointsByNetwork?: Record<string, string> }).endpointsByNetwork) ?? {}),
    }),
  };

  const normalizeRule = (rule: ArbitrageRule): ArbitrageRule => ({
    ...rule,
    network: normalizeNetworkKey(rule.network),
    tokenId: rule.tokenId?.trim() ?? undefined,
    tokenSymbol: rule.tokenSymbol?.trim() ?? undefined,
    minProfitPct:
      typeof rule.minProfitPct === "number" && Number.isFinite(rule.minProfitPct)
        ? rule.minProfitPct
        : base.minProfitPct,
  });
  const rulesSource = Array.isArray(partial.arbitrageRules)
    ? partial.arbitrageRules
    : base.arbitrageRules ?? [];
  const arbitrageRules = rulesSource.map(normalizeRule);

  return {
    ...base,
    ...partial,
    refreshMs: partial.refreshMs ?? base.refreshMs,
    minProfitPct: partial.minProfitPct ?? base.minProfitPct,
    defaultAmount:
      (partial as { defaultAmount?: string }).defaultAmount ??
      (partial as { baseAmount?: string }).baseAmount ??
      base.defaultAmount,
    pairs,
    arbitrageRules,
    notifications,
    tokens,
    networks,
    quoteApi,
    portfolio,
    pendle,
  };
}

function saveSettings(settings: Settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function formatNumber(value: string | number, maxFraction = 6): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Math.min(maxFraction, 4),
  }).format(num);
}

function formatProtocolDisplayName(value?: string | null): string {
  return String(value ?? "").replace(/\bUniswap\s+v(\d+)\b/gi, "Uni v$1");
}

const QUOTE_PRICE_OUTLIER_MULTIPLIER = 4;
const QUOTE_MIN_RECEIVE_VS_MEDIAN_RATIO = 0.25;
const QUOTE_ROUND_TRIP_MIN_RATIO = 0.5;
const QUOTE_ROUND_TRIP_MAX_RATIO = 1.5;

function finitePositiveNumber(value?: string | number | null): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function medianNumber(values: number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  const middleValue = sorted[middle];
  if (middleValue === undefined) return null;
  if (sorted.length % 2 === 1) return middleValue;
  const previousValue = sorted[middle - 1];
  return previousValue === undefined ? middleValue : (previousValue + middleValue) / 2;
}

function isWithinMultiplier(value: number, reference: number | null, multiplier: number): boolean {
  if (!reference || reference <= 0) return true;
  return value >= reference / multiplier && value <= reference * multiplier;
}

function isQuoteSaneForArbitrage(
  quote: VariantQuote,
  medians: {
    buyPrice: number | null;
    sellPrice: number | null;
    buyReceive: number | null;
  }
): boolean {
  const buyPrice = finitePositiveNumber(quote.buy?.price);
  const sellPrice = finitePositiveNumber(quote.sell?.price);
  const buyFrom = finitePositiveNumber(quote.buy?.fromAmount);
  const buyReceive = finitePositiveNumber(quote.buy?.receiveAmount);
  const sellFrom = finitePositiveNumber(quote.sell?.fromAmount);
  const sellReceive = finitePositiveNumber(quote.sell?.receiveAmount);
  if (!buyPrice || !sellPrice || !buyFrom || !buyReceive || !sellFrom || !sellReceive) return false;

  if (!isWithinMultiplier(buyPrice, medians.buyPrice, QUOTE_PRICE_OUTLIER_MULTIPLIER)) return false;
  if (!isWithinMultiplier(sellPrice, medians.sellPrice, QUOTE_PRICE_OUTLIER_MULTIPLIER)) return false;
  if (medians.buyReceive && buyReceive < medians.buyReceive * QUOTE_MIN_RECEIVE_VS_MEDIAN_RATIO) return false;

  const sellFromRatio = sellFrom / buyReceive;
  if (sellFromRatio < 0.95 || sellFromRatio > 1.05) return false;

  const roundTripRatio = sellReceive / buyFrom;
  return roundTripRatio >= QUOTE_ROUND_TRIP_MIN_RATIO && roundTripRatio <= QUOTE_ROUND_TRIP_MAX_RATIO;
}

function parseDateInputToMs(value?: string | number | null): number | null {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    try {
      let ms: bigint;
      if (raw.length <= 10) {
        ms = BigInt(raw) * 1000n; // unix seconds
      } else if (raw.length <= 13) {
        ms = BigInt(raw); // unix milliseconds
      } else if (raw.length <= 16) {
        ms = BigInt(raw) / 1000n; // microseconds
      } else {
        ms = BigInt(raw) / 1000000n; // nanoseconds+
      }
      const parsed = Number(ms);
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  const date = new Date(raw);
  const timestamp = date.getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function formatDateTime(value?: string | number | null): string {
  const ms = parseDateInputToMs(value);
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}

function formatDaysLeft(value?: string | number | null): string {
  const ms = parseDateInputToMs(value);
  if (ms === null) return "—";
  const diffMs = ms - Date.now();
  if (diffMs <= 0) return "Expired";
  const diffDays = diffMs / 86_400_000;
  if (diffDays >= 30) {
    return `${Math.floor(diffDays)} days left`;
  }
  if (diffDays >= 1) {
    return `${diffDays.toFixed(1)} days left`;
  }
  return `${(diffMs / 3_600_000).toFixed(1)} hours left`;
}

function formatShortCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
  if (minutes <= 0) return `${secs}s`;
  return `${minutes}m ${String(secs).padStart(2, "0")}s`;
}

function formatClockCountdown(ms: number): string {
  const safeSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function appendPortfolioLog(lines: string[], message: string): string[] {
  const timestamp = new Date().toLocaleTimeString();
  return [...lines, `[${timestamp}] ${message}`].slice(-PORTFOLIO_SCAN_LOG_LIMIT);
}

function summarizeChainCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "No positions found yet";
  return entries
    .map(([chain, count]) => `${count} ${count === 1 ? "position" : "positions"} on ${chain}`)
    .join(", ");
}

const MARKET_OPTIONS = ["kyberswap", "openocean", "okx"];
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DEFAULT_PORTFOLIO_WALLET_ADDRESS = "0x2156f29D64f81701B58877129006E8b1964149B6";
const DEFAULT_PENDLE_LIMIT_ROUTER = "0x000000000000c9b3e2c3ec88b1b4c0cd853f4321";
const PENDLE_WORKER_BASE =
  (import.meta.env.VITE_PENDLE_WORKER_BASE as string | undefined)?.trim() ||
  "/api/pendle";

const PENDLE_CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  56: "BNB Chain",
  146: "Sonic",
  42161: "Arbitrum",
  8453: "Base",
};

const PENDLE_CHAIN_NETWORK_KEY: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  56: "bnb",
  146: "sonic",
  42161: "arbitrum",
  8453: "base",
};

function extractMarketName(endpoint?: string): string {
  if (!endpoint) return "";
  const match = endpoint.match(/\/market\/([^/]+)\/swap_quote/i);
  return match?.[1] ?? "";
}

function buildMarketEndpoint(market: string) {
  return `https://canoe.v2.icarus.tools/market/${market}/swap_quote`;
}

function getVariantLabels(
  baseSymbol: string,
  quoteSymbol: string,
  baseVariant?: TokenVariant,
  quoteVariant?: TokenVariant
): string[] {
  const labels: string[] = [];
  const baseLabel = baseVariant?.label?.trim() ?? "";
  const quoteLabel = quoteVariant?.label?.trim() ?? "";
  if (baseLabel && baseLabel.toLowerCase() !== baseSymbol.toLowerCase()) {
    labels.push(baseLabel);
  }
  if (quoteLabel && quoteLabel.toLowerCase() !== quoteSymbol.toLowerCase()) {
    labels.push(quoteLabel);
  }
  return labels;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toAtomicAmount(amount: string, decimals: number): string {
  const normalized = amount.trim();
  if (!normalized) return "0";
  const [wholeRaw = "", fractionRaw = ""] = normalized.split(".");
  const whole = wholeRaw.replace(/\D/g, "") || "0";
  const fractionDigits = fractionRaw.replace(/\D/g, "");
  const paddedFraction = (fractionDigits + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${paddedFraction}`.replace(/^0+(?=\d)/, "");
  return combined || "0";
}

function fromAtomicAmount(amount: string, decimals: number): string {
  const sanitized = amount.replace(/\D/g, "");
  if (!sanitized) return "0";
  if (decimals <= 0) return sanitized;
  const pad = sanitized.padStart(decimals + 1, "0");
  const whole = pad.slice(0, -decimals);
  let frac = pad.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

const UNIV3_POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const UNIV3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const FLUENT_DEX_RPC_URL = "https://rpc.fluent.xyz";
const FLUENT_DEX_POSITION_MANAGER = "0x02bbE334A40E93a6460CCf18C4915Ae3886D12E9";
const FLUENT_DEX_FACTORY = "0x69Be606be7Fd2d27C8f9821329c748c77d24FF4f";
const SUSHI_V3_KATANA_POSITION_MANAGER = "0x2659C6085D26144117D904C46B48B6d180393d27";
const AERODROME_V3_BASE_POSITION_MANAGER = "0x827922686190790b37229fd06084350E74485b72";
const AERODROME_V3_BASE_FACTORY = "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a";
const AERODROME_VOTER_BASE = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5";
const UNIV3_PLASMA_POSITION_MANAGER = "0x743E03cceB4af2efA3CC76838f6E8B50B63F184c";
const UNIV3_PLASMA_FACTORY = "0xcb2436774C3e191c85056d248EF4260ce5f27A9D";
const VELODROME_V3_OPTIMISM_POSITION_MANAGER = "0x416b433906b1B72FA758e166e239c43d68dC6F29";
const VELODROME_V3_OPTIMISM_FACTORY = "0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F";
const VELODROME_VOTER_OPTIMISM = "0x41C914ee0c7E1A5edCD0295623e6dC557B5aBf3C";
const AERODROME_LP_SUGAR_BASE = "0x3058f92ebf83e2536f2084f20f7c0357d7d3ccfe";
const VELODROME_LP_SUGAR_OPTIMISM = "0x1d5E1893fCfb62CAaCE48eB2BAF7a6E134a8a27c";
const V3_DEPLOYMENTS: Record<string, { positionManager: string; factory?: string }> = {
  "uniswap_v3:ethereum": {
    positionManager: UNIV3_POSITION_MANAGER,
    factory: UNIV3_FACTORY,
  },
  "sushiswap_v3:katana": {
    positionManager: SUSHI_V3_KATANA_POSITION_MANAGER,
  },
  "aerodrome_v3:base": {
    positionManager: AERODROME_V3_BASE_POSITION_MANAGER,
    factory: AERODROME_V3_BASE_FACTORY,
  },
  "velodrome_v3:optimism": {
    positionManager: VELODROME_V3_OPTIMISM_POSITION_MANAGER,
    factory: VELODROME_V3_OPTIMISM_FACTORY,
  },
};
const UNIV4_DEPLOYMENTS: Record<string, { positionManager: string; stateView: string }> = {
  ethereum: {
    positionManager: "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e",
    stateView: "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227",
  },
  monad: {
    positionManager: "0x5b7EC4a94fF9beDb700fb82aB09d5846972F4016",
    stateView: "0x86e8631A016F9068C3f085fAF484Ee3f5FDeE8f2",
  },
};
const SELECTOR_POSITIONS = "0x99fbab88";
const SELECTOR_GET_POOL = "0x1698ee82";
const SELECTOR_SLOT0 = "0x3850c7bd";
const SELECTOR_DECIMALS = "0x313ce567";
const SELECTOR_SYMBOL = "0x95d89b41";
const SELECTOR_FACTORY = "0xc45a0155";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const YUZU_MOVEMENT_RPC_URL = "https://rpcproxy.yuzu.finance/v1";
const YUZU_MOVEMENT_INDEXER_URL = "https://rpc.sentio.xyz/movement-indexer/v1/graphql";
const YUZU_MOVEMENT_API_URL = "https://mainnet-api.yuzu.finance/v1";
const YUZU_MOVEMENT_CONTRACT =
  "0x46566b4a16a1261ab400ab5b9067de84ba152b5eb4016b217187f2a2ca980c5a";
const INITIA_REST_URL = "https://rest.initia.xyz";
const INITIA_DEX_API_URL = "https://dex-api.initia.xyz";
const INITIA_CLAMM_MODULE_ADDRESS =
  "0xd78a3b72c7ef0cfba7286bfb8c618aa4d6011dce05a832871cc9ab323c25f55e";
const INITIA_IUSD_USDC_LP_METADATA =
  "0xa83cdf62feab5f1a1e4c05005b14c534eb30266a5412522e2298a6506b3bf205";
const INITIA_IUSD_METADATA =
  "0x6c69733a9e722f3660afb524f89fce957801fa7e4408b8ef8fe89db9627b570e";
const INITIA_USDC_METADATA =
  "0xe0e9394b24e53775d6af87934ac02d73536ad58b7894f6ccff3f5e7c0d548e55";
const yuzuPoolCache = new Map<string, string[]>();
const yuzuTokenCache = new Map<string, Map<string, YuzuTokenMeta>>();
const yuzuPoolMetaCache = new Map<string, YuzuPoolMeta>();
const PORTFOLIO_DISCOVERY_SOURCES: PortfolioDiscoverySource[] = [
  {
    id: "uniswap-v3-ethereum",
    label: "Uniswap v3 on Ethereum",
    protocol: "Uniswap v3",
    chain: "Ethereum",
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    positionManagerAddress: UNIV3_POSITION_MANAGER,
    factoryAddress: UNIV3_FACTORY,
    mode: "erc721",
  },
  {
    id: "uniswap-v4-monad",
    label: "Uniswap v4 on Monad",
    protocol: "Uniswap v4",
    chain: "Monad",
    rpcUrl: "https://testnet-rpc.monad.xyz",
    positionManagerAddress: UNIV4_DEPLOYMENTS.monad?.positionManager,
    stateViewAddress: UNIV4_DEPLOYMENTS.monad?.stateView,
    mode: "erc721",
  },
  {
    id: "uniswap-v4-ethereum",
    label: "Uniswap v4 on Ethereum",
    protocol: "Uniswap v4",
    chain: "Ethereum",
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    positionManagerAddress: UNIV4_DEPLOYMENTS.ethereum?.positionManager,
    stateViewAddress: UNIV4_DEPLOYMENTS.ethereum?.stateView,
    mode: "erc721",
  },
  {
    id: "uniswap-v3-plasma",
    label: "Uniswap v3 on Plasma",
    protocol: "Uniswap v3",
    chain: "Plasma",
    rpcUrl: "https://plasma.drpc.org",
    positionManagerAddress: UNIV3_PLASMA_POSITION_MANAGER,
    factoryAddress: UNIV3_PLASMA_FACTORY,
    mode: "erc721",
  },
  {
    id: "fluent-dex-fluent",
    label: "Fluent DEX on Fluent",
    protocol: "Fluent DEX",
    chain: "Fluent",
    rpcUrl: FLUENT_DEX_RPC_URL,
    positionManagerAddress: FLUENT_DEX_POSITION_MANAGER,
    factoryAddress: FLUENT_DEX_FACTORY,
    mode: "erc721",
  },
  {
    id: "aerodrome-base",
    label: "Aerodrome Slipstream on Base",
    protocol: "Aerodrome v3",
    chain: "Base",
    rpcUrl: "https://base-rpc.publicnode.com",
    positionManagerAddress: AERODROME_V3_BASE_POSITION_MANAGER,
    factoryAddress: AERODROME_V3_BASE_FACTORY,
    sugarAddress: AERODROME_LP_SUGAR_BASE,
    voterAddress: AERODROME_VOTER_BASE,
    explorerApiUrl: "https://base.blockscout.com/api/v2",
    mode: "sugar",
  },
  {
    id: "velodrome-optimism",
    label: "Velodrome Slipstream on Optimism",
    protocol: "Velodrome v3",
    chain: "Optimism",
    rpcUrl: "https://optimism-rpc.publicnode.com",
    positionManagerAddress: VELODROME_V3_OPTIMISM_POSITION_MANAGER,
    factoryAddress: VELODROME_V3_OPTIMISM_FACTORY,
    sugarAddress: VELODROME_LP_SUGAR_OPTIMISM,
    voterAddress: VELODROME_VOTER_OPTIMISM,
    mode: "sugar",
  },
  {
    id: "yuzu-movement",
    label: "Yuzu on Movement",
    protocol: "Yuzu",
    chain: "Movement",
    rpcUrl: YUZU_MOVEMENT_RPC_URL,
    indexerUrl: YUZU_MOVEMENT_INDEXER_URL,
    apiUrl: YUZU_MOVEMENT_API_URL,
    contractAddress: YUZU_MOVEMENT_CONTRACT,
    mode: "yuzu",
  },
  {
    id: "initia-clamm",
    label: "Initia CLAMM",
    protocol: "Initia CLAMM",
    chain: "Initia",
    rpcUrl: INITIA_REST_URL,
    apiUrl: INITIA_DEX_API_URL,
    contractAddress: INITIA_CLAMM_MODULE_ADDRESS,
    mode: "initia",
  },
];
const SIGNATURE_V4_GET_POOL_AND_POSITION_INFO = "getPoolAndPositionInfo(uint256)";
const SIGNATURE_V4_GET_POSITION_LIQUIDITY = "getPositionLiquidity(uint256)";
const SIGNATURE_V4_GET_SLOT0 = "getSlot0(bytes32)";
const SIGNATURE_V4_GET_SLOT0_WITH_MANAGER = "getSlot0(address,bytes32)";
const SIGNATURE_V4_GET_SLOT0_BYTES25 = "getSlot0(bytes25)";
const SIGNATURE_V4_GET_SLOT0_WITH_MANAGER_BYTES25 = "getSlot0(address,bytes25)";
const SIGNATURE_V4_SLOT0 = "slot0(bytes32)";
const SIGNATURE_V4_SLOT0_WITH_MANAGER = "slot0(address,bytes32)";
const SIGNATURE_V4_SLOT0_BYTES25 = "slot0(bytes25)";
const SIGNATURE_V4_SLOT0_WITH_MANAGER_BYTES25 = "slot0(address,bytes25)";
const SIGNATURE_V4_POOL_MANAGER = "poolManager()";
const SIGNATURE_EXTSLOAD_BYTES32 = "extsload(bytes32)";
const V4_DYNAMIC_FEE_FLAG = 0x800000;
const V4_MAX_LP_FEE = 1_000_000;
const V4_SLOT0_MAPPING_SEARCH_LIMIT = 80;
const CHAIN_NATIVE_SYMBOL: Record<string, string> = {
  ethereum: "ETH",
  monad: "MON",
};
const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_TICK = 887272;
const selectorBySignature = new Map<string, string>();
const v4Slot0StorageSlotCache = new Map<string, number>();
const MASK_64 = (1n << 64n) - 1n;
const KECCAK_RATE_BYTES = 136;
const KECCAK_OUTPUT_BYTES = 32;
const KECCAK_ROUND_CONSTANTS: bigint[] = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];
const KECCAK_ROTATION_OFFSETS = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

function stripHexPrefix(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

function toHexPadded(value: bigint, bytes = 32): string {
  return value.toString(16).padStart(bytes * 2, "0");
}

function encodeAddressArg(address: string): string {
  const clean = stripHexPrefix(address).toLowerCase();
  return clean.padStart(64, "0");
}

function encodeUintArg(value: bigint): string {
  return toHexPadded(value, 32);
}

function encodeIntArg(value: bigint): string {
  const mod = 1n << 256n;
  const normalized = ((value % mod) + mod) % mod;
  return toHexPadded(normalized, 32);
}

function encodeBytes32Arg(value: string): string {
  return stripHexPrefix(value).padStart(64, "0").slice(-64);
}

function encodeFixedBytesArg(value: string, bytes: number): string {
  const targetHexLen = bytes * 2;
  const normalized = stripHexPrefix(value).padStart(targetHexLen, "0").slice(-targetHexLen);
  return `${normalized}${"0".repeat((32 - bytes) * 2)}`;
}

function normalizeChainKey(value?: string): string {
  if (!value) return "";
  const key = value.trim().toLowerCase();
  if (key === "bnb") return "bsc";
  if (key === "hyper") return "hyperevm";
  return key;
}

function NetworkLogo({ chain, name }: { chain: string; name: string }) {
  const key = normalizeChainKey(chain || name);
  if (key === "arbitrum") {
    return <img src={arbitrumLogoUrl} alt="" className="network-logo-image" />;
  }
  if (key === "avalanche") {
    return <img src={avalancheLogoUrl} alt="" className="network-logo-image" />;
  }
  if (key === "base") {
    return <img src={baseLogoUrl} alt="" className="network-logo-image" />;
  }
  if (key === "bsc") {
    return <img src={bscLogoUrl} alt="" className="network-logo-image" />;
  }
  if (key === "ethereum") {
    return <img src={ethereumLogoUrl} alt="" className="network-logo-image" />;
  }
  if (key === "hyperevm") {
    return <img src={hyperevmLogoUrl} alt="" className="network-logo-image" />;
  }
  if (key === "ink") {
    return <img src={inkLogoUrl} alt="" className="network-logo-image" />;
  }
  if (key === "linea") {
    return <img src={lineaLogoUrl} alt="" className="network-logo-image" />;
  }
  if (key === "mantle") {
    return <img src={mantleLogoUrl} alt="" className="network-logo-image" />;
  }
  if (key === "monad") {
    return <img src={monadLogoUrl} alt="" className="network-logo-image" />;
  }
  if (key === "optimism") {
    return <img src={optimismLogoUrl} alt="" className="network-logo-image" />;
  }
  if (key === "near") {
    return <img src={nearLogoUrl} alt="" className="network-logo-image" />;
  }
  if (key === "plasma") {
    return <img src={plasmaLogoUrl} alt="" className="network-logo-image" />;
  }
  if (key === "polygon") {
    return <img src={polygonLogoUrl} alt="" className="network-logo-image" />;
  }
  if (key === "solana") {
    return <img src={solanaLogoUrl} alt="" className="network-logo-image" />;
  }
  if (key === "sonic") {
    return <img src={sonicLogoUrl} alt="" className="network-logo-image" />;
  }
  if (key === "unichain") {
    return <img src={unichainLogoUrl} alt="" className="network-logo-image" />;
  }
  return (
    <span className="network-logo-fallback" aria-hidden="true">
      {name.trim().slice(0, 2).toUpperCase()}
    </span>
  );
}

function utf8ToHex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  const clean = stripHexPrefix(value);
  const normalized = clean.length % 2 === 0 ? clean : `0${clean}`;
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rotateLeft64(value: bigint, shift: number): bigint {
  if (shift === 0) return value & MASK_64;
  const left = (value << BigInt(shift)) & MASK_64;
  const right = value >> BigInt(64 - shift);
  return (left | right) & MASK_64;
}

function keccakF1600(state: BigUint64Array): void {
  const c = new BigUint64Array(5);
  const d = new BigUint64Array(5);
  const b = new BigUint64Array(25);
  for (let round = 0; round < 24; round += 1) {
    for (let x = 0; x < 5; x += 1) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    for (let x = 0; x < 5; x += 1) {
      d[x] = c[(x + 4) % 5]! ^ rotateLeft64(c[(x + 1) % 5]!, 1);
    }
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        state[x + 5 * y] = (state[x + 5 * y]! ^ d[x]!) & MASK_64;
      }
    }
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        const idx = x + 5 * y;
        const newX = y;
        const newY = (2 * x + 3 * y) % 5;
        b[newX + 5 * newY] = rotateLeft64(state[idx]!, KECCAK_ROTATION_OFFSETS[idx]!);
      }
    }
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        const idx = x + 5 * y;
        state[idx] =
          b[idx]! ^ (((~b[((x + 1) % 5) + 5 * y]!) & MASK_64) & b[((x + 2) % 5) + 5 * y]!);
      }
    }
    state[0] = (state[0]! ^ (KECCAK_ROUND_CONSTANTS[round] ?? 0n)) & MASK_64;
  }
}

function keccak256Hex(data: Uint8Array): string {
  const state = new BigUint64Array(25);
  const paddedLength = Math.ceil((data.length + 1) / KECCAK_RATE_BYTES) * KECCAK_RATE_BYTES;
  const padded = new Uint8Array(paddedLength);
  padded.set(data);
  padded[data.length] = 0x01;
  padded[paddedLength - 1] = (padded[paddedLength - 1] ?? 0) | 0x80;

  for (let offset = 0; offset < padded.length; offset += KECCAK_RATE_BYTES) {
    for (let i = 0; i < KECCAK_RATE_BYTES / 8; i += 1) {
      let lane = 0n;
      const laneOffset = offset + i * 8;
      for (let j = 0; j < 8; j += 1) {
        lane |= BigInt(padded[laneOffset + j] ?? 0) << BigInt(8 * j);
      }
      state[i] = (state[i]! ^ lane) & MASK_64;
    }
    keccakF1600(state);
  }

  const out = new Uint8Array(KECCAK_OUTPUT_BYTES);
  let outIndex = 0;
  let laneIndex = 0;
  while (outIndex < out.length) {
    const lane = state[laneIndex]!;
    for (let j = 0; j < 8 && outIndex < out.length; j += 1) {
      out[outIndex] = Number((lane >> BigInt(8 * j)) & 0xffn);
      outIndex += 1;
    }
    laneIndex += 1;
  }
  return `0x${bytesToHex(out)}`;
}

function keccak256Utf8(value: string): string {
  return keccak256Hex(new TextEncoder().encode(value));
}

function keccak256HexData(value: string): string {
  return keccak256Hex(hexToBytes(value));
}

function parseWord(data: string, index: number): string {
  const clean = stripHexPrefix(data);
  const start = index * 64;
  return clean.slice(start, start + 64).padEnd(64, "0");
}

function wordToAddress(word: string): string {
  return `0x${word.slice(24)}`;
}

function wordToBigInt(word: string): bigint {
  return BigInt(`0x${word || "0"}`);
}

function wordToUint24(word: string): number {
  return Number(wordToBigInt(word) & ((1n << 24n) - 1n));
}

function signedFromBits(value: bigint, bits: bigint): number {
  const mod = 1n << bits;
  const half = 1n << (bits - 1n);
  const normalized = value & (mod - 1n);
  const signed = normalized >= half ? normalized - mod : normalized;
  return Number(signed);
}

function isZeroAddress(address: string): boolean {
  return /^0x0{40}$/i.test(address);
}

function wordToSignedInt24(word: string): number {
  const mask = (1n << 24n) - 1n;
  const raw = wordToBigInt(word) & mask;
  const signed = raw >= (1n << 23n) ? raw - (1n << 24n) : raw;
  return Number(signed);
}

function decodeAbiString(data: string): string {
  const clean = stripHexPrefix(data);
  if (!clean) return "";
  if (clean.length === 64) {
    const bytes = clean.match(/.{1,2}/g) ?? [];
    return bytes
      .map((byte) => Number.parseInt(byte, 16))
      .filter((char) => char > 0)
      .map((char) => String.fromCharCode(char))
      .join("")
      .trim();
  }
  const offset = Number(wordToBigInt(parseWord(clean, 0)));
  const offsetWords = Math.floor(offset / 32);
  const length = Number(wordToBigInt(parseWord(clean, offsetWords)));
  if (!Number.isFinite(length) || length <= 0) return "";
  const start = (offsetWords + 1) * 64;
  const end = start + length * 2;
  const bytes = clean.slice(start, end).match(/.{1,2}/g) ?? [];
  return bytes.map((byte) => String.fromCharCode(Number.parseInt(byte, 16))).join("");
}

function normalizePortfolioTokenSymbol(symbol: string, chain?: string): string {
  const normalized = symbol.trim();
  if (normalizeChainKey(chain) === "fluent" && /^weth$/i.test(normalized)) {
    return "ETH";
  }
  return normalized;
}

const RPC_MIN_GAP_MS = 60;
const RPC_429_COOLDOWN_MS = 3_000;
const PLASMA_RPC_MIN_GAP_MS = 1_250;
const PLASMA_RPC_RATE_LIMIT_COOLDOWN_MS = 60_000;
const PLASMA_RPC_MAX_ATTEMPTS = 1;
const rpcQueueByUrl = new Map<string, Promise<void>>();
const rpcNextAllowedAtByUrl = new Map<string, number>();
const rpcRateLimitedUntilByUrl = new Map<string, number>();

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

function isPlasmaRpcUrl(rpcUrl: string): boolean {
  const normalized = rpcUrl.toLowerCase();
  return normalized.includes("plasma");
}

function getRpcMinGapMs(rpcUrl: string): number {
  return isPlasmaRpcUrl(rpcUrl) ? PLASMA_RPC_MIN_GAP_MS : RPC_MIN_GAP_MS;
}

function getRpcRateLimitCooldownMs(rpcUrl: string): number {
  return isPlasmaRpcUrl(rpcUrl) ? PLASMA_RPC_RATE_LIMIT_COOLDOWN_MS : RPC_429_COOLDOWN_MS;
}

function getRpcMaxAttempts(rpcUrl: string): number {
  return isPlasmaRpcUrl(rpcUrl) ? PLASMA_RPC_MAX_ATTEMPTS : 3;
}

function isRpcRateLimitError(message?: string, code?: number): boolean {
  const normalized = String(message ?? "").toLowerCase();
  return code === 15 || normalized.includes("too many request") || normalized.includes("rate limit");
}

async function scheduleRpcSlot(rpcUrl: string): Promise<void> {
  const previous = rpcQueueByUrl.get(rpcUrl) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  rpcQueueByUrl.set(rpcUrl, previous.then(() => current, () => current));

  try {
    await previous;
    const rateLimitedUntil = rpcRateLimitedUntilByUrl.get(rpcUrl) ?? 0;
    if (rateLimitedUntil > Date.now()) {
      throw new Error(`RPC rate limited; retry after ${Math.ceil((rateLimitedUntil - Date.now()) / 1000)}s`);
    }
    const waitMs = Math.max(0, (rpcNextAllowedAtByUrl.get(rpcUrl) ?? 0) - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    rpcNextAllowedAtByUrl.set(rpcUrl, Date.now() + getRpcMinGapMs(rpcUrl));
  } finally {
    release();
  }
}

async function rpcCall<T = string>(
  rpcUrl: string,
  method: string,
  params: unknown[]
): Promise<T> {
  const maxAttempts = getRpcMaxAttempts(rpcUrl);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await scheduleRpcSlot(rpcUrl);
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    });
    const text = await response.text();
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after")) ?? getRpcRateLimitCooldownMs(rpcUrl);
      rpcNextAllowedAtByUrl.set(
        rpcUrl,
        Math.max(rpcNextAllowedAtByUrl.get(rpcUrl) ?? 0, Date.now() + retryAfterMs)
      );
      rpcRateLimitedUntilByUrl.set(
        rpcUrl,
        Math.max(rpcRateLimitedUntilByUrl.get(rpcUrl) ?? 0, Date.now() + retryAfterMs)
      );
      if (attempt >= maxAttempts - 1) {
        throw new Error(`RPC HTTP 429: rate limited; retry after ${Math.ceil(retryAfterMs / 1000)}s`);
      }
      await sleep(retryAfterMs);
      continue;
    }
    if (!response.ok) {
      throw new Error(`RPC HTTP ${response.status}: ${text.slice(0, 160)}`);
    }
    const payload = JSON.parse(text) as { result?: T; error?: { message?: string } };
    if (payload.error) {
      if (isRpcRateLimitError(payload.error.message, (payload.error as { code?: number }).code)) {
        const retryAfterMs = getRpcRateLimitCooldownMs(rpcUrl) * (attempt + 1);
        rpcNextAllowedAtByUrl.set(
          rpcUrl,
          Math.max(rpcNextAllowedAtByUrl.get(rpcUrl) ?? 0, Date.now() + retryAfterMs)
        );
        rpcRateLimitedUntilByUrl.set(
          rpcUrl,
          Math.max(rpcRateLimitedUntilByUrl.get(rpcUrl) ?? 0, Date.now() + retryAfterMs)
        );
        if (attempt >= maxAttempts - 1) {
          throw new Error(`RPC rate limited; retry after ${Math.ceil(retryAfterMs / 1000)}s`);
        }
        await sleep(retryAfterMs);
        continue;
      }
      throw new Error(payload.error.message || "RPC error");
    }
    if (typeof payload.result === "undefined") {
      throw new Error("RPC result is empty");
    }
    return payload.result;
  }
  throw new Error("RPC request failed after retries");
}

async function resolveSelector(_rpcUrl: string, signature: string): Promise<string> {
  const cached = selectorBySignature.get(signature);
  if (cached) return cached;
  const selectorHash = keccak256Utf8(signature);
  const selector = `0x${stripHexPrefix(selectorHash).slice(0, 8)}`;
  selectorBySignature.set(signature, selector);
  return selector;
}

async function ethCallHex(rpcUrl: string, to: string, data: string): Promise<string> {
  const result = await rpcCall<string>(rpcUrl, "eth_call", [{ to, data }, "latest"]);
  return result;
}

type RpcLog = {
  topics?: string[];
  data?: string;
};

const MAX_LOG_BLOCK_RANGE = 50000n;
const POSITION_DISCOVERY_LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000;
const POSITION_DISCOVERY_CACHE_MS = 5 * 60 * 1000;
const BLOCKSCOUT_MAX_PAGES = 20;
const AERODROME_DEBUG_PREFIX = "[AerodromeDiscovery]";
const UNIV4_ETH_DEBUG_PREFIX = "[UniswapV4EthereumDiscovery]";
const PORTFOLIO_REFRESH_MS = 300_000;
const PORTFOLIO_SCAN_LOG_LIMIT = 18;
const discoveryFromBlockCache = new Map<string, { value: string; expiresAt: number }>();
const receivedErc721TokenIdsCache = new Map<string, { value: string[]; expiresAt: number }>();
const receivedErc721TokenIdsExplorerCache = new Map<string, { value: string[]; expiresAt: number }>();
const ownerOfCache = new Map<string, { value: string; expiresAt: number }>();
const gaugeByPoolCache = new Map<string, { value: string; expiresAt: number }>();

async function ethGetLogs(
  rpcUrl: string,
  filter: {
    address?: string;
    fromBlock?: string;
    toBlock?: string;
    topics?: Array<string | null>;
  }
): Promise<RpcLog[]> {
  const result = await rpcCall<RpcLog[]>(rpcUrl, "eth_getLogs", [filter]);
  return Array.isArray(result) ? result : [];
}

async function ethBlockNumber(rpcUrl: string): Promise<bigint> {
  const result = await rpcCall<string>(rpcUrl, "eth_blockNumber", []);
  return BigInt(result);
}

async function ethGetBlock(
  rpcUrl: string,
  blockTag: string
): Promise<{ number?: string; timestamp?: string } | null> {
  return rpcCall<{ number?: string; timestamp?: string } | null>(rpcUrl, "eth_getBlockByNumber", [
    blockTag,
    false,
  ]);
}

function parseHexBlockTag(value: string | undefined, fallback: bigint): bigint {
  if (!value || value === "latest") return fallback;
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
}

function extractMaxLogBlockRange(error: unknown): bigint | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/(?:exceed maximum block range|query exceeds max block range)\D+(\d+)/i);
  const matchedValue = match?.[1];
  if (!matchedValue) return null;
  try {
    const value = BigInt(matchedValue);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

async function ethGetLogsAdaptive(
  rpcUrl: string,
  filter: {
    address?: string;
    topics?: Array<string | null>;
  },
  start: bigint,
  end: bigint
): Promise<RpcLog[]> {
  try {
    return await ethGetLogs(rpcUrl, {
      ...filter,
      fromBlock: `0x${start.toString(16)}`,
      toBlock: `0x${end.toString(16)}`,
    });
  } catch (error) {
    const maxRange = extractMaxLogBlockRange(error);
    const currentRange = end - start;
    if (maxRange && currentRange > maxRange) {
      const out: RpcLog[] = [];
      for (let chunkStart = start; chunkStart <= end; chunkStart += maxRange + 1n) {
        const chunkEnd = chunkStart + maxRange > end ? end : chunkStart + maxRange;
        const chunk = await ethGetLogsAdaptive(rpcUrl, filter, chunkStart, chunkEnd);
        out.push(...chunk);
      }
      return out;
    }
    throw error;
  }
}

async function ethGetLogsChunked(
  rpcUrl: string,
  filter: {
    address?: string;
    fromBlock?: string;
    toBlock?: string;
    topics?: Array<string | null>;
  },
  options?: {
    newestFirst?: boolean;
  }
): Promise<RpcLog[]> {
  const latestBlock = await ethBlockNumber(rpcUrl);
  const fromBlock = parseHexBlockTag(filter.fromBlock, 0n);
  const toBlock = parseHexBlockTag(filter.toBlock, latestBlock);

  if (toBlock - fromBlock <= MAX_LOG_BLOCK_RANGE) {
    return ethGetLogsAdaptive(rpcUrl, filter, fromBlock, toBlock);
  }

  const out: RpcLog[] = [];
  if (options?.newestFirst) {
    for (let end = toBlock; end >= fromBlock; end -= MAX_LOG_BLOCK_RANGE + 1n) {
      const start = end > MAX_LOG_BLOCK_RANGE ? end - MAX_LOG_BLOCK_RANGE : 0n;
      const boundedStart = start < fromBlock ? fromBlock : start;
      const chunk = await ethGetLogsAdaptive(rpcUrl, filter, boundedStart, end);
      out.push(...chunk);
      if (boundedStart === fromBlock) break;
    }
  } else {
    for (let start = fromBlock; start <= toBlock; start += MAX_LOG_BLOCK_RANGE + 1n) {
      const end = start + MAX_LOG_BLOCK_RANGE > toBlock ? toBlock : start + MAX_LOG_BLOCK_RANGE;
      const chunk = await ethGetLogsAdaptive(rpcUrl, filter, start, end);
      out.push(...chunk);
    }
  }
  return out;
}

async function findBlockByTimestamp(rpcUrl: string, targetTimestampMs: number): Promise<bigint> {
  const latestBlockNumber = await ethBlockNumber(rpcUrl);
  const latestBlock = await ethGetBlock(rpcUrl, `0x${latestBlockNumber.toString(16)}`);
  const latestTimestampMs = latestBlock?.timestamp ? Number(BigInt(latestBlock.timestamp) * 1000n) : Date.now();
  if (!Number.isFinite(latestTimestampMs) || latestTimestampMs <= targetTimestampMs) {
    return 0n;
  }

  let low = 0n;
  let high = latestBlockNumber;
  while (low < high) {
    const mid = (low + high) / 2n;
    const block = await ethGetBlock(rpcUrl, `0x${mid.toString(16)}`);
    const timestampMs = block?.timestamp ? Number(BigInt(block.timestamp) * 1000n) : 0;
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
      break;
    }
    if (timestampMs < targetTimestampMs) {
      low = mid + 1n;
    } else {
      high = mid;
    }
  }
  return low;
}

async function getDiscoveryFromBlock(rpcUrl: string): Promise<string> {
  const cacheKey = rpcUrl.toLowerCase();
  const cached = discoveryFromBlockCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const targetTimestampMs = Date.now() - POSITION_DISCOVERY_LOOKBACK_MS;
  const blockNumber = await findBlockByTimestamp(rpcUrl, targetTimestampMs);
  const value = `0x${blockNumber.toString(16)}`;
  discoveryFromBlockCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + POSITION_DISCOVERY_CACHE_MS,
  });
  return value;
}

function encodeTopicAddress(address: string): string {
  return `0x${encodeAddressArg(address)}`;
}

async function fetchOwnedErc721TokenIds(
  rpcUrl: string,
  contractAddress: string,
  owner: string
): Promise<string[]> {
  const normalizedOwner = getAddress(owner);
  const isUniswapV4EthereumManager =
    contractAddress.toLowerCase() === (UNIV4_DEPLOYMENTS.ethereum?.positionManager ?? "").toLowerCase();
  const balanceRaw = await ethCallHex(
    rpcUrl,
    contractAddress,
    `0x70a08231${encodeAddressArg(normalizedOwner)}`
  );
  const balance = Number(wordToBigInt(parseWord(balanceRaw, 0)));
  if (isUniswapV4EthereumManager) {
    console.log(`${UNIV4_ETH_DEBUG_PREFIX} balanceOf`, {
      owner: normalizedOwner,
      contractAddress,
      balance,
    });
  }
  if (!Number.isFinite(balance) || balance <= 0) return [];

  const tokenOfOwnerByIndexSelector = await resolveSelector(
    rpcUrl,
    "tokenOfOwnerByIndex(address,uint256)"
  );

  try {
    const tokenIds = await Promise.all(
      Array.from({ length: balance }, async (_, index) => {
        const data =
          tokenOfOwnerByIndexSelector +
          encodeAddressArg(normalizedOwner) +
          encodeUintArg(BigInt(index));
        const raw = await ethCallHex(rpcUrl, contractAddress, data);
        return wordToBigInt(parseWord(raw, 0)).toString();
      })
    );
    const filtered = tokenIds.filter((tokenId) => tokenId !== "0");
    if (isUniswapV4EthereumManager) {
      console.log(`${UNIV4_ETH_DEBUG_PREFIX} tokenOfOwnerByIndex result`, {
        owner: normalizedOwner,
        tokenIds: filtered,
      });
    }
    return filtered;
  } catch (error) {
    if (isUniswapV4EthereumManager) {
      console.log(`${UNIV4_ETH_DEBUG_PREFIX} tokenOfOwnerByIndex failed`, {
        owner: normalizedOwner,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const recentVerified = await fetchOwnedErc721TokenIdsViaReceivedLogs(
      rpcUrl,
      contractAddress,
      normalizedOwner
    );
    if (isUniswapV4EthereumManager) {
      console.log(`${UNIV4_ETH_DEBUG_PREFIX} recent verified fallback after enumerable failure`, {
        owner: normalizedOwner,
        tokenIds: recentVerified,
        expectedBalance: balance,
      });
    }
    if (recentVerified.length >= balance) {
      return recentVerified;
    }

    const fullVerified = await fetchOwnedErc721TokenIdsViaReceivedLogs(
      rpcUrl,
      contractAddress,
      normalizedOwner,
      "0x0"
    );
    if (isUniswapV4EthereumManager) {
      console.log(`${UNIV4_ETH_DEBUG_PREFIX} full verified fallback after enumerable failure`, {
        owner: normalizedOwner,
        tokenIds: fullVerified,
        expectedBalance: balance,
      });
    }
    if (fullVerified.length >= balance) {
      return fullVerified;
    }

    const collectOwnedFromLogs = async (fromBlock: string) => {
      const ownerTopic = encodeTopicAddress(normalizedOwner).toLowerCase();
      const [receivedLogs, sentLogs] = await Promise.all([
        ethGetLogsChunked(
          rpcUrl,
          {
            address: contractAddress,
            fromBlock,
            toBlock: "latest",
            topics: [TRANSFER_TOPIC, null, ownerTopic],
          },
          { newestFirst: true }
        ),
        ethGetLogsChunked(
          rpcUrl,
          {
            address: contractAddress,
            fromBlock,
            toBlock: "latest",
            topics: [TRANSFER_TOPIC, ownerTopic],
          },
          { newestFirst: true }
        ),
      ]);
      if (isUniswapV4EthereumManager) {
        console.log(`${UNIV4_ETH_DEBUG_PREFIX} transfer log fallback raw`, {
          owner: normalizedOwner,
          fromBlock,
          receivedCount: receivedLogs.length,
          sentCount: sentLogs.length,
        });
      }
      const owned = new Set<string>();
      receivedLogs.forEach((log) => {
        const tokenId = log.topics?.[3] ? wordToBigInt(stripHexPrefix(log.topics[3])).toString() : "";
        if (tokenId) owned.add(tokenId);
      });
      sentLogs.forEach((log) => {
        const tokenId = log.topics?.[3] ? wordToBigInt(stripHexPrefix(log.topics[3])).toString() : "";
        if (tokenId) owned.delete(tokenId);
      });
      return Array.from(owned);
    };

    const fromBlock = await getDiscoveryFromBlock(rpcUrl);
    const recentOwned = await collectOwnedFromLogs(fromBlock);
    if (isUniswapV4EthereumManager) {
      console.log(`${UNIV4_ETH_DEBUG_PREFIX} recent log fallback`, {
        owner: normalizedOwner,
        fromBlock,
        tokenIds: recentOwned,
        expectedBalance: balance,
      });
    }
    if (recentOwned.length >= balance) {
      return recentOwned;
    }
    const fullOwned = await collectOwnedFromLogs("0x0");
    if (isUniswapV4EthereumManager) {
      console.log(`${UNIV4_ETH_DEBUG_PREFIX} full log fallback`, {
        owner: normalizedOwner,
        tokenIds: fullOwned,
      });
    }
    return fullOwned;
  }
}

async function fetchReceivedErc721TokenIdsFromBlock(
  rpcUrl: string,
  contractAddress: string,
  owner: string,
  fromBlock: string,
  cacheScope: string
): Promise<string[]> {
  const normalizedOwner = getAddress(owner);
  const isUniswapV4EthereumManager =
    contractAddress.toLowerCase() === (UNIV4_DEPLOYMENTS.ethereum?.positionManager ?? "").toLowerCase();
  const cacheKey = `${rpcUrl.toLowerCase()}|${contractAddress.toLowerCase()}|${normalizedOwner.toLowerCase()}|${cacheScope}|${fromBlock}`;
  const cached = receivedErc721TokenIdsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (isUniswapV4EthereumManager) {
      console.log(`${UNIV4_ETH_DEBUG_PREFIX} cached received transfer token ids`, {
        owner: normalizedOwner,
        fromBlock,
        cacheScope,
        tokenIds: cached.value,
      });
    }
    return cached.value;
  }
  const ownerTopic = encodeTopicAddress(normalizedOwner).toLowerCase();
  const receivedLogs = await ethGetLogsChunked(
    rpcUrl,
    {
      address: contractAddress,
      fromBlock,
      toBlock: "latest",
      topics: [TRANSFER_TOPIC, null, ownerTopic],
    },
    { newestFirst: true }
  );
  const tokenIds = new Set<string>();
  receivedLogs.forEach((log) => {
    const tokenId = log.topics?.[3] ? wordToBigInt(stripHexPrefix(log.topics[3])).toString() : "";
    if (tokenId) tokenIds.add(tokenId);
  });
  const value = Array.from(tokenIds);
  if (isUniswapV4EthereumManager) {
    console.log(`${UNIV4_ETH_DEBUG_PREFIX} received transfer logs`, {
      owner: normalizedOwner,
      fromBlock,
      cacheScope,
      receivedCount: receivedLogs.length,
      tokenIds: value,
    });
  }
  receivedErc721TokenIdsCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + POSITION_DISCOVERY_CACHE_MS,
  });
  return value;
}

async function fetchReceivedErc721TokenIds(
  rpcUrl: string,
  contractAddress: string,
  owner: string
): Promise<string[]> {
  const fromBlock = await getDiscoveryFromBlock(rpcUrl);
  return fetchReceivedErc721TokenIdsFromBlock(rpcUrl, contractAddress, owner, fromBlock, "recent");
}

async function fetchOwnedErc721TokenIdsViaReceivedLogs(
  rpcUrl: string,
  contractAddress: string,
  owner: string,
  fromBlock?: string
): Promise<string[]> {
  const normalizedOwner = getAddress(owner);
  const isUniswapV4EthereumManager =
    contractAddress.toLowerCase() === (UNIV4_DEPLOYMENTS.ethereum?.positionManager ?? "").toLowerCase();
  let receivedTokenIds: string[] = [];
  const resolvedFromBlock = fromBlock ?? await getDiscoveryFromBlock(rpcUrl);
  try {
    receivedTokenIds = await fetchReceivedErc721TokenIdsFromBlock(
      rpcUrl,
      contractAddress,
      normalizedOwner,
      resolvedFromBlock,
      fromBlock ? "full" : "recent"
    );
  } catch (error) {
    if (isUniswapV4EthereumManager) {
      console.log(`${UNIV4_ETH_DEBUG_PREFIX} received transfer lookup failed`, {
        owner: normalizedOwner,
        fromBlock: resolvedFromBlock,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return [];
  }
  if (isUniswapV4EthereumManager) {
    console.log(`${UNIV4_ETH_DEBUG_PREFIX} received transfer token ids`, {
      owner: normalizedOwner,
      fromBlock: resolvedFromBlock,
      tokenIds: receivedTokenIds,
    });
  }
  if (receivedTokenIds.length === 0) return [];
  const discovered = await Promise.all(
    receivedTokenIds.map(async (tokenId) => {
      try {
        const currentOwner = await fetchErc721OwnerOf(rpcUrl, contractAddress, tokenId);
        if (isUniswapV4EthereumManager) {
          console.log(`${UNIV4_ETH_DEBUG_PREFIX} ownerOf from received logs`, {
            owner: normalizedOwner,
            tokenId,
            currentOwner,
          });
        }
        return getAddress(currentOwner) === normalizedOwner ? tokenId : null;
      } catch {
        return null;
      }
    })
  );
  const filtered = discovered.filter((value): value is string => Boolean(value));
  if (isUniswapV4EthereumManager) {
    console.log(`${UNIV4_ETH_DEBUG_PREFIX} verified token ids from received logs`, {
      owner: normalizedOwner,
      tokenIds: filtered,
    });
  }
  return filtered;
}

type BlockscoutTokenTransfer = {
  timestamp?: string;
  to?: { hash?: string } | string;
  total?: { value?: string };
  token_instance?: { id?: string | number };
  token_id?: string | number;
  id?: string | number;
};

type BlockscoutLegacyNftTransfer = {
  timeStamp?: string;
  to?: string;
  tokenID?: string;
  tokenId?: string;
};

async function fetchReceivedErc721TokenIdsViaBlockscout(
  source: PortfolioDiscoverySource,
  contractAddress: string,
  owner: string,
  apiKey?: string
): Promise<string[] | null> {
  const normalizedApiKey = apiKey?.trim() ?? "";
  if (!source.explorerApiUrl) return null;

  const normalizedOwner = getAddress(owner);
  const lookbackStartMs = Date.now() - POSITION_DISCOVERY_LOOKBACK_MS;
  const cacheKey = [
    source.explorerApiUrl,
    contractAddress.toLowerCase(),
    normalizedOwner.toLowerCase(),
    String(Math.floor(lookbackStartMs / POSITION_DISCOVERY_CACHE_MS)),
    normalizedApiKey,
  ].join("|");
  const cached = receivedErc721TokenIdsExplorerCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (source.id === "aerodrome-base") {
      console.log(`${AERODROME_DEBUG_PREFIX} using cached Blockscout token ids`, {
        owner: normalizedOwner,
        count: cached.value.length,
        tokenIds: cached.value,
      });
    }
    return cached.value;
  }

  const fromBlock = await getDiscoveryFromBlock(source.rpcUrl);
  const legacyApiBase = source.explorerApiUrl.replace(/\/api\/v2\/?$/, "/api");
  const tokenIds = new Set<string>();
  const pageSize = 100;
  for (let page = 1; page <= BLOCKSCOUT_MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      module: "account",
      action: "tokennfttx",
      address: normalizedOwner,
      contractaddress: contractAddress,
      startblock: String(BigInt(fromBlock)),
      page: String(page),
      offset: String(pageSize),
      sort: "desc",
    });
    if (normalizedApiKey) query.set("apikey", normalizedApiKey);
    if (source.id === "aerodrome-base") {
      console.log(`${AERODROME_DEBUG_PREFIX} Blockscout request`, {
        owner: normalizedOwner,
        page,
        url: `${legacyApiBase}?${query.toString()}`,
      });
    }
    const response = await fetch(`${legacyApiBase}?${query.toString()}`);
    if (!response.ok) {
      if (source.id === "aerodrome-base") {
        console.log(`${AERODROME_DEBUG_PREFIX} Blockscout request failed`, {
          owner: normalizedOwner,
          page,
          status: response.status,
        });
      }
      throw new Error(`Explorer API HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      status?: string;
      message?: string;
      result?: BlockscoutLegacyNftTransfer[] | string;
    };
    const transfers = Array.isArray(payload.result) ? payload.result : [];
    if (source.id === "aerodrome-base") {
      console.log(`${AERODROME_DEBUG_PREFIX} Blockscout page response`, {
        owner: normalizedOwner,
        page,
        transferCount: transfers.length,
        status: payload.status ?? null,
        message: payload.message ?? null,
      });
    }
    let reachedLookbackLimit = false;
    transfers.forEach((transfer, transferIndex) => {
      const timestampMs = transfer.timeStamp ? Number(transfer.timeStamp) * 1000 : NaN;
      if (Number.isFinite(timestampMs) && timestampMs < lookbackStartMs) {
        reachedLookbackLimit = true;
        if (source.id === "aerodrome-base") {
          console.log(`${AERODROME_DEBUG_PREFIX} skipped transfer`, {
            owner: normalizedOwner,
            page,
            transferIndex,
            reason: "older_than_lookback",
            timestamp: transfer.timeStamp ?? null,
            to: transfer.to ?? null,
            tokenID: transfer.tokenID ?? null,
            tokenId: transfer.tokenId ?? null,
          });
        }
        return;
      }
      const toValue = String(transfer.to ?? "");
      if (toValue.toLowerCase() !== normalizedOwner.toLowerCase()) {
        if (source.id === "aerodrome-base") {
          console.log(`${AERODROME_DEBUG_PREFIX} skipped transfer`, {
            owner: normalizedOwner,
            page,
            transferIndex,
            reason: "to_mismatch",
            timestamp: transfer.timeStamp ?? null,
            to: transfer.to ?? null,
            parsedTo: toValue,
            tokenID: transfer.tokenID ?? null,
            tokenId: transfer.tokenId ?? null,
          });
        }
        return;
      }
      const tokenId = String(transfer.tokenID ?? transfer.tokenId ?? "").trim();
      if (tokenId) {
        tokenIds.add(tokenId);
        if (source.id === "aerodrome-base") {
          console.log(`${AERODROME_DEBUG_PREFIX} accepted transfer`, {
            owner: normalizedOwner,
            page,
            transferIndex,
            timestamp: transfer.timeStamp ?? null,
            tokenId,
          });
        }
        return;
      }
      if (source.id === "aerodrome-base") {
        console.log(`${AERODROME_DEBUG_PREFIX} skipped transfer`, {
          owner: normalizedOwner,
          page,
          transferIndex,
          reason: "missing_token_id",
          timestamp: transfer.timeStamp ?? null,
          to: transfer.to ?? null,
          tokenID: transfer.tokenID ?? null,
          tokenId: transfer.tokenId ?? null,
        });
      }
    });
    if (reachedLookbackLimit || transfers.length < pageSize) break;
  }

  const value = Array.from(tokenIds);
  if (source.id === "aerodrome-base") {
    console.log(`${AERODROME_DEBUG_PREFIX} Blockscout token ids`, {
      owner: normalizedOwner,
      count: value.length,
      tokenIds: value,
    });
  }
  receivedErc721TokenIdsExplorerCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + POSITION_DISCOVERY_CACHE_MS,
  });
  return value;
}

async function fetchErc721OwnerOf(
  rpcUrl: string,
  contractAddress: string,
  tokenId: string
): Promise<string> {
  const cacheKey = `${rpcUrl.toLowerCase()}|${contractAddress.toLowerCase()}|${tokenId}`;
  const cached = ownerOfCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const raw = await ethCallHex(
    rpcUrl,
    contractAddress,
    `0x6352211e${encodeUintArg(BigInt(tokenId))}`
  );
  const value = getAddress(wordToAddress(parseWord(raw, 0)));
  ownerOfCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + POSITION_DISCOVERY_CACHE_MS,
  });
  return value;
}

async function fetchV3TokenPoolAddress(
  source: PortfolioDiscoverySource,
  tokenId: string
): Promise<string> {
  if (!source.positionManagerAddress || !source.factoryAddress) {
    throw new Error("Missing v3 deployment metadata");
  }
  const positionsData = `${SELECTOR_POSITIONS}${encodeUintArg(BigInt(tokenId))}`;
  const rawPosition = await ethCallHex(source.rpcUrl, source.positionManagerAddress, positionsData);
  const token0 = wordToAddress(parseWord(rawPosition, 2));
  const token1 = wordToAddress(parseWord(rawPosition, 3));
  const fee = Number(wordToBigInt(parseWord(rawPosition, 4)));
  const getPoolSelector = getV3GetPoolSelector(source.protocol);
  const getPoolData =
    `${getPoolSelector}` +
    encodeAddressArg(token0) +
    encodeAddressArg(token1) +
    encodeUintArg(BigInt(fee));
  return getAddress(wordToAddress(parseWord(await ethCallHex(source.rpcUrl, source.factoryAddress, getPoolData), 0)));
}

async function fetchGaugeForPool(
  rpcUrl: string,
  voterAddress: string,
  poolAddress: string
): Promise<string> {
  const cacheKey = `${rpcUrl.toLowerCase()}|${voterAddress.toLowerCase()}|${poolAddress.toLowerCase()}`;
  const cached = gaugeByPoolCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const selector = await resolveSelector(rpcUrl, "gauges(address)");
  const raw = await ethCallHex(rpcUrl, voterAddress, `${selector}${encodeAddressArg(poolAddress)}`);
  const value = getAddress(wordToAddress(parseWord(raw, 0)));
  gaugeByPoolCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + POSITION_DISCOVERY_CACHE_MS,
  });
  return value;
}

async function isTokenStakedForOwner(
  source: PortfolioDiscoverySource,
  owner: string,
  tokenId: string
): Promise<boolean> {
  if (!source.voterAddress || !source.positionManagerAddress) return false;
  const poolAddress = await fetchV3TokenPoolAddress(source, tokenId);
  const gaugeAddress = await fetchGaugeForPool(source.rpcUrl, source.voterAddress, poolAddress);
  if (source.id === "aerodrome-base") {
    console.log(`${AERODROME_DEBUG_PREFIX} staking lookup`, {
      owner,
      tokenId,
      poolAddress,
      gaugeAddress,
    });
  }
  if (isZeroAddress(gaugeAddress)) return false;

  const normalizedOwner = getAddress(owner);
  try {
    const selector = await resolveSelector(source.rpcUrl, "stakedContains(address,uint256)");
    const raw = await ethCallHex(
      source.rpcUrl,
      gaugeAddress,
      `${selector}${encodeAddressArg(normalizedOwner)}${encodeUintArg(BigInt(tokenId))}`
    );
    const isStaked = wordToBigInt(parseWord(raw, 0)) !== 0n;
    if (source.id === "aerodrome-base") {
      console.log(`${AERODROME_DEBUG_PREFIX} stakedContains result`, {
        owner: normalizedOwner,
        tokenId,
        gaugeAddress,
        isStaked,
      });
    }
    return isStaked;
  } catch {
    const selector = await resolveSelector(source.rpcUrl, "stakedValues(address)");
    const raw = await ethCallHex(
      source.rpcUrl,
      gaugeAddress,
      `${selector}${encodeAddressArg(normalizedOwner)}`
    );
    const decoded = AbiCoder.defaultAbiCoder().decode(["uint256[]"], raw) as unknown[];
    const tokenIds = (decoded[0] ?? []) as bigint[];
    const isStaked = tokenIds.some((value) => value.toString() === tokenId);
    if (source.id === "aerodrome-base") {
      console.log(`${AERODROME_DEBUG_PREFIX} stakedValues result`, {
        owner: normalizedOwner,
        tokenId,
        gaugeAddress,
        stakedTokenIds: tokenIds.map((value) => value.toString()),
        isStaked,
      });
    }
    return isStaked;
  }
}

async function fetchStakedOrOwnedAerodromeTokenIds(
  source: PortfolioDiscoverySource,
  owner: string,
  explorerApiKey?: string
): Promise<string[]> {
  if (!source.positionManagerAddress) return [];
  const normalizedOwner = getAddress(owner);
  if (source.id === "aerodrome-base") {
    console.log(`${AERODROME_DEBUG_PREFIX} start`, {
      owner: normalizedOwner,
      explorerApiUrl: source.explorerApiUrl,
      usingApiKey: Boolean(explorerApiKey?.trim()),
    });
  }
  const explorerTokenIds = await fetchReceivedErc721TokenIdsViaBlockscout(
    source,
    source.positionManagerAddress,
    normalizedOwner,
    explorerApiKey
  );
  const candidateTokenIds = new Set((explorerTokenIds ?? []).filter(Boolean));
  if (source.id === "aerodrome-base") {
    console.log(`${AERODROME_DEBUG_PREFIX} candidate token ids`, {
      owner: normalizedOwner,
      count: candidateTokenIds.size,
      tokenIds: Array.from(candidateTokenIds),
    });
  }

  const discovered = await Promise.all(
    Array.from(candidateTokenIds).map(async (tokenId) => {
      try {
        const currentOwner = await fetchErc721OwnerOf(source.rpcUrl, source.positionManagerAddress!, tokenId);
        if (source.id === "aerodrome-base") {
          console.log(`${AERODROME_DEBUG_PREFIX} ownerOf result`, {
            owner: normalizedOwner,
            tokenId,
            currentOwner,
          });
        }
        if (getAddress(currentOwner) === normalizedOwner) {
          if (source.id === "aerodrome-base") {
            console.log(`${AERODROME_DEBUG_PREFIX} keeping owned token`, {
              owner: normalizedOwner,
              tokenId,
            });
          }
          return tokenId;
        }
        const isStaked = await isTokenStakedForOwner(source, normalizedOwner, tokenId);
        if (source.id === "aerodrome-base") {
          console.log(`${AERODROME_DEBUG_PREFIX} staking decision`, {
            owner: normalizedOwner,
            tokenId,
            isStaked,
          });
        }
        return isStaked ? tokenId : null;
      } catch (error) {
        if (source.id === "aerodrome-base") {
          console.log(`${AERODROME_DEBUG_PREFIX} token check failed`, {
            owner: normalizedOwner,
            tokenId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return null;
      }
    })
  );
  const filtered = discovered.filter((value): value is string => Boolean(value));
  if (source.id === "aerodrome-base") {
    console.log(`${AERODROME_DEBUG_PREFIX} final discovered token ids`, {
      owner: normalizedOwner,
      count: filtered.length,
      tokenIds: filtered,
    });
  }
  return filtered;
}

const SUGAR_POSITION_ABI =
  "tuple(uint256,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,int24,int24,uint160,uint160,address,uint32,address)[]";
const SUGAR_POSITIONS_PAGE_SIZE = 500n;
const SUGAR_MAX_PAGES = 12;

async function fetchSugarPositionIds(
  source: PortfolioDiscoverySource,
  owner: string
): Promise<string[]> {
  if (!source.sugarAddress) return [];
  const selector = await resolveSelector(source.rpcUrl, "positions(uint256,uint256,address)");
  const foundTokenIds = new Set<string>();

  for (let page = 0; page < SUGAR_MAX_PAGES; page += 1) {
    const offset = BigInt(page) * SUGAR_POSITIONS_PAGE_SIZE;
    const callData =
      selector +
      encodeUintArg(SUGAR_POSITIONS_PAGE_SIZE) +
      encodeUintArg(offset) +
      encodeAddressArg(owner);
    const raw = await ethCallHex(source.rpcUrl, source.sugarAddress, callData);
    const decoded = AbiCoder.defaultAbiCoder().decode([SUGAR_POSITION_ABI], raw) as unknown[];
    const positions = (decoded[0] ?? []) as Array<
      [
        bigint,
        string,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        number,
        number,
        bigint,
        bigint,
        string,
        number,
        string,
      ]
    >;
    if (positions.length === 0) break;

    positions
      .map((item) => ({
        tokenId: item[0]?.toString() ?? "",
        liquidity: item[2]?.toString() ?? "0",
        staked: item[3]?.toString() ?? "0",
      }))
      .filter(
        (item) =>
          item.tokenId &&
          item.tokenId !== "0" &&
          (item.liquidity !== "0" || item.staked !== "0")
      )
      .forEach((item) => {
        foundTokenIds.add(item.tokenId);
      });

    if (positions.length < Number(SUGAR_POSITIONS_PAGE_SIZE)) break;
  }

  return Array.from(foundTokenIds);
}

function normalizeMovementAccountAddress(address: string): string {
  const trimmed = String(address ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{1,64}$/.test(trimmed)) {
    throw new Error("Invalid Movement address");
  }
  return `0x${trimmed.replace(/^0x/, "").padStart(64, "0")}`;
}

function compactMovementAddress(address: string): string {
  return `0x${String(address).replace(/^0x/, "").replace(/^0+/, "") || "0"}`;
}

async function fetchYuzuJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Yuzu HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function fetchYuzuView<T>(
  source: PortfolioDiscoverySource,
  functionName: string,
  args: unknown[] = []
): Promise<T> {
  const contractAddress = source.contractAddress ?? YUZU_MOVEMENT_CONTRACT;
  return fetchYuzuJson<T>(`${source.rpcUrl.replace(/\/$/, "")}/view`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      function: `${contractAddress}::${functionName}`,
      type_arguments: [],
      arguments: args,
    }),
  });
}

async function fetchYuzuPoolIds(source: PortfolioDiscoverySource): Promise<string[]> {
  const cacheKey = `${source.rpcUrl}|${source.contractAddress ?? YUZU_MOVEMENT_CONTRACT}`;
  const cached = yuzuPoolCache.get(cacheKey);
  if (cached) return cached;
  const raw = await fetchYuzuView<Array<Array<{ inner: string }>>>(source, "liquidity_pool::get_all_pools");
  const poolIds = (raw[0] ?? []).map((pool) => compactMovementAddress(pool.inner)).filter(Boolean);
  yuzuPoolCache.set(cacheKey, poolIds);
  return poolIds;
}

async function fetchYuzuOwnedPositions(
  source: PortfolioDiscoverySource,
  owner: string
): Promise<YuzuDiscoveredPosition[]> {
  const indexerUrl = source.indexerUrl ?? YUZU_MOVEMENT_INDEXER_URL;
  const normalizedOwner = normalizeMovementAccountAddress(owner);
  const poolIds = await fetchYuzuPoolIds(source);
  if (poolIds.length === 0) return [];
  const creatorList = poolIds.map((poolId) => `"${normalizeMovementAccountAddress(poolId)}"`).join(",");
  const response = await fetchYuzuJson<{
    data?: {
      current_token_ownerships_v2?: Array<{
        current_token_data?: {
          token_name?: string;
          current_collection?: { creator_address?: string };
        };
      }>;
    };
    errors?: Array<{ message?: string }>;
  }>(indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `query MyQuery {
        current_token_ownerships_v2(
          where: {
            current_token_data: { current_collection: { creator_address: { _in: [${creatorList}] } } }
            owner_address: { _eq: "${normalizedOwner}" }
            amount: { _gt: "0" }
          }
        ) {
          current_token_data {
            token_name
            current_collection { creator_address }
          }
        }
      }`,
    }),
  });
  if (response.errors?.length) {
    throw new Error(response.errors.map((error) => error.message).filter(Boolean).join("; ") || "Yuzu indexer error");
  }
  const discovered = (response.data?.current_token_ownerships_v2 ?? [])
    .map((item) => ({
      tokenId: String(item.current_token_data?.token_name ?? "").trim(),
      poolId: compactMovementAddress(String(item.current_token_data?.current_collection?.creator_address ?? "")),
    }))
    .filter((item) => item.tokenId && item.poolId);
  const hydrated = await Promise.all(
    discovered.map(async (position) => {
      try {
        const raw = await fetchYuzuRawPosition(source, position.poolId, position.tokenId);
        return raw && BigInt(raw.liquidity || "0") > 0n ? position : null;
      } catch {
        return position;
      }
    })
  );
  return hydrated.filter((position): position is YuzuDiscoveredPosition => Boolean(position));
}

async function fetchYuzuTokenMap(source: PortfolioDiscoverySource): Promise<Map<string, YuzuTokenMeta>> {
  const apiUrl = source.apiUrl ?? YUZU_MOVEMENT_API_URL;
  const cached = yuzuTokenCache.get(apiUrl);
  if (cached) return cached;
  const response = await fetchYuzuJson<{ data?: YuzuTokenMeta[] }>(`${apiUrl.replace(/\/$/, "")}/tokens`);
  const tokenMap = new Map<string, YuzuTokenMeta>();
  (response.data ?? []).forEach((token) => {
    if (token.metadata) tokenMap.set(compactMovementAddress(token.metadata).toLowerCase(), token);
  });
  yuzuTokenCache.set(apiUrl, tokenMap);
  return tokenMap;
}

async function fetchYuzuPoolMeta(source: PortfolioDiscoverySource, poolId: string): Promise<YuzuPoolMeta> {
  const apiUrl = source.apiUrl ?? YUZU_MOVEMENT_API_URL;
  const normalizedPoolId = compactMovementAddress(poolId);
  const cacheKey = `${apiUrl}|${normalizedPoolId}`;
  const cached = yuzuPoolMetaCache.get(cacheKey);
  if (cached) return cached;
  const response = await fetchYuzuJson<{ data?: YuzuPoolMeta[] }>(
    `${apiUrl.replace(/\/$/, "")}/pools?keyword=${encodeURIComponent(normalizedPoolId)}`
  );
  const pool = (response.data ?? []).find(
    (item) => compactMovementAddress(item.poolAddr).toLowerCase() === normalizedPoolId.toLowerCase()
  );
  if (!pool) throw new Error("Yuzu pool not found");
  yuzuPoolMetaCache.set(cacheKey, pool);
  return pool;
}

async function fetchYuzuRawPosition(
  source: PortfolioDiscoverySource,
  poolId: string,
  tokenId: string
): Promise<YuzuRawPosition | null> {
  const raw = await fetchYuzuView<Array<Array<{ vec?: YuzuRawPosition[] }>>>(
    source,
    "position_nft_manager::get_positions",
    [[compactMovementAddress(poolId)], [tokenId]]
  );
  return raw[0]?.[0]?.vec?.[0] ?? null;
}

type InitiaDiscoveredPosition = {
  tokenId: string;
  poolId: string;
  tickLower: string;
  tickUpper: string;
  liquidity: string;
};

type InitiaPoolInfo = {
  swap_fee_bps?: string;
  tick_spacing?: string;
  metadata_0?: string;
  metadata_1?: string;
  tick_u64?: string;
  tick_neg?: boolean;
  sqrt_price?: string;
};

type InitiaRawPosition = {
  tick_lower?: { bits?: string };
  tick_upper?: { bits?: string };
  liquidity?: string;
};

async function fetchInitiaJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Initia HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function initiaHexObjectToBase64(value: string): string {
  const hex = String(value ?? "").trim().replace(/^0x/i, "");
  if (!/^[a-f0-9]{64}$/i.test(hex)) {
    throw new Error("Invalid Initia object id");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

async function fetchInitiaView<T>(
  source: PortfolioDiscoverySource,
  moduleName: "lens" | "pool",
  functionName: string,
  args: string[]
): Promise<T> {
  const restUrl = source.rpcUrl.replace(/\/$/, "");
  const moduleAddress = source.contractAddress ?? INITIA_CLAMM_MODULE_ADDRESS;
  const response = await fetchInitiaJson<{ data?: string }>(
    `${restUrl}/initia/move/v1/accounts/${moduleAddress}/modules/${moduleName}/view_functions/${functionName}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type_args: [], args }),
    }
  );
  return JSON.parse(response.data ?? "null") as T;
}

async function fetchInitiaOwnedPositions(
  source: PortfolioDiscoverySource,
  owner: string
): Promise<InitiaDiscoveredPosition[]> {
  const apiUrl = source.apiUrl ?? INITIA_DEX_API_URL;
  const positions: InitiaDiscoveredPosition[] = [];
  let nextKey: string | undefined;
  do {
    const params = new URLSearchParams({ "pagination.limit": "100" });
    if (nextKey) params.set("pagination.key", nextKey);
    const response = await fetchInitiaJson<{
      positions?: Array<{
        token_address?: string;
        lp_metadata?: string;
        tick_lower?: string;
        tick_upper?: string;
        liquidity?: string;
      }>;
      pagination?: { next_key?: string | null };
    }>(`${apiUrl.replace(/\/$/, "")}/indexer/clamm/v1/positions/${owner}?${params.toString()}`);
    (response.positions ?? []).forEach((position) => {
      const tokenId = String(position.token_address ?? "").trim();
      const poolId = String(position.lp_metadata ?? "").trim();
      const liquidity = String(position.liquidity ?? "0");
      if (tokenId && poolId && BigInt(liquidity || "0") > 0n) {
        positions.push({
          tokenId,
          poolId,
          tickLower: String(position.tick_lower ?? "0"),
          tickUpper: String(position.tick_upper ?? "0"),
          liquidity,
        });
      }
    });
    nextKey = response.pagination?.next_key ?? undefined;
  } while (nextKey);
  return positions;
}

function toDiscoveredPortfolioPosition(
  source: PortfolioDiscoverySource,
  tokenId: string,
  owner: string,
  options?: { poolId?: string }
): PortfolioPositionConfig {
  const chainLabel = source.chain.trim();
  const protocolLabel = source.protocol.trim();
  const walletAddress = normalizePortfolioWalletAddress(owner);
  const poolId = options?.poolId
    ? source.mode === "yuzu"
      ? compactMovementAddress(options.poolId)
      : options.poolId
    : undefined;
  const positionKey = poolId ? `${poolId}:${tokenId}` : tokenId;
  return {
    id: `${walletAddress.toLowerCase()}:${normalizeChainKey(chainLabel)}:${protocolLabel
      .toLowerCase()
      .replace(/\s+/g, "-")}:${positionKey}`,
    protocol: protocolLabel,
    chain: chainLabel,
    rpcUrl: source.rpcUrl,
    tokenId,
    poolId,
    walletAddress,
    positionManagerAddress: source.positionManagerAddress,
    factoryAddress: source.factoryAddress,
    stateViewAddress: source.stateViewAddress,
    sourceMode: source.mode,
  };
}

async function discoverPortfolioPositions(
  owner: string,
  options?: {
    explorerApiKey?: string;
    onProgress?: (event: PortfolioDiscoveryProgressEvent) => void;
  }
): Promise<PortfolioPositionConfig[]> {
  const normalizedOwner = normalizePortfolioWalletAddress(owner);
  console.log("[PortfolioDiscovery] start", {
    owner: normalizedOwner,
    sourceCount: PORTFOLIO_DISCOVERY_SOURCES.length,
  });
  const discoveredGroups = await Promise.all(
    PORTFOLIO_DISCOVERY_SOURCES.map(async (source) => {
      options?.onProgress?.({ type: "source-start", source, owner: normalizedOwner });
      try {
      const isMovementAccount = /^0x[a-f0-9]{64}$/.test(normalizedOwner);
      const isInitiaAccount = /^init1[0-9a-z]+$/.test(normalizedOwner);
      if (isInitiaAccount && source.mode !== "initia") {
        options?.onProgress?.({ type: "source-complete", source, owner: normalizedOwner, tokenIds: [] });
        return [];
      }
      if (!isInitiaAccount && source.mode === "initia") {
        options?.onProgress?.({ type: "source-complete", source, owner: normalizedOwner, tokenIds: [] });
        return [];
      }
      if (isMovementAccount && source.mode !== "yuzu") {
        options?.onProgress?.({ type: "source-complete", source, owner: normalizedOwner, tokenIds: [] });
        return [];
      }
      if (source.id === "aerodrome-base") {
        console.log("[PortfolioDiscovery] entering source", {
          sourceId: source.id,
          owner: normalizedOwner,
          mode: source.mode,
        });
      }
      if (source.id === "uniswap-v4-ethereum") {
        console.log(`${UNIV4_ETH_DEBUG_PREFIX} entering source`, {
          owner: normalizedOwner,
          sourceId: source.id,
          mode: source.mode,
          positionManagerAddress: source.positionManagerAddress,
          stateViewAddress: source.stateViewAddress,
        });
      }
      const tokenIdSet = new Set<string>();
      if (source.mode === "yuzu") {
        const positions = await fetchYuzuOwnedPositions(source, normalizedOwner);
        positions.forEach((position) => tokenIdSet.add(`${position.poolId}:${position.tokenId}`));
      } else if (source.mode === "initia") {
        const positions = await fetchInitiaOwnedPositions(source, normalizedOwner);
        positions.forEach((position) => tokenIdSet.add(`${position.poolId}:${position.tokenId}`));
      } else if (source.mode === "sugar") {
        (await fetchSugarPositionIds(source, normalizedOwner)).forEach((tokenId) => tokenIdSet.add(tokenId));
        if (source.id === "aerodrome-base") {
          (await fetchStakedOrOwnedAerodromeTokenIds(
            source,
            normalizedOwner,
            options?.explorerApiKey
          )).forEach((tokenId) =>
            tokenIdSet.add(tokenId)
          );
          console.log("[PortfolioDiscovery] aerodrome merged token ids", {
            owner: normalizedOwner,
            tokenIds: Array.from(tokenIdSet),
          });
        }
      } else if (source.positionManagerAddress) {
        (await fetchOwnedErc721TokenIds(source.rpcUrl, source.positionManagerAddress, normalizedOwner)).forEach(
          (tokenId) => tokenIdSet.add(tokenId)
        );
        if (/uniswap\s*v4/i.test(source.protocol)) {
          (
            await fetchOwnedErc721TokenIdsViaReceivedLogs(
              source.rpcUrl,
              source.positionManagerAddress,
              normalizedOwner
            )
          ).forEach((tokenId) => tokenIdSet.add(tokenId));
        }
      }
      const tokenIds = Array.from(tokenIdSet);
      if (source.id === "uniswap-v4-ethereum") {
        console.log(`${UNIV4_ETH_DEBUG_PREFIX} merged token ids`, {
          owner: normalizedOwner,
          tokenIds,
        });
      }
      options?.onProgress?.({ type: "source-complete", source, owner: normalizedOwner, tokenIds });
      return tokenIds.map((tokenId) => {
        if (source.mode === "yuzu") {
          const [poolId, positionId] = tokenId.split(":");
          return toDiscoveredPortfolioPosition(source, positionId ?? tokenId, normalizedOwner, { poolId });
        }
        if (source.mode === "initia") {
          const [poolId, positionId] = tokenId.split(":");
          return toDiscoveredPortfolioPosition(source, positionId ?? tokenId, normalizedOwner, { poolId });
        }
        return toDiscoveredPortfolioPosition(source, tokenId, normalizedOwner);
      });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options?.onProgress?.({ type: "source-error", source, owner: normalizedOwner, error: message });
        console.log("[PortfolioDiscovery] source failed", {
          owner: normalizedOwner,
          sourceId: source.id,
          protocol: source.protocol,
          chain: source.chain,
          error: message,
        });
        return [];
      }
    })
  );

  const deduped = new Map<string, PortfolioPositionConfig>();
  discoveredGroups.flat().forEach((position) => {
    deduped.set(position.id, position);
  });

  return Array.from(deduped.values()).sort((a, b) => {
    const chainCompare = a.chain.localeCompare(b.chain);
    if (chainCompare !== 0) return chainCompare;
    const protocolCompare = a.protocol.localeCompare(b.protocol);
    if (protocolCompare !== 0) return protocolCompare;
    try {
      const aId = BigInt(a.tokenId);
      const bId = BigInt(b.tokenId);
      if (aId === bId) return 0;
      return aId < bId ? -1 : 1;
    } catch {
      return a.tokenId.localeCompare(b.tokenId);
    }
  });
}

function resolveNativeSymbol(chainKey: string): string {
  return CHAIN_NATIVE_SYMBOL[chainKey] ?? "NATIVE";
}

function formatV4FeeLabel(fee: number): string {
  if (fee <= 0) return "0%";
  if ((fee & V4_DYNAMIC_FEE_FLAG) !== 0) return "Dynamic";
  return `${(fee / 10000).toFixed(2)}%`;
}

type TokenMeta = {
  symbol: string;
  decimals: number;
};

async function fetchTokenMeta(rpcUrl: string, chainKey: string, tokenAddress: string): Promise<TokenMeta> {
  if (isZeroAddress(tokenAddress)) {
    return {
      symbol: resolveNativeSymbol(chainKey),
      decimals: 18,
    };
  }
  const [decimalsRaw, symbolRaw] = await Promise.all([
    ethCallHex(rpcUrl, tokenAddress, SELECTOR_DECIMALS),
    ethCallHex(rpcUrl, tokenAddress, SELECTOR_SYMBOL),
  ]);
  const decimals = Number(wordToBigInt(parseWord(decimalsRaw, 0)));
  const symbol = decodeAbiString(symbolRaw) || "TOKEN";
  return {
    symbol,
    decimals: Number.isFinite(decimals) && decimals >= 0 ? decimals : 18,
  };
}

async function computePoolIdFromPoolKey(
  _rpcUrl: string,
  currency0: string,
  currency1: string,
  fee: number,
  tickSpacing: number,
  hooks: string
): Promise<string> {
  const payload =
    encodeAddressArg(currency0) +
    encodeAddressArg(currency1) +
    encodeUintArg(BigInt(fee)) +
    encodeIntArg(BigInt(tickSpacing)) +
    encodeAddressArg(hooks);
  return Promise.resolve(keccak256HexData(payload));
}

function poolIdBytes25FromPositionInfo(packedInfo: bigint): string {
  const mask200 = (1n << 200n) - 1n;
  const poolId = (packedInfo >> 56n) & mask200;
  return `0x${poolId.toString(16).padStart(50, "0")}`;
}

function poolIdBytes25FromHash(hash: string): string {
  const clean = stripHexPrefix(hash).padStart(64, "0");
  return `0x${clean.slice(0, 50)}`;
}

function decodeV4Slot0(raw: string): { sqrtPriceX96: bigint; tick: number; lpFee?: number } {
  const clean = stripHexPrefix(raw);
  if (!clean || clean.length < 64) {
    return { sqrtPriceX96: 0n, tick: 0, lpFee: undefined };
  }
  if (clean.length === 64) {
    const packed = wordToBigInt(parseWord(raw, 0));
    const sqrtPriceX96 = packed & ((1n << 160n) - 1n);
    const tickRaw = (packed >> 160n) & ((1n << 24n) - 1n);
    const lpFeeRaw = (packed >> 208n) & ((1n << 24n) - 1n);
    return {
      sqrtPriceX96,
      tick: signedFromBits(tickRaw, 24n),
      lpFee: Number(lpFeeRaw),
    };
  }
  return {
    sqrtPriceX96: wordToBigInt(parseWord(raw, 0)),
    tick: wordToSignedInt24(parseWord(raw, 1)),
    lpFee: undefined,
  };
}

function toBytes32(value: string, padMode: "start" | "end" = "start"): string {
  const clean = stripHexPrefix(value).toLowerCase();
  if (padMode === "end") return `0x${clean.padEnd(64, "0").slice(0, 64)}`;
  return `0x${clean.padStart(64, "0").slice(-64)}`;
}

function uniqueHex(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  values.forEach((value) => {
    const normalized = toBytes32(value).toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  });
  return out;
}

function isLikelyV4Slot0(
  decoded: { sqrtPriceX96: bigint; tick: number; lpFee?: number },
  expectedFee: number
): boolean {
  if (decoded.sqrtPriceX96 <= 0n) return false;
  if (!Number.isFinite(decoded.tick) || Math.abs(decoded.tick) > MAX_TICK) return false;

  const sqrtRatio = Number(decoded.sqrtPriceX96) / Number(Q96);
  if (!Number.isFinite(sqrtRatio) || sqrtRatio <= 0) return false;
  const approxTick = Math.log(sqrtRatio * sqrtRatio) / Math.log(1.0001);
  if (!Number.isFinite(approxTick) || Math.abs(approxTick - decoded.tick) > 2048) return false;

  if (typeof decoded.lpFee !== "number") return true;
  const lpFee = decoded.lpFee;
  const normalizedExpected = expectedFee & ((1 << 24) - 1);
  const isExpectedDynamic = (normalizedExpected & V4_DYNAMIC_FEE_FLAG) !== 0;
  const isLpDynamic = (lpFee & V4_DYNAMIC_FEE_FLAG) !== 0;
  if (isExpectedDynamic) {
    return isLpDynamic || lpFee <= V4_MAX_LP_FEE;
  }
  return lpFee === normalizedExpected || lpFee <= V4_MAX_LP_FEE;
}

async function tryReadV4Slot0ViaExtsload(
  rpcUrl: string,
  poolManagerAddress: string,
  expectedFee: number,
  poolIdCandidates: string[]
): Promise<{ sqrtPriceX96: bigint; tick: number; source: string } | null> {
  const selectorExtsload = await resolveSelector(rpcUrl, SIGNATURE_EXTSLOAD_BYTES32);
  const normalizedRpc = rpcUrl.toLowerCase();
  const normalizedManager = poolManagerAddress.toLowerCase();

  for (const poolId of uniqueHex(poolIdCandidates)) {
    const cacheKey = `${normalizedRpc}|${normalizedManager}|${poolId}`;
    const cachedMappingSlot = v4Slot0StorageSlotCache.get(cacheKey);
    const mappingSlots: number[] = [];
    if (typeof cachedMappingSlot === "number") mappingSlots.push(cachedMappingSlot);
    for (let mappingSlot = 0; mappingSlot <= V4_SLOT0_MAPPING_SEARCH_LIMIT; mappingSlot += 1) {
      if (mappingSlot === cachedMappingSlot) continue;
      mappingSlots.push(mappingSlot);
    }

    for (const mappingSlot of mappingSlots) {
      const storageSlot = keccak256HexData(`${encodeBytes32Arg(poolId)}${encodeUintArg(BigInt(mappingSlot))}`);
      try {
        const raw = await ethCallHex(
          rpcUrl,
          poolManagerAddress,
          `${selectorExtsload}${encodeBytes32Arg(storageSlot)}`
        );
        const decoded = decodeV4Slot0(raw);
        if (!isLikelyV4Slot0(decoded, expectedFee)) continue;
        v4Slot0StorageSlotCache.set(cacheKey, mappingSlot);
        return {
          sqrtPriceX96: decoded.sqrtPriceX96,
          tick: decoded.tick,
          source: `extsload:${mappingSlot}`,
        };
      } catch {
        // Try next slot silently; some RPCs return revert for unknown storage probes.
      }
    }
  }

  return null;
}

function formatScaledBigInt(value: bigint, scale: number): string {
  const base = 10n ** BigInt(scale);
  const whole = value / base;
  const fraction = value % base;
  if (fraction === 0n) return whole.toString();
  const fracRaw = fraction.toString().padStart(scale, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracRaw}`;
}

function formatPriceFromSqrtX96(
  sqrtPriceX96: bigint,
  dec0: number,
  dec1: number,
  displayScale = 10
): string {
  if (sqrtPriceX96 <= 0n) return "—";
  const numScale = 10n ** BigInt(Math.max(0, dec0 + displayScale));
  const denScale = 10n ** BigInt(Math.max(0, dec1));
  const numerator = sqrtPriceX96 * sqrtPriceX96 * numScale;
  const denominator = Q192 * denScale;
  if (denominator === 0n) return "—";
  const scaled = numerator / denominator;
  const exact = formatScaledBigInt(scaled, displayScale);
  const asNum = Number(exact);
  if (!Number.isFinite(asNum) || asNum <= 0) return exact;
  return formatPortfolioRangePrice(asNum);
}

function priceFromSqrtX96Number(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  if (sqrtPriceX96 <= 0n) return Number.NaN;
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  return ratio * ratio * 10 ** (dec0 - dec1);
}

function isUsdLikePortfolioSymbol(symbol?: string): boolean {
  const normalized = String(symbol ?? "").trim().toLowerCase();
  return /^(usdc|usdcx|usdc\.e|usdt|usdt\.e|dai|usd1|usdnr|susdnr|savusd|usde|susde|usds|susds)$/.test(
    normalized
  );
}

function formatPortfolioUsdValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const maximumFractionDigits = value >= 10_000 ? 0 : 2;
  return `$${formatNumber(value, maximumFractionDigits)}`;
}

function formatPortfolioRangePrice(value: number, significantDigits = 7): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 10_000_000) {
    return value.toExponential(significantDigits - 1).replace("e+", "e");
  }
  const precise = Number(value.toPrecision(significantDigits));
  const fractionDigits = value >= 1 ? Math.max(0, significantDigits - Math.floor(Math.log10(value)) - 1) : significantDigits;
  return formatNumber(precise, Math.min(8, fractionDigits));
}

function buildPortfolioValueSummary(
  amount0: number,
  amount1: number,
  priceToken1PerToken0: number,
  token0Symbol: string,
  token1Symbol: string
): { exposureText?: string; positionValueText?: string } {
  if (!Number.isFinite(priceToken1PerToken0) || priceToken1PerToken0 <= 0) return {};

  const token0ValueInToken1 = amount0 * priceToken1PerToken0;
  const token1ValueInToken1 = amount1;
  const totalValueInToken1 = token0ValueInToken1 + token1ValueInToken1;
  const token0Share = totalValueInToken1 > 0 ? (token0ValueInToken1 / totalValueInToken1) * 100 : 0;
  const token1Share = totalValueInToken1 > 0 ? (token1ValueInToken1 / totalValueInToken1) * 100 : 0;
  const exposureText =
    totalValueInToken1 > 0
      ? `${token0Symbol} ${Math.round(token0Share)}% · ${token1Symbol} ${Math.round(token1Share)}%`
      : undefined;

  let usdValue: number | undefined;
  if (isUsdLikePortfolioSymbol(token1Symbol)) {
    usdValue = totalValueInToken1;
  } else if (isUsdLikePortfolioSymbol(token0Symbol)) {
    usdValue = amount0 + amount1 / priceToken1PerToken0;
  }

  return {
    exposureText,
    positionValueText: usdValue ? formatPortfolioUsdValue(usdValue) : undefined,
  };
}

function formatTokenAmount(value: number, symbol: string): string {
  if (!Number.isFinite(value)) return `— ${symbol}`;
  const fixed = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 4,
  }).format(value);
  return `${fixed} ${symbol}`;
}

function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || Math.abs(tick) > MAX_TICK) {
    throw new Error(`Invalid tick: ${tick}`);
  }
  let absTick = Math.abs(tick);
  let ratio =
    absTick & 0x1
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  if (absTick & 0x2) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if (absTick & 0x4) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if (absTick & 0x8) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if (absTick & 0x10) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if (absTick & 0x20) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if (absTick & 0x40) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if (absTick & 0x80) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if (absTick & 0x100) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if (absTick & 0x200) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if (absTick & 0x400) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if (absTick & 0x800) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if (absTick & 0x1000) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if (absTick & 0x2000) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if (absTick & 0x4000) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if (absTick & 0x8000) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if (absTick & 0x10000) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if (absTick & 0x20000) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if (absTick & 0x40000) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if (absTick & 0x80000) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  const roundBit = ratio & ((1n << 32n) - 1n);
  return (ratio >> 32n) + (roundBit > 0n ? 1n : 0n);
}

function getAmount0Delta(
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint
): bigint {
  const [lower, upper] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  if (lower <= 0n || upper <= 0n || liquidity <= 0n) return 0n;
  const numerator1 = liquidity << 96n;
  const numerator2 = upper - lower;
  return (numerator1 * numerator2) / upper / lower;
}

function getAmount1Delta(
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint
): bigint {
  const [lower, upper] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  if (lower <= 0n || upper <= 0n || liquidity <= 0n) return 0n;
  return (liquidity * (upper - lower)) / Q96;
}

function computePositionTokenAmounts(
  liquidity: bigint,
  currentSqrtX96: bigint,
  tickLower: number,
  tickUpper: number,
  token0Decimals: number,
  token1Decimals: number
): { token0: number; token1: number } {
  if (liquidity <= 0n) {
    return { token0: 0, token1: 0 };
  }
  const sqrtLower = getSqrtRatioAtTick(tickLower);
  const sqrtUpper = getSqrtRatioAtTick(tickUpper);
  let amount0Raw: bigint;
  let amount1Raw: bigint;
  if (currentSqrtX96 <= sqrtLower) {
    amount0Raw = getAmount0Delta(sqrtLower, sqrtUpper, liquidity);
    amount1Raw = 0n;
  } else if (currentSqrtX96 < sqrtUpper) {
    amount0Raw = getAmount0Delta(currentSqrtX96, sqrtUpper, liquidity);
    amount1Raw = getAmount1Delta(sqrtLower, currentSqrtX96, liquidity);
  } else {
    amount0Raw = 0n;
    amount1Raw = getAmount1Delta(sqrtLower, sqrtUpper, liquidity);
  }
  const token0 = Number(fromAtomicAmount(amount0Raw.toString(), token0Decimals));
  const token1 = Number(fromAtomicAmount(amount1Raw.toString(), token1Decimals));
  return {
    token0: Number.isFinite(token0) ? token0 : 0,
    token1: Number.isFinite(token1) ? token1 : 0,
  };
}

function isUniswapV4Position(position: PortfolioPositionConfig): boolean {
  return /uniswap\s*v4/i.test(position.protocol);
}

function getV3ProtocolKey(protocol: string): "uniswap_v3" | "sushiswap_v3" | "aerodrome_v3" | "velodrome_v3" {
  const normalized = protocol.trim().toLowerCase();
  if (normalized.includes("sushi")) return "sushiswap_v3";
  if (normalized.includes("aerodrome")) return "aerodrome_v3";
  if (normalized.includes("velodrome")) return "velodrome_v3";
  return "uniswap_v3";
}

function getV3GetPoolSelector(protocol: string): string {
  const normalized = protocol.trim().toLowerCase();
  // Aerodrome/Velodrome Slipstream factory uses getPool(address,address,int24)
  if (normalized.includes("aerodrome") || normalized.includes("velodrome")) return "0x28af8d0b";
  return SELECTOR_GET_POOL;
}

function resolveV3Deployment(position: PortfolioPositionConfig): {
  positionManager: string;
  factory?: string;
} {
  const customManager = position.positionManagerAddress?.trim();
  const customFactory = position.factoryAddress?.trim();
  if (customManager) {
    return {
      positionManager: customManager,
      factory: customFactory || undefined,
    };
  }

  const protocolKey = getV3ProtocolKey(position.protocol);
  const chainKey = normalizeChainKey(position.chain);
  const deployment = V3_DEPLOYMENTS[`${protocolKey}:${chainKey}`];
  if (deployment) return deployment;

  if (protocolKey === "uniswap_v3") {
    return {
      positionManager: UNIV3_POSITION_MANAGER,
      factory: UNIV3_FACTORY,
    };
  }

  throw new Error(`No ${position.protocol} deployment configured for ${position.chain}`);
}

async function resolveV3FactoryAddress(
  rpcUrl: string,
  positionManager: string,
  fallbackFactory?: string
): Promise<string> {
  try {
    const raw = await ethCallHex(rpcUrl, positionManager, SELECTOR_FACTORY);
    const address = wordToAddress(parseWord(raw, 0));
    if (!isZeroAddress(address)) return address;
  } catch {
    // Fallback below.
  }
  if (fallbackFactory && !isZeroAddress(fallbackFactory)) return fallbackFactory;
  throw new Error("Factory address is not available for this v3 position manager");
}

function resolveV4Deployment(position: PortfolioPositionConfig): { positionManager: string; stateView: string } {
  if (position.positionManagerAddress && position.stateViewAddress) {
    return {
      positionManager: position.positionManagerAddress,
      stateView: position.stateViewAddress,
    };
  }
  const chainKey = normalizeChainKey(position.chain);
  const deployment = UNIV4_DEPLOYMENTS[chainKey];
  if (!deployment) {
    throw new Error(`No Uniswap v4 deployment configured for ${position.chain}`);
  }
  return deployment;
}

function buildEmptyPortfolioPositionSnapshot(
  position: PortfolioPositionConfig,
  tokenId: string
): PortfolioPositionSnapshot {
  return {
    id: position.id,
    title: position.title?.trim() || `${position.protocol} #${tokenId}`,
    protocol: position.protocol,
    chain: position.chain,
    tokenId,
    feeLabel: position.feeLabel,
    status: "ok",
    inRange: false,
    balanceText: "Empty",
    exposureText: "Empty",
    positionValueText: "$0",
    hasBalance: false,
    updatedAt: Date.now(),
  };
}

const Q80 = 1n << 80n;
const YUZU_TICK_CENTER = 443636;
const YUZU_MAX_UINT256 = (1n << 256n) - 1n;

function getYuzuSqrtRatioAtTick(tick: number): bigint {
  const absTick = tick < YUZU_TICK_CENTER ? YUZU_TICK_CENTER - tick : tick - YUZU_TICK_CENTER;
  let ratio =
    absTick & 1
      ? 340265354078544976698082559843614326784n
      : 340282366920938463463374607431768211456n;
  if (absTick & 0x2) ratio = (ratio * 340248342086729784833163084424934326272n) >> 128n;
  if (absTick & 0x4) ratio = (ratio * 340214320654664318389990405825464631296n) >> 128n;
  if (absTick & 0x8) ratio = (ratio * 340146287995602338275853453755324301312n) >> 128n;
  if (absTick & 0x10) ratio = (ratio * 340010263488231178223853832463785656320n) >> 128n;
  if (absTick & 0x20) ratio = (ratio * 339738377640345476870261989487337799680n) >> 128n;
  if (absTick & 0x40) ratio = (ratio * 339195258003219658561184762853115035648n) >> 128n;
  if (absTick & 0x80) ratio = (ratio * 338111622100602086564262494681729859584n) >> 128n;
  if (absTick & 0x100) ratio = (ratio * 335954724994790710924045888443083915264n) >> 128n;
  if (absTick & 0x200) ratio = (ratio * 331682121138380177001083646313987309568n) >> 128n;
  if (absTick & 0x400) ratio = (ratio * 323299236684854836574038915838422024192n) >> 128n;
  if (absTick & 0x800) ratio = (ratio * 307163716377036449298628741423763030016n) >> 128n;
  if (absTick & 0x1000) ratio = (ratio * 277268403626902478617217471084343853056n) >> 128n;
  if (absTick & 0x2000) ratio = (ratio * 225923453940452822857498961015547625472n) >> 128n;
  if (absTick & 0x4000) ratio = (ratio * 149997214084980533347406722303197708288n) >> 128n;
  if (absTick & 0x8000) ratio = (ratio * 66119101136036705030569676839239811072n) >> 128n;
  if (absTick & 0x10000) ratio = (ratio * 12847376061813933090541833434062389248n) >> 128n;
  if (absTick & 0x20000) ratio = (ratio * 485053260817416266108873772866994176n) >> 128n;
  if (absTick & 0x40000) ratio = (ratio * 691415978907519520719790451720192n) >> 128n;
  if (tick > YUZU_TICK_CENTER) ratio = YUZU_MAX_UINT256 / ratio;
  return ratio >> 48n;
}

function priceFromSqrtX80Number(sqrtPriceX80: bigint, dec0: number, dec1: number): number {
  if (sqrtPriceX80 <= 0n) return Number.NaN;
  const ratio = Number(sqrtPriceX80) / Number(Q80);
  return ratio * ratio * 10 ** (dec0 - dec1);
}

function formatPriceFromSqrtX80(
  sqrtPriceX80: bigint,
  dec0: number,
  dec1: number,
  displayScale = 10
): string {
  const price = priceFromSqrtX80Number(sqrtPriceX80, dec0, dec1);
  if (!Number.isFinite(price) || price <= 0) return "—";
  return formatPortfolioRangePrice(price);
}

function computeYuzuPositionTokenAmounts(
  liquidity: bigint,
  currentSqrtX80: bigint,
  tickLower: number,
  tickUpper: number,
  token0Decimals: number,
  token1Decimals: number
): { token0: number; token1: number } {
  if (liquidity <= 0n) return { token0: 0, token1: 0 };
  const sqrtLower = getYuzuSqrtRatioAtTick(tickLower);
  const sqrtUpper = getYuzuSqrtRatioAtTick(tickUpper);
  let amount0Raw = 0n;
  let amount1Raw = 0n;
  if (currentSqrtX80 <= sqrtLower) {
    amount0Raw = (liquidity * Q80 * (sqrtUpper - sqrtLower)) / sqrtLower / sqrtUpper;
  } else if (currentSqrtX80 < sqrtUpper) {
    amount0Raw = (liquidity * Q80 * (sqrtUpper - currentSqrtX80)) / currentSqrtX80 / sqrtUpper;
    amount1Raw = (liquidity * (currentSqrtX80 - sqrtLower)) / Q80;
  } else {
    amount1Raw = (liquidity * (sqrtUpper - sqrtLower)) / Q80;
  }
  const token0 = Number(fromAtomicAmount(amount0Raw.toString(), token0Decimals));
  const token1 = Number(fromAtomicAmount(amount1Raw.toString(), token1Decimals));
  return {
    token0: Number.isFinite(token0) ? token0 : 0,
    token1: Number.isFinite(token1) ? token1 : 0,
  };
}

function isYuzuPosition(position: PortfolioPositionConfig): boolean {
  return position.sourceMode === "yuzu" || /yuzu/i.test(position.protocol);
}

const INITIA_Q64 = 1n << 64n;
const INITIA_MAX_TICK = 443636n;
const INITIA_MAX_UINT256 = (1n << 256n) - 1n;

function initiaTickBitsToNumber(value: string | number | bigint): number {
  const raw = BigInt(value);
  const signed = raw >= INITIA_Q64 / 2n ? raw - INITIA_Q64 : raw;
  return Number(signed);
}

function getInitiaSqrtRatioAtTick(tick: number): bigint {
  const tickBig = BigInt(tick);
  const absTick = tickBig < 0n ? -tickBig : tickBig;
  if (absTick > INITIA_MAX_TICK) throw new Error("Initia tick out of range");
  let ratio =
    (absTick & 1n) === 0n
      ? 340282366920938463463374607431768211456n
      : 340265354078544963557816517032075149313n;
  if ((absTick & 2n) !== 0n) ratio = (ratio * 340248342086729790484326174814286782778n) >> 128n;
  if ((absTick & 4n) !== 0n) ratio = (ratio * 340214320654664324051920982716015181260n) >> 128n;
  if ((absTick & 8n) !== 0n) ratio = (ratio * 340146287995602323631171512101879684304n) >> 128n;
  if ((absTick & 16n) !== 0n) ratio = (ratio * 340010263488231146823593991679159461444n) >> 128n;
  if ((absTick & 32n) !== 0n) ratio = (ratio * 339738377640345403697157401104375502016n) >> 128n;
  if ((absTick & 64n) !== 0n) ratio = (ratio * 339195258003219555707034227454543997025n) >> 128n;
  if ((absTick & 128n) !== 0n) ratio = (ratio * 338111622100601834656805679988414885971n) >> 128n;
  if ((absTick & 256n) !== 0n) ratio = (ratio * 335954724994790223023589805789778977700n) >> 128n;
  if ((absTick & 512n) !== 0n) ratio = (ratio * 331682121138379247127172139078559817700n) >> 128n;
  if ((absTick & 1024n) !== 0n) ratio = (ratio * 323299236684853023288211250268160618739n) >> 128n;
  if ((absTick & 2048n) !== 0n) ratio = (ratio * 307163716377032989948697243942600083929n) >> 128n;
  if ((absTick & 4096n) !== 0n) ratio = (ratio * 277268403626896220162999269216087595045n) >> 128n;
  if ((absTick & 8192n) !== 0n) ratio = (ratio * 225923453940442621947126027127485391333n) >> 128n;
  if ((absTick & 16384n) !== 0n) ratio = (ratio * 149997214084966997727330242082538205943n) >> 128n;
  if ((absTick & 32768n) !== 0n) ratio = (ratio * 66119101136024775622716233608466517926n) >> 128n;
  if ((absTick & 65536n) !== 0n) ratio = (ratio * 12847376061809297530290974190478138313n) >> 128n;
  if ((absTick & 131072n) !== 0n) ratio = (ratio * 485053260817066172746253684029974020n) >> 128n;
  if ((absTick & 262144n) !== 0n) ratio = (ratio * 691415978906521570653435304214168n) >> 128n;
  if (tickBig >= 0n) ratio = INITIA_MAX_UINT256 / ratio;
  const quotient = ratio / INITIA_Q64;
  return ratio % INITIA_Q64 === 0n ? quotient : quotient + 1n;
}

function priceFromInitiaSqrtX64Number(sqrtPriceX64: bigint, dec0: number, dec1: number): number {
  if (sqrtPriceX64 <= 0n) return Number.NaN;
  const ratio = Number(sqrtPriceX64) / Number(INITIA_Q64);
  return ratio * ratio * 10 ** (dec0 - dec1);
}

function computeInitiaPositionTokenAmounts(
  liquidity: bigint,
  currentSqrtX64: bigint,
  tickLower: number,
  tickUpper: number,
  token0Decimals: number,
  token1Decimals: number
): { token0: number; token1: number } {
  if (liquidity <= 0n) return { token0: 0, token1: 0 };
  const sqrtLower = getInitiaSqrtRatioAtTick(tickLower);
  const sqrtUpper = getInitiaSqrtRatioAtTick(tickUpper);
  let amount0Raw = 0n;
  let amount1Raw = 0n;
  if (currentSqrtX64 < sqrtLower) {
    amount0Raw = (liquidity * INITIA_Q64 * (sqrtUpper - sqrtLower)) / sqrtLower / sqrtUpper;
  } else if (currentSqrtX64 < sqrtUpper) {
    amount0Raw = (liquidity * INITIA_Q64 * (sqrtUpper - currentSqrtX64)) / currentSqrtX64 / sqrtUpper;
    amount1Raw = (liquidity * (currentSqrtX64 - sqrtLower)) / INITIA_Q64;
  } else {
    amount1Raw = (liquidity * (sqrtUpper - sqrtLower)) / INITIA_Q64;
  }
  const token0 = Number(fromAtomicAmount(amount0Raw.toString(), token0Decimals));
  const token1 = Number(fromAtomicAmount(amount1Raw.toString(), token1Decimals));
  return {
    token0: Number.isFinite(token0) ? token0 : 0,
    token1: Number.isFinite(token1) ? token1 : 0,
  };
}

function isInitiaPosition(position: PortfolioPositionConfig): boolean {
  return position.sourceMode === "initia" || /initia/i.test(position.protocol);
}

async function fetchInitiaPositionSnapshot(position: PortfolioPositionConfig): Promise<PortfolioPositionSnapshot> {
  const tokenId = position.tokenId.trim();
  const poolId = position.poolId?.trim();
  if (!poolId) throw new Error("Missing Initia CLAMM pool id");
  const source = PORTFOLIO_DISCOVERY_SOURCES.find((item) => item.id === "initia-clamm");
  if (!source) throw new Error("Initia source is not configured");
  const [poolInfo, rawPosition] = await Promise.all([
    fetchInitiaView<InitiaPoolInfo>(source, "lens", "get_pool_info", [initiaHexObjectToBase64(poolId)]),
    fetchInitiaView<InitiaRawPosition>(source, "pool", "position_info", [initiaHexObjectToBase64(tokenId)]),
  ]);
  const liquidity = BigInt(rawPosition.liquidity ?? "0");
  if (liquidity <= 0n) {
    return buildEmptyPortfolioPositionSnapshot(position, tokenId);
  }

  const token0Symbol =
    String(poolInfo.metadata_0 ?? "").toLowerCase() === INITIA_IUSD_METADATA.toLowerCase() ? "iUSD" : "TOKEN0";
  const token1Symbol =
    String(poolInfo.metadata_1 ?? "").toLowerCase() === INITIA_USDC_METADATA.toLowerCase() ? "USDC" : "TOKEN1";
  const token0Decimals = 6;
  const token1Decimals = 6;
  const currentSqrtPrice = BigInt(poolInfo.sqrt_price ?? "0");
  const tickLower = initiaTickBitsToNumber(rawPosition.tick_lower?.bits ?? "0");
  const tickUpper = initiaTickBitsToNumber(rawPosition.tick_upper?.bits ?? "0");
  const currentTickRaw = Number(poolInfo.tick_u64 ?? "0");
  const currentTick = poolInfo.tick_neg ? -currentTickRaw : currentTickRaw;
  const lowerPrice = 1.0001 ** tickLower;
  const upperPrice = 1.0001 ** tickUpper;
  const currentPrice = priceFromInitiaSqrtX64Number(currentSqrtPrice, token0Decimals, token1Decimals);
  const amounts = computeInitiaPositionTokenAmounts(
    liquidity,
    currentSqrtPrice,
    tickLower,
    tickUpper,
    token0Decimals,
    token1Decimals
  );
  const valueSummary = buildPortfolioValueSummary(
    amounts.token0,
    amounts.token1,
    currentPrice,
    token0Symbol,
    token1Symbol
  );
  const feeBps = Number(poolInfo.swap_fee_bps ?? "0");
  const feeLabel = Number.isFinite(feeBps) ? `${formatNumber((feeBps / 100).toString(), 4)}%` : position.feeLabel;

  return {
    id: position.id,
    title: `${token0Symbol} / ${token1Symbol}`,
    protocol: position.protocol,
    chain: position.chain,
    tokenId,
    status: "ok",
    inRange: currentTick >= tickLower && currentTick < tickUpper,
    feeLabel,
    token0Symbol,
    token1Symbol,
    currentPriceText: `Current ${formatPortfolioRangePrice(currentPrice)} ${token1Symbol} per ${token0Symbol}`,
    rangeMinText: `Min ${formatPortfolioRangePrice(lowerPrice)} ${token1Symbol} per ${token0Symbol}`,
    rangeMaxText: `Max ${formatPortfolioRangePrice(upperPrice)} ${token1Symbol} per ${token0Symbol}`,
    balanceText: `${formatTokenAmount(amounts.token0, token0Symbol)} + ${formatTokenAmount(amounts.token1, token1Symbol)}`,
    exposureText: valueSummary.exposureText,
    positionValueText: valueSummary.positionValueText,
    hasBalance: amounts.token0 > 0 || amounts.token1 > 0,
    updatedAt: Date.now(),
  };
}

async function fetchYuzuPositionSnapshot(position: PortfolioPositionConfig): Promise<PortfolioPositionSnapshot> {
  const tokenId = position.tokenId.trim();
  const poolId = position.poolId?.trim();
  if (!poolId) throw new Error("Missing Yuzu pool id");
  const source = PORTFOLIO_DISCOVERY_SOURCES.find((item) => item.id === "yuzu-movement");
  if (!source) throw new Error("Yuzu source is not configured");
  const [pool, rawPosition, tokenMap] = await Promise.all([
    fetchYuzuPoolMeta(source, poolId),
    fetchYuzuRawPosition(source, poolId, tokenId),
    fetchYuzuTokenMap(source),
  ]);
  if (!rawPosition || BigInt(rawPosition.liquidity || "0") <= 0n) {
    return buildEmptyPortfolioPositionSnapshot(position, tokenId);
  }

  const token0Meta = tokenMap.get(compactMovementAddress(pool.token0).toLowerCase());
  const token1Meta = tokenMap.get(compactMovementAddress(pool.token1).toLowerCase());
  const token0Symbol = normalizePortfolioTokenSymbol(token0Meta?.symbol ?? "TOKEN0", position.chain);
  const token1Symbol = normalizePortfolioTokenSymbol(token1Meta?.symbol ?? "TOKEN1", position.chain);
  const token0Decimals = token0Meta?.decimals ?? pool.token0Decimals;
  const token1Decimals = token1Meta?.decimals ?? pool.token1Decimals;
  const currentSqrtPrice = BigInt(pool.currentSqrtPrice || "0");
  const liquidity = BigInt(rawPosition.liquidity);
  const amounts = computeYuzuPositionTokenAmounts(
    liquidity,
    currentSqrtPrice,
    Number(rawPosition.tick_lower),
    Number(rawPosition.tick_upper),
    token0Decimals,
    token1Decimals
  );
  const currentPrice = priceFromSqrtX80Number(currentSqrtPrice, token0Decimals, token1Decimals);
  const lowerPrice = priceFromSqrtX80Number(getYuzuSqrtRatioAtTick(Number(rawPosition.tick_lower)), token0Decimals, token1Decimals);
  const upperPrice = priceFromSqrtX80Number(getYuzuSqrtRatioAtTick(Number(rawPosition.tick_upper)), token0Decimals, token1Decimals);
  const valueSummary = buildPortfolioValueSummary(
    amounts.token0,
    amounts.token1,
    currentPrice,
    token0Symbol,
    token1Symbol
  );
  const feeRate = Number(pool.feeRate);
  const feeLabel = Number.isFinite(feeRate) ? `${formatNumber((feeRate / 10000).toString(), 4)}%` : position.feeLabel;

  return {
    id: position.id,
    title: `${token0Symbol} / ${token1Symbol}`,
    protocol: position.protocol,
    chain: position.chain,
    tokenId,
    status: "ok",
    inRange: Number(pool.currentTick) >= Number(rawPosition.tick_lower) && Number(pool.currentTick) <= Number(rawPosition.tick_upper),
    feeLabel,
    token0Symbol,
    token1Symbol,
    currentPriceText: `Current ${formatPriceFromSqrtX80(currentSqrtPrice, token0Decimals, token1Decimals)} ${token1Symbol} per ${token0Symbol}`,
    rangeMinText: `Min ${formatPortfolioRangePrice(lowerPrice)} ${token1Symbol} per ${token0Symbol}`,
    rangeMaxText: `Max ${formatPortfolioRangePrice(upperPrice)} ${token1Symbol} per ${token0Symbol}`,
    balanceText: `${formatTokenAmount(amounts.token0, token0Symbol)} + ${formatTokenAmount(amounts.token1, token1Symbol)}`,
    exposureText: valueSummary.exposureText,
    positionValueText: valueSummary.positionValueText,
    hasBalance: amounts.token0 > 0 || amounts.token1 > 0,
    updatedAt: Date.now(),
  };
}

async function fetchUniswapV3PositionSnapshot(
  position: PortfolioPositionConfig
): Promise<PortfolioPositionSnapshot> {
  const tokenId = position.tokenId.trim();
  if (!tokenId) {
    throw new Error("Missing tokenId");
  }
  const { positionManager, factory: fallbackFactory } = resolveV3Deployment(position);
  const positionsData = `${SELECTOR_POSITIONS}${encodeUintArg(BigInt(tokenId))}`;
  const rawPosition = await ethCallHex(position.rpcUrl, positionManager, positionsData);
  const token0 = wordToAddress(parseWord(rawPosition, 2));
  const token1 = wordToAddress(parseWord(rawPosition, 3));
  const fee = Number(wordToBigInt(parseWord(rawPosition, 4)));
  const tickLower = wordToSignedInt24(parseWord(rawPosition, 5));
  const tickUpper = wordToSignedInt24(parseWord(rawPosition, 6));
  const liquidity = wordToBigInt(parseWord(rawPosition, 7));
  if (liquidity <= 0n) {
    return buildEmptyPortfolioPositionSnapshot(position, tokenId);
  }
  const factoryAddress = await resolveV3FactoryAddress(position.rpcUrl, positionManager, fallbackFactory);

  const getPoolSelector = getV3GetPoolSelector(position.protocol);
  const getPoolData =
    `${getPoolSelector}` +
    encodeAddressArg(token0) +
    encodeAddressArg(token1) +
    encodeUintArg(BigInt(fee));
  const poolAddress = wordToAddress(parseWord(await ethCallHex(position.rpcUrl, factoryAddress, getPoolData), 0));
  if (/^0x0{40}$/.test(stripHexPrefix(poolAddress))) {
    throw new Error("Pool not found for position");
  }
  const slot0Raw = await ethCallHex(position.rpcUrl, poolAddress, SELECTOR_SLOT0);
  const currentSqrtX96 = wordToBigInt(parseWord(slot0Raw, 0));
  const currentTick = wordToSignedInt24(parseWord(slot0Raw, 1));

  const [token0DecimalsRaw, token1DecimalsRaw, token0SymbolRaw, token1SymbolRaw] =
    await Promise.all([
      ethCallHex(position.rpcUrl, token0, SELECTOR_DECIMALS),
      ethCallHex(position.rpcUrl, token1, SELECTOR_DECIMALS),
      ethCallHex(position.rpcUrl, token0, SELECTOR_SYMBOL),
      ethCallHex(position.rpcUrl, token1, SELECTOR_SYMBOL),
    ]);

  const token0Decimals = Number(wordToBigInt(parseWord(token0DecimalsRaw, 0)));
  const token1Decimals = Number(wordToBigInt(parseWord(token1DecimalsRaw, 0)));
  const token0Symbol = normalizePortfolioTokenSymbol(decodeAbiString(token0SymbolRaw) || "TOKEN0", position.chain);
  const token1Symbol = normalizePortfolioTokenSymbol(decodeAbiString(token1SymbolRaw) || "TOKEN1", position.chain);

  const minSqrtX96 = getSqrtRatioAtTick(tickLower);
  const maxSqrtX96 = getSqrtRatioAtTick(tickUpper);
  const inRange = currentSqrtX96 >= minSqrtX96 && currentSqrtX96 < maxSqrtX96;

  const amounts = computePositionTokenAmounts(
    liquidity,
    currentSqrtX96,
    tickLower,
    tickUpper,
    token0Decimals,
    token1Decimals
  );
  const balanceText = `${formatTokenAmount(amounts.token0, token0Symbol)} + ${formatTokenAmount(
    amounts.token1,
    token1Symbol
  )}`;
  const hasBalance = amounts.token0 > 0 || amounts.token1 > 0;
  const minPriceText = formatPriceFromSqrtX96(minSqrtX96, token0Decimals, token1Decimals);
  const maxPriceText = formatPriceFromSqrtX96(maxSqrtX96, token0Decimals, token1Decimals);
  const currentPriceText = formatPriceFromSqrtX96(currentSqrtX96, token0Decimals, token1Decimals);
  const valueSummary = buildPortfolioValueSummary(
    amounts.token0,
    amounts.token1,
    priceFromSqrtX96Number(currentSqrtX96, token0Decimals, token1Decimals),
    token0Symbol,
    token1Symbol
  );

  return {
    id: position.id,
    title: `${token0Symbol} / ${token1Symbol}`,
    protocol: position.protocol,
    chain: position.chain,
    tokenId: tokenId,
    feeLabel: position.feeLabel || `${(fee / 10000).toFixed(2)}%`,
    status: "ok",
    inRange,
    rangeText: `${minPriceText} — ${maxPriceText}`,
    rangeMinText: `Min ${minPriceText} ${token1Symbol} per ${token0Symbol}`,
    rangeMaxText: `Max ${maxPriceText} ${token1Symbol} per ${token0Symbol}`,
    currentPriceText: `${currentPriceText} ${token1Symbol} per ${token0Symbol}`,
    balanceText,
    exposureText: valueSummary.exposureText,
    positionValueText: valueSummary.positionValueText,
    hasBalance,
    token0Symbol,
    token1Symbol,
    updatedAt: Date.now(),
  };
}

async function fetchUniswapV4PositionSnapshot(
  position: PortfolioPositionConfig
): Promise<PortfolioPositionSnapshot> {
  const tokenId = position.tokenId.trim();
  if (!tokenId) {
    throw new Error("Missing tokenId");
  }
  const { positionManager, stateView } = resolveV4Deployment(position);
  const chainKey = normalizeChainKey(position.chain);
  const isUniswapV4Ethereum = chainKey === "ethereum";
  if (isUniswapV4Ethereum) {
    console.log(`${UNIV4_ETH_DEBUG_PREFIX} snapshot start`, {
      tokenId,
      positionId: position.id,
      positionManager,
      stateView,
      chain: position.chain,
    });
  }

  const selectorPositionLiquidity = await resolveSelector(position.rpcUrl, SIGNATURE_V4_GET_POSITION_LIQUIDITY);
  const liquidityRaw = await ethCallHex(
    position.rpcUrl,
    positionManager,
    `${selectorPositionLiquidity}${encodeUintArg(BigInt(tokenId))}`
  );
  const liquidity = wordToBigInt(parseWord(liquidityRaw, 0));
  if (liquidity <= 0n) {
    return buildEmptyPortfolioPositionSnapshot(position, tokenId);
  }

  const [
    selectorPoolAndInfo,
    selectorSlot0,
    selectorSlot0WithManager,
    selectorSlot0Bytes25,
    selectorSlot0WithManagerBytes25,
    selectorAltSlot0,
    selectorAltSlot0WithManager,
    selectorAltSlot0Bytes25,
    selectorAltSlot0WithManagerBytes25,
    selectorPoolManager,
  ] = await Promise.all([
    resolveSelector(position.rpcUrl, SIGNATURE_V4_GET_POOL_AND_POSITION_INFO),
    resolveSelector(position.rpcUrl, SIGNATURE_V4_GET_SLOT0),
    resolveSelector(position.rpcUrl, SIGNATURE_V4_GET_SLOT0_WITH_MANAGER),
    resolveSelector(position.rpcUrl, SIGNATURE_V4_GET_SLOT0_BYTES25),
    resolveSelector(position.rpcUrl, SIGNATURE_V4_GET_SLOT0_WITH_MANAGER_BYTES25),
    resolveSelector(position.rpcUrl, SIGNATURE_V4_SLOT0),
    resolveSelector(position.rpcUrl, SIGNATURE_V4_SLOT0_WITH_MANAGER),
    resolveSelector(position.rpcUrl, SIGNATURE_V4_SLOT0_BYTES25),
    resolveSelector(position.rpcUrl, SIGNATURE_V4_SLOT0_WITH_MANAGER_BYTES25),
    resolveSelector(position.rpcUrl, SIGNATURE_V4_POOL_MANAGER),
  ]);

  const poolAndInfoData = `${selectorPoolAndInfo}${encodeUintArg(BigInt(tokenId))}`;
  const poolAndInfoRaw = await ethCallHex(position.rpcUrl, positionManager, poolAndInfoData);

  const currency0 = wordToAddress(parseWord(poolAndInfoRaw, 0));
  const currency1 = wordToAddress(parseWord(poolAndInfoRaw, 1));
  const fee = wordToUint24(parseWord(poolAndInfoRaw, 2));
  const tickSpacing = wordToSignedInt24(parseWord(poolAndInfoRaw, 3));
  const hooks = wordToAddress(parseWord(poolAndInfoRaw, 4));
  const packedInfo = wordToBigInt(parseWord(poolAndInfoRaw, 5));
  const mask24 = (1n << 24n) - 1n;
  const tickLower = signedFromBits((packedInfo >> 8n) & mask24, 24n);
  const tickUpper = signedFromBits((packedInfo >> 32n) & mask24, 24n);
  const poolIdFromInfoBytes25 = poolIdBytes25FromPositionInfo(packedInfo);

  const [poolIdFromKeyHash, token0Meta, token1Meta] = await Promise.all([
    computePoolIdFromPoolKey(position.rpcUrl, currency0, currency1, fee, tickSpacing, hooks),
    fetchTokenMeta(position.rpcUrl, chainKey, currency0),
    fetchTokenMeta(position.rpcUrl, chainKey, currency1),
  ]);
  if (isUniswapV4Ethereum) {
    console.log(`${UNIV4_ETH_DEBUG_PREFIX} snapshot pool info`, {
      tokenId,
      currency0,
      currency1,
      fee,
      tickSpacing,
      hooks,
      tickLower,
      tickUpper,
      poolIdFromKeyHash,
    });
  }

  const poolManagerRaw = await ethCallHex(position.rpcUrl, positionManager, selectorPoolManager);
  const poolManagerAddress = wordToAddress(parseWord(poolManagerRaw, 0));
  const poolIdFromKeyBytes25 = poolIdBytes25FromHash(poolIdFromKeyHash);
  const poolIdFromInfoBytes32Padded = `0x${stripHexPrefix(poolIdFromInfoBytes25)
    .padEnd(64, "0")
    .toLowerCase()}`;
  const poolIdFromInfoBytes32LeftPadded = `0x${stripHexPrefix(poolIdFromInfoBytes25)
    .padStart(64, "0")
    .toLowerCase()}`;
  const poolIdFromKeyBytes32FromBytes25 = `0x${stripHexPrefix(poolIdFromKeyBytes25)
    .padEnd(64, "0")
    .toLowerCase()}`;
  const poolIdsToTry = [
    { kind: "bytes32" as const, value: toBytes32(poolIdFromKeyHash).toLowerCase() },
    { kind: "bytes25" as const, value: poolIdFromInfoBytes25.toLowerCase() },
    { kind: "bytes25" as const, value: poolIdFromKeyBytes25.toLowerCase() },
    { kind: "bytes32" as const, value: poolIdFromInfoBytes32Padded },
    { kind: "bytes32" as const, value: poolIdFromInfoBytes32LeftPadded },
    { kind: "bytes32" as const, value: poolIdFromKeyBytes32FromBytes25 },
  ];
  const poolIdCandidatesForExtsload = uniqueHex([
    toBytes32(poolIdFromKeyHash),
    poolIdFromInfoBytes32Padded,
    poolIdFromInfoBytes32LeftPadded,
    poolIdFromKeyBytes32FromBytes25,
  ]);
  let currentSqrtX96 = 0n;
  let currentTick = 0;
  let slot0Found = false;

  for (const poolIdEntry of poolIdsToTry) {
    const poolId = poolIdEntry.value;
    const isBytes25 = poolIdEntry.kind === "bytes25";
    const encodedPoolIdFor32 = encodeBytes32Arg(poolId);
    const encodedPoolIdFor25 = encodeFixedBytesArg(poolId, 25);
    const directPayload = isBytes25 ? encodedPoolIdFor25 : encodedPoolIdFor32;
    const withManagerPayload = `${encodeAddressArg(poolManagerAddress)}${directPayload}`;
    const directSelectors = isBytes25
      ? [selectorSlot0Bytes25, selectorAltSlot0Bytes25]
      : [selectorSlot0, selectorAltSlot0];
    const withManagerSelectors = isBytes25
      ? [selectorSlot0WithManagerBytes25, selectorAltSlot0WithManagerBytes25]
      : [selectorSlot0WithManager, selectorAltSlot0WithManager];

    const attempts: Array<{ target: string; label: string; selectors: string[]; payload: string }> = [
      { target: poolManagerAddress, label: "poolManager(poolId)", selectors: directSelectors, payload: directPayload },
      { target: stateView, label: "stateView(address,poolId)", selectors: withManagerSelectors, payload: withManagerPayload },
      { target: stateView, label: "stateView(poolId)", selectors: directSelectors, payload: directPayload },
      { target: positionManager, label: "positionManager(address,poolId)", selectors: withManagerSelectors, payload: withManagerPayload },
      { target: positionManager, label: "positionManager(poolId)", selectors: directSelectors, payload: directPayload },
    ];

    for (const attempt of attempts) {
      for (const selector of attempt.selectors) {
        try {
          const slot0Raw = await ethCallHex(position.rpcUrl, attempt.target, `${selector}${attempt.payload}`);
          const decoded = decodeV4Slot0(slot0Raw);
          if (decoded.sqrtPriceX96 > 0n) {
            currentSqrtX96 = decoded.sqrtPriceX96;
            currentTick = decoded.tick;
            slot0Found = true;
            break;
          }
        } catch {
          // Try next call signature/target.
        }
      }
      if (slot0Found) break;
    }
    if (slot0Found) break;
  }
  if (!slot0Found || currentSqrtX96 <= 0n) {
    const extsloadSlot0 = await tryReadV4Slot0ViaExtsload(
      position.rpcUrl,
      poolManagerAddress,
      fee,
      poolIdCandidatesForExtsload
    );
    if (extsloadSlot0) {
      currentSqrtX96 = extsloadSlot0.sqrtPriceX96;
      currentTick = extsloadSlot0.tick;
      slot0Found = true;
    }
  }
  if (!slot0Found || currentSqrtX96 <= 0n) {
    throw new Error("Unable to read slot0 from on-chain v4 pool");
  }

  const inRange = currentTick >= tickLower && currentTick < tickUpper;
  const minSqrtX96 = getSqrtRatioAtTick(tickLower);
  const maxSqrtX96 = getSqrtRatioAtTick(tickUpper);
  const amounts = computePositionTokenAmounts(
    liquidity,
    currentSqrtX96,
    tickLower,
    tickUpper,
    token0Meta.decimals,
    token1Meta.decimals
  );
  const balanceText = `${formatTokenAmount(amounts.token0, token0Meta.symbol)} + ${formatTokenAmount(
    amounts.token1,
    token1Meta.symbol
  )}`;
  const hasBalance = amounts.token0 > 0 || amounts.token1 > 0;
  const minPriceText = formatPriceFromSqrtX96(minSqrtX96, token0Meta.decimals, token1Meta.decimals);
  const maxPriceText = formatPriceFromSqrtX96(maxSqrtX96, token0Meta.decimals, token1Meta.decimals);
  const currentPriceText = formatPriceFromSqrtX96(currentSqrtX96, token0Meta.decimals, token1Meta.decimals);
  const valueSummary = buildPortfolioValueSummary(
    amounts.token0,
    amounts.token1,
    priceFromSqrtX96Number(currentSqrtX96, token0Meta.decimals, token1Meta.decimals),
    token0Meta.symbol,
    token1Meta.symbol
  );
  if (isUniswapV4Ethereum) {
    console.log(`${UNIV4_ETH_DEBUG_PREFIX} snapshot success`, {
      tokenId,
      liquidity: liquidity.toString(),
      currentTick,
      inRange,
      token0Symbol: token0Meta.symbol,
      token1Symbol: token1Meta.symbol,
      hasBalance,
      balanceText,
    });
  }

  return {
    id: position.id,
    title: `${token0Meta.symbol} / ${token1Meta.symbol}`,
    protocol: position.protocol,
    chain: position.chain,
    tokenId,
    feeLabel: position.feeLabel || formatV4FeeLabel(fee),
    status: "ok",
    inRange,
    rangeText: `${minPriceText} — ${maxPriceText}`,
    rangeMinText: `Min ${minPriceText} ${token1Meta.symbol} per ${token0Meta.symbol}`,
    rangeMaxText: `Max ${maxPriceText} ${token1Meta.symbol} per ${token0Meta.symbol}`,
    currentPriceText: `${currentPriceText} ${token1Meta.symbol} per ${token0Meta.symbol}`,
    balanceText,
    exposureText: valueSummary.exposureText,
    positionValueText: valueSummary.positionValueText,
    hasBalance,
    token0Symbol: token0Meta.symbol,
    token1Symbol: token1Meta.symbol,
    updatedAt: Date.now(),
  };
}

function useSettingsState() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  return { settings, setSettings };
}

function App() {
  const { settings, setSettings } = useSettingsState();
  const [arbSettings, setArbSettings] = useState<ArbSettings>(() => normalizeArbSettings());
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadThemeMode());
  const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">(() => resolveThemeMode(loadThemeMode()));
  const [activeTab, setActiveTab] = useState<TabId>(() => loadActiveTab());
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"main" | "notifications">("main");
  const [showNotificationsMenu, setShowNotificationsMenu] = useState(false);
  const notificationsMenuRef = useRef<HTMLDivElement | null>(null);
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement | null>(null);
  const themeOptionRefs = useRef<Record<ThemeMode, HTMLButtonElement | null>>({
    dark: null,
    light: null,
    system: null,
  });
  const [collapsedPairs, setCollapsedPairs] = useState<Record<string, boolean>>({});
  const [pairSortById, setPairSortById] = useState<Record<string, PairSortState>>({});
  const [selectedArbPairId, setSelectedArbPairId] = useState<string | null>(null);
  const [selectedArbNewPairId, setSelectedArbNewPairId] = useState<string | null>(null);
  const [hostedEnabledPairIds, setHostedEnabledPairIds] = useState<string[]>(() => loadHostedEnabledPairIds());
  const [hostedPairOverrides, setHostedPairOverrides] = useState<HostedPairOverrides>(() => loadHostedPairOverrides());
  const [hostedUserId] = useState(() => loadHostedUserId());
  const [hostedPriceAlerts, setHostedPriceAlerts] = useState<HostedPriceAlertsState>(() => loadHostedPriceAlertsState());
  const [hostedAlertPriceDrafts, setHostedAlertPriceDrafts] = useState<Record<string, string>>({});
  const [editingHostedPairId, setEditingHostedPairId] = useState<string | null>(null);
  const [editingHostedAlertPairId, setEditingHostedAlertPairId] = useState<string | null>(null);
  const [hostedAlertSaveStatus, setHostedAlertSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [hostedTelegramConnect, setHostedTelegramConnect] = useState<HostedTelegramConnectState>({
    loading: false,
    error: null,
    botUsername: "",
    startUrl: "",
  });
  const [quoteMap, setQuoteMap] = useState<QuoteMap>({});
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [arbError, setArbError] = useState<string | null>(null);
  const [isArbSyncing, setIsArbSyncing] = useState(false);
  const arbRefreshRequestInFlightRef = useRef(false);
  const [isPortfolioRefreshing, setIsPortfolioRefreshing] = useState(false);
  const isRunning = true;
  const lastNotificationRef = useRef<Record<string, { ts: number; amount: number }>>({});
  const [portfolioMap, setPortfolioMap] = useState<Record<string, PortfolioPositionSnapshot>>({});
  const [portfolioUpdatedAt, setPortfolioUpdatedAt] = useState<number | null>(null);
  const [portfolioNowMs, setPortfolioNowMs] = useState<number>(() => Date.now());
  const [portfolioScanStatus, setPortfolioScanStatus] = useState<PortfolioScanStatus>(() => ({
    phase: "idle",
    current: "Portfolio auto-scan on",
    logLines: appendPortfolioLog([], "Portfolio auto-scan enabled"),
    activeSources: [],
    scannedSources: 0,
    totalSources: 0,
    walletCount: 0,
    foundByChain: {},
    foundTotal: 0,
    updatedAt: null,
    nextUpdateAt: Date.now() + PORTFOLIO_REFRESH_MS,
    errors: [],
    sourceStates: {},
  }));
  const portfolioRefreshInFlightRef = useRef(false);
  const portfolioPendingRefreshPositionsRef = useRef<PortfolioPositionConfig[] | null>(null);
  const portfolioStatusRef = useRef<Record<string, boolean>>(loadPortfolioRangeStatus());
  const portfolioScanLogBodyRef = useRef<HTMLDivElement | null>(null);
  const [showAddPosition, setShowAddPosition] = useState(false);
  const [portfolioWalletInput, setPortfolioWalletInput] = useState(
    () => settings.portfolio?.walletAddress ?? ""
  );
  const [portfolioWalletTagInput, setPortfolioWalletTagInput] = useState(
    () => settings.portfolio?.walletTag ?? ""
  );
  const [portfolioDiscoveryError, setPortfolioDiscoveryError] = useState<string | null>(null);
  const [isPortfolioDiscovering, setIsPortfolioDiscovering] = useState(false);
  const portfolioDiscoveryInFlightRef = useRef(false);
  const [pendleRuntimeById, setPendleRuntimeById] = useState<Record<string, PendleStrategyRuntime>>({});
  const [expandedPendleStrategyId, setExpandedPendleStrategyId] = useState<string | null>(null);
  const [pendleNowMs, setPendleNowMs] = useState<number>(() => Date.now());
  const pendleCycleInFlightRef = useRef<Record<string, boolean>>({});
  const pendleTimersRef = useRef<Record<string, number>>({});
  const pendleStrategiesRef = useRef<PendleStrategyConfig[]>([]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (IS_HOSTED_MODE && activeTab === "pendle") {
      setActiveTab("arb");
      localStorage.setItem(TAB_STORAGE_KEY, "arb");
      return;
    }
    localStorage.setItem(TAB_STORAGE_KEY, activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (!IS_HOSTED_MODE || typeof window === "undefined") return;
    localStorage.setItem(HOSTED_ENABLED_PAIRS_STORAGE_KEY, JSON.stringify(hostedEnabledPairIds));
  }, [hostedEnabledPairIds]);

  useEffect(() => {
    if (!IS_HOSTED_MODE || typeof window === "undefined") return;
    localStorage.setItem(HOSTED_PAIR_OVERRIDES_STORAGE_KEY, JSON.stringify(hostedPairOverrides));
  }, [hostedPairOverrides]);

  useEffect(() => {
    if (!IS_HOSTED_MODE || typeof window === "undefined") return;
    localStorage.setItem(HOSTED_PRICE_ALERTS_STORAGE_KEY, JSON.stringify(hostedPriceAlerts));
  }, [hostedPriceAlerts]);

  const refreshHostedPriceAlerts = useCallback(async () => {
    if (!IS_HOSTED_MODE || !hostedUserId) return null;
    const response = await fetch(`/api/alerts?userId=${encodeURIComponent(hostedUserId)}`);
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload?.ok) return null;
    const next = sanitizeHostedPriceAlertsState(payload);
    setHostedPriceAlerts(next);
    return next;
  }, [hostedUserId]);

  const loadHostedTelegramConnect = useCallback(async () => {
    if (!IS_HOSTED_MODE || !hostedUserId) return null;
    setHostedTelegramConnect((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const response = await fetch(`/api/telegram/connect?userId=${encodeURIComponent(hostedUserId)}`);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? "Telegram connect is not configured");
      }
      setHostedTelegramConnect({
        loading: false,
        error: null,
        botUsername: String(payload.botUsername ?? ""),
        startUrl: String(payload.startUrl ?? ""),
      });
      if (payload.telegram) {
        setHostedPriceAlerts((prev) => sanitizeHostedPriceAlertsState({ ...prev, telegram: payload.telegram }));
      }
      return payload;
    } catch (error) {
      setHostedTelegramConnect({
        loading: false,
        error: error instanceof Error ? error.message : "Telegram connect failed",
        botUsername: "",
        startUrl: "",
      });
      return null;
    }
  }, [hostedUserId]);

  useEffect(() => {
    if (!IS_HOSTED_MODE || !hostedUserId) return;
    let cancelled = false;
    refreshHostedPriceAlerts()
      .then((payload) => {
        if (cancelled || !payload) return;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hostedUserId, refreshHostedPriceAlerts]);

  useEffect(() => {
    if (!IS_HOSTED_MODE || !editingHostedAlertPairId) return;
    void loadHostedTelegramConnect();
  }, [editingHostedAlertPairId, loadHostedTelegramConnect]);

  useEffect(() => {
    setHostedAlertPriceDrafts({});
  }, [editingHostedAlertPairId]);

  const toggleHostedPairEnabled = useCallback((pairId: string) => {
    if (!IS_HOSTED_MODE) return;
    setHostedEnabledPairIds((prev) => {
      const next = new Set(prev);
      if (next.has(pairId)) {
        next.delete(pairId);
      } else {
        next.add(pairId);
      }
      return next.size > 0 ? Array.from(next) : [];
    });
  }, []);

  useEffect(() => {
    const persisted = loadPersistedNotifications();
    if (!persisted) return;
    const hasNotifications = typeof persisted.notifications !== "undefined";
    const hasPortfolioToggle =
      typeof persisted.portfolioNotificationsEnabled === "boolean";
    const hasPendleToggle =
      typeof persisted.pendleNotificationsEnabled === "boolean";
    if (!hasNotifications && !hasPortfolioToggle && !hasPendleToggle) return;

    setSettings((prev) =>
      normalizeSettings({
        ...prev,
        notifications: hasNotifications
          ? { ...(prev.notifications ?? BASE_SETTINGS.notifications!), ...persisted.notifications }
          : prev.notifications,
        portfolio: {
          ...(prev.portfolio ?? BASE_SETTINGS.portfolio!),
          notificationsEnabled: hasPortfolioToggle
            ? Boolean(persisted.portfolioNotificationsEnabled)
            : prev.portfolio?.notificationsEnabled ?? false,
        },
        pendle: {
          ...(prev.pendle ?? BASE_SETTINGS.pendle!),
          notificationsEnabled: hasPendleToggle
            ? Boolean(persisted.pendleNotificationsEnabled)
            : prev.pendle?.notificationsEnabled ?? false,
        },
      })
    );
  }, [setSettings]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload: PersistedNotifications = {
      notifications: settings.notifications,
      portfolioNotificationsEnabled: settings.portfolio?.notificationsEnabled ?? false,
      pendleNotificationsEnabled: settings.pendle?.notificationsEnabled ?? false,
    };
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(payload));
  }, [settings.notifications, settings.pendle?.notificationsEnabled, settings.portfolio?.notificationsEnabled]);

  useEffect(() => {
    setPortfolioWalletInput(settings.portfolio?.walletAddress ?? "");
  }, [settings.portfolio?.walletAddress]);

  useEffect(() => {
    setPortfolioWalletTagInput(settings.portfolio?.walletTag ?? "");
  }, [settings.portfolio?.walletTag]);

  useEffect(() => {
    if (!showNotificationsMenu) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!notificationsMenuRef.current?.contains(event.target as Node)) {
        setShowNotificationsMenu(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [showNotificationsMenu]);

  useEffect(() => {
    if (!showThemeMenu) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!themeMenuRef.current?.contains(event.target as Node)) {
        setShowThemeMenu(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowThemeMenu(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showThemeMenu]);

  useEffect(() => {
    if (!showThemeMenu) return;
    const activeRef =
      themeOptionRefs.current[themeMode] ??
      themeOptionRefs.current[resolvedTheme] ??
      themeOptionRefs.current.system;
    activeRef?.focus();
  }, [resolvedTheme, showThemeMenu, themeMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const nextResolvedTheme = themeMode === "system" ? (media.matches ? "dark" : "light") : themeMode;
      setResolvedTheme(nextResolvedTheme);
      document.documentElement.setAttribute("data-theme", nextResolvedTheme);
      document.documentElement.style.colorScheme = nextResolvedTheme;
    };
    localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    applyTheme();
    if (themeMode !== "system") return;
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themeMode]);

  const networks = useMemo(() => settings.networks ?? [], [settings.networks]);
  const arbNetworks = useMemo(() => arbSettings.networks ?? [], [arbSettings.networks]);
  const allArbPairs = useMemo(
    () => applyHostedPairOverridesToPairs(arbSettings.pairs ?? [], hostedPairOverrides),
    [arbSettings.pairs, hostedPairOverrides]
  );
  const hostedEnabledPairSet = useMemo(() => new Set(hostedEnabledPairIds), [hostedEnabledPairIds]);
  const isHostedPairEnabled = useCallback(
    (pairId: string) => !IS_HOSTED_MODE || hostedEnabledPairSet.has(pairId),
    [hostedEnabledPairSet]
  );
  const activePairs = useMemo(
    () => (IS_HOSTED_MODE ? allArbPairs.filter((pair) => hostedEnabledPairSet.has(pair.id)) : allArbPairs),
    [allArbPairs, hostedEnabledPairSet]
  );
  const hostedQuoteQuery = useMemo(() => {
    if (!IS_HOSTED_MODE) return "";
    const pairIds = hostedEnabledPairIds
      .map((id) => id.trim())
      .filter(Boolean)
      .sort();
    const params = new URLSearchParams();
    if (pairIds.length > 0) {
      params.set("pairs", pairIds.join(","));
    }
    const overrides = sanitizeHostedPairOverrides(
      pairIds.reduce<HostedPairOverrides>((acc, pairId) => {
        const override = hostedPairOverrides[pairId];
        if (override) acc[pairId] = override;
        return acc;
      }, {})
    );
    if (Object.keys(overrides).length > 0) {
      params.set("overrides", JSON.stringify(overrides));
    }
    const query = params.toString();
    return query ? `?${query}` : "";
  }, [hostedEnabledPairIds, hostedPairOverrides]);
  const pendle = useMemo(() => {
    return (
      settings.pendle ?? {
        strategies: [
          {
            id: createPendleStrategyId(42161, "", 0),
            enabled: false,
            chainId: 42161,
            marketAddress: "",
            amount: "1000",
            orderTokenAddress: "",
            orderTokenSymbol: "TOKEN",
            orderTokenDecimals: 18,
            checkIntervalMs: 15_000,
            targetDiscountPct: 9,
            replaceLowerThresholdPct: 4.5,
            replaceThresholdPct: 4.98,
            orderExpiryMinutes: 1440,
          },
        ],
        underlyingSymbol: "TOKEN",
        underlyingDecimals: 18,
        rpcByChainId: {},
        limitOrderContractByChainId: {},
      }
    );
  }, [settings.pendle]);
  const pendleStrategies = useMemo(() => pendle.strategies ?? [], [pendle.strategies]);
  useEffect(() => {
    pendleStrategiesRef.current = pendleStrategies;
  }, [pendleStrategies]);
  useEffect(() => {
    if (pendleStrategies.length === 0) {
      setExpandedPendleStrategyId(null);
      return;
    }
    const stillExists =
      expandedPendleStrategyId &&
      pendleStrategies.some((strategy) => strategy.id === expandedPendleStrategyId);
    if (!stillExists) {
      setExpandedPendleStrategyId(pendleStrategies[0]?.id ?? null);
    }
  }, [expandedPendleStrategyId, pendleStrategies]);
  const activePendleStrategy = useMemo(
    () =>
      (expandedPendleStrategyId
        ? pendleStrategies.find((strategy) => strategy.id === expandedPendleStrategyId)
        : null) ?? pendleStrategies[0] ?? null,
    [expandedPendleStrategyId, pendleStrategies]
  );
  const activePendleRuntime = useMemo(
    () =>
      activePendleStrategy
        ? pendleRuntimeById[activePendleStrategy.id] ?? createPendleRuntimeState()
        : createPendleRuntimeState(),
    [activePendleStrategy, pendleRuntimeById]
  );
  const tokensById = useMemo(() => {
    const map: Record<string, TokenConfig> = {};
    settings.tokens?.forEach((token) => {
      map[token.id] = token;
    });
    return map;
  }, [settings.tokens]);
  const arbTokensById = useMemo(() => {
    const map: Record<string, TokenConfig> = {};
    arbSettings.tokens?.forEach((token) => {
      map[token.id] = token;
    });
    return map;
  }, [arbSettings.tokens]);

  const setPendleRuntime = useCallback((strategyId: string, patch: Partial<PendleStrategyRuntime>) => {
    setPendleRuntimeById((prev) => ({
      ...prev,
      [strategyId]: {
        ...createPendleRuntimeState(),
        ...(prev[strategyId] ?? {}),
        ...patch,
      },
    }));
  }, []);

  const pendleMarketInfo = activePendleRuntime.marketInfo;
  const pendleTokenMeta = activePendleRuntime.tokenMeta;
  const pendleCurrentApy = activePendleRuntime.currentApy;
  const pendleOrders = activePendleRuntime.orders;
  const pendleOrderRows = activePendleRuntime.orderRows;
  const pendleMarketLoading = activePendleRuntime.marketLoading;
  const pendleMarketError = activePendleRuntime.marketError;
  const pendleCycleError = activePendleRuntime.cycleError;
  const pendleCycleWarning = activePendleRuntime.cycleWarning;
  const pendleIsRunning = activePendleRuntime.isRunning;
  const pendleLastCheckedAt = activePendleRuntime.lastCheckedAt;
  const pendleNextCycleAt = activePendleRuntime.nextCycleAt;

  const pendleChainLabel = useMemo(
    () =>
      activePendleStrategy
        ? PENDLE_CHAIN_NAMES[activePendleStrategy.chainId] ?? `Chain ${activePendleStrategy.chainId}`
        : "—",
    [activePendleStrategy]
  );
  const pendleRpcUrl = useMemo(
    () =>
      activePendleStrategy
        ? pendle.rpcByChainId[String(activePendleStrategy.chainId)] ?? ""
        : "",
    [activePendleStrategy, pendle.rpcByChainId]
  );
  const pendleLimitOrderContract = useMemo(
    () =>
      activePendleStrategy
        ? pendle.limitOrderContractByChainId[String(activePendleStrategy.chainId)] ??
          DEFAULT_PENDLE_LIMIT_ROUTER
        : DEFAULT_PENDLE_LIMIT_ROUTER,
    [activePendleStrategy, pendle.limitOrderContractByChainId]
  );
  const pendleDisplayTokenMeta = useMemo(() => {
    if (pendleTokenMeta) return pendleTokenMeta;
    const decimals = Number(pendle.underlyingDecimals);
    if (Number.isFinite(decimals) && decimals >= 0) {
      return {
        symbol: pendle.underlyingSymbol?.trim() || "TOKEN",
        decimals,
      };
    }
    return null;
  }, [pendle.underlyingDecimals, pendle.underlyingSymbol, pendleTokenMeta]);

  const pendleNetworkKey = useMemo(() => {
    return activePendleStrategy ? PENDLE_CHAIN_NETWORK_KEY[activePendleStrategy.chainId] ?? "" : "";
  }, [activePendleStrategy]);

  const pendleTokenOptions = useMemo(() => {
    const options: Array<{ address: string; label: string; symbol: string; decimals: number }> = [];
    const seen = new Set<string>();
    const pushOption = (addressRaw: string, symbol: string, decimals: number, label?: string) => {
      const address = addressRaw.trim();
      if (!EVM_ADDRESS_RE.test(address)) return;
      const key = address.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      options.push({
        address,
        symbol,
        decimals,
        label: label?.trim() || symbol,
      });
    };
    if (pendleNetworkKey) {
      settings.tokens?.forEach((token) => {
        const mainAddress = token.addresses?.[pendleNetworkKey]?.trim() ?? "";
        const decimals = Number(token.decimalsByNetwork?.[pendleNetworkKey] ?? 18);
        if (mainAddress) {
          pushOption(mainAddress, token.symbol, Number.isFinite(decimals) ? decimals : 18, token.symbol);
        }
        const variants = token.variantsByNetwork?.[pendleNetworkKey] ?? [];
        variants.forEach((variant) => {
          const variantAddress = variant.address?.trim() ?? "";
          const variantDecimals = Number(
            variant.decimals ?? token.decimalsByNetwork?.[pendleNetworkKey] ?? 18
          );
          const variantLabel = variant.label?.trim() || token.symbol;
          pushOption(
            variantAddress,
            token.symbol,
            Number.isFinite(variantDecimals) ? variantDecimals : 18,
            variantLabel
          );
        });
      });
    }
    if (pendleMarketInfo?.underlyingAssetAddress) {
      const decimals =
        Number.isFinite(Number(pendle.underlyingDecimals)) && Number(pendle.underlyingDecimals) >= 0
          ? Number(pendle.underlyingDecimals)
          : 18;
      pushOption(
        pendleMarketInfo.underlyingAssetAddress,
        pendleDisplayTokenMeta?.symbol ?? pendle.underlyingSymbol ?? "TOKEN",
        decimals,
        pendleDisplayTokenMeta?.symbol ?? pendle.underlyingSymbol ?? "Underlying"
      );
    }
    return options;
  }, [
    pendle.underlyingDecimals,
    pendle.underlyingSymbol,
    pendleDisplayTokenMeta?.symbol,
    pendleMarketInfo?.underlyingAssetAddress,
    pendleNetworkKey,
    settings.tokens,
  ]);

  const pendleSelectedToken = useMemo(() => {
    const selected = (activePendleStrategy?.orderTokenAddress ?? "").trim().toLowerCase();
    if (selected) {
      const found = pendleTokenOptions.find((item) => item.address.toLowerCase() === selected);
      if (found) return found;
    }
    const firstOption = pendleTokenOptions[0];
    if (firstOption) return firstOption;
    return {
      address: pendleMarketInfo?.underlyingAssetAddress ?? "",
      label: activePendleStrategy?.orderTokenSymbol ?? pendleDisplayTokenMeta?.symbol ?? "TOKEN",
      symbol: activePendleStrategy?.orderTokenSymbol ?? pendleDisplayTokenMeta?.symbol ?? "TOKEN",
      decimals:
        Number.isFinite(Number(activePendleStrategy?.orderTokenDecimals)) &&
        Number(activePendleStrategy?.orderTokenDecimals) >= 0
          ? Number(activePendleStrategy?.orderTokenDecimals)
          : pendleDisplayTokenMeta?.decimals ?? 18,
    };
  }, [
    activePendleStrategy?.orderTokenAddress,
    activePendleStrategy?.orderTokenDecimals,
    activePendleStrategy?.orderTokenSymbol,
    pendleDisplayTokenMeta?.decimals,
    pendleDisplayTokenMeta?.symbol,
    pendleMarketInfo?.underlyingAssetAddress,
    pendleTokenOptions,
  ]);

  const updatePendleSettings = useCallback(
    (patch: Partial<PendleConfig>) => {
      setSettings({
        ...settings,
        pendle: {
          ...pendle,
          ...patch,
        },
      });
    },
    [pendle, setSettings, settings]
  );

  const updatePendleStrategy = useCallback(
    (strategyId: string, patch: Partial<PendleStrategyConfig>) => {
      updatePendleSettings({
        strategies: pendleStrategies.map((strategy) =>
          strategy.id === strategyId ? { ...strategy, ...patch } : strategy
        ),
      });
    },
    [pendleStrategies, updatePendleSettings]
  );

  const addPendleStrategy = useCallback(() => {
    const fallback = activePendleStrategy ?? pendleStrategies[0];
    const nextChainId = fallback?.chainId ?? 42161;
    const next = {
      id: createPendleStrategyId(nextChainId, "", Date.now()),
      enabled: false,
      chainId: nextChainId,
      marketAddress: "",
      amount: fallback?.amount ?? "1000",
      orderTokenAddress: fallback?.orderTokenAddress ?? "",
      orderTokenSymbol: fallback?.orderTokenSymbol ?? "TOKEN",
      orderTokenDecimals: fallback?.orderTokenDecimals ?? 18,
      checkIntervalMs: fallback?.checkIntervalMs ?? 15_000,
      targetDiscountPct: fallback?.targetDiscountPct ?? 9,
      replaceLowerThresholdPct: fallback?.replaceLowerThresholdPct ?? 4.5,
      replaceThresholdPct: fallback?.replaceThresholdPct ?? 4.98,
      orderExpiryMinutes: fallback?.orderExpiryMinutes ?? 1440,
    } as PendleStrategyConfig;
    updatePendleSettings({ strategies: [...pendleStrategies, next] });
    setExpandedPendleStrategyId(next.id);
  }, [activePendleStrategy, pendleStrategies, updatePendleSettings]);

  const removePendleStrategy = useCallback(
    (strategyId: string) => {
      const nextStrategies = pendleStrategies.filter((strategy) => strategy.id !== strategyId);
      if (nextStrategies.length === 0) return;
      updatePendleSettings({ strategies: nextStrategies });
      if (expandedPendleStrategyId === strategyId) {
        setExpandedPendleStrategyId(nextStrategies[0]?.id ?? null);
      }
      setPendleRuntimeById((prev) => {
        const next = { ...prev };
        delete next[strategyId];
        return next;
      });
      delete pendleCycleInFlightRef.current[strategyId];
      const timer = pendleTimersRef.current[strategyId];
      if (timer) clearTimeout(timer);
      delete pendleTimersRef.current[strategyId];
    },
    [expandedPendleStrategyId, pendleStrategies, updatePendleSettings]
  );

  useEffect(() => {
    if (!activePendleStrategy) return;
    const nextAddress = pendleSelectedToken.address?.trim() ?? "";
    if (!nextAddress) return;
    const currentAddress = (activePendleStrategy.orderTokenAddress ?? "").trim();
    const currentDecimals =
      Number.isFinite(Number(activePendleStrategy.orderTokenDecimals)) &&
      Number(activePendleStrategy.orderTokenDecimals) >= 0
        ? Number(activePendleStrategy.orderTokenDecimals)
        : null;
    const needsUpdate =
      !currentAddress ||
      currentAddress.toLowerCase() !== nextAddress.toLowerCase() ||
      currentDecimals !== pendleSelectedToken.decimals ||
      (activePendleStrategy.orderTokenSymbol ?? "") !== pendleSelectedToken.symbol;
    if (!needsUpdate) return;
    updatePendleStrategy(activePendleStrategy.id, {
      orderTokenAddress: nextAddress,
      orderTokenDecimals: pendleSelectedToken.decimals,
      orderTokenSymbol: pendleSelectedToken.symbol,
    });
  }, [
    activePendleStrategy,
    pendleSelectedToken.address,
    pendleSelectedToken.decimals,
    pendleSelectedToken.symbol,
    updatePendleStrategy,
  ]);

  const getPendleNextCycleLabel = useCallback(
    (strategyId: string) => {
      const strategy = pendleStrategies.find((item) => item.id === strategyId);
      if (!strategy?.enabled) return "Paused";
      const runtime = pendleRuntimeById[strategyId] ?? createPendleRuntimeState();
      if (runtime.isRunning && runtime.nextCycleAt === null) return "Checking now";
      if (runtime.nextCycleAt === null) return "Pending";
      const diffSec = Math.ceil((runtime.nextCycleAt - pendleNowMs) / 1000);
      if (diffSec <= 0) return "Due now";
      return `Next in ${formatShortCountdown(diffSec)}`;
    },
    [pendleNowMs, pendleRuntimeById, pendleStrategies]
  );

  const pendleNextCycleLabel = useMemo(
    () => (activePendleStrategy ? getPendleNextCycleLabel(activePendleStrategy.id) : "Paused"),
    [activePendleStrategy, getPendleNextCycleLabel]
  );

  const getNetworksForPair = useCallback(
    (pair: PairConfig) => arbNetworks.filter((net) => pair.networks?.[net.chain]),
    [arbNetworks]
  );

  const getPairTokens = useCallback(
    (pair: PairConfig) => ({
      base: arbTokensById[pair.baseTokenId],
      quote: arbTokensById[pair.quoteTokenId],
    }),
    [arbTokensById]
  );

  const editingHostedPairBase = useMemo(
    () => (editingHostedPairId ? (arbSettings.pairs ?? []).find((pair) => pair.id === editingHostedPairId) ?? null : null),
    [arbSettings.pairs, editingHostedPairId]
  );

  const editingHostedPair = useMemo(
    () => (editingHostedPairId ? allArbPairs.find((pair) => pair.id === editingHostedPairId) ?? null : null),
    [allArbPairs, editingHostedPairId]
  );

  const editingHostedPairTokens = useMemo(
    () => (editingHostedPair ? getPairTokens(editingHostedPair) : { base: undefined, quote: undefined }),
    [editingHostedPair, getPairTokens]
  );

  const editingHostedPairLabel = editingHostedPair
    ? `${editingHostedPairTokens.base?.symbol ?? editingHostedPair.baseTokenId}/${editingHostedPairTokens.quote?.symbol ?? editingHostedPair.quoteTokenId}`
    : "";

  const editableHostedPairNetworks = useMemo(() => {
    if (!editingHostedPairBase) return [];
    return arbNetworks.filter((net) => editingHostedPairBase.networks?.[net.chain]);
  }, [arbNetworks, editingHostedPairBase]);

  const editingHostedAlertPairBase = useMemo(
    () => (editingHostedAlertPairId ? (arbSettings.pairs ?? []).find((pair) => pair.id === editingHostedAlertPairId) ?? null : null),
    [arbSettings.pairs, editingHostedAlertPairId]
  );

  const editingHostedAlertPair = useMemo(
    () => (editingHostedAlertPairId ? allArbPairs.find((pair) => pair.id === editingHostedAlertPairId) ?? null : null),
    [allArbPairs, editingHostedAlertPairId]
  );

  const editingHostedAlertPairTokens = useMemo(
    () => (editingHostedAlertPair ? getPairTokens(editingHostedAlertPair) : { base: undefined, quote: undefined }),
    [editingHostedAlertPair, getPairTokens]
  );

  const editingHostedAlertPairLabel = editingHostedAlertPair
    ? `${editingHostedAlertPairTokens.base?.symbol ?? editingHostedAlertPair.baseTokenId}/${editingHostedAlertPairTokens.quote?.symbol ?? editingHostedAlertPair.quoteTokenId}`
    : "";

  const editableHostedAlertNetworks = useMemo(() => {
    if (!editingHostedAlertPairBase) return [];
    return arbNetworks.filter((net) => editingHostedAlertPairBase.networks?.[net.chain]);
  }, [arbNetworks, editingHostedAlertPairBase]);

  const getHostedPairAlert = useCallback(
    (pairId: string, side: HostedPriceAlertSide): HostedPriceAlert => {
      return (
        hostedPriceAlerts.alerts.find((alert) => alert.pairId === pairId && alert.side === side) ?? {
          id: `${pairId}-${side}`,
          pairId,
          side,
          operator: side === "buy" ? "below" : "above",
          price: 1,
          networks: [],
          enabled: false,
          cooldownMs: DEFAULT_PRICE_ALERT_COOLDOWN_MS,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      );
    },
    [hostedPriceAlerts.alerts]
  );

  const upsertHostedPairAlert = useCallback((pairId: string, side: HostedPriceAlertSide, patch: Partial<HostedPriceAlert>) => {
    setHostedPriceAlerts((prev) => {
      const existing = prev.alerts.find((alert) => alert.pairId === pairId && alert.side === side) ?? getHostedPairAlert(pairId, side);
      const nextAlert = sanitizeHostedPriceAlert({
        ...existing,
        ...patch,
        pairId,
        side,
        updatedAt: Date.now(),
      });
      if (!nextAlert) return prev;
      const alerts = prev.alerts.filter((alert) => !(alert.pairId === pairId && alert.side === side));
      return { ...prev, alerts: [...alerts, nextAlert] };
    });
    setHostedAlertSaveStatus("idle");
  }, [getHostedPairAlert]);

  const getHostedAlertDraftKey = useCallback((pairId: string, side: HostedPriceAlertSide) => `${pairId}:${side}`, []);

  const updateHostedAlertPriceDraft = useCallback(
    (pairId: string, side: HostedPriceAlertSide, value: string) => {
      const draftKey = getHostedAlertDraftKey(pairId, side);
      setHostedAlertPriceDrafts((prev) => ({ ...prev, [draftKey]: value }));
      const price = Number(value);
      if (value.trim() !== "" && Number.isFinite(price) && price > 0) {
        upsertHostedPairAlert(pairId, side, { price });
      }
    },
    [getHostedAlertDraftKey, upsertHostedPairAlert]
  );

  const clearHostedAlertPriceDraftIfInvalid = useCallback(
    (pairId: string, side: HostedPriceAlertSide) => {
      const draftKey = getHostedAlertDraftKey(pairId, side);
      setHostedAlertPriceDrafts((prev) => {
        const value = prev[draftKey];
        if (typeof value === "undefined") return prev;
        const price = Number(value);
        if (value.trim() !== "" && Number.isFinite(price) && price > 0) return prev;
        const next = { ...prev };
        delete next[draftKey];
        return next;
      });
    },
    [getHostedAlertDraftKey]
  );

  const saveHostedPriceAlerts = useCallback(async () => {
    if (!IS_HOSTED_MODE || !hostedUserId) return;
    setHostedAlertSaveStatus("saving");
    const payload = sanitizeHostedPriceAlertsState(hostedPriceAlerts);
    try {
      const response = await fetch("/api/alerts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: hostedUserId, ...payload }),
      });
      if (!response.ok) throw new Error(await response.text());
      const saved = await response.json();
      setHostedPriceAlerts(sanitizeHostedPriceAlertsState(saved));
      setHostedAlertSaveStatus("saved");
      setEditingHostedAlertPairId(null);
    } catch {
      setHostedAlertSaveStatus("error");
    }
  }, [hostedPriceAlerts, hostedUserId]);

  const updateHostedPairAmount = useCallback((pairId: string, amount: string) => {
    if (!IS_HOSTED_MODE) return;
    setHostedPairOverrides((prev) => ({
      ...prev,
      [pairId]: {
        ...(prev[pairId] ?? {}),
        amount,
      },
    }));
  }, []);

  const updateHostedPairNetwork = useCallback(
    (pairId: string, chain: string, enabled: boolean) => {
      if (!IS_HOSTED_MODE) return;
      const basePair = (arbSettings.pairs ?? []).find((pair) => pair.id === pairId);
      setHostedPairOverrides((prev) =>
        sanitizeHostedPairOverrides({
          ...prev,
          [pairId]: {
            ...(prev[pairId] ?? {}),
            networks: {
              ...(basePair?.networks ?? {}),
              ...(prev[pairId]?.networks ?? {}),
              [chain]: enabled,
            },
          },
        })
      );
    },
    [arbSettings.pairs]
  );

  const resetHostedPairOverride = useCallback((pairId: string) => {
    if (!IS_HOSTED_MODE) return;
    setHostedPairOverrides((prev) => {
      const next = { ...prev };
      delete next[pairId];
      return next;
    });
  }, []);

  const computeUsdcUsdtRateFromQuotes = useCallback(
    (pair: PairConfig, quotes: VariantQuote[]): number | null => {
      const candidate = quotes.find(
        (item) =>
          (item.status === "ok" || item.status === "loading") && item.buy && item.sell
      );
      if (!candidate?.buy || !candidate.sell) return null;
      const rates: number[] = [];
      if (pair.baseTokenId === "usdc" && pair.quoteTokenId === "usdt") {
        const buyRate = Number(candidate.buy.receiveAmount) / Number(candidate.buy.fromAmount);
        const sellRate = Number(candidate.sell.fromAmount) / Number(candidate.sell.receiveAmount);
        if (Number.isFinite(buyRate)) rates.push(buyRate);
        if (Number.isFinite(sellRate)) rates.push(sellRate);
      } else {
        const buyRate = Number(candidate.buy.fromAmount) / Number(candidate.buy.receiveAmount);
        const sellRate = Number(candidate.sell.receiveAmount) / Number(candidate.sell.fromAmount);
        if (Number.isFinite(buyRate)) rates.push(buyRate);
        if (Number.isFinite(sellRate)) rates.push(sellRate);
      }
      if (rates.length === 0) return null;
      return rates.reduce((sum, value) => sum + value, 0) / rates.length;
    },
    []
  );

  const buildTokenVariants = useCallback(
    (token: TokenConfig, chain: string): TokenVariant[] => {
      const variants: TokenVariant[] = [];
      const baseDecimals = token.decimalsByNetwork?.[chain] ?? 18;
      const mainAddressRaw = token.addresses?.[chain];
      const mainAddress = typeof mainAddressRaw === "string" ? mainAddressRaw.trim() : "";
      const usdtToken = arbTokensById.usdt;
      const proxyUsdt =
        token.id === "usdc" &&
        chain === "plasma" &&
        !mainAddress &&
        usdtToken?.addresses?.[chain];
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
    },
    [arbTokensById]
  );

  const buildVariantCombos = useCallback(
    (pair: PairConfig, network: NetworkConfig) => {
      const base = arbTokensById[pair.baseTokenId];
      const quote = arbTokensById[pair.quoteTokenId];
      if (!base || !quote) {
        return {
          combos: [] as Array<{ id: string; baseVariant: TokenVariant; quoteVariant: TokenVariant }>,
          error: "Missing token mapping",
          baseSymbol: base?.symbol ?? pair.baseTokenId,
          quoteSymbol: quote?.symbol ?? pair.quoteTokenId,
        };
      }
      const baseVariants = buildTokenVariants(base, network.chain);
      const quoteVariants = buildTokenVariants(quote, network.chain);
      if (baseVariants.length === 0 || quoteVariants.length === 0) {
        return {
          combos: [] as Array<{ id: string; baseVariant: TokenVariant; quoteVariant: TokenVariant }>,
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
    },
    [arbTokensById, buildTokenVariants]
  );

  const buildErrorVariantItem = useCallback(
    (
      pair: PairConfig,
      network: NetworkConfig,
      baseSymbol: string,
      quoteSymbol: string,
      message: string
    ): VariantQuote => ({
      id: `${pair.id}-${network.chain}-error`,
      networkId: network.chain,
      status: "error",
      baseVariant: { id: "base", label: baseSymbol, address: "", decimals: 0 },
      quoteVariant: { id: "quote", label: quoteSymbol, address: "", decimals: 0 },
      error: message,
      updatedAt: Date.now(),
    }),
    []
  );

  const getPairAmount = useCallback(
    (pair: PairConfig) => (pair.amount?.trim() ? pair.amount : arbSettings.defaultAmount),
    [arbSettings.defaultAmount]
  );

  const refreshPendleOrders = useCallback(
    async (
      strategy: PendleStrategyConfig,
      market: PendleMarketInfo,
      currentApy: number | null
    ) => {
      const response = await fetch(`${PENDLE_WORKER_BASE}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chainId: strategy.chainId,
          marketAddress: market.address,
          currentApy:
            typeof currentApy === "number" && Number.isFinite(currentApy)
              ? currentApy
              : null,
          orderTokenAddress: strategy.orderTokenAddress,
          orderTokenDecimals: strategy.orderTokenDecimals,
        }),
      });
      const json = (await response.json()) as {
        ok: boolean;
        error?: string;
        warning?: string;
        currentApy?: number;
        orders?: PendleMakerOrder[];
        rows?: PendleOrderSnapshot[];
      };
      if (!response.ok || !json.ok) {
        throw new Error(json.error || `HTTP ${response.status}`);
      }
      setPendleRuntime(strategy.id, {
        currentApy:
          typeof json.currentApy === "number" && Number.isFinite(json.currentApy) && json.currentApy > 0
            ? json.currentApy
            : currentApy,
        orders: Array.isArray(json.orders) ? json.orders : [],
        orderRows: Array.isArray(json.rows) ? json.rows : [],
        cycleWarning: json.warning ?? null,
      });
      return Array.isArray(json.orders) ? json.orders : [];
    },
    [setPendleRuntime]
  );

  const loadPendleMarket = useCallback(
    async (strategyId: string) => {
      const strategy = pendleStrategiesRef.current.find((item) => item.id === strategyId);
      if (!strategy) return;
      const rawAddress = strategy.marketAddress.trim();
      if (!rawAddress) {
        setPendleRuntime(strategyId, {
          marketInfo: null,
          tokenMeta: null,
          currentApy: null,
          orders: [],
          orderRows: [],
          marketError: null,
          marketLoading: false,
        });
        return;
      }
      if (!EVM_ADDRESS_RE.test(rawAddress)) {
        setPendleRuntime(strategyId, {
          marketInfo: null,
          tokenMeta: null,
          currentApy: null,
          orders: [],
          orderRows: [],
          marketError: "Enter a valid EVM market address",
          marketLoading: false,
        });
        return;
      }
      setPendleRuntime(strategyId, { marketLoading: true, marketError: null });
      try {
        const pendleApi = await loadPendleModule();
        const info = await pendleApi.fetchPendleMarketInfo(strategy.chainId, rawAddress);
        const rpcUrl = pendle.rpcByChainId[String(strategy.chainId)]?.trim();
        let tokenMeta: { symbol: string; decimals: number } | null = null;
        if (rpcUrl) {
          try {
            tokenMeta = await pendleApi.fetchTokenMeta(rpcUrl, info.underlyingAssetAddress);
          } catch {
            tokenMeta = null;
          }
        }
        const marketData = await pendleApi.fetchPendleMarketData(info.chainId, info.address);
        const impliedApy = Number(marketData.impliedApy ?? 0);
        const normalizedApy = Number.isFinite(impliedApy) ? impliedApy : null;
        setPendleRuntime(strategyId, {
          marketInfo: info,
          tokenMeta,
          currentApy: normalizedApy,
          cycleError: null,
        });
        await refreshPendleOrders(strategy, info, normalizedApy);
        if (!tokenMeta) {
          setPendleRuntime(strategyId, {
            marketError:
              "Market loaded, but token metadata via RPC is unavailable. Set a working RPC or use manual symbol/decimals.",
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load market";
        setPendleRuntime(strategyId, {
          marketInfo: null,
          tokenMeta: null,
          currentApy: null,
          orders: [],
          orderRows: [],
          marketError: /failed to fetch/i.test(message)
            ? "Failed to fetch market details (check internet / CORS / market address)"
            : message,
        });
      } finally {
        setPendleRuntime(strategyId, { marketLoading: false });
      }
    },
    [pendle.rpcByChainId, refreshPendleOrders, setPendleRuntime]
  );

  const runPendleCycleByStrategyId = useCallback(
    async (strategyId: string): Promise<boolean> => {
      const strategy = pendleStrategiesRef.current.find((item) => item.id === strategyId);
      if (!strategy) return false;
      if (pendleCycleInFlightRef.current[strategyId]) return true;
      const rawAddress = strategy.marketAddress.trim();
      if (!EVM_ADDRESS_RE.test(rawAddress)) {
        setPendleRuntime(strategyId, {
          cycleError: "Enter a valid EVM market address",
        });
        return true;
      }
      const rpcUrl = (pendle.rpcByChainId[String(strategy.chainId)] ?? "").trim();
      const verifyingContract =
        (pendle.limitOrderContractByChainId[String(strategy.chainId)] ?? DEFAULT_PENDLE_LIMIT_ROUTER).trim() ||
        DEFAULT_PENDLE_LIMIT_ROUTER;
      if (!strategy.amount.trim() || Number(strategy.amount) <= 0) {
        setPendleRuntime(strategyId, { cycleError: "Amount must be greater than 0" });
        return true;
      }
      if (!strategy.orderTokenAddress || !Number.isFinite(Number(strategy.orderTokenDecimals))) {
        setPendleRuntime(strategyId, {
          cycleError: "Order token is not configured. Select token and decimals.",
        });
        return true;
      }
      pendleCycleInFlightRef.current[strategyId] = true;
      setPendleRuntime(strategyId, { isRunning: true, cycleWarning: null, nextCycleAt: null });
      try {
        const response = await fetch(`${PENDLE_WORKER_BASE}/run-cycle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chainId: strategy.chainId,
            marketAddress: rawAddress,
            amount: strategy.amount,
            checkIntervalMs: strategy.checkIntervalMs,
            targetDiscountPct: strategy.targetDiscountPct,
            replaceLowerThresholdPct: strategy.replaceLowerThresholdPct,
            replaceThresholdPct: strategy.replaceThresholdPct,
            orderExpiryMinutes: strategy.orderExpiryMinutes,
            orderTokenAddress: strategy.orderTokenAddress,
            orderTokenDecimals: strategy.orderTokenDecimals,
            orderTokenSymbol: strategy.orderTokenSymbol,
            rpcUrl,
            limitOrderContract: verifyingContract,
          }),
        });
        const json = (await response.json()) as {
          ok: boolean;
          error?: string;
          warning?: string;
          stopStrategy?: boolean;
          stopReason?: string;
          currentApy?: number;
          orders?: PendleMakerOrder[];
          rows?: PendleOrderSnapshot[];
        };
        if (!response.ok || !json.ok) {
          throw new Error(json.error || `HTTP ${response.status}`);
        }
        setPendleRuntime(strategyId, {
          currentApy:
            typeof json.currentApy === "number" && Number.isFinite(json.currentApy) && json.currentApy > 0
              ? json.currentApy
              : null,
          orders: Array.isArray(json.orders) ? json.orders : [],
          orderRows: Array.isArray(json.rows) ? json.rows : [],
          cycleWarning: json.warning ?? null,
          lastCheckedAt: Date.now(),
          cycleError: null,
        });
        if (json.stopStrategy) {
          updatePendleStrategy(strategyId, { enabled: false });
          setPendleRuntime(strategyId, {
            cycleWarning: json.stopReason || "Strategy stopped: filled amount dropped below configured amount.",
            nextCycleAt: null,
          });
          return false;
        }
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Pendle cycle failed";
        setPendleRuntime(strategyId, { cycleError: `Pendle cycle failed: ${message}` });
        return true;
      } finally {
        setPendleRuntime(strategyId, { isRunning: false });
        pendleCycleInFlightRef.current[strategyId] = false;
      }
    },
    [pendle.limitOrderContractByChainId, pendle.rpcByChainId, setPendleRuntime, updatePendleStrategy]
  );

  const stopPendleStrategyById = useCallback(
    async (strategyId: string) => {
      const strategy = pendleStrategiesRef.current.find((item) => item.id === strategyId);
      if (!strategy) return;
      if (pendleCycleInFlightRef.current[strategyId]) {
        setPendleRuntime(strategyId, {
          cycleWarning: "Wait for current cycle to finish, then stop again.",
        });
        return;
      }

      const rawAddress = strategy.marketAddress.trim();
      const rpcUrl = (pendle.rpcByChainId[String(strategy.chainId)] ?? "").trim();
      const verifyingContract =
        (pendle.limitOrderContractByChainId[String(strategy.chainId)] ?? DEFAULT_PENDLE_LIMIT_ROUTER).trim() ||
        DEFAULT_PENDLE_LIMIT_ROUTER;

      setPendleRuntime(strategyId, {
        isRunning: true,
        cycleError: null,
        cycleWarning: null,
      });

      try {
        if (EVM_ADDRESS_RE.test(rawAddress) && rpcUrl) {
          const response = await fetch(`${PENDLE_WORKER_BASE}/cancel-all`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chainId: strategy.chainId,
              marketAddress: rawAddress,
              rpcUrl,
              limitOrderContract: verifyingContract,
              orderTokenDecimals: strategy.orderTokenDecimals,
            }),
          });
          const json = (await response.json()) as {
            ok: boolean;
            error?: string;
            currentApy?: number | null;
            canceledCount?: number;
            orders?: PendleMakerOrder[];
            rows?: PendleOrderSnapshot[];
          };
          if (!response.ok || !json.ok) {
            throw new Error(json.error || `HTTP ${response.status}`);
          }
          setPendleRuntime(strategyId, {
            currentApy:
              typeof json.currentApy === "number" && Number.isFinite(json.currentApy)
                ? json.currentApy
                : null,
            orders: Array.isArray(json.orders) ? json.orders : [],
            orderRows: Array.isArray(json.rows) ? json.rows : [],
            cycleWarning: `Stopped. Canceled ${Number(json.canceledCount ?? 0)} active order(s).`,
            lastCheckedAt: Date.now(),
          });
        } else {
          setPendleRuntime(strategyId, {
            cycleWarning: "Stopped.",
          });
        }
        updatePendleStrategy(strategyId, { enabled: false });
        setPendleRuntime(strategyId, { nextCycleAt: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to stop strategy";
        setPendleRuntime(strategyId, {
          cycleError: `Stop failed: ${message}`,
        });
      } finally {
        setPendleRuntime(strategyId, { isRunning: false });
      }
    },
    [pendle.limitOrderContractByChainId, pendle.rpcByChainId, setPendleRuntime, updatePendleStrategy]
  );

  useEffect(() => {
    if (!activePendleStrategy) return;
    const rawAddress = activePendleStrategy.marketAddress.trim();
    if (!rawAddress) {
      setPendleRuntime(activePendleStrategy.id, {
        marketInfo: null,
        tokenMeta: null,
        currentApy: null,
        orders: [],
        orderRows: [],
        marketError: null,
      });
      return;
    }
    const timer = window.setTimeout(() => {
      loadPendleMarket(activePendleStrategy.id).catch(() => undefined);
    }, 350);
    return () => clearTimeout(timer);
  }, [activePendleStrategy, loadPendleMarket, setPendleRuntime]);

  useEffect(() => {
    pendleStrategies.forEach((strategy) => {
      const rawAddress = strategy.marketAddress.trim();
      if (!EVM_ADDRESS_RE.test(rawAddress)) return;
      const runtime = pendleRuntimeById[strategy.id];
      if (runtime?.marketInfo || runtime?.marketLoading) return;
      loadPendleMarket(strategy.id).catch(() => undefined);
    });
  }, [loadPendleMarket, pendleRuntimeById, pendleStrategies]);

  useEffect(() => {
    Object.values(pendleTimersRef.current).forEach((timer) => clearTimeout(timer));
    pendleTimersRef.current = {};
    pendleStrategies.forEach((strategy) => {
      if (!strategy.enabled) {
        setPendleRuntime(strategy.id, { nextCycleAt: null, isRunning: false });
      }
    });
    let cancelled = false;
    const runAndSchedule = async (strategyId: string) => {
      if (cancelled) return;
      const shouldContinue = await runPendleCycleByStrategyId(strategyId);
      if (cancelled) return;
      if (!shouldContinue) return;
      const strategy = pendleStrategiesRef.current.find((item) => item.id === strategyId);
      if (!strategy?.enabled) return;
      const interval = Math.max(1_000, Number(strategy.checkIntervalMs || 15_000));
      setPendleRuntime(strategyId, { nextCycleAt: Date.now() + interval });
      pendleTimersRef.current[strategyId] = window.setTimeout(() => {
        runAndSchedule(strategyId).catch(() => undefined);
      }, interval);
    };
    pendleStrategies
      .filter((strategy) => strategy.enabled)
      .forEach((strategy) => {
        runAndSchedule(strategy.id).catch(() => undefined);
      });
    return () => {
      cancelled = true;
      Object.values(pendleTimersRef.current).forEach((timer) => clearTimeout(timer));
      pendleTimersRef.current = {};
    };
  }, [pendleStrategies, runPendleCycleByStrategyId, setPendleRuntime]);

  useEffect(() => {
    const hasEnabledWithNext = pendleStrategies.some((strategy) => {
      if (!strategy.enabled) return false;
      const runtime = pendleRuntimeById[strategy.id];
      return typeof runtime?.nextCycleAt === "number" && Number.isFinite(runtime.nextCycleAt);
    });
    if (!hasEnabledWithNext) return;
    const updateNow = () => setPendleNowMs(Date.now());
    updateNow();
    const timer = window.setInterval(updateNow, 250);
    return () => clearInterval(timer);
  }, [pendleRuntimeById, pendleStrategies]);

  const applyArbSnapshotPayload = useCallback((payload: Partial<ArbSnapshotResponse>) => {
    if (payload.settings && !IS_HOSTED_MODE) {
      setArbSettings(normalizeArbSettings(payload.settings));
    }
    if (payload.quoteMap) {
      setQuoteMap((previous) => mergeLoadingQuoteMap(previous, payload.quoteMap ?? {}));
    }
    if (typeof payload.updatedAt === "number") {
      setLastUpdated(payload.updatedAt);
    }
    setArbError(null);
  }, []);

  const streamArbRefresh = useCallback(async () => {
    if (arbRefreshRequestInFlightRef.current) return;
    arbRefreshRequestInFlightRef.current = true;
    setIsArbSyncing(true);
    setQuoteMap((previous) => markQuoteMapRefreshing(previous, activePairs));
    try {
      const response = await fetch(`${ARB_STREAM_ENDPOINT}${hostedQuoteQuery}`, {
        method: "GET",
        headers: { accept: "application/x-ndjson" },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.body) {
        throw new Error("Streaming response is not available");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const payload = JSON.parse(trimmed) as Partial<ArbSnapshotResponse> & { error?: string };
          if (payload.error) {
            throw new Error(payload.error);
          }
          applyArbSnapshotPayload(payload);
          setIsArbSyncing(Boolean(payload.refreshing || payload.stale));
        }
        if (done) break;
      }

      const finalLine = buffer.trim();
      if (finalLine) {
        const payload = JSON.parse(finalLine) as Partial<ArbSnapshotResponse> & { error?: string };
        if (payload.error) {
          throw new Error(payload.error);
        }
        applyArbSnapshotPayload(payload);
        setIsArbSyncing(Boolean(payload.refreshing || payload.stale));
      } else {
        setIsArbSyncing(false);
      }
    } catch (error) {
      try {
        await fetch(`${ARB_REFRESH_ENDPOINT}${hostedQuoteQuery}`, {
          method: "POST",
          headers: { accept: "application/json" },
        });
      } catch {
        // Polling will retry on the next cycle; keep the stream error visible.
      }
      setIsArbSyncing(false);
      setArbError(error instanceof Error ? error.message : "Failed to stream Arb refresh");
    } finally {
      arbRefreshRequestInFlightRef.current = false;
    }
  }, [activePairs, applyArbSnapshotPayload, hostedQuoteQuery]);

  const refreshQuotes = useCallback(async () => {
    if (!isRunning) return false;
    if (IS_HOSTED_MODE) {
      await streamArbRefresh();
      return false;
    }
    try {
      const response = await fetch(`${ARB_SNAPSHOT_ENDPOINT}${hostedQuoteQuery}`, {
        method: "GET",
        headers: {
          accept: "application/json",
        },
      });
      const payload = (await response.json()) as ArbSnapshotResponse & { error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      applyArbSnapshotPayload(payload);
      const nextRefreshing = Boolean(payload.refreshing || payload.stale);
      setIsArbSyncing(nextRefreshing);
      if (payload.stale && !payload.refreshing && !arbRefreshRequestInFlightRef.current) {
        arbRefreshRequestInFlightRef.current = true;
        fetch(`${ARB_REFRESH_ENDPOINT}${hostedQuoteQuery}`, {
          method: "POST",
          headers: { accept: "application/json" },
        })
          .catch(() => undefined)
          .finally(() => {
            arbRefreshRequestInFlightRef.current = false;
          });
      }
      setArbError(null);
      return nextRefreshing;
    } catch (error) {
      setIsArbSyncing(false);
      setArbError(error instanceof Error ? error.message : "Failed to load shared Arb data");
      return false;
    }
  }, [
    applyArbSnapshotPayload,
    hostedQuoteQuery,
    isRunning,
    streamArbRefresh,
  ]);

  useEffect(() => {
    if (!isRunning) return;
    let isMounted = true;
    let timer: number | undefined;

    const run = async () => {
      if (!isMounted) return;
      const nextRefreshing = await refreshQuotes();
      if (!isMounted) return;
      timer = window.setTimeout(run, nextRefreshing ? 1000 : arbSettings.refreshMs);
    };

    run();
    return () => {
      isMounted = false;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [arbSettings.refreshMs, isRunning, refreshQuotes]);

  const opportunitiesByPair = useMemo(() => {
    return activePairs.map((pair) => {
      const { base, quote } = getPairTokens(pair);
      const baseSymbol = base?.symbol ?? pair.baseTokenId;
      const quoteSymbol = quote?.symbol ?? pair.quoteTokenId;
      const amountRaw = getPairAmount(pair);
      const amountValue = Number(amountRaw);
      const list: ArbitrageOpportunity[] = [];
      const pairQuotes = quoteMap[pair.id] ?? {};
      const rules = arbSettings.arbitrageRules ?? [];
      const excludedChains = new Set(
        Object.entries(pairQuotes)
          .filter(([, items]) => (items ?? []).some((item) => item.excludeFromArb))
          .map(([chain]) => chain)
      );
      const rawQuotes = getNetworksForPair(pair)
        .flatMap((net) => {
          if (excludedChains.has(net.chain)) return [];
          const items = pairQuotes[net.chain] ?? [];
          return items.map((item) => ({ net, quote: item }));
        })
        .filter((item) => {
          if (!item.quote || !item.quote.buy || !item.quote.sell) return false;
          if (item.quote.excludeFromArb) return false;
          return item.quote.status === "ok";
        });
      const sanityMedians = {
        buyPrice: medianNumber(rawQuotes.map((item) => finitePositiveNumber(item.quote.buy?.price) ?? 0)),
        sellPrice: medianNumber(rawQuotes.map((item) => finitePositiveNumber(item.quote.sell?.price) ?? 0)),
        buyReceive: medianNumber(rawQuotes.map((item) => finitePositiveNumber(item.quote.buy?.receiveAmount) ?? 0)),
      };
      const quotes = rawQuotes.filter((item) => isQuoteSaneForArbitrage(item.quote, sanityMedians));

      for (const buyItem of quotes) {
        const buyUpdatedAt = Number(buyItem.quote?.updatedAt ?? 0);
        if (!Number.isFinite(buyUpdatedAt) || buyUpdatedAt <= 0) continue;
        const buyPrice = Number(buyItem.quote?.buy?.price ?? 0);
        if (!Number.isFinite(buyPrice) || buyPrice <= 0) continue;
        for (const sellItem of quotes) {
          const sameChain = buyItem.net.chain === sellItem.net.chain;
          if (buyItem.quote.id === sellItem.quote.id) continue;
          if (sameChain && !pair.allowSameChainArb) continue;
          if (sameChain && (pair.sameChainRequiresDifferentMarkets ?? true)) {
            const buyMarket = buyItem.quote.buy?.market?.trim().toLowerCase() ?? "";
            const sellMarket = sellItem.quote.sell?.market?.trim().toLowerCase() ?? "";
            if (buyMarket && sellMarket && buyMarket === sellMarket) {
              continue;
            }
          }
          const sellUpdatedAt = Number(sellItem.quote?.updatedAt ?? 0);
          if (!Number.isFinite(sellUpdatedAt) || sellUpdatedAt <= 0) continue;
          if (Math.abs(buyUpdatedAt - sellUpdatedAt) > arbSettings.refreshMs) continue;
          const sellPrice = Number(sellItem.quote?.sell?.price ?? 0);
          if (!Number.isFinite(sellPrice) || sellPrice <= 0) continue;
          const profit = sellPrice - buyPrice;
          const profitPct = (profit / buyPrice) * 100;
          const profitTotal =
            Number.isFinite(amountValue) && amountValue > 0
              ? amountValue * (sellPrice / buyPrice - 1)
              : profit;
          const matchedRules = rules.filter((rule) => {
            const networkMatch = rule.network
              ? rule.side === "buy"
                ? buyItem.net.chain === rule.network
                : rule.side === "sell"
                ? sellItem.net.chain === rule.network
                : buyItem.net.chain === rule.network || sellItem.net.chain === rule.network
              : true;
            if (!networkMatch) return false;
            const tokenId = rule.tokenId?.toLowerCase() ?? "";
            const tokenSymbol = rule.tokenSymbol?.toLowerCase() ?? "";
            const baseId = pair.baseTokenId.toLowerCase();
            const quoteId = pair.quoteTokenId.toLowerCase();
            const baseName = baseSymbol.toLowerCase();
            const quoteName = quoteSymbol.toLowerCase();
            if (!tokenId && !tokenSymbol) return true;
            if (rule.tokenSide === "base") {
              return tokenId ? baseId === tokenId : baseName === tokenSymbol;
            }
            if (rule.tokenSide === "quote") {
              return tokenId ? quoteId === tokenId : quoteName === tokenSymbol;
            }
            return tokenId
              ? baseId === tokenId || quoteId === tokenId
              : baseName === tokenSymbol || quoteName === tokenSymbol;
          });
          const routeMinProfitPct =
            matchedRules.length > 0
              ? Math.max(...matchedRules.map((rule) => rule.minProfitPct))
              : arbSettings.minProfitPct;
          let pairMinProfitPct = routeMinProfitPct;
          if (pair.id === "ausd-usdc") {
            pairMinProfitPct = Math.max(pairMinProfitPct, 0.04);
          }
          pairMinProfitPct *= getArbThresholdMultiplier(
            pair.id,
            buyItem.net.chain,
            sellItem.net.chain,
            sellItem.quote.routeLabel
          );
          if (profitPct >= pairMinProfitPct) {
            const routeTags = matchedRules.map((rule) => rule.tag).filter(Boolean) as string[];
            if (isMovementUsdcUsdtSourceDeal(pair.id, buyItem.net.chain)) {
              routeTags.push("18h");
            }
            if (isAvalancheSavusdRedeemSellDeal(pair.id, sellItem.net.chain, sellItem.quote.routeLabel)) {
              routeTags.push("7d");
            }
            list.push({
              buyNet: buyItem.net.name,
              sellNet: sellItem.net.name,
              buyChain: buyItem.net.chain,
              sellChain: sellItem.net.chain,
              profit,
              profitTotal,
              profitPct,
              minProfitThreshold: pairMinProfitPct,
              buyPrice,
              sellPrice,
              amount: Number.isFinite(amountValue) ? amountValue : 0,
              buyVariant: buyItem.quote?.buy?.receiveVariantLabel,
              sellVariant: sellItem.quote?.sell?.receiveVariantLabel,
              buyFromVariant: buyItem.quote?.buy?.fromVariantLabel,
              buyToVariant: buyItem.quote?.buy?.receiveVariantLabel,
              sellFromVariant: sellItem.quote?.sell?.fromVariantLabel,
              sellToVariant: sellItem.quote?.sell?.receiveVariantLabel,
              buyBaseVariant: buyItem.quote.baseVariant,
              buyQuoteVariant: buyItem.quote.quoteVariant,
              sellBaseVariant: sellItem.quote.baseVariant,
              sellQuoteVariant: sellItem.quote.quoteVariant,
              buyRouteLabel: buyItem.quote.routeLabel,
              sellRouteLabel: sellItem.quote.routeLabel,
              routeTags,
            });
          }
        }
      }

      return {
        pair,
        baseSymbol,
        quoteSymbol,
        opportunities: list.sort((a, b) => b.profitPct - a.profitPct),
      };
    });
  }, [
    activePairs,
    getNetworksForPair,
    getPairAmount,
    getPairTokens,
    arbSettings.arbitrageRules,
    arbSettings.minProfitPct,
    arbSettings.refreshMs,
    quoteMap,
  ]);

  const pairRefreshDoneMap = useMemo(() => {
    const doneByPair: Record<string, boolean> = {};
    activePairs.forEach((pair) => {
      const networksForPair = getNetworksForPair(pair);
      if (networksForPair.length === 0) {
        doneByPair[pair.id] = false;
        return;
      }
      const pairQuotes = quoteMap[pair.id] ?? {};
      doneByPair[pair.id] = networksForPair.every((net) => {
        const items = pairQuotes[net.chain];
        if (!items || items.length === 0) return false;
        return items.every((item) => item.status !== "idle" && item.status !== "loading");
      });
    });
    return doneByPair;
  }, [activePairs, getNetworksForPair, quoteMap]);

  const formatTokenWithVariant = useCallback((symbol: string, variant?: string) => {
    if (!variant) return symbol;
    const normalized = variant.trim();
    if (!normalized) return symbol;
    if (normalized.toLowerCase() === symbol.toLowerCase()) return symbol;
    return normalized;
  }, []);

  const getNotificationRule = useCallback(
    (pairId: string) => settings.notifications?.pairs.find((rule) => rule.pairId === pairId),
    [settings.notifications?.pairs]
  );

  const getNotificationThreshold = useCallback(
    (pairId: string, buyChain: string, sellChain: string) => {
      const rule = getNotificationRule(pairId);
      const base = rule?.minProfitPct ?? settings.minProfitPct;
      const overrides = rule?.networks ?? {};
      const buyOverride = overrides[buyChain];
      if (typeof buyOverride === "number" && Number.isFinite(buyOverride)) return buyOverride;
      const sellOverride = overrides[sellChain];
      if (typeof sellOverride === "number" && Number.isFinite(sellOverride)) return sellOverride;
      return base;
    },
    [getNotificationRule, settings.minProfitPct]
  );

  const sendTelegramMessage = useCallback(
    async (text: string) => {
      const telegram = settings.notifications?.telegram;
      if (!telegram?.botToken || !telegram.chatId) return;
      const response = await fetch("/api/telegram/send-message", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          botToken: telegram.botToken,
          chat_id: telegram.chatId,
          text,
        }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Telegram error: ${response.status} ${errorText.slice(0, 120)}`);
      }
    },
    [settings.notifications?.telegram]
  );

  useEffect(() => {
    if (!settings.notifications?.enabled) return;
    const telegram = settings.notifications.telegram;
    if (!telegram?.botToken || !telegram.chatId) return;
    const now = Date.now();
    const cooldownMs = 60_000;
    const minAmountChangePct = Math.max(
      0,
      Number(settings.notifications?.minAmountChangePct ?? 30)
    );

    opportunitiesByPair.forEach(({ pair, baseSymbol, quoteSymbol, opportunities }) => {
      if (!pairRefreshDoneMap[pair.id]) return;
      opportunities.forEach((opp) => {
        const threshold = getNotificationThreshold(pair.id, opp.buyChain, opp.sellChain);
        if (opp.profitPct < threshold) return;
        const key = `${pair.id}|${opp.buyChain}|${opp.sellChain}|${opp.buyToVariant}|${opp.sellToVariant}|${opp.buyRouteLabel ?? ""}|${opp.sellRouteLabel ?? ""}`;
        const lastState = lastNotificationRef.current[key];
        const lastSent = lastState?.ts ?? 0;
        if (now - lastSent < cooldownMs) return;
        const previousAmount = lastState?.amount ?? null;
        const currentAmount = opp.profitTotal;
        if (previousAmount !== null && Number.isFinite(previousAmount) && Number.isFinite(currentAmount)) {
          const changePct =
            previousAmount === 0
              ? 100
              : (Math.abs(currentAmount - previousAmount) / Math.abs(previousAmount)) * 100;
          if (changePct < minAmountChangePct) return;
        }
        const buyFrom = formatTokenWithVariant(quoteSymbol, opp.buyFromVariant);
        const buyTo = formatTokenWithVariant(baseSymbol, opp.buyToVariant);
        const sellFrom = formatTokenWithVariant(baseSymbol, opp.sellFromVariant);
        const sellTo = formatTokenWithVariant(quoteSymbol, opp.sellToVariant);
        const sameChain = opp.buyChain === opp.sellChain;
        const buyRouteSuffix = opp.buyRouteLabel ? ` via ${opp.buyRouteLabel}` : "";
        const sellRouteSuffix = opp.sellRouteLabel ? ` via ${opp.sellRouteLabel}` : "";
        const routeText = sameChain
          ? `Swap ${buyFrom} -> ${buyTo} on ${opp.buyNet}${buyRouteSuffix}, then swap ${sellFrom} -> ${sellTo} on ${opp.sellNet}${sellRouteSuffix}.`
          : `Swap ${buyFrom} -> ${buyTo} on ${opp.buyNet}${buyRouteSuffix}, then bridge to ${opp.sellNet} and swap ${sellFrom} -> ${sellTo} on ${opp.sellNet}${sellRouteSuffix}.`;
        const message = [
          routeText,
          `Expected profit: ${formatNumber(opp.profitTotal.toFixed(6))} ${quoteSymbol}`,
        ].join("\n");
        sendTelegramMessage(message).catch(() => undefined);
        lastNotificationRef.current[key] = { ts: now, amount: currentAmount };
      });
    });
  }, [
    opportunitiesByPair,
    pairRefreshDoneMap,
    settings.notifications,
    formatTokenWithVariant,
    getNotificationThreshold,
    sendTelegramMessage,
    quoteMap,
  ]);

  const refreshPortfolioPositions = useCallback(async (positions: PortfolioPositionConfig[]) => {
    if (positions.length === 0) {
      setPortfolioMap({});
      if (portfolioDiscoveryInFlightRef.current) return;
      setPortfolioScanStatus((prev) => ({
        ...prev,
        phase: "idle",
        current: "No configured positions to refresh",
        logLines: appendPortfolioLog(prev.logLines, "No configured positions to refresh"),
        foundByChain: {},
        foundTotal: 0,
        updatedAt: Date.now(),
      }));
      return;
    }
    if (portfolioRefreshInFlightRef.current) {
      portfolioPendingRefreshPositionsRef.current = positions;
      return;
    }
    portfolioPendingRefreshPositionsRef.current = null;
    portfolioRefreshInFlightRef.current = true;
    setIsPortfolioRefreshing(true);
    setPortfolioScanStatus((prev) => ({
      ...prev,
      phase: "refreshing",
      current: `Refreshing ${positions.length} ${positions.length === 1 ? "position" : "positions"}...`,
      logLines: appendPortfolioLog(
        prev.logLines,
        `Refreshing ${positions.length} ${positions.length === 1 ? "position" : "positions"}...`
      ),
      foundByChain: positions.reduce<Record<string, number>>((counts, position) => {
        const chain = position.chain?.trim() || "Unknown";
        counts[chain] = (counts[chain] ?? 0) + 1;
        return counts;
      }, {}),
      foundTotal: positions.length,
    }));
    try {
      const snapshots = await Promise.all(
        positions.map(async (position) => {
          try {
            return isYuzuPosition(position)
              ? await fetchYuzuPositionSnapshot(position)
              : isInitiaPosition(position)
              ? await fetchInitiaPositionSnapshot(position)
              : isUniswapV4Position(position)
              ? await fetchUniswapV4PositionSnapshot(position)
              : await fetchUniswapV3PositionSnapshot(position);
          } catch (error) {
            return {
              id: position.id,
              title: position.title?.trim() || `${formatProtocolDisplayName(position.protocol)} #${position.tokenId}`,
              protocol: position.protocol,
              chain: position.chain,
              tokenId: position.tokenId,
              feeLabel: position.feeLabel,
              status: "error" as const,
              error: error instanceof Error ? error.message : "Failed to load position",
              updatedAt: Date.now(),
            };
          }
        })
      );
      const emptyPositionIds = new Set(
        snapshots
          .filter((item) => item.status === "ok" && item.hasBalance === false)
          .map((item) => item.id)
      );
      const trackedSnapshots = snapshots.filter((item) => !emptyPositionIds.has(item.id));
      const nextMap: Record<string, PortfolioPositionSnapshot> = {};
      trackedSnapshots.forEach((item) => {
        nextMap[item.id] = item;
      });
      setPortfolioMap(nextMap);
      if (emptyPositionIds.size > 0) {
        setSettings((prev) => ({
          ...prev,
          portfolio: {
            refreshMs: prev.portfolio?.refreshMs ?? PORTFOLIO_REFRESH_MS,
            notificationsEnabled: prev.portfolio?.notificationsEnabled ?? false,
            walletAddress: prev.portfolio?.walletAddress ?? "",
            walletTag: prev.portfolio?.walletTag ?? "",
            wallets: prev.portfolio?.wallets ?? [getDefaultPortfolioWallet()],
            ignoredEmptyPositionIds: Array.from(
              new Set([...(prev.portfolio?.ignoredEmptyPositionIds ?? []), ...Array.from(emptyPositionIds)])
            ),
            positions: (prev.portfolio?.positions ?? []).filter((item) => !emptyPositionIds.has(item.id)),
          },
        }));
      }
      const updatedAt = Date.now();
      const snapshotCounts = snapshots.reduce<Record<string, { total: number; empty: number; errors: number }>>(
        (counts, snapshot) => {
          const chain = snapshot.chain?.trim() || "Unknown";
          const existing = counts[chain] ?? { total: 0, empty: 0, errors: 0 };
          existing.total += 1;
          if (snapshot.status === "error") existing.errors += 1;
          if (snapshot.status === "ok" && snapshot.hasBalance === false) existing.empty += 1;
          counts[chain] = existing;
          return counts;
        },
        {}
      );
      const nonEmptyCounts = trackedSnapshots.reduce<Record<string, number>>((counts, snapshot) => {
        if (snapshot.status !== "ok") return counts;
        const chain = snapshot.chain?.trim() || "Unknown";
        counts[chain] = (counts[chain] ?? 0) + 1;
        return counts;
      }, {});
      const nonEmptyTotal = Object.values(nonEmptyCounts).reduce((sum, count) => sum + count, 0);
      setPortfolioUpdatedAt(updatedAt);
      setPortfolioScanStatus((prev) => ({
        ...prev,
        phase: "idle",
        current: `Updated ${nonEmptyTotal} ${nonEmptyTotal === 1 ? "position" : "positions"}`,
        logLines: Object.entries(snapshotCounts).reduce((lines, [chain, counts]) => {
          const parts = [`updated ${counts.total} ${counts.total === 1 ? "position" : "positions"} on ${chain}`];
          if (counts.empty > 0) parts.push(`${counts.empty} empty`);
          if (counts.errors > 0) parts.push(`${counts.errors} error${counts.errors === 1 ? "" : "s"}`);
          return appendPortfolioLog(lines, parts.join(", "));
        }, appendPortfolioLog(prev.logLines, "Position refresh complete")),
        foundByChain: nonEmptyCounts,
        foundTotal: nonEmptyTotal,
        updatedAt,
      }));
    } finally {
      setIsPortfolioRefreshing(false);
      portfolioRefreshInFlightRef.current = false;
      const pendingPositions = portfolioPendingRefreshPositionsRef.current;
      portfolioPendingRefreshPositionsRef.current = null;
      if (pendingPositions) {
        window.setTimeout(() => {
          refreshPortfolioPositions(pendingPositions).catch(() => undefined);
        }, 0);
      }
    }
  }, []);

  const refreshPortfolio = useCallback(async () => {
    if (!isRunning) return;
    await refreshPortfolioPositions(settings.portfolio?.positions ?? []);
  }, [isRunning, refreshPortfolioPositions, settings.portfolio?.positions]);

  const portfolioPositions = IS_HOSTED_MODE ? [] : settings.portfolio?.positions ?? [];
  const portfolioNotificationsEnabled = !IS_HOSTED_MODE && (settings.portfolio?.notificationsEnabled ?? false);
  const trackedPortfolioWallets = IS_HOSTED_MODE
    ? []
    : settings.portfolio?.wallets ?? [getDefaultPortfolioWallet()];
  const nonEmptyPortfolioCountsByChain = useMemo(() => {
    const counts: Record<string, number> = {};
    Object.values(portfolioMap).forEach((snapshot) => {
      if (snapshot.status !== "ok" || snapshot.hasBalance === false) return;
      const chain = snapshot.chain?.trim() || "Unknown";
      counts[chain] = (counts[chain] ?? 0) + 1;
    });
    return counts;
  }, [portfolioMap]);

  useEffect(() => {
    const timer = window.setInterval(() => setPortfolioNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const discoverPortfolioWallets = useCallback(
    async (walletsToScan: PortfolioWalletConfig[], options?: { manual?: boolean }) => {
      const normalizedWallets: PortfolioWalletConfig[] = [];
      walletsToScan.forEach((wallet) => {
        try {
          const address = normalizePortfolioWalletAddress(String(wallet.address ?? "").trim());
          normalizedWallets.push({
            address,
            tag: String(wallet.tag ?? "").trim() || formatDefaultWalletTag(address),
          });
        } catch {
          // Invalid saved wallet rows are ignored during automatic discovery.
        }
      });

      if (normalizedWallets.length === 0) {
        if (options?.manual) setPortfolioDiscoveryError("Enter a valid wallet address");
        return;
      }
      if (portfolioDiscoveryInFlightRef.current) return;

      portfolioDiscoveryInFlightRef.current = true;
      setPortfolioDiscoveryError(null);
      setIsPortfolioDiscovering(true);
      setPortfolioScanStatus((prev) => ({
        ...prev,
        phase: "scanning",
        current: `Scanning ${normalizedWallets.length} ${normalizedWallets.length === 1 ? "wallet" : "wallets"}...`,
        logLines: appendPortfolioLog(
          prev.logLines,
          `Starting scan for ${normalizedWallets.length} ${normalizedWallets.length === 1 ? "wallet" : "wallets"}`
        ),
        activeSources: [],
        scannedSources: 0,
        totalSources: normalizedWallets.length * PORTFOLIO_DISCOVERY_SOURCES.length,
        walletCount: normalizedWallets.length,
        foundByChain: {},
        foundTotal: 0,
        errors: [],
        sourceStates: Object.fromEntries(PORTFOLIO_DISCOVERY_SOURCES.map((source) => [source.id, "idle"])),
      }));
      try {
        const discoveries: Array<{
          wallet: PortfolioWalletConfig;
          positions: PortfolioPositionConfig[];
        }> = [];
        for (const wallet of normalizedWallets) {
          const positions = await discoverPortfolioPositions(wallet.address, {
            onProgress: (event) => {
              const sourceKey = `${event.owner}:${event.source.id}`;
              setPortfolioScanStatus((prev) => {
                const activeSources = new Set(prev.activeSources);
                const foundByChain = { ...prev.foundByChain };
                const errors = [...prev.errors];
                const sourceStates = { ...prev.sourceStates };
                let scannedSources = prev.scannedSources;
                let current = `Scanning ${event.source.chain}...`;

                if (event.type === "source-start") {
                  activeSources.add(sourceKey);
                  sourceStates[event.source.id] = "scanning";
                  return {
                    ...prev,
                    phase: "scanning",
                    current,
                    logLines: appendPortfolioLog(prev.logLines, `Scanning ${event.source.chain} (${event.source.protocol})...`),
                    activeSources: Array.from(activeSources),
                    scannedSources,
                    foundByChain,
                    foundTotal: Object.values(foundByChain).reduce((sum, count) => sum + count, 0),
                    errors: errors.slice(-4),
                    sourceStates,
                  };
                } else {
                  activeSources.delete(sourceKey);
                  scannedSources += 1;
                  if (event.type === "source-complete") {
                    sourceStates[event.source.id] = "done";
                    const foundCount = event.tokenIds?.length ?? 0;
                    if (foundCount > 0) {
                      foundByChain[event.source.chain] = (foundByChain[event.source.chain] ?? 0) + foundCount;
                    }
                    current =
                      foundCount > 0
                        ? `Found ${foundCount} ${foundCount === 1 ? "position" : "positions"} on ${event.source.chain}`
                        : `Scanned ${event.source.chain}`;
                  } else {
                    sourceStates[event.source.id] = "error";
                    errors.push(`${event.source.chain}: ${event.error ?? "scan failed"}`);
                    current = `Scan failed on ${event.source.chain}`;
                  }
                }

                const foundTotal = Object.values(foundByChain).reduce((sum, count) => sum + count, 0);
                const logMessage =
                  event.type === "source-complete"
                    ? (event.tokenIds?.length ?? 0) > 0
                      ? `Found ${event.tokenIds?.length ?? 0} ${(event.tokenIds?.length ?? 0) === 1 ? "position" : "positions"} on ${event.source.chain}`
                      : `No positions on ${event.source.chain} (${event.source.protocol})`
                    : `Error on ${event.source.chain}: ${event.error ?? "scan failed"}`;
                const completedAll = prev.totalSources > 0 && scannedSources >= prev.totalSources;
                return {
                  ...prev,
                  phase: "scanning",
                  current,
                  logLines: completedAll
                    ? appendPortfolioLog(appendPortfolioLog(prev.logLines, logMessage), "All sources scanned")
                    : appendPortfolioLog(prev.logLines, logMessage),
                  activeSources: Array.from(activeSources),
                  scannedSources,
                  foundByChain,
                  foundTotal,
                  errors: errors.slice(-4),
                  sourceStates,
                };
              });
            },
          });
          discoveries.push({ wallet, positions });
        }

        const ignoredEmptyPositionIds = new Set(settings.portfolio?.ignoredEmptyPositionIds ?? []);
        const scannedAddressSet = new Set(normalizedWallets.map((wallet) => wallet.address.toLowerCase()));
        const nextPositions = discoveries.flatMap(({ wallet, positions }) =>
          positions
            .filter((item) => item.sourceMode === "yuzu" || !ignoredEmptyPositionIds.has(item.id))
            .map((item) => ({
              ...item,
              walletAddress: wallet.address,
              walletTag: wallet.tag,
            }))
        );

        setSettings((prev) => {
          const existingWallets = prev.portfolio?.wallets ?? [];
          const mergedWallets = new Map<string, PortfolioWalletConfig>();
          existingWallets.forEach((wallet) => {
            try {
              const address = normalizePortfolioWalletAddress(wallet.address);
              mergedWallets.set(address.toLowerCase(), {
                address,
                tag: wallet.tag?.trim() || formatDefaultWalletTag(address),
              });
            } catch {
              // Ignore invalid saved wallet rows.
            }
          });
          normalizedWallets.forEach((wallet) => {
            mergedWallets.set(wallet.address.toLowerCase(), wallet);
          });

          return {
            ...prev,
            portfolio: {
              refreshMs: prev.portfolio?.refreshMs ?? PORTFOLIO_REFRESH_MS,
              notificationsEnabled: prev.portfolio?.notificationsEnabled ?? false,
              walletAddress: normalizedWallets[0]?.address ?? prev.portfolio?.walletAddress ?? "",
              walletTag: normalizedWallets[0]?.tag ?? prev.portfolio?.walletTag ?? "",
              wallets: Array.from(mergedWallets.values()),
              ignoredEmptyPositionIds: prev.portfolio?.ignoredEmptyPositionIds ?? [],
              positions: [
                ...(prev.portfolio?.positions ?? []).filter((item) => {
                  try {
                    const walletAddress = item.walletAddress ? normalizePortfolioWalletAddress(item.walletAddress) : "";
                    return !walletAddress || !scannedAddressSet.has(walletAddress.toLowerCase());
                  } catch {
                    return true;
                  }
                }),
                ...nextPositions,
              ],
            },
          };
        });

        if (options?.manual) {
          setShowAddPosition(false);
        }
        if (nextPositions.length === 0) {
          setPortfolioDiscoveryError(
            normalizedWallets.length === 1
              ? "No supported positions found for this wallet"
              : "No supported positions found for tracked wallets"
          );
          setPortfolioScanStatus((prev) => ({
            ...prev,
            phase: "idle",
            current: "No supported positions found",
            logLines: appendPortfolioLog(prev.logLines, "No supported positions found"),
            foundByChain: {},
            foundTotal: 0,
            updatedAt: Date.now(),
          }));
        }
        if (nextPositions.length > 0) {
          const foundByChain = nextPositions.reduce<Record<string, number>>((counts, position) => {
            const chain = position.chain?.trim() || "Unknown";
            counts[chain] = (counts[chain] ?? 0) + 1;
            return counts;
          }, {});
          setPortfolioScanStatus((prev) => ({
            ...prev,
            phase: "refreshing",
            current: `Found ${nextPositions.length} ${nextPositions.length === 1 ? "position" : "positions"}; refreshing...`,
            logLines: appendPortfolioLog(
              prev.logLines,
              `Found ${nextPositions.length} ${nextPositions.length === 1 ? "position" : "positions"} total; refreshing balances`
            ),
            foundByChain,
            foundTotal: nextPositions.length,
          }));
          void refreshPortfolioPositions(nextPositions).catch(() => undefined);
        }
      } catch (error) {
        setPortfolioDiscoveryError(
          error instanceof Error ? error.message : "Failed to discover wallet positions"
        );
        setPortfolioScanStatus((prev) => ({
          ...prev,
          phase: "idle",
          current: error instanceof Error ? error.message : "Failed to discover wallet positions",
          logLines: appendPortfolioLog(
            prev.logLines,
            error instanceof Error ? `Scan failed: ${error.message}` : "Scan failed"
          ),
          errors: [...prev.errors, error instanceof Error ? error.message : "Failed to discover wallet positions"].slice(-4),
        }));
      } finally {
        setIsPortfolioDiscovering(false);
        portfolioDiscoveryInFlightRef.current = false;
      }
    },
    [refreshPortfolioPositions, setSettings]
  );

  const discoverPortfolioByWallet = useCallback(async () => {
    await discoverPortfolioWallets(
      [
        {
          address: portfolioWalletInput,
          tag: portfolioWalletTagInput,
        },
      ],
      { manual: true }
    );
  }, [discoverPortfolioWallets, portfolioWalletInput, portfolioWalletTagInput]);

  const portfolioAutoDiscoveryWallets = useMemo(() => {
    if (trackedPortfolioWallets.length > 0) return trackedPortfolioWallets;
    const fallbackAddress = settings.portfolio?.walletAddress?.trim();
    if (fallbackAddress) {
      return [
        {
          address: fallbackAddress,
          tag: settings.portfolio?.walletTag ?? "",
        },
      ];
    }
    return [getDefaultPortfolioWallet()];
  }, [settings.portfolio?.walletAddress, settings.portfolio?.walletTag, trackedPortfolioWallets]);

  const portfolioAutoDiscoveryKey = useMemo(
    () =>
      portfolioAutoDiscoveryWallets
        .map((wallet) => `${wallet.address.trim().toLowerCase()}:${wallet.tag?.trim() ?? ""}`)
        .join("|"),
    [portfolioAutoDiscoveryWallets]
  );

  useEffect(() => {
    if (IS_HOSTED_MODE) return;
    if (portfolioAutoDiscoveryWallets.length === 0) return;
    let mounted = true;
    let timer: number | undefined;
    const run = async () => {
      if (!mounted) return;
      await discoverPortfolioWallets(portfolioAutoDiscoveryWallets);
      if (!mounted) return;
      const nextUpdateAt = Date.now() + PORTFOLIO_REFRESH_MS;
      setPortfolioScanStatus((prev) => ({
        ...prev,
        nextUpdateAt,
      }));
      timer = window.setTimeout(() => {
        run().catch(() => undefined);
      }, PORTFOLIO_REFRESH_MS);
    };
    run().catch(() => undefined);
    return () => {
      mounted = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [discoverPortfolioWallets, portfolioAutoDiscoveryKey]);

  useEffect(() => {
    if (IS_HOSTED_MODE) return;
    if (activeTab !== "portfolio") return;
    if (portfolioPositions.length === 0) return;
    refreshPortfolio().catch(() => undefined);
  }, [activeTab, portfolioPositions, refreshPortfolio]);

  const removePortfolioWallet = useCallback(
    (address: string) => {
      let normalizedAddress = "";
      try {
        normalizedAddress = normalizePortfolioWalletAddress(address);
      } catch {
        return;
      }
      const nextWallets = trackedPortfolioWallets.filter((item) => {
        try {
          return normalizePortfolioWalletAddress(item.address) !== normalizedAddress;
        } catch {
          return false;
        }
      });
      const fallbackWallet = nextWallets[0] ?? null;
      setSettings({
        ...settings,
        portfolio: {
          refreshMs: settings.portfolio?.refreshMs ?? PORTFOLIO_REFRESH_MS,
          notificationsEnabled: portfolioNotificationsEnabled,
          walletAddress: fallbackWallet?.address ?? "",
          walletTag: fallbackWallet?.tag ?? "",
          wallets: nextWallets,
          ignoredEmptyPositionIds: settings.portfolio?.ignoredEmptyPositionIds ?? [],
          positions: portfolioPositions.filter((item) => {
            try {
              return normalizePortfolioWalletAddress(item.walletAddress ?? "") !== normalizedAddress;
            } catch {
              return true;
            }
          }),
        },
      });
    },
    [portfolioNotificationsEnabled, portfolioPositions, setSettings, settings, trackedPortfolioWallets]
  );

  useEffect(() => {
    if (IS_HOSTED_MODE) return;
    if (!isRunning) return;
    let mounted = true;
    let timer: number | undefined;
    const run = async () => {
      if (!mounted) return;
      await refreshPortfolio();
      if (!mounted) return;
      const intervalMs = Math.max(
        PORTFOLIO_REFRESH_MS,
        Number(settings.portfolio?.refreshMs ?? PORTFOLIO_REFRESH_MS)
      );
      timer = window.setTimeout(run, intervalMs);
    };
    run();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [isRunning, refreshPortfolio, settings.portfolio?.refreshMs]);

  useEffect(() => {
    if (!settings.portfolio?.notificationsEnabled) return;
    const telegram = settings.notifications?.telegram;
    if (!telegram?.botToken || !telegram.chatId) return;
    let didChangeStoredStatus = false;
    Object.values(portfolioMap).forEach((item) => {
      if (item.status !== "ok" || typeof item.inRange !== "boolean") {
        return;
      }
      if (item.hasBalance === false) {
        if (item.id in portfolioStatusRef.current) {
          delete portfolioStatusRef.current[item.id];
          didChangeStoredStatus = true;
        }
        return;
      }
      const previous = portfolioStatusRef.current[item.id];
      if (typeof previous === "boolean" && previous === item.inRange) {
        return;
      }
      if (typeof previous === "boolean" && previous !== item.inRange) {
        const message = [
          `${item.protocol}: ${item.title} (${item.chain})`,
          `Token ID: ${item.tokenId}`,
          `Status: ${item.inRange ? "In range" : "Out of range"}`,
          `Range: ${item.rangeText ?? "—"}`,
          `Current: ${item.currentPriceText ?? "—"}`,
        ].join("\n");
        sendTelegramMessage(message).catch(() => undefined);
      }
      if (previous !== item.inRange) {
        portfolioStatusRef.current[item.id] = item.inRange;
        didChangeStoredStatus = true;
      }
    });
    if (didChangeStoredStatus) {
      persistPortfolioRangeStatus(portfolioStatusRef.current);
    }
  }, [portfolioMap, sendTelegramMessage, settings.notifications?.telegram, settings.portfolio?.notificationsEnabled]);

  const portfolioNextUpdateText =
    portfolioScanStatus.nextUpdateAt && portfolioScanStatus.nextUpdateAt > portfolioNowMs
      ? formatClockCountdown(portfolioScanStatus.nextUpdateAt - portfolioNowMs)
      : "now";
  const portfolioFoundSummary = summarizeChainCounts(
    Object.keys(nonEmptyPortfolioCountsByChain).length > 0
      ? nonEmptyPortfolioCountsByChain
      : {}
  );
  const portfolioSourceRows = PORTFOLIO_DISCOVERY_SOURCES.map((source) => {
    const state = portfolioScanStatus.sourceStates[source.id] ?? "idle";
    const protocolLabel = formatProtocolDisplayName(source.protocol);
    const text = `${source.chain}, ${protocolLabel}`;
    return {
      id: source.id,
      label: text,
      state,
      text: state === "error" ? `${text} failed` : text,
    };
  });
  const visiblePortfolioPositions = useMemo(() => {
    return portfolioPositions
      .filter((position) => {
        const snapshot = portfolioMap[position.id];
        return !(snapshot?.status === "ok" && snapshot.hasBalance === false);
      })
      .map((position, index) => ({ position, index }))
      .sort((left, right) => {
        const leftSnapshot = portfolioMap[left.position.id];
        const rightSnapshot = portfolioMap[right.position.id];
        const getRank = (snapshot: PortfolioPositionSnapshot | undefined) => {
          if (snapshot?.status === "ok" && snapshot.hasBalance !== false) return 0;
          if (snapshot?.status === "error") return 1;
          return 2;
        };
        const rankDelta = getRank(leftSnapshot) - getRank(rightSnapshot);
        return rankDelta || left.index - right.index;
      })
      .map(({ position }) => position);
  }, [portfolioMap, portfolioPositions]);
  const portfolioStatusTone =
    portfolioDiscoveryError
      ? "out"
      : portfolioScanStatus.phase === "idle" && portfolioScanStatus.updatedAt
      ? "ok"
      : "idle";
  const portfolioStatusLabel =
    portfolioScanStatus.phase === "scanning"
      ? portfolioScanStatus.current
      : portfolioScanStatus.phase === "refreshing"
      ? portfolioScanStatus.current
      : portfolioScanStatus.updatedAt
      ? `Updated ${new Date(portfolioScanStatus.updatedAt).toLocaleTimeString()}`
      : portfolioUpdatedAt
      ? `Updated ${new Date(portfolioUpdatedAt).toLocaleTimeString()}`
      : portfolioScanStatus.current;
  const portfolioScanProgressText =
    portfolioScanStatus.totalSources > 0
      ? `${portfolioScanStatus.scannedSources}/${portfolioScanStatus.totalSources} sources scanned`
      : `${PORTFOLIO_DISCOVERY_SOURCES.length} sources configured`;
  const portfolioActiveSourcesText =
    portfolioScanStatus.phase === "scanning" && portfolioScanStatus.activeSources.length > 0
      ? `${portfolioScanStatus.activeSources.length} active`
      : "idle";
  const portfolioScanLogLines = useMemo(() => {
    return portfolioScanStatus.logLines.length > 0
      ? portfolioScanStatus.logLines
      : appendPortfolioLog([], portfolioStatusLabel);
  }, [portfolioScanStatus.logLines, portfolioStatusLabel]);
  useEffect(() => {
    if (activeTab !== "portfolio") return;
    const element = portfolioScanLogBodyRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [
    activeTab,
    portfolioScanLogLines,
    portfolioFoundSummary,
    portfolioDiscoveryError,
    portfolioScanStatus.errors,
  ]);

  const handlePairSortToggle = useCallback((pairId: string, column: PairSortColumn) => {
    setPairSortById((prev) => {
      const current = prev[pairId];
      if (!current || current.column !== column) {
        return {
          ...prev,
          [pairId]: { column, direction: "desc" },
        };
      }
      return {
        ...prev,
        [pairId]: {
          column,
          direction: current.direction === "desc" ? "asc" : "desc",
        },
      };
    });
  }, []);

  const sortPairRows = useCallback(
    (rows: Array<{ net: NetworkConfig; quote: VariantQuote; rowKey: string }>, sortState?: PairSortState) => {
      if (!sortState) return rows;
      const priceFor = (quote: VariantQuote) => {
        const raw = sortState.column === "buyPrice" ? quote.buy?.price : quote.sell?.price;
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
      };
      return rows
        .map((row, index) => ({
          row,
          index,
          value: priceFor(row.quote),
        }))
        .sort((a, b) => {
          if (a.value === null && b.value === null) return a.index - b.index;
          if (a.value === null) return 1;
          if (b.value === null) return -1;
          const diff = a.value - b.value;
          if (diff === 0) return a.index - b.index;
          return sortState.direction === "asc" ? diff : -diff;
        })
        .map((item) => item.row);
    },
    []
  );

  const renderThemeIcon = useCallback((mode: ThemeMode | "resolved-dark" | "resolved-light") => {
    if (mode === "dark" || mode === "resolved-dark") {
      return (
        <svg className="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M15.6 3.2a8.8 8.8 0 1 0 5.2 15 7.2 7.2 0 1 1-5.2-15Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    }
    if (mode === "light" || mode === "resolved-light") {
      return (
        <svg className="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M12 2.5v2.5M12 19v2.5M21.5 12H19M5 12H2.5M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8M18.4 18.4l-1.8-1.8M7.4 7.4 5.6 5.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      );
    }
    return (
      <svg className="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="5" width="16" height="11" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M10 19h4M8 19h8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }, []);

  const currentThemeMenuLabel =
    themeMode === "system" ? "System theme" : resolvedTheme === "dark" ? "Dark theme" : "Light theme";

  const resetLocalOverrides = useCallback(() => {
    if (typeof window === "undefined") return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
    localStorage.removeItem(PORTFOLIO_STATUS_STORAGE_KEY);
    localStorage.removeItem(TAB_STORAGE_KEY);
    localStorage.removeItem(HOSTED_ENABLED_PAIRS_STORAGE_KEY);
    localStorage.removeItem(HOSTED_PAIR_OVERRIDES_STORAGE_KEY);
    window.location.reload();
  }, []);

  const hasOpportunities = opportunitiesByPair.some((entry) => entry.opportunities.length > 0);
  const hasAnyNotificationsEnabled = Boolean(
    settings.notifications?.enabled ||
      (!IS_HOSTED_MODE && settings.portfolio?.notificationsEnabled) ||
      (!IS_HOSTED_MODE && settings.pendle?.notificationsEnabled)
  );
  const arbNewPairSummaries = useMemo(() => {
    return allArbPairs.map((pair) => {
      const { base, quote } = getPairTokens(pair);
      const baseSymbol = base?.symbol ?? pair.baseTokenId;
      const quoteSymbol = quote?.symbol ?? pair.quoteTokenId;
      const pairLabel = `${baseSymbol}/${quoteSymbol}`;
      const networksForPair = getNetworksForPair(pair);
      const pairQuotes = quoteMap[pair.id] ?? {};
      const allItems = Object.values(pairQuotes).flat();
      const liveRoutes = allItems.filter((item) => item.status === "ok").length;
      const syncingRoutes = allItems.filter((item) => item.status === "loading" || item.status === "idle").length;
      const entry = opportunitiesByPair.find((item) => item.pair.id === pair.id);
      return {
        pair,
        pairLabel,
        enabled: isHostedPairEnabled(pair.id),
        baseSymbol,
        quoteSymbol,
        networks: networksForPair,
        bestOpportunity: entry?.opportunities[0] ?? null,
        opportunities: entry?.opportunities ?? [],
        liveRoutes,
        syncingRoutes,
      };
    });
  }, [allArbPairs, getNetworksForPair, getPairTokens, isHostedPairEnabled, opportunitiesByPair, quoteMap]);

  useEffect(() => {
    if (!selectedArbPairId) return;
    const exists = arbNewPairSummaries.some((item) => item.pair.id === selectedArbPairId);
    if (!exists) {
      setSelectedArbPairId(null);
    }
  }, [arbNewPairSummaries, selectedArbPairId]);

  const filteredOpportunitiesByPair = useMemo(
    () =>
      selectedArbPairId
        ? opportunitiesByPair.filter(({ pair }) => pair.id === selectedArbPairId)
        : opportunitiesByPair,
    [opportunitiesByPair, selectedArbPairId]
  );
  const filteredActivePairs = useMemo(
    () =>
      selectedArbPairId
        ? allArbPairs.filter((pair) => pair.id === selectedArbPairId)
        : activePairs,
    [activePairs, allArbPairs, selectedArbPairId]
  );
  const hasFilteredOpportunities = filteredOpportunitiesByPair.some((entry) => entry.opportunities.length > 0);

  useEffect(() => {
    if (arbNewPairSummaries.length === 0) {
      setSelectedArbNewPairId(null);
      return;
    }
    const exists = selectedArbNewPairId
      ? arbNewPairSummaries.some((item) => item.pair.id === selectedArbNewPairId)
      : false;
    if (!exists) {
      const firstPairId = arbNewPairSummaries[0]?.pair.id ?? null;
      setSelectedArbNewPairId(firstPairId);
    }
  }, [arbNewPairSummaries, selectedArbNewPairId]);

  const selectedArbNewSummary = useMemo(() => {
    if (arbNewPairSummaries.length === 0) return null;
    return (
      arbNewPairSummaries.find((item) => item.pair.id === selectedArbNewPairId) ??
      arbNewPairSummaries[0] ??
      null
    );
  }, [arbNewPairSummaries, selectedArbNewPairId]);

  const arbNewQuoteRows = useMemo(() => {
    if (!selectedArbNewSummary) return [];
    const pair = selectedArbNewSummary.pair;
    const pairQuotes = quoteMap[pair.id] ?? {};
    const pairNetworks = getNetworksForPair(pair);
    return pairNetworks.flatMap((net) => {
      const existing = pairQuotes[net.chain];
      if (existing && existing.length > 0) {
        return existing.map((item, index) => ({
          net,
          quote: item,
          rowKey: `${pair.id}-${net.chain}-${item.id}-${index}`,
        }));
      }
      const fallback = buildVariantCombos(pair, net);
      if (fallback.combos.length === 0) {
        return [
          {
            net,
            quote: buildErrorVariantItem(
              pair,
              net,
              selectedArbNewSummary.baseSymbol,
              selectedArbNewSummary.quoteSymbol,
              fallback.error ?? "No variants"
            ),
            rowKey: `${pair.id}-${net.chain}-empty-new`,
          },
        ];
      }
      return fallback.combos.map((combo, index) => ({
        net,
        quote: {
          id: `${pair.id}-${net.chain}-${combo.id}`,
          networkId: net.chain,
          status: "loading" as const,
          baseVariant: combo.baseVariant,
          quoteVariant: combo.quoteVariant,
        },
        rowKey: `${pair.id}-${net.chain}-${combo.id}-${index}-new`,
      }));
    });
  }, [getNetworksForPair, quoteMap, selectedArbNewSummary]);

  const arbNewHighlightedRoutes = selectedArbNewSummary?.opportunities.slice(0, 5) ?? [];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <nav className="top-nav">
            <button
              className={activeTab === "arb" ? "active" : ""}
              onClick={() => setActiveTab("arb")}
            >
              Arb
            </button>
            <button
              className={activeTab === "portfolio" ? "active" : ""}
              onClick={() => setActiveTab("portfolio")}
            >
              Portfolio
            </button>
            {!IS_HOSTED_MODE ? (
              <button
                className={activeTab === "pendle" ? "active" : ""}
                onClick={() => setActiveTab("pendle")}
              >
                Pendle
              </button>
            ) : null}
          </nav>
          <div className={`topbar-actions ${showThemeMenu ? "theme-open" : ""}`}>
            <div className="notifications-menu" ref={notificationsMenuRef}>
              <button
                className={`bell-button ${showNotificationsMenu ? "active" : ""}`}
                type="button"
                aria-label="Notification settings"
                aria-expanded={showNotificationsMenu}
                onClick={() => {
                  setShowThemeMenu(false);
                  setShowNotificationsMenu((prev) => !prev);
                }}
              >
                <svg className="bell-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M15 17H9m9-2.5c-.9-.8-1.3-1.9-1.3-3.1V9a4.7 4.7 0 0 0-9.4 0v2.4c0 1.2-.5 2.3-1.3 3.1-.5.4-.2 1.5.5 1.5h11c.7 0 1-.9.5-1.5Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M10 19a2 2 0 0 0 4 0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
                {hasAnyNotificationsEnabled ? <span className="bell-indicator" aria-hidden="true" /> : null}
              </button>
              {showNotificationsMenu ? (
                <div className="notifications-popover">
                  <div className="notifications-popover-title">Notifications</div>
                  <div className="notifications-popover-group">
                    <div className="notifications-row">
                      <div>
                        <div className="notifications-row-title">Arb</div>
                        <div className="notifications-row-sub">Cross-chain deal alerts</div>
                      </div>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={settings.notifications?.enabled ?? false}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              notifications: {
                                ...settings.notifications!,
                                enabled: e.target.checked,
                              },
                            })
                          }
                        />
                        <span className="slider" />
                      </label>
                    </div>
                    {!IS_HOSTED_MODE ? (
                    <div className="notifications-row">
                      <div>
                        <div className="notifications-row-title">Portfolio</div>
                        <div className="notifications-row-sub">LP range status alerts</div>
                      </div>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={portfolioNotificationsEnabled}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              portfolio: {
                                refreshMs: settings.portfolio?.refreshMs ?? PORTFOLIO_REFRESH_MS,
                                notificationsEnabled: e.target.checked,
                                walletAddress: settings.portfolio?.walletAddress ?? "",
                                walletTag: settings.portfolio?.walletTag ?? "",
                                wallets: settings.portfolio?.wallets ?? [getDefaultPortfolioWallet()],
                                ignoredEmptyPositionIds: settings.portfolio?.ignoredEmptyPositionIds ?? [],
                                positions: portfolioPositions,
                              },
                            })
                          }
                        />
                        <span className="slider" />
                      </label>
                    </div>
                    ) : null}
                    {!IS_HOSTED_MODE ? (
                    <div className="notifications-row">
                      <div>
                        <div className="notifications-row-title">Pendle</div>
                        <div className="notifications-row-sub">Strategy notifications</div>
                      </div>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={settings.pendle?.notificationsEnabled ?? false}
                          onChange={(e) =>
                            updatePendleSettings({
                              notificationsEnabled: e.target.checked,
                            })
                          }
                        />
                        <span className="slider" />
                      </label>
                    </div>
                    ) : null}
                  </div>
                  <button
                    className="notifications-popover-link"
                    type="button"
                    onClick={() => {
                      setSettingsTab("notifications");
                      setShowSettings(true);
                      setShowNotificationsMenu(false);
                    }}
                  >
                    Open detailed settings
                  </button>
                </div>
              ) : null}
            </div>
            <div
              className={`theme-switch ${showThemeMenu ? "expanded" : "collapsed"}`}
              ref={themeMenuRef}
            >
              <button
                className={`theme-switch-trigger ${showThemeMenu ? "active" : ""}`}
                type="button"
                aria-label={currentThemeMenuLabel}
                aria-haspopup="menu"
                aria-expanded={showThemeMenu}
                onClick={() => {
                  setShowNotificationsMenu(false);
                  setShowThemeMenu((prev) => !prev);
                }}
              >
                {renderThemeIcon(themeMode === "system" ? "system" : resolvedTheme === "dark" ? "resolved-dark" : "resolved-light")}
              </button>
              {showThemeMenu ? (
                <div className="theme-switch-panel" role="menu" aria-label="Theme switcher">
                  <button
                    ref={(node) => {
                      themeOptionRefs.current.dark = node;
                    }}
                    className={themeMode === "dark" ? "active" : ""}
                    onClick={() => {
                      setThemeMode("dark");
                      setShowThemeMenu(false);
                    }}
                    aria-label="Dark theme"
                    role="menuitemradio"
                    aria-checked={themeMode === "dark"}
                    type="button"
                  >
                    {renderThemeIcon("dark")}
                  </button>
                  <button
                    ref={(node) => {
                      themeOptionRefs.current.light = node;
                    }}
                    className={themeMode === "light" ? "active" : ""}
                    onClick={() => {
                      setThemeMode("light");
                      setShowThemeMenu(false);
                    }}
                    aria-label="Light theme"
                    role="menuitemradio"
                    aria-checked={themeMode === "light"}
                    type="button"
                  >
                    {renderThemeIcon("light")}
                  </button>
                  <button
                    ref={(node) => {
                      themeOptionRefs.current.system = node;
                    }}
                    className={themeMode === "system" ? "active" : ""}
                    onClick={() => {
                      setThemeMode("system");
                      setShowThemeMenu(false);
                    }}
                    aria-label="System theme"
                    role="menuitemradio"
                    aria-checked={themeMode === "system"}
                    type="button"
                  >
                    {renderThemeIcon("system")}
                  </button>
                </div>
              ) : null}
            </div>
            <button
              className="gear"
              onClick={() => {
                setShowThemeMenu(false);
                setShowSettings(true);
              }}
              aria-label="settings"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="11.6" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <path
                  d="M19.4 14.6a1.6 1.6 0 0 0 .32 1.76l.06.06a1.95 1.95 0 1 1-2.76 2.76l-.06-.06a1.6 1.6 0 0 0-1.76-.32 1.6 1.6 0 0 0-.97 1.46V20.6a2 2 0 1 1-4 0v-.09a1.6 1.6 0 0 0-.97-1.46 1.6 1.6 0 0 0-1.76.32l-.06.06a1.95 1.95 0 1 1-2.76-2.76l.06-.06A1.6 1.6 0 0 0 4.6 14.6a1.6 1.6 0 0 0-1.46-.97H3a2 2 0 1 1 0-4h.09a1.6 1.6 0 0 0 1.46-.97 1.6 1.6 0 0 0-.32-1.76l-.06-.06a1.95 1.95 0 1 1 2.76-2.76l.06.06a1.6 1.6 0 0 0 1.76.32H8.8A1.6 1.6 0 0 0 9.77 3V2.6a2 2 0 1 1 4 0v.09a1.6 1.6 0 0 0 .97 1.46h.05a1.6 1.6 0 0 0 1.76-.32l.06-.06a1.95 1.95 0 1 1 2.76 2.76l-.06.06a1.6 1.6 0 0 0-.32 1.76v.05a1.6 1.6 0 0 0 1.46.97H21a2 2 0 1 1 0 4h-.09a1.6 1.6 0 0 0-1.46.97Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {activeTab === "arb" ? (
        <>
      <section className="arb-pair-filter" aria-label="Displayed pairs">
        <div className="arb-pair-filter-title">Displayed pairs</div>
        <div className="arb-pair-filter-bar">
          {arbNewPairSummaries.map((item) => {
            const isActive = selectedArbPairId === item.pair.id;
            return (
              <button
                key={`arb-filter-${item.pair.id}`}
                type="button"
                className={`arb-pair-filter-chip ${isActive ? "active" : ""} ${
                  item.enabled ? "" : "disabled"
                }`}
                aria-pressed={isActive}
                onClick={() =>
                  setSelectedArbPairId((prev) => (prev === item.pair.id ? null : item.pair.id))
                }
              >
                <span className="arb-pair-filter-chip-label">{item.pairLabel}</span>
                <span className="arb-pair-filter-chip-meta">
                  {item.networks.length} nets
                  {item.bestOpportunity ? ` · ${item.bestOpportunity.profitPct.toFixed(2)}%` : ""}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="arb">
        <div className="section-title">Cross-chain deals</div>
        {arbError ? (
          <div className="empty">{arbError}</div>
        ) : !hasFilteredOpportunities ? (
          <div className="empty">No deals above threshold yet.</div>
        ) : (
          <div className="arb-list">
            {filteredOpportunitiesByPair.map(({ pair, baseSymbol, quoteSymbol, opportunities }) =>
              opportunities.map((opp, index) => (
                <div className="arb-card" key={`${pair.id}-${opp.buyNet}-${opp.sellNet}-${index}`}>
                  {(() => {
                    const isMintRedeemLabel = (label?: string) =>
                      /mint\s*\/\s*redeem/i.test(String(label ?? ""));
                    const buyAction = isMintRedeemLabel(opp.buyRouteLabel) ? "Mint" : "Buy";
                    const sellAction = isMintRedeemLabel(opp.sellRouteLabel) ? "Redeem" : "Sell";
                    const labels = [
                      opp.buyRouteLabel,
                      opp.sellRouteLabel,
                      opp.buyVariant,
                      opp.sellVariant,
                      opp.buyFromVariant,
                      opp.buyToVariant,
                      opp.sellFromVariant,
                      opp.sellToVariant,
                    ]
                      .filter(Boolean)
                      .filter((label) => {
                        const value = String(label).toLowerCase();
                        return (
                          value &&
                          !isMintRedeemLabel(String(label)) &&
                          value !== baseSymbol.toLowerCase() &&
                          value !== quoteSymbol.toLowerCase()
                        );
                      });
                    const unique = Array.from(new Set(labels));
                    const pills = [...unique, ...(opp.routeTags ?? [])];
                    return (
                      <div className="arb-title">
                        <span className="arb-title-text">
                          {baseSymbol}/{quoteSymbol}: {buyAction} on {opp.buyNet} → {sellAction} on {opp.sellNet}
                        </span>
                        {pills.length > 0 ? (
                          <span className="arb-title-pill-wrap">
                            {pills.map((label) => (
                              <span
                                className="variant-pill"
                                key={`${pair.id}-${opp.buyNet}-${opp.sellNet}-${label}`}
                              >
                                {label}
                              </span>
                            ))}
                          </span>
                        ) : null}
                      </div>
                    );
                  })()}
                  <div className="arb-metric">
                    <span>Amount</span>
                    <strong>
                      {formatNumber(opp.amount || 0, 6)} {quoteSymbol}
                    </strong>
                  </div>
                  <div className="arb-metric">
                    <span>Profit</span>
                    <strong>
                      {formatNumber(opp.profitTotal.toFixed(6))} {quoteSymbol}
                    </strong>
                  </div>
                  <div className="arb-metric">
                    <span>Spread</span>
                    <strong>{opp.profitPct.toFixed(2)}%</strong>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </section>

      {filteredActivePairs.map((pair) => {
        const { base, quote } = getPairTokens(pair);
        const baseSymbol = base?.symbol ?? pair.baseTokenId;
        const quoteSymbol = quote?.symbol ?? pair.quoteTokenId;
        const pairLabel = `${baseSymbol}/${quoteSymbol}`;
        const isCollapsed = collapsedPairs[pair.id] ?? false;
        const pairSortState = pairSortById[pair.id];
        const pairQuotes = quoteMap[pair.id] ?? {};
        const pairNetworks = getNetworksForPair(pair);
        const pairEnabled = isHostedPairEnabled(pair.id);
          const unsortedRows = pairNetworks.flatMap((net) => {
            const existing = pairQuotes[net.chain];
            if (existing && existing.length > 0) {
              return existing.map((item, index) => ({
              net,
              quote: item,
              rowKey: `${pair.id}-${net.chain}-${item.id}-${index}`,
            }));
          }
          const fallback = buildVariantCombos(pair, net);
          if (fallback.combos.length === 0) {
            return [
              {
                net,
                quote: buildErrorVariantItem(
                  pair,
                  net,
                  baseSymbol,
                  quoteSymbol,
                  fallback.error ?? "No variants"
                ),
                rowKey: `${pair.id}-${net.chain}-empty`,
              },
            ];
          }
          const placeholders = fallback.combos.map((combo) => ({
            id: `${pair.id}-${net.chain}-${combo.id}`,
            networkId: net.chain,
            status: "loading" as const,
            baseVariant: combo.baseVariant,
            quoteVariant: combo.quoteVariant,
          }));
          return placeholders.map((item, index) => ({
            net,
            quote: item,
            rowKey: `${pair.id}-${net.chain}-${item.id}-${index}`,
          }));
        });
        const rows = sortPairRows(unsortedRows, pairSortState);
        const buyPriceSortDir = pairSortState?.column === "buyPrice" ? pairSortState.direction : null;
        const sellPriceSortDir = pairSortState?.column === "sellPrice" ? pairSortState.direction : null;
        const pairHasPriceAlert = hostedPriceAlerts.alerts.some((alert) => alert.pairId === pair.id && alert.enabled);
        return (
          <section className="pair-section" key={pair.id}>
            <div className="table-card pair-table-card">
              <div className="pair-card-header">
                <div className="pair-card-title-row">
                  <span className="pair-table-title">{pairLabel}</span>
                  {IS_HOSTED_MODE ? (
                    <div className="pair-hosted-actions">
                      <button
                        type="button"
                        className={`pair-enabled-toggle ${pairEnabled ? "enabled" : "disabled"}`}
                        onClick={() => toggleHostedPairEnabled(pair.id)}
                      >
                        {pairEnabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        className="pair-edit-toggle"
                        onClick={() => setEditingHostedPairId(pair.id)}
                        aria-label={`Edit ${pairLabel} settings`}
                        title="Edit pair settings"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="M4 20h4.4L19.2 9.2a2.2 2.2 0 0 0 0-3.1l-1.3-1.3a2.2 2.2 0 0 0-3.1 0L4 15.6V20Z"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <path
                            d="m13.8 5.8 4.4 4.4"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={`pair-alert-toggle ${pairHasPriceAlert ? "active" : ""}`}
                        onClick={() => setEditingHostedAlertPairId(pair.id)}
                        aria-label={`Edit ${pairLabel} price alerts`}
                        title="Edit price alerts"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="M18 9a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <path
                            d="M10 21h4"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </div>
                  ) : null}
                </div>
                <button
                  className="pair-toggle pair-card-toggle"
                  onClick={() =>
                    setCollapsedPairs((prev) => ({
                      ...prev,
                      [pair.id]: !(prev[pair.id] ?? false),
                    }))
                  }
                  aria-label={isCollapsed ? `Expand ${pairLabel}` : `Collapse ${pairLabel}`}
                >
                  <span className={`pair-toggle-icon ${isCollapsed ? "collapsed" : ""}`} aria-hidden="true">
                    ▾
                  </span>
                </button>
              </div>
            {!isCollapsed && pairEnabled ? (
                <div className="table-body">
                  <div className="table-wrap">
                    <table className="quote-table arb-quote-table">
                      <colgroup>
                        <col className="col-network" />
                        <col className="col-buy" />
                        <col className="col-buy-price" />
                        <col className="col-sell" />
                        <col className="col-sell-price" />
                        <col className="col-status" />
                      </colgroup>
                      <thead>
                        <tr>
                          <th>Network</th>
                          <th>Buy (receive)</th>
                          <th>
                            <button
                              className={`sortable-header-btn ${buyPriceSortDir ? "active" : ""}`}
                              type="button"
                              onClick={() => handlePairSortToggle(pair.id, "buyPrice")}
                            >
                              Buy price
                              <span className="sortable-header-icon" aria-hidden="true">
                                {buyPriceSortDir === "asc" ? "⬆️" : buyPriceSortDir === "desc" ? "⬇️" : "↕️"}
                              </span>
                            </button>
                          </th>
                          <th>Sell (receive)</th>
                          <th>
                            <button
                              className={`sortable-header-btn ${sellPriceSortDir ? "active" : ""}`}
                              type="button"
                              onClick={() => handlePairSortToggle(pair.id, "sellPrice")}
                            >
                              Sell price
                              <span className="sortable-header-icon" aria-hidden="true">
                                {sellPriceSortDir === "asc" ? "⬆️" : sellPriceSortDir === "desc" ? "⬇️" : "↕️"}
                              </span>
                            </button>
                          </th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(({ net, quote, rowKey }) => {
                          const status = quote?.status ?? "idle";
                          const isLoading = status === "loading" || status === "idle";
                          const showBuySkeleton = isLoading && !quote?.buy;
                          const showSellSkeleton = isLoading && !quote?.sell;
                          const variantLabels = quote
                            ? (() => {
                                const labels = getVariantLabels(
                                  baseSymbol,
                                  quoteSymbol,
                                  quote.baseVariant,
                                  quote.quoteVariant
                                );
                                if (quote.routeLabel?.trim()) {
                                  labels.push(quote.routeLabel.trim());
                                }
                                return Array.from(new Set(labels));
                              })()
                            : [];
                          return (
                            <tr key={rowKey}>
                              <td>
                                <div className="network-cell">
                                  <div className="network-heading">
                                    <span className="network-logo" aria-hidden="true">
                                      <NetworkLogo chain={net.chain} name={net.name} />
                                    </span>
                                    <div className="network-name">{net.name}</div>
                                  </div>
                                  {variantLabels.length > 0 ? (
                                    <div className="variant-pills grouped" role="list" aria-label="Network labels">
                                      {variantLabels.map((label, index) => (
                                        <span className="variant-pill grouped" key={`${rowKey}-v-${index}`} role="listitem">
                                          {label}
                                        </span>
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                              </td>
                              <td>
                                <div className="table-cell">
                                  {showBuySkeleton ? (
                                    <div className="skeleton-stack">
                                      <div className="skeleton-line lg" />
                                      <div className="skeleton-line sm" />
                                      <div className="skeleton-line xs" />
                                    </div>
                                  ) : quote?.buy ? (
                                    <>
                                      <div className="cell-main">
                                        {formatNumber(quote.buy.receiveAmount, 6)} {quote.buy.receiveSymbol}
                                      </div>
                                      <div className="cell-sub">
                                        for {formatNumber(quote.buy.fromAmount, 6)} {quote.buy.fromSymbol}
                                      </div>
                                      <div className="cell-sub">Market: {quote.buy.market}</div>
                                    </>
                                  ) : (
                                    "—"
                                  )}
                                </div>
                              </td>
                              <td>
                                <div className="table-cell table-cell-price">
                                  {showBuySkeleton ? (
                                    <div className="skeleton-stack">
                                      <div className="skeleton-line md" />
                                      <div className="skeleton-line xs" />
                                    </div>
                                  ) : quote?.buy ? (
                                    <div className="cell-main">
                                      {formatNumber(quote.buy.price, 6)}{" "}
                                      <span className="arb-price-pair-label">
                                        {quoteSymbol}/{baseSymbol}
                                      </span>
                                    </div>
                                  ) : (
                                    "—"
                                  )}
                                </div>
                              </td>
                              <td>
                                <div className="table-cell">
                                  {showSellSkeleton ? (
                                    <div className="skeleton-stack">
                                      <div className="skeleton-line lg" />
                                      <div className="skeleton-line sm" />
                                      <div className="skeleton-line xs" />
                                    </div>
                                  ) : quote?.sell ? (
                                    <>
                                      <div className="cell-main">
                                        {formatNumber(quote.sell.receiveAmount, 6)} {quote.sell.receiveSymbol}
                                      </div>
                                      <div className="cell-sub">
                                        for {formatNumber(quote.sell.fromAmount, 6)} {quote.sell.fromSymbol}
                                      </div>
                                      <div className="cell-sub">Market: {quote.sell.market}</div>
                                    </>
                                  ) : (
                                    "—"
                                  )}
                                </div>
                              </td>
                              <td>
                                <div className="table-cell table-cell-price">
                                  {showSellSkeleton ? (
                                    <div className="skeleton-stack">
                                      <div className="skeleton-line md" />
                                      <div className="skeleton-line xs" />
                                    </div>
                                  ) : quote?.sell ? (
                                    <div className="cell-main">
                                      {formatNumber(quote.sell.price, 6)}{" "}
                                      <span className="arb-price-pair-label">
                                        {quoteSymbol}/{baseSymbol}
                                      </span>
                                    </div>
                                  ) : (
                                    "—"
                                  )}
                                </div>
                              </td>
                              <td>
                                <span className={`status ${status}`} data-align="left">
                                  {status === "ok" ? "OK" : status}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : !isCollapsed ? (
                <div className="pair-disabled-body">
                  Pair is disabled for this hosted view.
                </div>
              ) : null}
            </div>
          </section>
        );
      })}
        </>
      ) : activeTab === "arb-new" ? (
        selectedArbNewSummary ? (
          <section className="arb-new-shell">
            <aside className="arb-new-rail">
              <div className="arb-new-brand">
                <div className="arb-new-brand-mark" />
                <div>
                  <div className="arb-new-brand-title">Arb (new)</div>
                  <div className="arb-new-brand-sub">Alternative dashboard view</div>
                </div>
              </div>
              <div className="arb-new-rail-label">Monitored pairs</div>
              <div className="arb-new-pair-list">
                {arbNewPairSummaries.map((item) => (
                  <button
                    key={item.pair.id}
                    type="button"
                    className={`arb-new-pair-item ${selectedArbNewSummary.pair.id === item.pair.id ? "active" : ""}`}
                    onClick={() => setSelectedArbNewPairId(item.pair.id)}
                  >
                    <div className="arb-new-pair-item-top">
                      <span>{item.pairLabel}</span>
                      <span className="arb-new-pair-item-count">{item.networks.length}</span>
                    </div>
                    <div className="arb-new-pair-item-sub">
                      {item.bestOpportunity
                        ? `${item.bestOpportunity.profitPct.toFixed(2)}% best spread`
                        : item.syncingRoutes > 0
                        ? "Syncing live routes"
                        : "No deals above threshold"}
                    </div>
                  </button>
                ))}
              </div>
            </aside>

            <div className="arb-new-main">
              <div className="arb-new-banner">
                <span>Shared quote engine is {isArbSyncing ? "syncing live routes" : "up to date"}.</span>
                <span>
                  {lastUpdated ? `Last sync ${new Date(lastUpdated).toLocaleTimeString()}` : "Waiting for first snapshot"}
                </span>
              </div>

              <section className="arb-new-hero">
                <div className="arb-new-hero-main">
                  <div className="arb-new-kicker">Cross-chain opportunity monitor</div>
                  <h1>{selectedArbNewSummary.pairLabel}</h1>
                  <div className="arb-new-hero-sub">
                    {selectedArbNewSummary.bestOpportunity
                      ? `Best route: buy on ${selectedArbNewSummary.bestOpportunity.buyNet} and sell on ${selectedArbNewSummary.bestOpportunity.sellNet}`
                      : "Monitoring all configured routes for this pair across supported networks."}
                  </div>

                  <div className="arb-new-network-cluster">
                    {selectedArbNewSummary.networks.map((net) => (
                      <span className="arb-new-network-avatar" key={`${selectedArbNewSummary.pair.id}-${net.chain}`}>
                        <NetworkLogo chain={net.chain} name={net.name} />
                      </span>
                    ))}
                  </div>

                  <div className="arb-new-stats">
                    <div className="arb-new-stat-card">
                      <span>Best spread</span>
                      <strong>
                        {selectedArbNewSummary.bestOpportunity
                          ? `${selectedArbNewSummary.bestOpportunity.profitPct.toFixed(2)}%`
                          : "—"}
                      </strong>
                    </div>
                    <div className="arb-new-stat-card">
                      <span>Est. profit</span>
                      <strong>
                        {selectedArbNewSummary.bestOpportunity
                          ? `${formatNumber(selectedArbNewSummary.bestOpportunity.profitTotal.toFixed(6))} ${selectedArbNewSummary.quoteSymbol}`
                          : "—"}
                      </strong>
                    </div>
                    <div className="arb-new-stat-card">
                      <span>Live routes</span>
                      <strong>{selectedArbNewSummary.liveRoutes}</strong>
                    </div>
                    <div className="arb-new-stat-card">
                      <span>Configured amount</span>
                      <strong>
                        {formatNumber(getPairAmount(selectedArbNewSummary.pair) || 0, 6)} {selectedArbNewSummary.quoteSymbol}
                      </strong>
                    </div>
                  </div>
                </div>

                <div className="arb-new-spotlight">
                  <div className="arb-new-panel-title">Top routes</div>
                  {arbNewHighlightedRoutes.length === 0 ? (
                    <div className="arb-new-empty">No routes above threshold for this pair yet.</div>
                  ) : (
                    arbNewHighlightedRoutes.map((opp, index) => (
                      <div className="arb-new-route-card" key={`${selectedArbNewSummary.pair.id}-${opp.buyChain}-${opp.sellChain}-${index}`}>
                        <div className="arb-new-route-title">
                          <span>{opp.buyNet} → {opp.sellNet}</span>
                          <span className="arb-new-route-spread">{opp.profitPct.toFixed(2)}%</span>
                        </div>
                        <div className="arb-new-route-sub">
                          {formatNumber(opp.profitTotal.toFixed(6))} {selectedArbNewSummary.quoteSymbol} profit
                        </div>
                        <div className="arb-new-route-tags">
                          {Array.from(
                            new Set(
                              [
                                opp.buyRouteLabel,
                                opp.sellRouteLabel,
                                ...(opp.routeTags ?? []),
                              ].filter(Boolean)
                            )
                          ).map((tag) => (
                            <span key={`${selectedArbNewSummary.pair.id}-${String(tag)}`} className="arb-new-tag">
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="arb-new-board">
                <div className="arb-new-panel-head">
                  <div>
                    <div className="arb-new-panel-title">Route board</div>
                    <div className="arb-new-panel-sub">All live quote routes for the selected pair</div>
                  </div>
                </div>

                <div className="arb-new-board-surface">
                  <table className="arb-new-table">
                    <thead>
                      <tr>
                        <th>Route</th>
                        <th>Buy leg</th>
                        <th>Sell leg</th>
                        <th>Round-trip</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {arbNewQuoteRows.map(({ net, quote, rowKey }) => {
                        const status = quote?.status ?? "idle";
                        const isLoading = status === "loading" || status === "idle";
                        const labels = Array.from(
                          new Set(
                            getVariantLabels(
                              selectedArbNewSummary.baseSymbol,
                              selectedArbNewSummary.quoteSymbol,
                              quote.baseVariant,
                              quote.quoteVariant
                            ).concat(quote.routeLabel?.trim() ? [quote.routeLabel.trim()] : [])
                          )
                        );
                        return (
                          <tr key={rowKey}>
                            <td>
                              <div className="arb-new-route-cell">
                                <div className="arb-new-route-network">
                                  <span className="arb-new-network-avatar small">
                                    <NetworkLogo chain={net.chain} name={net.name} />
                                  </span>
                                  <div>
                                    <div className="arb-new-route-network-name">{net.name}</div>
                                    {labels.length > 0 ? (
                                      <div className="arb-new-route-tags compact">
                                        {labels.map((label) => (
                                          <span className="arb-new-tag" key={`${rowKey}-${label}`}>
                                            {label}
                                          </span>
                                        ))}
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td>
                              {isLoading ? (
                                <div className="skeleton-stack">
                                  <div className="skeleton-line md" />
                                  <div className="skeleton-line xs" />
                                </div>
                              ) : quote.buy ? (
                                <div className="arb-new-value-block">
                                  <strong>{formatNumber(quote.buy.receiveAmount, 6)} {quote.buy.receiveSymbol}</strong>
                                  <span>for {formatNumber(quote.buy.fromAmount, 6)} {quote.buy.fromSymbol}</span>
                                  <span>{quote.buy.market}</span>
                                </div>
                              ) : (
                                <span className="arb-new-dash">—</span>
                              )}
                            </td>
                            <td>
                              {isLoading ? (
                                <div className="skeleton-stack">
                                  <div className="skeleton-line md" />
                                  <div className="skeleton-line xs" />
                                </div>
                              ) : quote.sell ? (
                                <div className="arb-new-value-block">
                                  <strong>{formatNumber(quote.sell.receiveAmount, 6)} {quote.sell.receiveSymbol}</strong>
                                  <span>for {formatNumber(quote.sell.fromAmount, 6)} {quote.sell.fromSymbol}</span>
                                  <span>{quote.sell.market}</span>
                                </div>
                              ) : (
                                <span className="arb-new-dash">—</span>
                              )}
                            </td>
                            <td>
                              {isLoading ? (
                                <div className="skeleton-stack">
                                  <div className="skeleton-line sm" />
                                  <div className="skeleton-line xs" />
                                </div>
                              ) : (
                                <div className="arb-new-value-block">
                                  <strong>
                                    {typeof quote.roundTripPct === "number" && Number.isFinite(quote.roundTripPct)
                                      ? `${quote.roundTripPct.toFixed(2)}%`
                                      : "—"}
                                  </strong>
                                  <span>
                                    {quote.sell?.price && quote.buy?.price
                                      ? `${formatNumber(quote.sell.price, 6)} / ${formatNumber(quote.buy.price, 6)}`
                                      : "No rate comparison"}
                                  </span>
                                </div>
                              )}
                            </td>
                            <td>
                              <span className={`status ${status}`}>
                                {status === "ok" ? "Live" : status}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          </section>
        ) : (
          <div className="empty">No pair data available yet.</div>
        )
      ) : activeTab === "portfolio" ? (
        IS_HOSTED_MODE ? (
          <section className="portfolio-hosted-empty">
            <div className="empty">Portfolio scanning is disabled in the hosted version.</div>
          </section>
        ) : (
        <>
          <section className="portfolio-scanner-panel">
            <div className="portfolio-scanner-toolbar">
              {trackedPortfolioWallets.length > 0 ? (
                <div className="portfolio-wallet-list" aria-label="Added wallets">
                  {trackedPortfolioWallets.map((wallet) => (
                    <span className="portfolio-wallet-chip" key={wallet.address}>
                      {wallet.tag || formatDefaultWalletTag(wallet.address)}
                      <button
                        type="button"
                        className="tracked-wallet-remove"
                        aria-label={`Remove wallet ${wallet.address}`}
                        onClick={() => removePortfolioWallet(wallet.address)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <div />
              )}
              <div className="portfolio-scanner-actions">
                <button
                  className="portfolio-scan-btn"
                  type="button"
                  onClick={() => {
                    discoverPortfolioByWallet().catch(() => undefined);
                  }}
                  disabled={isPortfolioDiscovering}
                >
                  {isPortfolioDiscovering ? "Refreshing..." : "Refresh"}
                </button>
                <button
                  className="portfolio-wallet-manage"
                  type="button"
                  onClick={() => setShowAddPosition((prev) => !prev)}
                >
                  {showAddPosition ? "Hide add wallet" : "Add wallet"}
                </button>
              </div>
            </div>
          </section>

          <div className="portfolio-content-layout">
            <aside className="portfolio-live-status">
                <div className="portfolio-live-head">
                  <span>Live Status</span>
                </div>
                <div className="portfolio-live-body">
                  <div className="portfolio-live-sources">
                    {portfolioSourceRows.map((source) => (
                      <div className={`portfolio-live-row source ${source.state}`} key={source.id}>
                        {source.state === "scanning" ? (
                          <span className="portfolio-live-spinner" aria-label={`${source.label} scanning`} />
                        ) : source.state === "done" ? (
                          <span className="portfolio-live-icon ok">✓</span>
                        ) : source.state === "error" ? (
                          <span className="portfolio-live-icon error">!</span>
                        ) : (
                          <span className="portfolio-live-icon idle">•</span>
                        )}
                        <span>{source.text}</span>
                      </div>
                    ))}
                  </div>
                  <div className="portfolio-live-row next-update">
                    <span className="portfolio-live-icon">◷</span>
                    <span>Next update in {portfolioNextUpdateText}</span>
                  </div>
                </div>
              </aside>

          {showAddPosition ? (
            <section className="portfolio-add">
              <div className="portfolio-add-grid">
                <label>
                  Wallet address
                  <input
                    type="text"
                    value={portfolioWalletInput}
                    onChange={(e) => setPortfolioWalletInput(e.target.value)}
                    placeholder="0x..."
                  />
                </label>
                <label>
                  Wallet tag
                  <input
                    type="text"
                    value={portfolioWalletTagInput}
                    onChange={(e) => setPortfolioWalletTagInput(e.target.value)}
                    placeholder="Auto: 0x...[last 3]"
                  />
                </label>
              </div>
              <div className="settings-hint">
                Scans supported protocols automatically: Uni v3, Uni v4, Aerodrome Slipstream,
                and Velodrome staked / unstaked concentrated positions.
              </div>
              <div className="settings-hint">
                For Base Aerodrome, the scanner currently uses the public Blockscout endpoint without an API key.
              </div>
              {portfolioDiscoveryError ? <div className="error-text">{portfolioDiscoveryError}</div> : null}
              <div className="portfolio-add-actions">
                <button
                  className="rule-add"
                  type="button"
                  onClick={() => {
                    discoverPortfolioByWallet().catch(() => undefined);
                  }}
                  disabled={isPortfolioDiscovering}
                >
                  {isPortfolioDiscovering ? "Scanning wallet..." : "Scan positions"}
                </button>
              </div>
            </section>
          ) : null}

          <section className="portfolio-list">
            {visiblePortfolioPositions.map((position) => {
              const snapshot = portfolioMap[position.id];
              const isLoading = !snapshot || snapshot.status === "loading";
              const statusText =
                snapshot?.status === "ok"
                  ? snapshot.inRange
                    ? "In range"
                    : "Out of range"
                  : snapshot?.status === "error"
                  ? "Error"
                  : "Loading";
              return (
                <article className="portfolio-card" key={position.id}>
                  <div className="portfolio-card-top">
                    <div className="portfolio-title-row">
                      <div className="portfolio-title-main">
                        <span className="portfolio-title">
                          {snapshot?.title ||
                            position.title ||
                            `${formatProtocolDisplayName(position.protocol)} #${position.tokenId}`}
                        </span>
                        <span
                          className={`variant-pill portfolio-badge status-pill ${
                            snapshot?.status === "ok"
                              ? snapshot.inRange
                                ? "ok"
                                : "out"
                              : snapshot?.status === "error"
                              ? "error"
                              : "idle"
                          }`}
                        >
                          {snapshot?.status === "error" ? (
                            <span className="portfolio-status-mark">!</span>
                          ) : (
                            <span
                              className={`range-indicator ${
                                snapshot?.inRange ? "ok" : "out"
                              } ${isLoading ? "idle" : ""}`}
                            />
                          )}
                          {statusText}
                        </span>
                        {position.walletTag ? (
                          <span className="variant-pill portfolio-badge">{position.walletTag}</span>
                        ) : null}
                        <span className="variant-pill portfolio-badge">
                          {formatProtocolDisplayName(snapshot?.protocol || position.protocol)}
                        </span>
                        <span className="variant-pill portfolio-badge">{snapshot?.chain || position.chain}</span>
                      </div>
                      <button
                        className="portfolio-remove"
                        onClick={() =>
                          setSettings({
                            ...settings,
                            portfolio: {
                              refreshMs: settings.portfolio?.refreshMs ?? PORTFOLIO_REFRESH_MS,
                              notificationsEnabled: portfolioNotificationsEnabled,
                              walletAddress: settings.portfolio?.walletAddress ?? "",
                              walletTag: settings.portfolio?.walletTag ?? "",
                              wallets: settings.portfolio?.wallets ?? [getDefaultPortfolioWallet()],
                              ignoredEmptyPositionIds: settings.portfolio?.ignoredEmptyPositionIds ?? [],
                              positions: portfolioPositions.filter((item) => item.id !== position.id),
                            },
                          })
                        }
                        aria-label="Remove position"
                        title="Remove position"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  <div className="portfolio-card-body">
                    <div className="portfolio-grid">
                      <div className="portfolio-metric">
                        <div className="cell-sub">Position value</div>
                        <div className="cell-main">
                          {isLoading ? (
                            <div className="portfolio-skeleton">
                              <div className="skeleton-line md" />
                            </div>
                          ) : (
                            snapshot?.positionValueText ?? "—"
                          )}
                        </div>
                      </div>
                      <div className="portfolio-metric">
                        <div className="cell-sub">Position exposure</div>
                        <div className="cell-main">
                          {isLoading ? (
                            <div className="portfolio-skeleton">
                              <div className="skeleton-line lg" />
                              <div className="skeleton-line xs" />
                            </div>
                          ) : (
                            snapshot?.exposureText ?? snapshot?.balanceText ?? "—"
                          )}
                        </div>
                      </div>
                      <div className="portfolio-metric">
                        <div className="cell-sub">Range</div>
                        <div className="cell-main">
                          {isLoading ? (
                            <div className="portfolio-skeleton">
                              <div className="skeleton-line md" />
                              <div className="skeleton-line sm" />
                            </div>
                          ) : (
                            <div className="portfolio-range-lines">
                              <div>{snapshot?.rangeMinText ?? snapshot?.rangeText ?? "—"}</div>
                              <div>{snapshot?.rangeMaxText ?? ""}</div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    {snapshot?.status === "error" ? (
                      <div className="cell-sub error-text">{snapshot.error ?? "Failed to fetch"}</div>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </section>
          </div>
        </>
        )
      ) : (
        <>
          <section className="summary">
            <button className="pill" type="button" onClick={addPendleStrategy}>
              + Add strategy
            </button>
          </section>

          <section className="pendle">
            <div className="section-title">Pendle YT limit strategies</div>
            <div className="table-card pendle-strategies">
              <div className="table-body">
                <div className="table-wrap">
                  <table className="quote-table">
                    <thead>
                      <tr>
                        <th>Chain</th>
                        <th>Market</th>
                        <th>Status</th>
                        <th>Open orders</th>
                        <th>Best discount</th>
                        <th>Next cycle</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendleStrategies.length === 0 ? (
                        <tr>
                          <td colSpan={6}>
                            <div className="cell-sub">No strategies configured.</div>
                          </td>
                        </tr>
                      ) : (
                        pendleStrategies.map((strategy) => {
                          const runtime = pendleRuntimeById[strategy.id] ?? createPendleRuntimeState();
                          const bestDiscount = runtime.orderRows.reduce<number | null>((acc, row) => {
                            if (!Number.isFinite(Number(row.discountPct))) return acc;
                            const value = Number(row.discountPct);
                            if (acc === null) return value;
                            return Math.max(acc, value);
                          }, null);
                          return (
                            <tr
                              key={strategy.id}
                              className={activePendleStrategy?.id === strategy.id ? "active-pendle-row" : ""}
                              onClick={() => setExpandedPendleStrategyId(strategy.id)}
                            >
                              <td>
                                <div className="cell-main">
                                  {PENDLE_CHAIN_NAMES[strategy.chainId] ?? `Chain ${strategy.chainId}`}
                                </div>
                              </td>
                              <td>
                                <div className="cell-sub">
                                  {runtime.marketInfo?.name
                                    ? runtime.marketInfo.name
                                    : strategy.marketAddress
                                    ? `${strategy.marketAddress.slice(0, 10)}...${strategy.marketAddress.slice(-6)}`
                                    : "Not set"}
                                </div>
                              </td>
                              <td>
                                <span className={`status ${strategy.enabled ? "ok" : "idle"}`}>
                                  {strategy.enabled
                                    ? runtime.isRunning
                                      ? "RUNNING"
                                      : "ACTIVE"
                                    : "PAUSED"}
                                </span>
                              </td>
                              <td>
                                <div className="cell-main">{runtime.orderRows.length}</div>
                              </td>
                              <td>
                                <div className="cell-sub">
                                  {bestDiscount === null ? "—" : `${bestDiscount.toFixed(2)}%`}
                                </div>
                              </td>
                              <td>
                                <div className="cell-sub">{getPendleNextCycleLabel(strategy.id)}</div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {activePendleStrategy ? (
              <>
                <section className="summary">
                  <button
                    className="pill"
                    type="button"
                    onClick={() => {
                      if (activePendleStrategy.enabled) {
                        stopPendleStrategyById(activePendleStrategy.id).catch(() => undefined);
                        return;
                      }
                      updatePendleStrategy(activePendleStrategy.id, { enabled: true });
                    }}
                  >
                    {activePendleStrategy.enabled ? "Stop" : "Start"}
                  </button>
                  <button
                    className="pill"
                    type="button"
                    onClick={() => {
                      runPendleCycleByStrategyId(activePendleStrategy.id).catch(() => undefined);
                    }}
                  >
                    Run now
                  </button>
                  <button
                    className="pill"
                    type="button"
                    disabled={pendleStrategies.length <= 1}
                    onClick={() => removePendleStrategy(activePendleStrategy.id)}
                  >
                    Remove
                  </button>
                </section>

                <div className="pendle-card">
                  <div className="pendle-form">
                    <label>
                      Chain ID
                      <input
                        type="number"
                        min={1}
                        value={activePendleStrategy.chainId}
                        onChange={(e) =>
                          updatePendleStrategy(activePendleStrategy.id, {
                            chainId: Number.isFinite(Number(e.target.value))
                              ? Number(e.target.value)
                              : activePendleStrategy.chainId,
                          })
                        }
                      />
                    </label>
                    <label>
                      Market address
                      <input
                        type="text"
                        value={activePendleStrategy.marketAddress}
                        onChange={(e) =>
                          updatePendleStrategy(activePendleStrategy.id, {
                            marketAddress: e.target.value.trim(),
                          })
                        }
                        placeholder="0x..."
                      />
                    </label>
                    <label>
                      Order token
                      <select
                        value={pendleSelectedToken.address}
                        onChange={(e) => {
                          const next = pendleTokenOptions.find(
                            (item) => item.address.toLowerCase() === e.target.value.toLowerCase()
                          );
                          if (!next) return;
                          updatePendleStrategy(activePendleStrategy.id, {
                            orderTokenAddress: next.address,
                            orderTokenDecimals: next.decimals,
                            orderTokenSymbol: next.symbol,
                          });
                        }}
                      >
                        {pendleTokenOptions.map((option) => (
                          <option key={option.address.toLowerCase()} value={option.address}>
                            {option.label} ({option.symbol}) - {option.address.slice(0, 6)}...{option.address.slice(-4)}
                          </option>
                        ))}
                        {pendleTokenOptions.length === 0 ? (
                          <option value={pendleSelectedToken.address || ""}>No tokens available</option>
                        ) : null}
                      </select>
                    </label>
                    <label>
                      RPC URL (for cancel/approve)
                      <input
                        type="text"
                        value={pendleRpcUrl}
                        onChange={(e) =>
                          updatePendleSettings({
                            rpcByChainId: {
                              ...pendle.rpcByChainId,
                              [String(activePendleStrategy.chainId)]: e.target.value.trim(),
                            },
                          })
                        }
                        placeholder="https://..."
                      />
                    </label>
                    <label>
                      Amount ({pendleSelectedToken.symbol || "token"})
                      <input
                        type="text"
                        value={activePendleStrategy.amount}
                        onChange={(e) =>
                          updatePendleStrategy(activePendleStrategy.id, {
                            amount: e.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      Token symbol (fallback)
                      <input
                        type="text"
                        value={pendle.underlyingSymbol ?? ""}
                        onChange={(e) =>
                          updatePendleSettings({
                            underlyingSymbol: e.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      Token decimals (fallback)
                      <input
                        type="number"
                        min={0}
                        value={pendle.underlyingDecimals ?? 18}
                        onChange={(e) =>
                          updatePendleSettings({
                            underlyingDecimals: Number.isFinite(Number(e.target.value))
                              ? Number(e.target.value)
                              : pendle.underlyingDecimals,
                          })
                        }
                      />
                    </label>
                    <label>
                      Recheck interval (seconds)
                      <input
                        type="number"
                        min={1}
                        value={Math.max(1, Math.round((activePendleStrategy.checkIntervalMs || 15_000) / 1_000))}
                        onChange={(e) =>
                          updatePendleStrategy(activePendleStrategy.id, {
                            checkIntervalMs:
                              Math.max(1, Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : 1) *
                              1_000,
                          })
                        }
                      />
                    </label>
                    <label>
                      Target below implied rate (%)
                      <input
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={activePendleStrategy.targetDiscountPct}
                        onChange={(e) =>
                          updatePendleStrategy(activePendleStrategy.id, {
                            targetDiscountPct: Number.isFinite(Number(e.target.value))
                              ? Number(e.target.value)
                              : activePendleStrategy.targetDiscountPct,
                          })
                        }
                      />
                    </label>
                    <label>
                      Replace if below current &lt; (%)
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        value={activePendleStrategy.replaceLowerThresholdPct}
                        onChange={(e) =>
                          updatePendleStrategy(activePendleStrategy.id, {
                            replaceLowerThresholdPct: Number.isFinite(Number(e.target.value))
                              ? Number(e.target.value)
                              : activePendleStrategy.replaceLowerThresholdPct,
                          })
                        }
                      />
                    </label>
                    <label>
                      Replace if below current &gt; (%)
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        value={activePendleStrategy.replaceThresholdPct}
                        onChange={(e) =>
                          updatePendleStrategy(activePendleStrategy.id, {
                            replaceThresholdPct: Number.isFinite(Number(e.target.value))
                              ? Number(e.target.value)
                              : activePendleStrategy.replaceThresholdPct,
                          })
                        }
                      />
                    </label>
                  </div>

                  <div className="pendle-market-info">
                    <div className="pendle-market-head">
                      <strong>Market details</strong>
                      <span className="cell-sub">{pendleChainLabel}</span>
                    </div>
                    {pendleMarketLoading ? (
                      <div className="skeleton-stack">
                        <div className="skeleton-line lg" />
                        <div className="skeleton-line sm" />
                        <div className="skeleton-line md" />
                      </div>
                    ) : pendleMarketInfo ? (
                      <div className="pendle-market-grid">
                        <div>
                          <div className="cell-sub">Name</div>
                          <div className="cell-main">{pendleMarketInfo.name}</div>
                        </div>
                        <div>
                          <div className="cell-sub">Current implied rate</div>
                          <div className="cell-main">
                            {pendleCurrentApy === null
                              ? "—"
                              : `${(pendleCurrentApy * 100).toFixed(4)}%`}
                          </div>
                        </div>
                        <div>
                          <div className="cell-sub">Underlying token</div>
                          <div className="cell-main">
                            {pendleDisplayTokenMeta?.symbol ?? "—"} ({pendleMarketInfo.underlyingAssetAddress})
                          </div>
                        </div>
                        <div>
                          <div className="cell-sub">Expiry</div>
                          <div className="cell-main">{formatDaysLeft(pendleMarketInfo.expiry)}</div>
                        </div>
                        <div>
                          <div className="cell-sub">Open orders</div>
                          <div className="cell-main">{pendleOrders.length}</div>
                        </div>
                      </div>
                    ) : (
                      <div className="cell-sub">Enter chain + market address to load details.</div>
                    )}
                    {pendleMarketError ? <div className="cell-sub error-text">{pendleMarketError}</div> : null}
                    {pendleCycleError ? <div className="cell-sub error-text">{pendleCycleError}</div> : null}
                    {pendleCycleWarning ? <div className="cell-sub">{pendleCycleWarning}</div> : null}
                    {pendleLastCheckedAt ? (
                      <div className="cell-sub">Last checked: {new Date(pendleLastCheckedAt).toLocaleTimeString()}</div>
                    ) : null}
                    {activePendleStrategy.enabled ? <div className="cell-sub">{pendleNextCycleLabel}</div> : null}
                  </div>
                </div>

                <div className="table-card pendle-orders">
                  <div className="table-body">
                    <div className="table-wrap">
                      <table className="quote-table">
                        <colgroup>
                          <col style={{ width: "18%" }} />
                          <col style={{ width: "18%" }} />
                          <col style={{ width: "20%" }} />
                          <col style={{ width: "16%" }} />
                          <col style={{ width: "14%" }} />
                          <col style={{ width: "14%" }} />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>Order ID</th>
                            <th>Amount</th>
                            <th>Order implied rate</th>
                            <th>Below current</th>
                            <th>Created</th>
                            <th>Expiry</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pendleOrderRows.length === 0 ? (
                            <tr>
                              <td colSpan={6}>
                                <div className="cell-sub">No active orders.</div>
                              </td>
                            </tr>
                          ) : (
                            pendleOrderRows.map((order) => (
                              <tr key={order.id}>
                                <td>
                                  <div className="cell-main">{order.id.slice(0, 10)}…{order.id.slice(-6)}</div>
                                </td>
                                <td>
                                  <div className="cell-main">
                                    {formatNumber(order.amount, 6)} {pendleSelectedToken.symbol ?? ""}
                                  </div>
                                </td>
                                <td>
                                  <div className="cell-main">
                                    {order.orderApy === null ? "—" : `${(order.orderApy * 100).toFixed(4)}%`}
                                  </div>
                                </td>
                                <td>
                                  <div className="cell-main">
                                    {order.discountPct === null ? "—" : `${order.discountPct.toFixed(2)}%`}
                                  </div>
                                </td>
                                <td>
                                  <div className="cell-sub">{formatDateTime(order.createdAt)}</div>
                                </td>
                                <td>
                                  <div className="cell-sub">{formatDaysLeft(order.expiresAt)}</div>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </>
            ) : null}
          </section>
        </>
      )}

      {IS_HOSTED_MODE && editingHostedPair ? (
        <div className="settings-overlay" onClick={() => setEditingHostedPairId(null)}>
          <div className="settings pair-settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="settings-header">
              <div>
                <div className="settings-heading">{editingHostedPairLabel}</div>
                <div className="pair-settings-subtitle">Pair settings</div>
              </div>
              <button className="close" onClick={() => setEditingHostedPairId(null)} aria-label="Close pair settings">
                ×
              </button>
            </div>
            <div className="pair-settings-content">
              <label className="pair-settings-field">
                Amount
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={editingHostedPair.amount ?? ""}
                  onChange={(event) => updateHostedPairAmount(editingHostedPair.id, event.target.value)}
                />
              </label>
              <div className="pair-settings-title">Active networks</div>
              <div className="pair-network-list">
                {editableHostedPairNetworks.map((net) => (
                  <label className="pair-network-option" key={net.chain}>
                    <input
                      type="checkbox"
                      checked={Boolean(editingHostedPair.networks?.[net.chain])}
                      onChange={(event) =>
                        updateHostedPairNetwork(editingHostedPair.id, net.chain, event.target.checked)
                      }
                    />
                    <span>{net.name}</span>
                  </label>
                ))}
              </div>
              <div className="pair-settings-actions">
                <button type="button" className="settings-reset-btn" onClick={() => resetHostedPairOverride(editingHostedPair.id)}>
                  Reset pair
                </button>
                <button type="button" className="pair-enabled-toggle enabled" onClick={() => setEditingHostedPairId(null)}>
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {IS_HOSTED_MODE && editingHostedAlertPair ? (
        <div className="settings-overlay" onClick={() => setEditingHostedAlertPairId(null)}>
          <div className="settings pair-settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="settings-header">
              <div>
                <div className="settings-heading">{editingHostedAlertPairLabel}</div>
                <div className="pair-settings-subtitle">Price alerts</div>
              </div>
              <button className="close" onClick={() => setEditingHostedAlertPairId(null)} aria-label="Close price alerts">
                ×
              </button>
            </div>
            <div className="pair-settings-content pair-alert-settings-content">
              <section className="pair-alert-telegram">
                <div className="pair-alert-telegram-header">
                  <div>
                    <div className="pair-settings-title">Telegram</div>
                    <div className="pair-alert-telegram-status">
                      {hostedPriceAlerts.telegram.enabled
                        ? `Connected${hostedPriceAlerts.telegram.username ? ` to @${hostedPriceAlerts.telegram.username}` : ""}`
                        : "Not connected"}
                    </div>
                  </div>
                  <span className={`pair-alert-connection-pill ${hostedPriceAlerts.telegram.enabled ? "connected" : ""}`}>
                    {hostedPriceAlerts.telegram.enabled ? "Connected" : "Disconnected"}
                  </span>
                </div>
                <div className="pair-alert-telegram-actions">
                  <a
                    className={`pair-enabled-toggle enabled ${hostedTelegramConnect.loading || !hostedTelegramConnect.startUrl ? "is-disabled" : ""}`}
                    href={hostedTelegramConnect.startUrl || undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-disabled={hostedTelegramConnect.loading || !hostedTelegramConnect.startUrl}
                    onClick={(event) => {
                      if (hostedTelegramConnect.loading || !hostedTelegramConnect.startUrl) {
                        event.preventDefault();
                      }
                    }}
                  >
                    {hostedTelegramConnect.loading ? "Loading..." : "Connect Telegram"}
                  </a>
                  <button
                    type="button"
                    className="settings-reset-btn"
                    disabled={hostedTelegramConnect.loading}
                    onClick={() => void loadHostedTelegramConnect()}
                  >
                    Check connection
                  </button>
                </div>
                {hostedTelegramConnect.botUsername ? (
                  <div className="pair-alert-user-id">Bot: @{hostedTelegramConnect.botUsername}</div>
                ) : null}
                {hostedTelegramConnect.error ? (
                  <div className="pair-alert-connect-error">{hostedTelegramConnect.error}</div>
                ) : null}
                <div className="pair-alert-user-id">Alert profile: {hostedUserId}</div>
              </section>

              {(["buy", "sell"] as HostedPriceAlertSide[]).map((side) => {
                const alert = getHostedPairAlert(editingHostedAlertPair.id, side);
                const allNetworks = alert.networks.length === 0;
                const title = side === "buy" ? "Buy price alert" : "Sell price alert";
                const priceDraftKey = getHostedAlertDraftKey(editingHostedAlertPair.id, side);
                const priceDraftValue = hostedAlertPriceDrafts[priceDraftKey];
                return (
                  <section className="pair-alert-card" key={side}>
                    <div className="pair-alert-card-header">
                      <label className="pair-network-option pair-alert-toggle-row">
                        <input
                          type="checkbox"
                          checked={alert.enabled}
                          onChange={(event) =>
                            upsertHostedPairAlert(editingHostedAlertPair.id, side, { enabled: event.target.checked })
                          }
                        />
                        <span>{title}</span>
                      </label>
                      <select
                        className="pair-alert-select"
                        value={alert.operator}
                        onChange={(event) =>
                          upsertHostedPairAlert(editingHostedAlertPair.id, side, {
                            operator: event.target.value as HostedPriceAlertOperator,
                          })
                        }
                      >
                        <option value="above">Above</option>
                        <option value="below">Below</option>
                      </select>
                    </div>
                    <div className="pair-alert-grid">
                      <label className="pair-settings-field">
                        Price
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={priceDraftValue ?? String(alert.price)}
                          onChange={(event) => updateHostedAlertPriceDraft(editingHostedAlertPair.id, side, event.target.value)}
                          onBlur={() => clearHostedAlertPriceDraftIfInvalid(editingHostedAlertPair.id, side)}
                        />
                      </label>
                      <label className="pair-settings-field">
                        Cooldown, min
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={Math.round(alert.cooldownMs / 60000)}
                          onChange={(event) =>
                            upsertHostedPairAlert(editingHostedAlertPair.id, side, {
                              cooldownMs: Math.max(0, Number(event.target.value)) * 60000,
                            })
                          }
                        />
                      </label>
                    </div>
                    <div className="pair-settings-title">Networks</div>
                    <div className="pair-network-list">
                      <label className="pair-network-option">
                        <input
                          type="checkbox"
                          checked={allNetworks}
                          onChange={(event) =>
                            upsertHostedPairAlert(editingHostedAlertPair.id, side, {
                              networks: event.target.checked ? [] : editableHostedAlertNetworks.map((net) => net.chain),
                            })
                          }
                        />
                        <span>All active networks</span>
                      </label>
                      {editableHostedAlertNetworks.map((net) => {
                        const checked = allNetworks || alert.networks.includes(net.chain);
                        return (
                          <label className={`pair-network-option ${allNetworks ? "muted" : ""}`} key={net.chain}>
                            <input
                              type="checkbox"
                              disabled={allNetworks}
                              checked={checked}
                              onChange={(event) => {
                                const networks = new Set(alert.networks);
                                if (event.target.checked) {
                                  networks.add(net.chain);
                                } else {
                                  networks.delete(net.chain);
                                }
                                upsertHostedPairAlert(editingHostedAlertPair.id, side, {
                                  networks: Array.from(networks),
                                });
                              }}
                            />
                            <span>{net.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </section>
                );
              })}

              <div className="pair-settings-actions">
                <div className={`pair-alert-save-status ${hostedAlertSaveStatus}`}>
                  {hostedAlertSaveStatus === "saving"
                    ? "Saving..."
                    : hostedAlertSaveStatus === "saved"
                      ? "Saved"
                      : hostedAlertSaveStatus === "error"
                        ? "Save failed"
                        : ""}
                </div>
                <button type="button" className="settings-reset-btn" onClick={() => setEditingHostedAlertPairId(null)}>
                  Cancel
                </button>
                <button type="button" className="pair-enabled-toggle enabled" onClick={() => void saveHostedPriceAlerts()}>
                  Save alerts
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showSettings ? (
        <div className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings" onClick={(event) => event.stopPropagation()}>
            <div className="settings-header">
              <div className="settings-heading">Settings</div>
              <button className="close" onClick={() => setShowSettings(false)} aria-label="Close settings">
                ×
              </button>
            </div>
            <div className="settings-layout">
              <aside className="settings-sidebar">
                <div className="settings-tabs">
                  <button
                    className={settingsTab === "main" ? "active" : ""}
                    onClick={() => setSettingsTab("main")}
                  >
                    Main
                  </button>
                  <button
                    className={settingsTab === "notifications" ? "active" : ""}
                    onClick={() => setSettingsTab("notifications")}
                  >
                    Notifications
                  </button>
                </div>
                <button className="settings-reset-btn" type="button" onClick={resetLocalOverrides}>
                  Reset local changes
                </button>
              </aside>
              <div className="settings-content">
            {settingsTab === "main" ? (
              <>
                <div className="settings-group">
                  <div className="settings-title">Parameters</div>
                  <label>
                    Default amount (used when pair amount is empty)
                    <input
                      type="text"
                      value={settings.defaultAmount}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          defaultAmount: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    Refresh interval (ms)
                    <input
                      type="number"
                      min={2000}
                      value={settings.refreshMs}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          refreshMs: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    Arbitrage threshold (%)
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={settings.minProfitPct}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          minProfitPct: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                </div>

                <div className="settings-group">
                  <div className="settings-title">Quote API markets</div>
                  <div className="settings-hint">
                    Leave blank to use the default endpoint.
                  </div>
                  <datalist id="market-options">
                    {MARKET_OPTIONS.map((option) => (
                      <option key={`market-${option}`} value={option} />
                    ))}
                  </datalist>
                  {settings.networks.map((net) => {
                    const currentMarket = extractMarketName(
                      settings.quoteApi.endpointsByNetwork?.[net.chain]
                    );
                    return (
                      <div className="network-row" key={`market-${net.chain}`}>
                        <div className="network-info">
                          <div className="network-name">{net.chain}</div>
                          <div className="network-id">Market</div>
                        </div>
                        <label>
                          Market name
                          <input
                            type="text"
                            list="market-options"
                            placeholder="Default"
                            value={currentMarket}
                            onChange={(e) => {
                              const value = e.target.value.trim();
                              const nextEndpoints = {
                                ...(settings.quoteApi.endpointsByNetwork ?? {}),
                              };
                              if (value) {
                                nextEndpoints[net.chain] = buildMarketEndpoint(value);
                              } else {
                                delete nextEndpoints[net.chain];
                              }
                              setSettings({
                                ...settings,
                                quoteApi: {
                                  ...settings.quoteApi,
                                  endpointsByNetwork: nextEndpoints,
                                },
                              });
                            }}
                          />
                        </label>
                      </div>
                    );
                  })}
                </div>

                <div className="settings-group">
                  <div className="settings-title">Arbitrage rules</div>
                  {(settings.arbitrageRules ?? []).map((rule, index) => (
                    <div className="rule-row" key={`rule-${rule.id ?? index}`}>
                      <label>
                        Side
                        <select
                          value={rule.side ?? ""}
                          onChange={(e) => {
                            const value = e.target.value as ArbitrageRule["side"];
                            setSettings({
                              ...settings,
                              arbitrageRules: (settings.arbitrageRules ?? []).map((item, i) =>
                                i === index ? { ...item, side: value || undefined } : item
                              ),
                            });
                          }}
                        >
                          <option value="">Any</option>
                          <option value="buy">Buy</option>
                          <option value="sell">Sell</option>
                        </select>
                      </label>
                      <label>
                        Network
                        <select
                          value={rule.network ?? ""}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              arbitrageRules: (settings.arbitrageRules ?? []).map((item, i) =>
                                i === index
                                  ? { ...item, network: e.target.value || undefined }
                                  : item
                              ),
                            })
                          }
                        >
                          <option value="">Any</option>
                          {settings.networks.map((net) => (
                            <option key={`rule-net-${index}-${net.chain}`} value={net.chain}>
                              {net.name} ({net.chain})
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Token side
                        <select
                          value={rule.tokenSide ?? ""}
                          onChange={(e) => {
                            const value = e.target.value as ArbitrageRule["tokenSide"];
                            setSettings({
                              ...settings,
                              arbitrageRules: (settings.arbitrageRules ?? []).map((item, i) =>
                                i === index ? { ...item, tokenSide: value || undefined } : item
                              ),
                            });
                          }}
                        >
                          <option value="">Any</option>
                          <option value="base">Base</option>
                          <option value="quote">Quote</option>
                        </select>
                      </label>
                      <label>
                        Token
                        <select
                          value={rule.tokenId ?? ""}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              arbitrageRules: (settings.arbitrageRules ?? []).map((item, i) =>
                                i === index
                                  ? { ...item, tokenId: e.target.value || undefined }
                                  : item
                              ),
                            })
                          }
                        >
                          <option value="">Any</option>
                          {settings.tokens.map((token) => (
                            <option key={`rule-token-${index}-${token.id}`} value={token.id}>
                              {token.symbol} ({token.id})
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Min profit (%)
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={rule.minProfitPct}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              arbitrageRules: (settings.arbitrageRules ?? []).map((item, i) =>
                                i === index
                                  ? { ...item, minProfitPct: Number(e.target.value) }
                                  : item
                              ),
                            })
                          }
                        />
                      </label>
                      <label>
                        Tag
                        <input
                          type="text"
                          value={rule.tag ?? ""}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              arbitrageRules: (settings.arbitrageRules ?? []).map((item, i) =>
                                i === index
                                  ? { ...item, tag: e.target.value || undefined }
                                  : item
                              ),
                            })
                          }
                        />
                      </label>
                      <button
                        className="rule-remove"
                        onClick={() =>
                          setSettings({
                            ...settings,
                            arbitrageRules: (settings.arbitrageRules ?? []).filter((_, i) => i !== index),
                          })
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <button
                    className="rule-add"
                    onClick={() =>
                      setSettings({
                        ...settings,
                        arbitrageRules: [
                          ...(settings.arbitrageRules ?? []),
                          {
                            id: `rule-${Date.now()}`,
                            side: "sell",
                            network: settings.networks[0]?.chain ?? "",
                            tokenId: settings.tokens[0]?.id ?? "",
                            tokenSide: "quote",
                            minProfitPct: settings.minProfitPct,
                            tag: "",
                          },
                        ],
                      })
                    }
                  >
                    Add rule
                  </button>
                </div>

                <div className="settings-group">
                  <div className="settings-title">Tokens</div>
                  {settings.tokens.map((token) => (
                    <div className="token-editor" key={`token-${token.id}`}>
                      <div className="token-editor-header">
                        <div>
                          <div className="token-name">{token.symbol}</div>
                          <div className="token-id">ID: {token.id}</div>
                        </div>
                        <label>
                          Symbol
                          <input
                            type="text"
                            value={token.symbol}
                            onChange={(e) =>
                              setSettings({
                                ...settings,
                                tokens: settings.tokens.map((item) =>
                                  item.id === token.id ? { ...item, symbol: e.target.value } : item
                                ),
                              })
                            }
                          />
                        </label>
                      </div>
                      <div className="token-addresses">
                        {settings.networks.map((net) => (
                          <div className="token-address-row" key={`token-${token.id}-${net.chain}`}>
                            <div className="address-label">{net.name}</div>
                            <input
                              type="text"
                              placeholder="Token address"
                              value={token.addresses[net.chain] ?? ""}
                              onChange={(e) =>
                                setSettings({
                                  ...settings,
                                  tokens: settings.tokens.map((item) =>
                                    item.id === token.id
                                      ? {
                                          ...item,
                                          addresses: {
                                            ...item.addresses,
                                            [net.chain]: e.target.value,
                                          },
                                        }
                                      : item
                                  ),
                                })
                              }
                            />
                            <input
                              type="number"
                              min={0}
                              placeholder="Decimals"
                              value={token.decimalsByNetwork[net.chain] ?? ""}
                              onChange={(e) => {
                                const value = e.target.value;
                                setSettings({
                                  ...settings,
                                  tokens: settings.tokens.map((item) => {
                                    if (item.id !== token.id) return item;
                                    const nextDecimals = { ...item.decimalsByNetwork };
                                    if (value === "") {
                                      delete nextDecimals[net.chain];
                                    } else {
                                      nextDecimals[net.chain] = Number(value);
                                    }
                                    return {
                                      ...item,
                                      decimalsByNetwork: nextDecimals,
                                    };
                                  }),
                                });
                              }}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="settings-group">
                  <div className="settings-title">Token pairs</div>
                  {settings.pairs.map((pair) => {
                    const baseToken = tokensById[pair.baseTokenId];
                    const quoteToken = tokensById[pair.quoteTokenId];
                    const baseSymbol = baseToken?.symbol ?? pair.baseTokenId;
                    const quoteSymbol = quoteToken?.symbol ?? pair.quoteTokenId;
                    return (
                      <div className="pair-editor" key={`pair-${pair.id}`}>
                        <div className="pair-editor-header">
                          <div className="pair-name">
                            {baseSymbol}/{quoteSymbol}
                          </div>
                          <label>
                            Amount (override)
                            <input
                              type="text"
                              value={pair.amount ?? ""}
                              onChange={(e) =>
                                setSettings({
                                  ...settings,
                                  pairs: settings.pairs.map((item) =>
                                    item.id === pair.id ? { ...item, amount: e.target.value } : item
                                  ),
                                })
                              }
                            />
                          </label>
                        </div>
                        <div className="pair-grid">
                          <label>
                            Base token
                            <select
                              value={pair.baseTokenId}
                              onChange={(e) =>
                                setSettings({
                                  ...settings,
                                  pairs: settings.pairs.map((item) =>
                                    item.id === pair.id
                                      ? {
                                          ...item,
                                          baseTokenId: e.target.value,
                                        }
                                      : item
                                  ),
                                })
                              }
                            >
                              {settings.tokens.map((token) => (
                                <option key={`base-${pair.id}-${token.id}`} value={token.id}>
                                  {token.symbol} ({token.id})
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Quote token
                            <select
                              value={pair.quoteTokenId}
                              onChange={(e) =>
                                setSettings({
                                  ...settings,
                                  pairs: settings.pairs.map((item) =>
                                    item.id === pair.id
                                      ? {
                                          ...item,
                                          quoteTokenId: e.target.value,
                                        }
                                      : item
                                  ),
                                })
                              }
                            >
                              {settings.tokens.map((token) => (
                                <option key={`quote-${pair.id}-${token.id}`} value={token.id}>
                                  {token.symbol} ({token.id})
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <div className="pair-networks">
                          {settings.networks.map((net) => (
                            <div className="network-toggle" key={`pair-${pair.id}-${net.chain}`}>
                              <div className="network-toggle-label">{net.name}</div>
                              <label className="switch">
                                <input
                                  type="checkbox"
                                  checked={pair.networks?.[net.chain] ?? false}
                                  onChange={(e) =>
                                    setSettings({
                                      ...settings,
                                      pairs: settings.pairs.map((item) =>
                                        item.id === pair.id
                                          ? {
                                              ...item,
                                              networks: {
                                                ...item.networks,
                                                [net.chain]: e.target.checked,
                                              },
                                            }
                                          : item
                                      ),
                                    })
                                  }
                                />
                                <span className="slider" />
                              </label>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="settings-group">
                  <div className="settings-title">Networks</div>
                  {settings.networks.map((net) => (
                    <div className="network-row" key={`net-${net.chain}`}>
                      <div className="network-info">
                        <div className="network-name">{net.chain}</div>
                        <div className="network-id">Chain</div>
                      </div>
                      <label>
                        Display name
                        <input
                          type="text"
                          value={net.name}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              networks: settings.networks.map((item) =>
                                item.chain === net.chain ? { ...item, name: e.target.value } : item
                              ),
                            })
                          }
                        />
                      </label>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="settings-group">
                  <div className="settings-title">Telegram</div>
                  <div className="row">
                    <div className="network-toggle">
                      <div className="network-toggle-label">Enable notifications</div>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={settings.notifications?.enabled ?? false}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              notifications: {
                                ...settings.notifications!,
                                enabled: e.target.checked,
                              },
                            })
                          }
                        />
                        <span className="slider" />
                      </label>
                    </div>
                  </div>
                  <label>
                    Min profit change for same route (%)
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={settings.notifications?.minAmountChangePct ?? 30}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          notifications: {
                            ...settings.notifications!,
                            minAmountChangePct: Number(e.target.value),
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    Bot token
                    <input
                      type="text"
                      value={settings.notifications?.telegram.botToken ?? ""}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          notifications: {
                            ...settings.notifications!,
                            telegram: {
                              ...settings.notifications!.telegram,
                              botToken: e.target.value,
                            },
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    Chat ID
                    <input
                      type="text"
                      value={settings.notifications?.telegram.chatId ?? ""}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          notifications: {
                            ...settings.notifications!,
                            telegram: {
                              ...settings.notifications!.telegram,
                              chatId: e.target.value,
                            },
                          },
                        })
                      }
                    />
                  </label>
                </div>

                <div className="settings-group">
                  <div className="settings-title">Pair thresholds</div>
                  {(settings.notifications?.pairs ?? []).map((rule) => {
                    const pair = settings.pairs.find((item) => item.id === rule.pairId);
                    if (!pair) return null;
                    const baseToken = tokensById[pair.baseTokenId];
                    const quoteToken = tokensById[pair.quoteTokenId];
                    const baseSymbol = baseToken?.symbol ?? pair.baseTokenId;
                    const quoteSymbol = quoteToken?.symbol ?? pair.quoteTokenId;
                    const enabledNetworks = settings.networks.filter((net) => pair.networks?.[net.chain]);
                    return (
                      <div className="notification-pair" key={`notif-${pair.id}`}>
                        <div className="pair-name">
                          {baseSymbol}/{quoteSymbol}
                        </div>
                        <label>
                          Pair profit (%)
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            value={rule.minProfitPct}
                            onChange={(e) =>
                              setSettings({
                                ...settings,
                                notifications: {
                                  ...settings.notifications!,
                                  pairs: (settings.notifications?.pairs ?? []).map((item) =>
                                    item.pairId === rule.pairId
                                      ? { ...item, minProfitPct: Number(e.target.value) }
                                      : item
                                  ),
                                },
                              })
                            }
                          />
                        </label>
                        <div className="notification-networks">
                          {enabledNetworks.map((net) => (
                            <label key={`notif-${pair.id}-${net.chain}`}>
                              {net.name} override (%)
                              <input
                                type="number"
                                min={0}
                                step={0.01}
                                placeholder="use pair"
                                value={rule.networks?.[net.chain] ?? ""}
                                onChange={(e) => {
                                  const value = e.target.value;
                                  setSettings({
                                    ...settings,
                                    notifications: {
                                      ...settings.notifications!,
                                      pairs: (settings.notifications?.pairs ?? []).map((item) => {
                                        if (item.pairId !== rule.pairId) return item;
                                        const next = { ...(item.networks ?? {}) };
                                        if (value === "") {
                                          delete next[net.chain];
                                        } else {
                                          next[net.chain] = Number(value);
                                        }
                                        return { ...item, networks: next };
                                      }),
                                    },
                                  });
                                }}
                              />
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
