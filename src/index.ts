import { createBot } from "./bot/createBot.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { startScanner } from "./scanner/index.js";
import { startMiniAppServer } from "./web/server.js";

async function main(): Promise<void> {
  const bot = createBot();
  const stopScanner = env.x1ScannerEnabled ? startScanner(env.x1ScannerIntervalSeconds) : () => undefined;
  const stopMiniApp = startMiniAppServer();

  let botStarted = false;

  try {
    await bot.launch();
    botStarted = true;
    logger.info("Bot launched");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("409") || message.includes("getUpdates")) {
      logger.warn({ error }, "Bot launch skipped because another polling instance is already running");
    } else {
      throw error;
    }
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down bot");
    stopScanner();
    stopMiniApp();
    if (botStarted) {
      await bot.stop(signal);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  logger.error({ error }, "Failed to start bot");
  process.exit(1);
});
