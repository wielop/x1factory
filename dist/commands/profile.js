import { formatDisplayName } from "../bot/formatters.js";
import { factoryHeader, formatTestingNotice, mainMenuKeyboard, shortWallet } from "../bot/ui.js";
import { getProfileWithStats } from "../services/profileService.js";
import { getSeasonTestingNotice } from "../services/seasonService.js";
export async function showProfile(ctx) {
    const from = ctx.from;
    if (!from) {
        await ctx.reply("MIND FACTORY could not read your operator profile.");
        return;
    }
    const profile = await getProfileWithStats(from.id);
    if (!profile) {
        await ctx.reply([
            factoryHeader("NO FACTORY YET"),
            "",
            "Connect your wallet first. Once connected, this screen will show your Season Points, rank and recent activity."
        ].join("\n"), mainMenuKeyboard());
        return;
    }
    const testingNotice = getSeasonTestingNotice(profile.currentSeason?.name);
    const recentEvents = profile.recentEvents.length > 0
        ? profile.recentEvents.slice(0, 4).map((entry) => `- ${entry}`)
        : ["- No activity logged yet."];
    await ctx.reply([
        factoryHeader("OPERATOR PROFILE"),
        "",
        `Operator: ${formatDisplayName(profile.user)}`,
        `Wallet: ${shortWallet(profile.user.activeWallet?.address)}`,
        "",
        `Season: ${profile.currentSeason?.name ?? "not open yet"}`,
        `Season Points: ${profile.currentSeasonStats?.totalPoints ?? 0}`,
        `Rank: ${profile.currentSeasonStats?.rank ? `#${profile.currentSeasonStats.rank}` : "unranked"}`,
        `All-time Points: ${profile.allTimePoints}`,
        "",
        "Recent activity:",
        ...recentEvents,
        ...formatTestingNotice(testingNotice)
    ].join("\n"), mainMenuKeyboard());
}
export function registerProfileCommand(bot) {
    bot.command("profile", showProfile);
}
