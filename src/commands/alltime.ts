import type { BotInstance } from "../bot/types.js";
import { formatRanking } from "../bot/formatters.js";
import { getAllTimeLeaderboard } from "../services/leaderboardService.js";

export function registerAllTimeCommand(bot: BotInstance): void {
  bot.command("alltime", async (ctx) => {
    const entries = getAllTimeLeaderboard();

    await ctx.reply(
      [
        "All-time leaderboard",
        "",
        formatRanking(entries)
      ].join("\n")
    );
  });
}
