import { factoryHeader, mainMenuKeyboard } from "../bot/ui.js";
import { env } from "../config/env.js";
import { getActiveWalletForUser } from "../db/walletRepository.js";
import { registerProfile } from "../services/profileService.js";
import { processDailyCheckin } from "../services/pointsService.js";
import { getCurrentSeason } from "../services/seasonService.js";
const PANEL_URL = "https://x1factory.xyz/panel";
function getPanelUrl() { return env.miniAppUrl ?? PANEL_URL; }
export async function showDailyCheckin(ctx) {
    const from = ctx.from;
    if (!from)
        return;
    const user = await registerProfile(from);
    const wallet = await getActiveWalletForUser(user.id);
    const season = await getCurrentSeason();
    if (!wallet) {
        await ctx.reply([factoryHeader("DAILY CHECK-IN"), "", "Connect your wallet first to earn Season Points."].join("\n"), mainMenuKeyboard(getPanelUrl()));
        return;
    }
    if (!season) {
        await ctx.reply([factoryHeader("DAILY CHECK-IN"), "", "No active season right now. Check back soon."].join("\n"), mainMenuKeyboard(getPanelUrl()));
        return;
    }
    const result = await processDailyCheckin(user.id, season.id);
    if (!result.created) {
        await ctx.reply([
            factoryHeader("DAILY CHECK-IN"),
            "",
            "Already checked in today. Come back tomorrow!",
            "",
            `Season Points: ${result.totalPoints}`,
            result.rank ? `Rank: #${result.rank}` : "Rank: unranked"
        ].join("\n"), mainMenuKeyboard(getPanelUrl()));
        return;
    }
    await ctx.reply([
        factoryHeader("DAILY CHECK-IN"),
        "",
        `+${result.points} Season Points earned!`,
        "",
        `Season Points: ${result.totalPoints}`,
        result.rank ? `Rank: #${result.rank}` : "Rank: unranked"
    ].join("\n"), mainMenuKeyboard(getPanelUrl()));
}
export function registerCheckinCommand(bot) {
    bot.command("checkin", showDailyCheckin);
}
