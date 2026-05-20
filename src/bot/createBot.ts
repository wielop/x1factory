import { Telegraf } from "telegraf";

import { setBotNotifier } from "./notifier.js";
import { registerCommands } from "../commands/index.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

export function createBot(): Telegraf {
  const bot = new Telegraf(env.botToken);
  setBotNotifier(bot);

  registerCommands(bot);

  bot.catch((error, ctx) => {
    logger.error(
      {
        error,
        updateType: ctx.updateType,
        fromId: ctx.from?.id,
        chatId: ctx.chat?.id
      },
      "Bot error"
    );
  });

  void bot.telegram.setMyCommands([
    { command: "start", description: "Open MIND FACTORY" },
    { command: "help", description: "How the factory works" },
    { command: "register", description: "Connect wallet" },
    { command: "play", description: "Play Reactor Rush" },
    { command: "clicker", description: "Factory Clicker legacy" },
    { command: "profile", description: "My Factory" },
    { command: "season", description: "Season line" },
    { command: "leaderboard", description: "Operator leaderboard" },
    { command: "alltime", description: "All-time operators" }
  ]);

  return bot;
}
