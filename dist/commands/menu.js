import { MENU_LABELS } from "../bot/ui.js";
import { showHowItWorks } from "./help.js";
import { showConnectWallet } from "./register.js";
import { showStart } from "./start.js";
export function registerMenuActions(bot) {
    bot.hears(MENU_LABELS.connectWallet, showConnectWallet);
    bot.hears(MENU_LABELS.howItWorks, showHowItWorks);
    bot.hears("Menu", showStart);
}
