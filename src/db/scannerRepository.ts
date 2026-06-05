import { prisma } from "./prisma.js";

export async function getWalletScannerCursor(walletId: number) {
  return prisma.walletScannerCursor.findUnique({
    where: {
      walletId
    }
  });
}

export async function upsertWalletScannerCursor(params: {
  walletId: number;
  lastSlot?: number | null;
  snapshot?: unknown;
  scannedAt?: Date;
}) {
  return prisma.walletScannerCursor.upsert({
    where: {
      walletId: params.walletId
    },
    create: {
      walletId: params.walletId,
      lastSlot: params.lastSlot != null ? BigInt(params.lastSlot) : null,
      snapshot: params.snapshot as never,
      scannedAt: params.scannedAt ?? new Date()
    },
    update: {
      lastSlot: params.lastSlot != null ? BigInt(params.lastSlot) : null,
      snapshot: params.snapshot as never,
      scannedAt: params.scannedAt ?? new Date()
    }
  });
}
