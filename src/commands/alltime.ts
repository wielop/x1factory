import type { BotInstance } from "../bot/types.js";
import { formatRanking } from "../bot/formatters.js";
import { FACTORY_XP, factoryHeader, mainMenuKeyboard } from "../bot/ui.js";
import { getAllTimeLeaderboard } from "../services/leaderboardService.js";

export function registerAllTimeCommand(bot: BotInstance): void {
  bot.command("alltime", async (ctx) => {
    const entries = await getAllTimeLeaderboard();

    if (entries.length === 0) {
      await ctx.reply(
        [
          factoryHeader("ALL-TIME"),
          "",
          "Official all-time ranking starts after test mode."
        ].join("\n"),
        mainMenuKeyboard()
      );
      return;
    }

    await ctx.reply(
      [
        factoryHeader("ALL-TIME"),
        `${FACTORY_XP} leaderboard`,
        "",
        formatRanking(entries)
      ].join("\n"),
      mainMenuKeyboard()
    );
  });
}
