import { readFile } from "node:fs/promises";
import path from "node:path";

export const ROOT_DIR = process.cwd();
export const CONFIG_PATH = path.join(ROOT_DIR, "src", "config.json");

export async function readAppConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

export function sanitizeHostedConfig(config) {
  return {
    ...config,
    notifications: {
      ...(config.notifications ?? {}),
      telegram: {
        botToken: "",
        chatId: "",
      },
    },
    portfolio: {
      refreshMs: config.portfolio?.refreshMs ?? 300000,
      notificationsEnabled: false,
      walletAddress: "",
      walletTag: "",
      wallets: [],
      ignoredEmptyPositionIds: [],
      positions: [],
    },
    pendle: {
      strategies: [],
      rpcByChainId: {},
      limitOrderContractByChainId: {},
      notificationsEnabled: false,
    },
  };
}
