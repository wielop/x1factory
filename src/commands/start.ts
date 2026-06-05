import type { BotContext, BotInstance } from "../bot/types.js";
import { Markup } from "telegraf";
import { env } from "../config/env.js";
import { factoryHeader, formatTestingNotice, mainMenuKeyboard } from "../bot/ui.js";
import { getCurrentSeason, getSeasonTestingNotice } from "../services/seasonService.js";

const REACTOR_RUSH_URL = "https://x1factory.xyz/telegrambot";

function getMiniAppUrl(): string {
  return env.miniAppUrl ?? REACTOR_RUSH_URL;
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

  await ctx.reply(
    [
      factoryHeader(),
      "",
      "Connect your wallet. Open the Mini App. Tap the reactor core.",
      "",
      "Your factory earns Factory XP from real X1Factory activity:",
      "- rig purchases",
      "- renewals",
      "- active rigs",
      "- MIND claims",
      "- MIND staking",
      "",
      "Reactor Rush turns daily taps into Hash, upgrades, boosts and Season Points.",
      "Use the button below to open the game inside Telegram.",
      ...formatTestingNotice(testingNotice)
    ].join("\n"),
    mainMenuKeyboard(getMiniAppUrl())
  );

  await ctx.reply(
    "Play the Mini App:",
    Markup.inlineKeyboard([
      Markup.button.webApp("Play Reactor Rush", getMiniAppUrl())
    ])
  );
}

export function registerStartCommand(bot: BotInstance): void {
  bot.start(showStart);
  bot.command("play", showPlay);
}
