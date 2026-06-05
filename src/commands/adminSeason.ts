import type { BotInstance } from "../bot/types.js";
import { SUPPORTED_EVENT_TYPES } from "../config/points.js";
import { logger } from "../config/logger.js";
import { getScannerStatus, runScannerOnce, scanWalletManually } from "../scanner/index.js";
import { addManualSeasonPoints, resolveUserByTelegramUsernameOrId } from "../services/adminService.js";
import { processDailyCheckin, processEvent } from "../services/pointsService.js";
import { adminEndSeason, adminStartSeason, getAdminSeasonStatus, getSeasonTestingNotice } from "../services/seasonService.js";
import { getCurrentSeason } from "../services/seasonService.js";

import { isAdminTelegramUser, replyUnauthorized } from "./adminAuth.js";

function parseAdminPointsCommand(text: string, commandName: "admin_addpoints" | "admin_removepoints") {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const withoutCommand = firstLine.replace(new RegExp(`^/${commandName}(?:@\\S+)?\\s*`, "i"), "").trim();
  const parts = withoutCommand.split(/\s+/).filter(Boolean);

  if (parts.length < 3) {
    return null;
  }

  const [target, pointsText, ...reasonParts] = parts;
  const reason = reasonParts.join(" ").trim();

  if (!reason) {
    return null;
  }

  return {
    target,
    pointsText,
    reason
  };
}

function parseAdminEventCommand(text: string) {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const withoutCommand = firstLine.replace(/^\/admin_event(?:@\S+)?\s*/i, "").trim();
  const parts = withoutCommand.split(/\s+/).filter(Boolean);

  if (parts.length < 2) {
    return null;
  }

  const [target, eventType, maybeValue, maybeTxHash] = parts;

  return {
    target,
    eventType,
    maybeValue,
    maybeTxHash
  };
}

function parseSingleArgumentCommand(text: string, commandName: string): string | null {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const value = firstLine.replace(new RegExp(`^/${commandName}(?:@\\S+)?\\s*`, "i"), "").trim();
  return value || null;
}

function describeDynamicEventInput(eventType: string): string {
  if (eventType === "claim_mind_daily") {
    return "daily claimed MIND total";
  }

  if (eventType === "stake_snapshot") {
    return "current highest stake snapshot";
  }

  return "numeric value";
}

