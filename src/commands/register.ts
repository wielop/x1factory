import type { BotContext, BotInstance } from "../bot/types.js";
import { startWalletRegistration } from "../bot/registrationState.js";
import { FACTORY_XP, factoryHeader, formatTestingNotice, mainMenuKeyboard, shortWallet, walletInputKeyboard } from "../bot/ui.js";
import { getActiveWalletForUser } from "../db/walletRepository.js";
import { registerActiveWalletForCurrentSeason, registerProfile } from "../services/profileService.js";
import { getCurrentSeason, getSeasonTestingNotice } from "../services/seasonService.js";

export async function showConnectWallet(ctx: BotContext): Promise<void> {
  const from = ctx.from;

  if (!from) {
    await ctx.reply("MIND FACTORY could not read your Telegram profile. Try again in a private chat.");
    return;
  }

  const profile = await registerProfile(from);
  const activeWallet = await getActiveWalletForUser(profile.id);
  const season = await getCurrentSeason();
  const testingNotice = getSeasonTestingNotice(season?.name);

  if (activeWallet) {
    const seasonRegistration = await registerActiveWalletForCurrentSeason({
      userId: profile.id,
      walletId: activeWallet.id,
      walletAddress: activeWallet.address
    });

    await ctx.reply(
      [
        factoryHeader("WALLET CONNECTED"),
        "",
        `Your factory is already linked to ${shortWallet(activeWallet.address)}.`,
        `Season line: ${seasonRegistration.season?.name ?? "not open yet"}`,
        seasonRegistration.registration ? "Status: ready to earn Factory XP" : "Status: waiting for the next season",
        "",
        "Need to change wallets? Ask an admin to move your factory safely.",
        ...formatTestingNotice(testingNotice)
      ].join("\n"),
      mainMenuKeyboard()
    );
    return;
  }

  startWalletRegistration(from.id);

  await ctx.reply(
    [
      factoryHeader("CONNECT WALLET"),
      "",
      "Paste your X1/Solana wallet address in the next message.",
      "",
      "Once connected, this wallet becomes your factory ID for the season.",
      `Season registration grants 50 ${FACTORY_XP}.`,
      "",
      "Wallet changes are admin-only, so check the address before sending.",
      ...formatTestingNotice(testingNotice)
    ].join("\n"),
    walletInputKeyboard()
  );
}

export function registerRegisterCommand(bot: BotInstance): void {
  bot.command("register", showConnectWallet);
}
