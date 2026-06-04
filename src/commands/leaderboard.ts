import type { BotContext, BotInstance } from "../bot/types.js";
import { formatRanking } from "../bot/formatters.js";
import { FACTORY_XP, factoryHeader, formatTestingNotice, mainMenuKeyboard } from "../bot/ui.js";
import { getAllTimeLeaderboard, getSeasonLeaderboard } from "../services/leaderboardService.js";
import { getCurrentSeason, getSeasonTestingNotice } from "../services/seasonService.js";

export async function showLeaderboard(ctx: BotContext): Promise<void> {
  const season = await getCurrentSeason();
  const [seasonEntries, allTimeEntries] = await Promise.all([
    getSeasonLeaderboard(),
    getAllTimeLeaderboard(5)
  ]);
  const testingNotice = getSeasonTestingNotice(season?.name);

  const seasonRanking =
    seasonEntries.length > 0
      ? formatRanking(seasonEntries)
      : "No factories have produced XP in this season yet.";
  const allTimeRanking =
    allTimeEntries.length > 0
      ? formatRanking(allTimeEntries)
      : "Official all-time ranking starts after test mode.";

  await ctx.reply(
    [
      factoryHeader("LEADERBOARD"),
      "",
      `${season?.name ?? "Current season"} // ${FACTORY_XP}`,
      seasonRanking,
      "",
      `All-time // ${FACTORY_XP}`,
      allTimeRanking,
      ...formatTestingNotice(testingNotice)
    ].join("\n"),
    mainMenuKeyboard()
  );
}

export function registerLeaderboardCommand(bot: BotInstance): void {
  bot.command("leaderboard", showLeaderboard);
}
