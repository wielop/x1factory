import { prisma } from "./prisma.js";
export async function getWalletScannerCursor(walletId) {
    return prisma.walletScannerCursor.findUnique({
        where: {
            walletId
        }
    });
}
export async function upsertWalletScannerCursor(params) {
    return prisma.walletScannerCursor.upsert({
        where: {
            walletId: params.walletId
        },
        create: {
            walletId: params.walletId,
            lastSlot: params.lastSlot != null ? BigInt(params.lastSlot) : null,
            snapshot: params.snapshot,
            scannedAt: params.scannedAt ?? new Date()
        },
        update: {
            lastSlot: params.lastSlot != null ? BigInt(params.lastSlot) : null,
            snapshot: params.snapshot,
            scannedAt: params.scannedAt ?? new Date()
        }
    });
}
