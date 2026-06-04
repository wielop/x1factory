import type { BotInstance } from "../bot/types.js";
import { MENU_LABELS } from "../bot/ui.js";

import { showCancelClaim, showClaimMind, showClicker, showRunFactory } from "./clicker.js";
import { showHowItWorks } from "./help.js";
import { showLeaderboard } from "./leaderboard.js";
import { showProfile } from "./profile.js";
import { showConnectWallet } from "./register.js";
import { showSeason } from "./season.js";
import { showStart } from "./start.js";

export function registerMenuActions(bot: BotInstance): void {
  bot.hears(MENU_LABELS.factoryClicker, showClicker);
  bot.hears(MENU_LABELS.connectWallet, showConnectWallet);
  bot.hears(MENU_LABELS.myFactory, showProfile);
  bot.hears(MENU_LABELS.season, showSeason);
  bot.hears(MENU_LABELS.leaderboard, showLeaderboard);
  bot.hears(MENU_LABELS.howItWorks, showHowItWorks);
  bot.hears(MENU_LABELS.runFactory, showRunFactory);
  bot.hears(MENU_LABELS.claimMind, showClaimMind);
  bot.hears(MENU_LABELS.cancelClaim, showCancelClaim);
  bot.hears(MENU_LABELS.backToMenu, showStart);
  bot.hears("Menu", showStart);
}
