import type { BotInstance } from "../bot/types.js";
import { formatRanking } from "../bot/formatters.js";
import { getSeasonLeaderboard } from "../services/leaderboardService.js";
import { getCurrentSeason } from "../services/seasonService.js";

export function registerLeaderboardCommand(bot: BotInstance): void {
  bot.command("leaderboard", async (ctx) => {
    const season = await getCurrentSeason();
    const entries = getSeasonLeaderboard();

    await ctx.reply(
      [
        `${season?.name ?? "Current season"} leaderboard`,
        "",
        formatRanking(entries)
      ].join("\n")
    );
  });
}