export function registerAdminSeasonCommands(bot: BotInstance): void {
  bot.command("admin_startseason", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await replyUnauthorized((message) => ctx.reply(message));
      return;
    }

    const rawName = ctx.message.text.replace(/^\/admin_startseason(@\S+)?\s*/i, "").trim();
    const seasonName = rawName || "Season 0 - Bot Test";

    try {
      const season = await adminStartSeason(seasonName);
      const testingNotice = getSeasonTestingNotice(season.name);
      await ctx.reply(
        [
          "Season started.",
          `Name: ${season.name}`,
          `Start: ${season.startsAt.toISOString()}`,
          `End: ${season.endsAt.toISOString()}`,
          `Status: ${season.status}`,
          ...(testingNotice ? ["", testingNotice] : [])
        ].join("\n")
      );
    } catch (error) {
      logger.warn({ error, telegramUserId: ctx.from.id }, "Admin start season failed");
      await ctx.reply(error instanceof Error ? error.message : "Failed to start season.");
    }
  });

  bot.command("admin_endseason", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await replyUnauthorized((message) => ctx.reply(message));
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
  bot.command("admin_status", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await replyUnauthorized((message) => ctx.reply(message));
      return;
    }

    try {
      const status = await getAdminSeasonStatus();

      if (!status) {
        await ctx.reply("No active season found.");
        return;
      }

      const testingNotice = getSeasonTestingNotice(status.season.name);

      await ctx.reply(
        [
          "Active season status",
          `Name: ${status.season.name}`,
          `Status: ${status.season.status}`,
          `Start: ${status.season.startsAt.toISOString()}`,
          `End: ${status.season.endsAt.toISOString()}`,
          `Registered Users: ${status.registeredUsers}`,
          `Total Season Points: ${status.totalPoints}`,
          `Top 5 Users: ${
            status.topUsers.length > 0
              ? status.topUsers
                  .map((entry) => {
                    const label = entry.user.username
                      ? `@${entry.user.username}`
                      : entry.user.telegramId.toString();
                    return `#${entry.rank ?? "-"} ${label} (${entry.totalPoints})`;
                  })
                  .join(", ")
              : "none"
          }`,
          ...(testingNotice ? ["", testingNotice] : [])
        ].join("\n")
      );
    } catch (error) {
      logger.warn({ error, telegramUserId: ctx.from.id }, "Admin status failed");
      await ctx.reply(error instanceof Error ? error.message : "Failed to load admin status.");
    }
  });

  bot.command("admin_addpoints", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await replyUnauthorized((message) => ctx.reply(message));
      return;
    }

    const parsed = parseAdminPointsCommand(ctx.message.text, "admin_addpoints");

    if (!parsed) {
      await ctx.reply("Usage: /admin_addpoints <telegramUsernameOrId> <points> <reason>");
      return;
    }

    const { target, pointsText, reason } = parsed;
    const points = Number(pointsText);

    if (!Number.isFinite(points) || points <= 0) {
      await ctx.reply("Points must be a positive integer.");
      return;
    }

    try {
      const outcome = await addManualSeasonPoints({
        telegramUsernameOrId: target,
        points,
        reason
      });

      await ctx.reply(
        [
          "Manual points added.",
          `User: ${outcome.user.username ? `@${outcome.user.username}` : outcome.user.telegramId.toString()}`,
          `Points: ${points}`,
          `Reason: ${reason}`,
          `Season Total: ${outcome.result.totalPoints}`,
          `Current Rank: ${outcome.result.rank ? `#${outcome.result.rank}` : "unranked"}`
        ].join("\n")
      );
    } catch (error) {
      logger.warn({ error, telegramUserId: ctx.from.id }, "Admin add points failed");
      await ctx.reply(error instanceof Error ? error.message : "Failed to add points.");
    }
  });

  bot.command("admin_removepoints", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await replyUnauthorized((message) => ctx.reply(message));
      return;
    }

    const parsed = parseAdminPointsCommand(ctx.message.text, "admin_removepoints");

    if (!parsed) {
      await ctx.reply("Usage: /admin_removepoints <telegramUsernameOrId> <points> <reason>");
      return;
    }

    const { target, pointsText, reason } = parsed;
    const points = Number(pointsText);

    if (!Number.isFinite(points) || points <= 0) {
      await ctx.reply("Points must be a positive integer.");
      return;
    }

    try {
      const outcome = await addManualSeasonPoints({
        telegramUsernameOrId: target,
        points: -points,
        reason: `Manual removal: ${reason}`
      });

      await ctx.reply(
        [
          "Manual points removed.",
          `User: ${outcome.user.username ? `@${outcome.user.username}` : outcome.user.telegramId.toString()}`,
          `Points Removed: ${points}`,
          `Reason: ${reason}`,
          `Season Total: ${outcome.result.totalPoints}`,
          `Current Rank: ${outcome.result.rank ? `#${outcome.result.rank}` : "unranked"}`
        ].join("\n")
      );
    } catch (error) {
      logger.warn({ error, telegramUserId: ctx.from.id }, "Admin remove points failed");
      await ctx.reply(error instanceof Error ? error.message : "Failed to remove points.");
    }
  });

  bot.command("admin_event", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await replyUnauthorized((message) => ctx.reply(message));
      return;
    }

    const parsed = parseAdminEventCommand(ctx.message.text);

    if (!parsed) {
      await ctx.reply("Usage: /admin_event <telegramUsernameOrId> <eventType> [value] [txHash]");
      return;
    }

    const activeSeason = await getCurrentSeason();

    if (!activeSeason) {
      await ctx.reply("No active season found.");
      return;
    }

    const user = await resolveUserByTelegramUsernameOrId(parsed.target);

    if (!user) {
      await ctx.reply("User not found.");
      return;
    }

    try {
      const eventType = parsed.eventType as (typeof SUPPORTED_EVENT_TYPES)[number] | "daily_checkin";
      let result;

      if (eventType === "daily_checkin") {
        result = await processDailyCheckin(user.id, activeSeason.id);
      } else if (eventType === "claim_mind_daily" || eventType === "stake_snapshot") {
        const value = Number(parsed.maybeValue);

        if (!Number.isFinite(value)) {
          await ctx.reply(`Event ${eventType} requires a numeric value for ${describeDynamicEventInput(eventType)}.`);
          return;
        }

        result = await processEvent(user.id, activeSeason.id, eventType, { value });
      } else if ((SUPPORTED_EVENT_TYPES as readonly string[]).includes(eventType)) {
        const txHash =
          parsed.maybeValue && !/^-?\d+(\.\d+)?$/.test(parsed.maybeValue) ? parsed.maybeValue : parsed.maybeTxHash;

        result = await processEvent(user.id, activeSeason.id, eventType, txHash ? { txHash } : undefined);
      } else {
        await ctx.reply("Unsupported event type. Use /admin_eventtypes.");
        return;
      }

      await ctx.reply(
        [
          "Admin event processed.",
          `User: ${user.username ? `@${user.username}` : user.telegramId.toString()}`,
          `Event: ${eventType}`,
          `Points Applied: ${result.points}`,
          `Season Total: ${result.totalPoints}`,
          `Current Rank: ${result.rank ? `#${result.rank}` : "unranked"}`
        ].join("\n")
      );
    } catch (error) {
      logger.warn({ error, telegramUserId: ctx.from.id }, "Admin event processing failed");
      await ctx.reply(error instanceof Error ? error.message : "Failed to process event.");
    }
  });

  bot.command("admin_eventtypes", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await replyUnauthorized((message) => ctx.reply(message));
      return;
    }

    await ctx.reply(
      [
        "Supported event types:",
        "wallet_registration -> /admin_event <user> wallet_registration [txHash]",
        "starter_rig_purchase -> /admin_event <user> starter_rig_purchase [txHash]",
        "pro_rig_purchase -> /admin_event <user> pro_rig_purchase [txHash]",
        "industrial_rig_purchase -> /admin_event <user> industrial_rig_purchase [txHash]",
        "starter_renewal -> /admin_event <user> starter_renewal [txHash]",
        "pro_renewal -> /admin_event <user> pro_renewal [txHash]",
        "industrial_renewal -> /admin_event <user> industrial_renewal [txHash]",
        "daily_active_starter -> /admin_event <user> daily_active_starter [txHash]",
        "daily_active_pro -> /admin_event <user> daily_active_pro [txHash]",
        "daily_active_industrial -> /admin_event <user> daily_active_industrial [txHash]",
        "claim_mind_daily -> /admin_event <user> claim_mind_daily <dailyClaimedMindTotal>",
        "stake_snapshot -> /admin_event <user> stake_snapshot <currentHighestStakeSnapshot>",
        "daily_checkin -> /admin_event <user> daily_checkin"
      ].join("\n")
    );
  });

  bot.command("admin_scanner_status", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await replyUnauthorized((message) => ctx.reply(message));
      return;
    }

    const status = getScannerStatus();

    await ctx.reply(
      [
        "Scanner status",
        `Enabled: ${status.enabled ? "true" : "false"}`,
        `Parser Confirmed: ${status.parserConfirmed ? "true" : "false"}`,
        `Parser: ${status.parserMessage}`,
        `RPC Host: ${status.rpcHost}`,
        `Program ID: ${status.programId}`,
        `IDL Path: ${status.idlPath ?? "not found"}`,
        `Last Scan: ${status.lastScanAt ? status.lastScanAt.toISOString() : "never"}`,
        `Recent Errors: ${
          status.recentErrors.length > 0
            ? status.recentErrors.map((entry) => `${entry.at.toISOString()} ${entry.wallet ?? "-"} ${entry.message}`).join(" | ")
            : "none"
        }`
      ].join("\n")
    );
  });

  bot.command("admin_scanner_once", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await replyUnauthorized((message) => ctx.reply(message));
      return;
    }

    try {
      const summary = await runScannerOnce();
      await ctx.reply(
        [
          "Scanner run finished.",
          `Season ID: ${summary.seasonId ?? "none"}`,
          `Wallets Scanned: ${summary.walletsScanned}`,
          `Events Detected: ${summary.eventsDetected}`,
          `Points Awarded: ${summary.pointsAwarded}`,
          `Clicker Top-ups Detected: ${summary.clickerTopUpsDetected}`,
          `Clicker Claims Settled: ${summary.clickerClaimsSettled}`,
          `Errors: ${summary.errors}`,
          `Message: ${summary.message}`
        ].join("\n")
      );
    } catch (error) {
      logger.warn({ error, telegramUserId: ctx.from.id }, "Admin scanner once failed");
      await ctx.reply(error instanceof Error ? error.message : "Failed to run scanner.");
    }
  });

  bot.command("admin_scan_wallet", async (ctx) => {
    if (!ctx.from || !isAdminTelegramUser(ctx.from.id)) {
      await replyUnauthorized((message) => ctx.reply(message));
      return;
    }

    const wallet = parseSingleArgumentCommand(ctx.message.text, "admin_scan_wallet");

    if (!wallet) {
      await ctx.reply("Usage: /admin_scan_wallet <wallet>");
      return;
    }

    try {
      const result = await scanWalletManually(wallet);
      await ctx.reply(
        [
          "Wallet scan finished.",
          `Wallet: ${result.wallet}`,
          `Parser Confirmed: ${result.parserConfirmed ? "true" : "false"}`,
          `Parser: ${result.parserMessage}`,
          `Applied To Season: ${result.applied ? "true" : "false"}`,
          `Events Detected: ${result.eventsDetected}`,
          `Points Awarded: ${result.pointsAwarded}`,
          `State: ${
            result.state
              ? `starter=${result.state.activeStarterCount}, pro=${result.state.activeProCount}, industrial=${result.state.activeIndustrialCount}, stake=${result.state.stakedMindAmount}`
              : "unavailable"
          }`,
          `Diagnostics: ${
            result.diagnostics.length > 0
              ? result.diagnostics
                  .slice(0, 5)
                  .map(
                    (entry) =>
                      `${entry.txHash.slice(0, 12)}... [${entry.instructionNames.join(",") || "-"}]${entry.reason ? ` ${entry.reason}` : ""}`
                  )
                  .join(" | ")
              : "none"
          }`
        ].join("\n")
      );
    } catch (error) {
      logger.warn({ error, telegramUserId: ctx.from.id, wallet }, "Admin scan wallet failed");
      await ctx.reply(error instanceof Error ? error.message : "Failed to scan wallet.");
    }
  });
}
