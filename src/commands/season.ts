import type { BotInstance } from "../bot/types.js";
import { getSeasonOverview } from "../services/seasonService.js";

export function registerSeasonCommand(bot: BotInstance): void {
  bot.command("season", async (ctx) => {
    const overview = await getSeasonOverview();

    if (!overview) {
      await ctx.reply("No active or upcoming season found.");
      return;
    }

    const { season } = overview;

    await ctx.reply(
      [
        `${season.name} (${season.status})`,
        `Start: ${season.startsAt.toISOString()}`,
        `End: ${season.endsAt.toISOString()}`,
        `Season Duration: ${overview.defaults.seasonDurationDays} days`,
        `Break Duration: ${overview.defaults.breakDurationDays} days`,
        `Day Number: ${overview.dayNumber > 0 ? overview.dayNumber : "not started"}`,
        `Time Left: ${overview.timeLeft}`
      ].join("\n")
    );
  });
}
