import type { BotInstance } from "../bot/types.js";
import { logger } from "../config/logger.js";
import { adminEndSeason, adminStartSeason } from "../services/seasonService.js";

import { isAdminTelegramUser } from "./adminAuth.js";

export function registerAdminSeasonCommands(bot: BotInstance): void {
  bot.command("admin_startseason", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await ctx.reply("Admin access required.");
      return;
    }

    const rawName = ctx.message.text.replace(/^\/admin_startseason(@\S+)?\s*/i, "").trim();

    if (!rawName) {
      await ctx.reply("Usage: /admin_startseason <name>");
      return;
    }

    try {
      const season = await adminStartSeason(rawName);
      await ctx.reply(
        [
          "Season started.",
          `Name: ${season.name}`,
          `Start: ${season.startsAt.toISOString()}`,
          `End: ${season.endsAt.toISOString()}`,
          `Status: ${season.status}`
        ].join("\n")
      );
    } catch (error) {
      logger.warn({ error, telegramUserId: ctx.from.id }, "Admin start season failed");
      await ctx.reply(error instanceof Error ? error.message : "Failed to start season.");
    }
  });

  bot.command("admin_endseason", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await ctx.reply("Admin access required.");
      return;
    }

    try {
      const season = await adminEndSeason();
      await ctx.reply(
        [
          "Season ended.",
          `Name: ${season.name}`,
          `Ended At: ${season.endsAt.toISOString()}`,
          `Status: ${season.status}`
        ].join("\n")
      );
    } catch (error) {
      logger.warn({ error, telegramUserId: ctx.from.id }, "Admin end season failed");
      await ctx.reply(error instanceof Error ? error.message : "Failed to end season.");
    }
  });

}
