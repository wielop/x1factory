import type { BotContext, BotInstance } from "../bot/types.js";
import { FACTORY_XP, factoryHeader, mainMenuKeyboard } from "../bot/ui.js";
import { isAdminTelegramUser } from "./adminAuth.js";

export async function showHowItWorks(ctx: BotContext): Promise<void> {
  const publicLines = [
    factoryHeader("HOW IT WORKS"),
    "",
    "1. Connect your wallet.",
    "2. Open the Mini App or use the buttons in chat.",
    "3. Daily activity turns into Factory XP and claimable MIND.",
    "",
    "Factory Clicker:",
    "- tap the reactor core to build claimable MIND",
    "- top up the clicker wallet with XNT",
    "- claim MIND to your season wallet",
    "",
    "You earn Factory XP for:",
    "- buying rigs",
    "- renewing rigs",
    "- keeping rigs active",
    "- claiming MIND",
    "- growing your MIND stake",
    "",
    "Use the buttons below. No commands needed."
  ];

  const adminLines = [
    "",
    "Admin console:",
    "/admin_startseason - start a season",
    "/admin_endseason - end active season",
    "/admin_status - active season status",
    "/admin_addpoints - add manual points",
    "/admin_removepoints - remove manual points",
    "/admin_event - process an admin event",
    "/admin_eventtypes - list supported event types",
    "/admin_scanner_status - scanner status",
    "/admin_scanner_once - run scanner now",
    "/admin_scan_wallet - scan one wallet",
    "/admin_set_wallet - update a user's wallet",
    "/admin_broadcast - broadcast a message",
    "/admin_clicker_settle - settle a pending clicker claim"
  ];

  await ctx.reply(
    [
      ...publicLines,
      ...(ctx.from && isAdminTelegramUser(ctx.from.id) ? adminLines : []),
      "",
      `${FACTORY_XP} is game score, not a token balance.`
    ].join("\n"),
    mainMenuKeyboard()
  );
}

export function registerHelpCommand(bot: BotInstance): void {
  bot.help(async (ctx) => {
    await showHowItWorks(ctx);
  });
}
