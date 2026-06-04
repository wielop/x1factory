import type { BotInstance } from "../bot/types.js";

import { registerAdminBroadcastCommand } from "./adminBroadcast.js";
import { registerAdminClickerCommands } from "./adminClicker.js";
import { registerAdminSeasonCommands } from "./adminSeason.js";
import { registerAdminSetWalletCommand } from "./adminSetWallet.js";
import { registerClickerCommand } from "./clicker.js";
import { registerAllTimeCommand } from "./alltime.js";
import { registerHelpCommand } from "./help.js";
import { registerLeaderboardCommand } from "./leaderboard.js";
import { registerMenuActions } from "./menu.js";
import { registerProfileCommand } from "./profile.js";
import { registerRegisterCommand } from "./register.js";
import { registerWalletTextHandler } from "./registerWalletText.js";
import { registerSeasonCommand } from "./season.js";
import { registerStartCommand } from "./start.js";

export function registerCommands(bot: BotInstance): void {
  registerStartCommand(bot);
  registerHelpCommand(bot);
  registerRegisterCommand(bot);
  registerProfileCommand(bot);
  registerSeasonCommand(bot);
  registerLeaderboardCommand(bot);
  registerAllTimeCommand(bot);
  registerClickerCommand(bot);
  registerMenuActions(bot);
  registerAdminSeasonCommands(bot);
  registerAdminBroadcastCommand(bot);
  registerAdminClickerCommands(bot);
  registerAdminSetWalletCommand(bot);
  registerWalletTextHandler(bot);
}
