let botInstance = null;
export function setBotNotifier(bot) {
    botInstance = bot;
}
export async function notifyTelegramUser(telegramUserId, message) {
    if (!botInstance) {
        return;
    }
    await botInstance.telegram.sendMessage(Number(telegramUserId), message);
}
