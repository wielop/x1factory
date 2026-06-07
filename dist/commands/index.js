import { registerAdminBroadcastCommand } from "./adminBroadcast.js";
import { registerAdminSeasonCommands } from "./adminSeason.js";
import { registerAdminSetWalletCommand } from "./adminSetWallet.js";
import { registerAllTimeCommand } from "./alltime.js";
import { registerCheckinCommand } from "./checkin.js";
import { registerHelpCommand } from "./help.js";
import { registerLeaderboardCommand } from "./leaderboard.js";
import { registerMenuActions } from "./menu.js";
import { registerProfileCommand } from "./profile.js";
import { registerRegisterCommand } from "./register.js";
import { registerWalletTextHandler } from "./registerWalletText.js";
import { registerSeasonCommand } from "./season.js";
import { registerStartCommand } from "./start.js";
export function registerCommands(bot) {
    registerStartCommand(bot);
    registerHelpCommand(bot);
    registerCheckinCommand(bot);
    registerRegisterCommand(bot);
    registerProfileCommand(bot);
    registerSeasonCommand(bot);
    registerLeaderboardCommand(bot);
    registerAllTimeCommand(bot);
    registerMenuActions(bot);
    registerAdminSeasonCommands(bot);
    registerAdminBroadcastCommand(bot);
    registerAdminSetWalletCommand(bot);
    registerWalletTextHandler(bot);
}
