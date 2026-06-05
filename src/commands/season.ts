import type { BotContext, BotInstance } from "../bot/types.js";
import { FACTORY_XP, factoryHeader, formatTestingNotice, mainMenuKeyboard } from "../bot/ui.js";
import { getSeasonOverview, getSeasonTestingNotice } from "../services/seasonService.js";

export async function showSeason(ctx: BotContext): Promise<void> {
  const overview = await getSeasonOverview();

  if (!overview) {
    await ctx.reply(
      [
        factoryHeader("SEASON LINE"),
        "",
        "No season is open yet.",
        "Connect now and wait for the next production run."
      ].join("\n"),
      mainMenuKeyboard()
    );
    return;
  }

  const { season } = overview;
  const testingNotice = getSeasonTestingNotice(season.name);

  await ctx.reply(
      [
        factoryHeader("SEASON LINE"),
        "",
        `${season.name}`,
        `Status: ${season.status}`,
        `Factory day: ${overview.dayNumber > 0 ? overview.dayNumber : "not started"}`,
        `Time left: ${overview.timeLeft}`,
        "",
        `Operators connected: ${overview.registeredMiners}`,
        `Active factories today: ${overview.activeMinersToday}`,
        `${FACTORY_XP} minted this season: ${overview.totalPointsDistributed}`,
        "",
        `Season window: ${overview.defaults.seasonDurationDays} days`,
        `Factory cooldown: ${overview.defaults.breakDurationDays} days`,
        ...formatTestingNotice(testingNotice)
      ].join("\n"),
      mainMenuKeyboard()
    );
  }

export function registerSeasonCommand(bot: BotInstance): void {
  bot.command("season", showSeason);
}
