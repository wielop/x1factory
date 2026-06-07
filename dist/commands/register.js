import { startWalletRegistration } from "../bot/registrationState.js";
import { factoryHeader, formatTestingNotice, shortWallet, walletInputKeyboard } from "../bot/ui.js";
import { getActiveWalletForUser } from "../db/walletRepository.js";
import { registerProfile } from "../services/profileService.js";
import { getCurrentSeason, getSeasonTestingNotice } from "../services/seasonService.js";
export async function showConnectWallet(ctx) {
    const from = ctx.from;
    if (!from) {
        await ctx.reply("MIND FACTORY could not read your Telegram profile. Try again in a private chat.");
        return;
    }
    const profile = await registerProfile(from);
    const activeWallet = await getActiveWalletForUser(profile.id);
    const season = await getCurrentSeason();
    const testingNotice = getSeasonTestingNotice(season?.name);
    startWalletRegistration(from.id);
    const currentLine = activeWallet
        ? `Current wallet: ${shortWallet(activeWallet.address)}`
        : "No wallet connected yet.";
    const note = activeWallet
        ? "Note: wallet changes are locked once you earn points in an active season."
        : "Once connected, this wallet is your season identity.";
    await ctx.reply([
        factoryHeader("CONNECT WALLET"),
        "",
        currentLine,
        "",
        "Paste your Solana wallet address to connect or update it.",
        note,
        ...formatTestingNotice(testingNotice)
    ].join("\n"), walletInputKeyboard());
}
export function registerRegisterCommand(bot) {
    bot.command("register", showConnectWallet);
}
