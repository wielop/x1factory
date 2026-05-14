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
  logLevel: process.env.LOG_LEVEL ?? "info",
  x1FactoryAdapter: process.env.X1FACTORY_ADAPTER ?? "mock",
  scannerIntervalMs: Number(process.env.SCANNER_INTERVAL_MS ?? 120000),
  adminIds: (process.env.ADMIN_TELEGRAM_IDS ?? process.env.ADMIN_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value))
};
