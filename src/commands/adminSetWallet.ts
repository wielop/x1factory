import type { BotInstance } from "../bot/types.js";
import { findUserByTelegramId } from "../db/userRepository.js";
import { registerActiveWalletForCurrentSeason } from "../services/profileService.js";
import { isValidWalletAddress } from "../services/walletValidation.js";
import { assignActiveWalletToUser } from "../db/walletRepository.js";

import { isAdminTelegramUser } from "./adminAuth.js";

export function registerAdminSetWalletCommand(bot: BotInstance): void {
  bot.command("admin_set_wallet", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await ctx.reply("Admin access required.");
      return;
    }

    const [, telegramIdText, walletAddress] = ctx.message.text.trim().split(/\s+/);
    const telegramId = Number(telegramIdText);

    if (!Number.isInteger(telegramId) || !walletAddress) {
      await ctx.reply("Usage: /admin_set_wallet <telegram_id> <wallet_address>");
      return;
    }

    if (!isValidWalletAddress(walletAddress)) {
      await ctx.reply("Invalid wallet format.");
      return;
    }

    const user = await findUserByTelegramId(BigInt(telegramId));

    if (!user) {
      await ctx.reply("User not found.");
      return;
    }

    const wallet = await assignActiveWalletToUser({
      userId: user.id,
      address: walletAddress,
      allowReassignment: true
    });

    await registerActiveWalletForCurrentSeason({
      userId: user.id,
      walletId: wallet.id,
      walletAddress: wallet.address
    });

    await ctx.reply(
      [
        "Wallet updated by admin.",
        `User: ${user.telegramId.toString()}`,
        `Wallet: ${wallet.address}`
      ].join("\n")
    );
  });
}
