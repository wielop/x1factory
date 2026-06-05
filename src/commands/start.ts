import type { BotContext, BotInstance } from "../bot/types.js";
import { env } from "../config/env.js";
import { factoryHeader, formatTestingNotice, mainMenuKeyboard } from "../bot/ui.js";
import { getCurrentSeason, getSeasonTestingNotice } from "../services/seasonService.js";

const PANEL_URL = "https://x1factory.xyz/panel";

function getPanelUrl(): string {
  return env.miniAppUrl ?? PANEL_URL;
}

export async function showStart(ctx: BotContext): Promise<void> {
  const season = await getCurrentSeason();
  const testingNotice = getSeasonTestingNotice(season?.name);

  await ctx.reply(
    [
      factoryHeader(),
      "",
      "Track your Season Points from real X1Factory on-chain activity:",
      "- rig purchases & renewals",
      "- daily check-ins",
      "- MIND staking",
      "",
      "Open the Season Panel to see your Miner's Passport, rankings and missions.",
      ...formatTestingNotice(testingNotice)
    ].join("\n"),
    mainMenuKeyboard(getPanelUrl())
  );
}

export function registerStartCommand(bot: BotInstance): void {
  bot.start(showStart);
}
