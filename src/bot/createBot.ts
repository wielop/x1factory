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
    { command: "checkin", description: "Daily check-in (+10 pts)" },
    { command: "register", description: "Connect wallet" },
    { command: "profile", description: "My profile" },
    { command: "season", description: "Current season" },
    { command: "leaderboard", description: "Season leaderboard" },
    { command: "alltime", description: "All-time rankings" },
    { command: "help", description: "How It Works" }
  ]);

  return bot;
}
