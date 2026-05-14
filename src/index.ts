import { createBot } from "./bot/createBot.js";
import { logger } from "./config/logger.js";

async function main(): Promise<void> {
  const bot = createBot();

  await bot.launch();
  logger.info("Bot launched");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down bot");
    await bot.stop(signal);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  logger.error({ error }, "Failed to start bot");
  process.exit(1);
});
