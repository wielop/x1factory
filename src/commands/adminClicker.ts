import type { BotInstance } from "../bot/types.js";
import { logger } from "../config/logger.js";
import { formatClickerMicroAmount, renderClickerScreen, settlePendingClickerClaim } from "../services/clickerService.js";
import { resolveUserByTelegramUsernameOrId } from "../services/adminService.js";
import { creditReactorEnergy, getHashRushLeaderboard, resetHashRushForUser } from "../services/hashRushService.js";

import { isAdminTelegramUser, replyUnauthorized } from "./adminAuth.js";

function parseAdminClickerSettleCommand(text: string) {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const withoutCommand = firstLine.replace(/^\/admin_clicker_settle(?:@\S+)?\s*/i, "").trim();
  const parts = withoutCommand.split(/\s+/).filter(Boolean);

  if (parts.length < 1) {
    return null;
  }

  const [target, paymentTxHash, payoutTxHash] = parts;

  return {
    target,
    paymentTxHash,
    payoutTxHash
  };
}

function parseAdminCreditEnergyCommand(text: string) {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const withoutCommand = firstLine.replace(/^\/admin_credit_energy(?:@\S+)?\s*/i, "").trim();
  const parts = withoutCommand.split(/\s+/).filter(Boolean);

  if (parts.length < 2) {
    return null;
  }

  const [target, amountText, ...reasonParts] = parts;
  const amount = Number(amountText);

  if (!Number.isInteger(amount) || amount <= 0) {
    return null;
  }

  return {
    target,
    amount,
    reason: reasonParts.join(" ") || "manual admin credit"
  };
}

function parseAdminResetClickerCommand(text: string) {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const target = firstLine.replace(/^\/admin_reset_clicker(?:@\S+)?\s*/i, "").trim();
  return target || null;
}

export function registerAdminClickerCommands(bot: BotInstance): void {
  bot.command("admin_clicker_status", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await replyUnauthorized((message) => ctx.reply(message));
      return;
    }

    try {
      const leaderboard = await getHashRushLeaderboard(5);
      const rows = leaderboard.profiles.map((profile, index) => {
        const name = profile.user.username ? `@${profile.user.username}` : profile.user.telegramId.toString();
        return `#${index + 1} ${name} - ${profile.totalHashPoints.toLocaleString("en-US")} HP, energy ${profile.energy}/${profile.energyCap}`;
      });

      await ctx.reply(
        [
          `Hash Rush status - ${leaderboard.season.name}`,
          "",
          ...(rows.length ? rows : ["No clicker profiles yet."])
        ].join("\n")
      );
    } catch (error) {
      logger.warn({ error, telegramUserId: ctx.from.id }, "Admin clicker status failed");
      await ctx.reply(error instanceof Error ? error.message : "Failed to load clicker status.");
    }
  });

  bot.command("admin_credit_energy", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await replyUnauthorized((message) => ctx.reply(message));
      return;
    }

    const parsed = parseAdminCreditEnergyCommand(ctx.message.text);

    if (!parsed) {
      await ctx.reply("Usage: /admin_credit_energy <telegramUsernameOrId> <amount> <reason>");
      return;
    }

    const user = await resolveUserByTelegramUsernameOrId(parsed.target);

    if (!user) {
      await ctx.reply("User not found.");
      return;
    }

    try {
      const balance = await creditReactorEnergy({
        userId: user.id,
        amount: parsed.amount,
        reason: parsed.reason
      });
      const userLabel = user.username ? `@${user.username}` : user.telegramId.toString();

      await ctx.reply(
        [
          "Reactor Energy credited.",
          `User: ${userLabel}`,
          `Amount: ${parsed.amount}`,
          `Balance: ${balance.balance}`,
          `Reason: ${parsed.reason}`
        ].join("\n")
      );
    } catch (error) {
      logger.warn({ error, telegramUserId: ctx.from.id }, "Admin credit energy failed");
      await ctx.reply(error instanceof Error ? error.message : "Failed to credit Reactor Energy.");
    }
  });

  bot.command("admin_reset_clicker", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await replyUnauthorized((message) => ctx.reply(message));
      return;
    }

    const target = parseAdminResetClickerCommand(ctx.message.text);

    if (!target) {
      await ctx.reply("Usage: /admin_reset_clicker <telegramUsernameOrId>");
      return;
    }

    const user = await resolveUserByTelegramUsernameOrId(target);

    if (!user) {
      await ctx.reply("User not found.");
      return;
    }

    try {
      await resetHashRushForUser(user.id);
      const userLabel = user.username ? `@${user.username}` : user.telegramId.toString();
      await ctx.reply(`Hash Rush reset for ${userLabel}.`);
    } catch (error) {
      logger.warn({ error, telegramUserId: ctx.from.id }, "Admin reset clicker failed");
      await ctx.reply(error instanceof Error ? error.message : "Failed to reset Hash Rush.");
    }
  });

  bot.command("admin_clicker_settle", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await replyUnauthorized((message) => ctx.reply(message));
      return;
    }

    const parsed = parseAdminClickerSettleCommand(ctx.message.text);

    if (!parsed) {
      await ctx.reply("Usage: /admin_clicker_settle <telegramUsernameOrId> [paymentTxHash] [payoutTxHash]");
      return;
    }

    const user = await resolveUserByTelegramUsernameOrId(parsed.target);

    if (!user) {
      await ctx.reply("User not found.");
      return;
    }

    try {
      const result = await settlePendingClickerClaim({
        userId: user.id,
        paymentTxHash: parsed.paymentTxHash ?? null,
        payoutTxHash: parsed.payoutTxHash ?? null
      });

      const userLabel = user.username ? `@${user.username}` : user.telegramId.toString();
      const claimSummary = [
        "Clicker claim settled.",
        `User: ${userLabel}`,
        `Claim ID: ${result.claimId}`,
        `MIND paid: ${formatClickerMicroAmount(result.settledMindMicro)}`,
        `XNT received: ${formatClickerMicroAmount(result.settledXntMicro)}`,
        `Payment Tx: ${result.paymentTxHash ?? "not set"}`,
        `Payout Tx: ${result.payoutTxHash ?? "not set"}`,
        "",
        renderClickerScreen(result)
      ].join("\n");

      await ctx.reply(claimSummary);

      try {
        await ctx.telegram.sendMessage(Number(user.telegramId), result.message);
      } catch (error) {
        logger.warn({ error, telegramId: user.telegramId.toString() }, "Clicker payout notification failed");
      }
    } catch (error) {
      logger.warn({ error, telegramUserId: ctx.from.id }, "Admin clicker settle failed");
      await ctx.reply(error instanceof Error ? error.message : "Failed to settle clicker claim.");
    }
  });
}
