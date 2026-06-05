import { existsSync } from "node:fs";
import { resolve } from "node:path";

import dotenv from "dotenv";

const envLocalPath = resolve(process.cwd(), ".env.local");
const envPath = resolve(process.cwd(), ".env");

if (existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath });
  dotenv.config({ path: envPath });
} else {
  dotenv.config({ path: envPath });
}

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : undefined;
}

export const env = {
  botToken: requireEnv("BOT_TOKEN"),
  databaseUrl: requireEnv("DATABASE_URL"),
  x1RpcUrl: optionalEnv("X1_RPC_URL"),
  x1FactoryProgramId: optionalEnv("X1FACTORY_PROGRAM_ID"),
  mindMint: optionalEnv("MIND_MINT"),
  xntMint: optionalEnv("XNT_MINT"),
  miniAppUrl: optionalEnv("MINI_APP_URL"),
    miniAppPort: Number(process.env.MINI_APP_PORT ?? 4174),
    miniAppHost: process.env.MINI_APP_HOST ?? "127.0.0.1",
    xntDepositTreasuryWallet: optionalEnv("XNT_DEPOSIT_TREASURY_WALLET"),
    reactorEnergyRatePerXnt: Number(process.env.REACTOR_ENERGY_RATE_PER_XNT ?? 1000),
    xntDepositMinAmount: Number(process.env.XNT_DEPOSIT_MIN_AMOUNT ?? 0.1),
    x1FactoryIdlPath: optionalEnv("X1FACTORY_IDL_PATH"),
  x1ScannerEnabled: (process.env.X1_SCANNER_ENABLED ?? "false").trim().toLowerCase() === "true",
  x1ScannerIntervalSeconds: Number(process.env.X1_SCANNER_INTERVAL_SECONDS ?? 120),
  logLevel: process.env.LOG_LEVEL ?? "info",
  adminIds: (process.env.ADMIN_TELEGRAM_IDS ?? process.env.ADMIN_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value))
};
