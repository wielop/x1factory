import { env } from "../config/env.js";

export function isAdminTelegramUser(telegramUserId: number): boolean {
  return env.adminIds.includes(telegramUserId);
}
