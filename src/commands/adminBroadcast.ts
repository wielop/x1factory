import type { BotInstance } from "../bot/types.js";
import { logger } from "../config/logger.js";
import { prisma } from "../db/prisma.js";

import { isAdminTelegramUser } from "./adminAuth.js";

export function registerAdminBroadcastCommand(bot: BotInstance): void {
  bot.command("admin_broadcast", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await ctx.reply("Admin access required.");
      return;
    }

    const message = ctx.message.text.replace(/^\/admin_broadcast(@\S+)?\s*/i, "").trim();

    if (!message) {
      await ctx.reply("Usage: /admin_broadcast <message>");
      return;
    }

    const users = await prisma.user.findMany({
      select: {
        telegramId: true
      }
    });

    let delivered = 0;
    let failed = 0;

    for (const user of users) {
      try {
        await bot.telegram.sendMessage(Number(user.telegramId), message);
        delivered += 1;
      } catch (error) {
        failed += 1;
        logger.warn({ error, telegramId: user.telegramId.toString() }, "Broadcast delivery failed");
      }
    }

    await ctx.reply(`Broadcast finished. Delivered: ${delivered}. Failed: ${failed}.`);
  });
}
