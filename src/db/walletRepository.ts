import type { Wallet } from "@prisma/client";

import { prisma } from "./prisma.js";

export async function findWalletByAddress(address: string): Promise<Wallet | null> {
  return prisma.wallet.findUnique({
    where: { address }
  });
}

export async function getActiveWalletForUser(userId: number): Promise<Wallet | null> {
  return prisma.wallet.findFirst({
    where: {
      userId,
      isActive: true
    }
  });
}

export async function getWalletWithOwnerByAddress(address: string) {
  return prisma.wallet.findUnique({
    where: { address },
    include: {
      user: true
    }
  });
}

export async function assignActiveWalletToUser(params: {
  userId: number;
  address: string;
  label?: string;
  allowReassignment?: boolean;
}): Promise<Wallet> {
  return prisma.$transaction(async (tx) => {
    const existingWallet = await tx.wallet.findUnique({
      where: { address: params.address }
    });

    if (
      existingWallet?.userId &&
      existingWallet.userId !== params.userId &&
      !params.allowReassignment
    ) {
      throw new Error("Wallet is already registered to another user.");
    }

    const wallet = await tx.wallet.upsert({
      where: { address: params.address },
      create: {
        address: params.address,
        label: params.label,
        userId: params.userId,
        isActive: true
      },
      update: {
        label: params.label,
        userId: params.userId,
        isActive: true
      }
    });

    await tx.wallet.updateMany({
      where: {
        userId: params.userId,
        NOT: { id: wallet.id }
      },
      data: {
        isActive: false
      }
    });

    await tx.user.update({
      where: { id: params.userId },
      data: {
        activeWalletId: wallet.id
      }
    });

    return wallet;
  });
}
