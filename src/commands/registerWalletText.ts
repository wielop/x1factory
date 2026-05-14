import type { BotInstance } from "../bot/types.js";
import { clearWalletRegistration, isWalletRegistrationPending } from "../bot/registrationState.js";
import { logger } from "../config/logger.js";
import { registerWalletForTelegramUser } from "../services/profileService.js";
import { isValidWalletAddress } from "../services/walletValidation.js";

export function registerWalletTextHandler(bot: BotInstance): void {
  bot.on("text", async (ctx, next) => {
    if (!ctx.from) {
      return next();
    }

    const text = ctx.message.text.trim();

    if (text.startsWith("/")) {
      return next();
    }

    if (!isWalletRegistrationPending(ctx.from.id)) {
      return next();
    }

    if (!isValidWalletAddress(text)) {
      await ctx.reply("Invalid wallet format. Send a valid Solana/X1 public key.");
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
          "Wallet registered.",
          `Wallet: ${result.wallet.address}`,
          `Season: ${result.season?.name ?? "no active or upcoming season found"}`,
          result.registration ? "Season registration: active" : "Season registration: skipped"
        ].join("\n")
      );
    } catch (error) {
      logger.warn({ error, telegramUserId: ctx.from.id }, "Wallet registration failed");
      await ctx.reply(error instanceof Error ? error.message : "Failed to register wallet.");
    }
  });
}
