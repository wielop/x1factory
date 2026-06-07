import { env } from "../config/env.js";
export function isAdminTelegramUser(telegramUserId) {
    return env.adminIds.includes(telegramUserId);
}
export async function replyUnauthorized(reply) {
    await reply("Unauthorized");
}
