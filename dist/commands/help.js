import { FACTORY_XP, factoryHeader, mainMenuKeyboard } from "../bot/ui.js";
import { isAdminTelegramUser } from "./adminAuth.js";
export async function showHowItWorks(ctx) {
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
        "/admin_broadcast - broadcast a message"
    ];
    await ctx.reply([
        ...publicLines,
        ...(ctx.from && isAdminTelegramUser(ctx.from.id) ? adminLines : []),
        "",
        `${FACTORY_XP} tracks your on-chain activity score.`
    ].join("\n"), mainMenuKeyboard());
}
export function registerHelpCommand(bot) {
    bot.help(async (ctx) => {
        await showHowItWorks(ctx);
    });
}
