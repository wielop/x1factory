import type { Prisma, User } from "@prisma/client";

import { prisma } from "./prisma.js";

export type TelegramUserPayload = {
  telegramId: bigint;
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
};

export async function upsertTelegramUser(payload: TelegramUserPayload): Promise<User> {
  const data: Prisma.UserUncheckedCreateInput = {
    telegramId: payload.telegramId,
    username: payload.username,
    firstName: payload.firstName,
    lastName: payload.lastName,
    languageCode: payload.languageCode,
    lastSeenAt: new Date()
  };

  return prisma.user.upsert({
    where: { telegramId: payload.telegramId },
    create: data,
    update: {
      username: payload.username,
      firstName: payload.firstName,
      lastName: payload.lastName,
      languageCode: payload.languageCode,
      lastSeenAt: new Date()
    }
  });
}

export async function findUserByTelegramId(telegramId: bigint): Promise<User | null> {
  return prisma.user.findUnique({
    where: { telegramId }
  });
}

export async function findUserById(userId: number): Promise<User | null> {
  return prisma.user.findUnique({
    where: { id: userId }
  });
}

export async function findUserWithWalletsByTelegramId(telegramId: bigint): Promise<User | null> {
  return prisma.user.findUnique({
    where: { telegramId },
    include: {
      activeWallet: true,
      wallets: true
    }
  });
}
