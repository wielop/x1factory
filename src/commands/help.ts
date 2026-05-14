import type { BotInstance } from "../bot/types.js";

export function registerHelpCommand(bot: BotInstance): void {
  bot.help(async (ctx) => {
    await ctx.reply(
      [
        "Available commands:",
        "/start - bot introduction",
        "/help - command list",
        "/register - start wallet registration",
        "/profile - show your saved profile, wallet and mock seasonal stats",
        "/season - current season details",
        "/leaderboard - current season leaderboard",
        "/alltime - all-time leaderboard",
        "/admin_startseason - admin only",
        "/admin_endseason - admin only"
      ].join("\n")
    );
  });
}
