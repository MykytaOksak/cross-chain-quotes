import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const WORKER_ENV_PATH = path.join(ROOT_DIR, ".env.worker");

function parseEnvFile(filePath) {
  const parsed = {};
  const raw = readFileSync(filePath, "utf8");
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) return;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key) parsed[key] = value;
  });
  return parsed;
}

function startProcess(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: ROOT_DIR,
    env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(`${name} stopped by signal ${signal}`);
      return;
    }
    console.log(`${name} exited with code ${code ?? 0}`);
  });

  child.on("error", (error) => {
    console.error(`${name} failed to start:`, error);
  });

  return child;
}

const workerEnv = existsSync(WORKER_ENV_PATH) ? parseEnvFile(WORKER_ENV_PATH) : {};
const pendlePort = workerEnv.PENDLE_WORKER_PORT || process.env.PENDLE_WORKER_PORT || "8788";
const appPort = process.env.APP_PORT || process.env.PORT || "4173";
const vitePort = process.env.VITE_PORT || "5173";

if (!workerEnv.PENDLE_PRIVATE_KEY && !process.env.PENDLE_PRIVATE_KEY) {
  console.warn("PENDLE_PRIVATE_KEY is not set. Pendle worker endpoints will fail until you add it to .env.worker.");
}

if (!process.env.npm_execpath) {
  console.error("npm_execpath is not set. Run this stack through `npm run local:dev`.");
  process.exit(1);
}

const sharedEnv = {
  ...process.env,
  ...workerEnv,
  PENDLE_WORKER_PORT: pendlePort,
  APP_PORT: appPort,
  PENDLE_API_BASE: `http://127.0.0.1:${pendlePort}`,
};

const children = [
  startProcess("pendle-worker", process.execPath, [path.join("server", "pendle-worker.mjs")], sharedEnv),
  startProcess("app-server", process.execPath, [path.join("server", "app-server.mjs")], sharedEnv),
  startProcess(
    "vite-dev",
    process.execPath,
    [process.env.npm_execpath, "run", "dev", "--", "--host", "127.0.0.1", "--port", vitePort],
    sharedEnv
  ),
];

function shutdown(signal) {
  console.log(`Stopping local dev stack (${signal})...`);
  children.forEach((child) => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  });
  setTimeout(() => process.exit(0), 250);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(
  `Local dev stack started. Frontend: http://localhost:${vitePort}, App API: http://localhost:${appPort}, Pendle worker: http://localhost:${pendlePort}`
);
