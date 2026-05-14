import type { BotInstance } from "../bot/types.js";
import { formatDisplayName } from "../bot/formatters.js";
import { getProfileWithStats } from "../services/profileService.js";

export function registerProfileCommand(bot: BotInstance): void {
  bot.command("profile", async (ctx) => {
    const from = ctx.from;

    if (!from) {
      await ctx.reply("Unable to resolve your Telegram profile.");
      return;
    }

    const profile = await getProfileWithStats(from.id);

    if (!profile) {
      await ctx.reply("No profile found yet. Run /register first.");
      return;
    }

    await ctx.reply(
      [
        `Profile: ${formatDisplayName(profile.user)}`,
        `Telegram ID: ${profile.user.telegramId.toString()}`,
        `Wallet: ${profile.user.activeWallet?.address ?? "not registered"}`,
        `Current Season: ${profile.currentSeason?.name ?? "no active or upcoming season"}`,
        `Current Season Points: ${profile.currentSeasonStats?.totalPoints ?? 0}`,
        `Current Rank: ${profile.currentSeasonStats?.rank ? `#${profile.currentSeasonStats.rank}` : "unranked"}`,
        `All-Time Points: ${profile.allTimePoints}`,
        `Badges: ${profile.badges.length > 0 ? profile.badges.join(", ") : "none"}`,
        `Recent Events: ${
          profile.recentEvents.length > 0 ? profile.recentEvents.join(", ") : "none"
        }`
      ].join("\n")
    );
  });
}
