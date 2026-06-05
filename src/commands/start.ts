import type { BotContext, BotInstance } from "../bot/types.js";
import { Markup } from "telegraf";
import { env } from "../config/env.js";
import { factoryHeader, formatTestingNotice, mainMenuKeyboard } from "../bot/ui.js";
import { getCurrentSeason, getSeasonTestingNotice } from "../services/seasonService.js";

const PANEL_URL = "https://x1factory.xyz/panel";

function getMiniAppUrl(): string {
  return env.miniAppUrl ?? PANEL_URL;
}

export async function showPlay(ctx: BotContext): Promise<void> {
  await ctx.reply(
    "Open X1Factory Reactor Rush inside Telegram.",
    Markup.inlineKeyboard([
      Markup.button.webApp("Play Reactor Rush", getMiniAppUrl())
    ])
  );
}

export async function showStart(ctx: BotContext): Promise<void> {
  const season = await getCurrentSeason();
  const testingNotice = getSeasonTestingNotice(season?.name);
  const seasonLine = season ? `${season.name} is live.` : "No active season at the moment.";

  await ctx.reply(
    [
      factoryHeader(),
      "",
      seasonLine,
      "",
      "Earn Season Points from your X1Factory on-chain activity:",
      "— rig purchases & renewals",
      "— daily active rigs",
      "— MIND claims & staking",
      "",
      "Connect your Solana wallet to start tracking.",
      "Check your rank on the leaderboard and follow your progress in the Season Panel.",
      ...formatTestingNotice(testingNotice)
    ].join("\n"),
    mainMenuKeyboard(getMiniAppUrl())
  );

}

export function registerStartCommand(bot: BotInstance): void {
  bot.start(showStart);
  bot.command("play", showPlay);
}
