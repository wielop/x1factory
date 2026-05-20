import type { BotContext, BotInstance } from "../bot/types.js";
import { formatDisplayName } from "../bot/formatters.js";
import { FACTORY_XP, factoryHeader, formatTestingNotice, mainMenuKeyboard, shortWallet } from "../bot/ui.js";
import { formatClickerMicroAmount, getClickerDashboard } from "../services/clickerService.js";
import { getProfileWithStats } from "../services/profileService.js";
import { getSeasonTestingNotice } from "../services/seasonService.js";

function getTapsPerMind(level: number): number {
  const table = [20, 19, 18, 17, 16, 15, 14, 13, 12, 10];
  return table[Math.max(1, Math.min(10, level)) - 1] ?? 20;
}

export async function showProfile(ctx: BotContext): Promise<void> {
  const from = ctx.from;

  if (!from) {
    await ctx.reply("MIND FACTORY could not read your operator profile.");
    return;
  }

  const profile = await getProfileWithStats(from.id);
  const clicker = await getClickerDashboard(from);

  if (!profile) {
    await ctx.reply(
      [
        factoryHeader("NO FACTORY YET"),
        "",
        "Connect your wallet first. Once your factory is online, this screen will show your XP, rank and recent production."
      ].join("\n"),
      mainMenuKeyboard()
    );
    return;
  }

  const testingNotice = getSeasonTestingNotice(profile.currentSeason?.name);
  const recentEvents =
    profile.recentEvents.length > 0
      ? profile.recentEvents.slice(0, 4).map((entry) => `- ${entry}`)
      : ["- No production logged yet."];

  const clickerLines = !clicker.seasonName
    ? ["", "Factory Clicker: waiting for the next season."]
    : clicker.payoutWallet
    ? [
        "",
        "Factory Clicker:",
        `- Claimable MIND: ${formatClickerMicroAmount(clicker.claimableMindMicro)}`,
        `- Taps left today: ${clicker.tapsLeft}`,
        `- Claim status: ${clicker.pendingClaim ? clicker.pendingClaim.paymentStatus.toLowerCase() : "none"}`,
        `- Operator level: ${clicker.operatorLevel}`,
        `- Tap power: 1 MIND / ${getTapsPerMind(clicker.reactorCoreLevel)} taps`,
        `- Streak: ${clicker.streakDays} days`,
        `- Season wallet: ${shortWallet(clicker.payoutWallet.address)}`,
        `- Funding wallet: ${shortWallet(clicker.clickerWallet?.address)}`
      ]
    : ["", "Factory Clicker: connect your wallet to unlock the tap loop."];

  await ctx.reply(
    [
      factoryHeader("OPERATOR PROFILE"),
      "",
      `Operator: ${formatDisplayName(profile.user)}`,
      `Wallet: ${shortWallet(profile.user.activeWallet?.address)}`,
      "",
      `Season line: ${profile.currentSeason?.name ?? "not open yet"}`,
      `${FACTORY_XP}: ${profile.currentSeasonStats?.totalPoints ?? 0}`,
      `Operator rank: ${profile.currentSeasonStats?.rank ? `#${profile.currentSeasonStats.rank}` : "unranked"}`,
      `All-time ${FACTORY_XP}: ${profile.allTimePoints}`,
      "",
      "Recent production:",
      ...recentEvents,
      ...clickerLines,
      ...formatTestingNotice(testingNotice)
    ].join("\n"),
    mainMenuKeyboard()
  );
}

export function registerProfileCommand(bot: BotInstance): void {
  bot.command("profile", showProfile);
}
