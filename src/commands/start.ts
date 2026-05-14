import type { BotInstance } from "../bot/types.js";

export function registerStartCommand(bot: BotInstance): void {
  bot.start(async (ctx) => {
    await ctx.reply(
      [
        "Welcome to x1factory-seasons-bot.",
        "",
        "Use /register to save your profile, /season to see the current season, and /leaderboard or /alltime to check rankings."
      ].join("\n")
    );
  });
}
