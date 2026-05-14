import type { Telegraf } from "telegraf";
import type { Context } from "telegraf";

let botInstance: Telegraf<Context> | null = null;

export function setBotNotifier(bot: Telegraf<Context>): void {
  botInstance = bot;
}

export async function notifyTelegramUser(telegramUserId: bigint | number, message: string): Promise<void> {
  if (!botInstance) {
    return;
  }

  await botInstance.telegram.sendMessage(Number(telegramUserId), message);
}
