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
    { command: "start", description: "Start the bot" },
    { command: "help", description: "Show help" },
    { command: "register", description: "Register your wallet" },
    { command: "profile", description: "Show your profile" },
    { command: "season", description: "Current season info" },
    { command: "leaderboard", description: "Season leaderboard" },
    { command: "alltime", description: "All-time leaderboard" },
    { command: "admin_startseason", description: "Admin: start a season" },
    { command: "admin_endseason", description: "Admin: end active season" }
  ]);

  return bot;
}
