import type { BotContext, BotInstance } from "../bot/types.js";
import { FACTORY_XP, factoryHeader, mainMenuKeyboard } from "../bot/ui.js";

export async function showHowItWorks(ctx: BotContext): Promise<void> {
  const publicLines = [
    factoryHeader("HOW IT WORKS"),
    "",
    "1. Connect your wallet.",
    "2. Open the Season Panel to see your Miner's Passport.",
    "3. Earn Season Points from real X1Factory on-chain activity.",
    "",
    "You earn Season Points for:",
    "- buying rigs",
    "- renewing rigs",
    "- keeping rigs active",
    "- claiming MIND",
    "- growing your MIND stake",
    "",
    "Use the Season Panel to track your rank, badges and missions."
  ];

  await ctx.reply(
    [
      ...publicLines,
      "",
      `${FACTORY_XP} tracks your on-chain activity score.`
    ].join("\n"),
    mainMenuKeyboard()
  );
}

export function registerHelpCommand(bot: BotInstance): void {
  bot.help(async (ctx) => {
    await showHowItWorks(ctx);
  });
}
