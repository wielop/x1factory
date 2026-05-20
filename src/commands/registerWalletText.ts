import type { BotInstance } from "../bot/types.js";
import { clearWalletRegistration, isWalletRegistrationPending } from "../bot/registrationState.js";
import { FACTORY_XP, factoryHeader, mainMenuKeyboard, shortWallet } from "../bot/ui.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { registerWalletForTelegramUser } from "../services/profileService.js";
import { isValidWalletAddress } from "../services/walletValidation.js";

export function registerWalletTextHandler(bot: BotInstance): void {
  bot.on("text", async (ctx, next) => {
    if (!ctx.from) {
      return next();
    }

    const text = ctx.message.text.trim();

    if (text === "Cancel") {
      clearWalletRegistration(ctx.from.id);
      await ctx.reply("Wallet connection cancelled. Your factory is unchanged.", mainMenuKeyboard());
      return;
    }

    if (text.startsWith("/")) {
      return next();
    }

    if (!isWalletRegistrationPending(ctx.from.id)) {
      return next();
    }

    if (!isValidWalletAddress(text)) {
      await ctx.reply(
        [
          factoryHeader("WALLET CHECK"),
          "",
          "That does not look like a valid X1/Solana wallet.",
          "Paste the public wallet address only, not a private key or seed phrase."
        ].join("\n")
      );
      return;
    }

    try {
      const result = await registerWalletForTelegramUser({
        telegramUser: ctx.from,
        walletAddress: text
      });

      clearWalletRegistration(ctx.from.id);

      await ctx.reply(
        [
          factoryHeader("FACTORY ONLINE"),
          "",
          `Wallet connected: ${shortWallet(result.wallet.address)}`,
          `Season line: ${result.season?.name ?? "not open yet"}`,
          result.registration ? `Registration bonus queued: +50 ${FACTORY_XP}` : "Season registration: waiting for the next season",
          "",
          "Your factory is ready. Keep your rigs running and watch the XP stack."
        ].join("\n"),
        mainMenuKeyboard(env.miniAppUrl)
      );
    } catch (error) {
      logger.warn({ error, telegramUserId: ctx.from.id }, "Wallet registration failed");
      await ctx.reply(
        [
          factoryHeader("CONNECTION FAILED"),
          "",
          error instanceof Error ? error.message : "The factory could not connect this wallet.",
          "",
          "Try again or contact an admin if the wallet should belong to you."
        ].join("\n"),
        mainMenuKeyboard(env.miniAppUrl)
      );
    }
  });
}
