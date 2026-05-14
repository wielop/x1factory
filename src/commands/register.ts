import type { BotInstance } from "../bot/types.js";
import { startWalletRegistration } from "../bot/registrationState.js";
import { getActiveWalletForUser } from "../db/walletRepository.js";
import { registerProfile } from "../services/profileService.js";

export function registerRegisterCommand(bot: BotInstance): void {
  bot.command("register", async (ctx) => {
    const from = ctx.from;

    if (!from) {
      await ctx.reply("Unable to read Telegram user info for this chat.");
      return;
    }

    const profile = await registerProfile(from);
    const activeWallet = await getActiveWalletForUser(profile.id);

    if (activeWallet) {
      await ctx.reply(
        [
          "Wallet already registered.",
          `Active wallet: ${activeWallet.address}`,
          "Wallet changes are allowed only through the admin command."
        ].join("\n")
      );
      return;
    }

    startWalletRegistration(from.id);

    await ctx.reply(
      [
        "Profile registered.",
        `Telegram ID: ${profile.telegramId.toString()}`,
        `Username: ${profile.username ? `@${profile.username}` : "not set"}`,
        `Name: ${[profile.firstName, profile.lastName].filter(Boolean).join(" ") || "not set"}`,
        "",
        "Send your wallet address to complete registration.",
        "Wallet changes are blocked for regular users and must be done by admin."
      ].join("\n")
    );
  });
}
