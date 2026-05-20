import { env } from "../config/env.js";

export function isAdminTelegramUser(telegramUserId: number): boolean {
  return env.adminIds.includes(telegramUserId);
}

export async function replyUnauthorized(reply: (message: string) => Promise<unknown>) {
  await reply("Unauthorized");
}
