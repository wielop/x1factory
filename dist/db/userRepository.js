import { prisma } from "./prisma.js";
export async function upsertTelegramUser(payload) {
    const data = {
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
export async function findUserByTelegramId(telegramId) {
    return prisma.user.findUnique({
        where: { telegramId }
    });
}
export async function findUserByUsername(username) {
    const normalizedUsername = username.replace(/^@/, "").trim();
    if (!normalizedUsername) {
        return null;
    }
    return prisma.user.findFirst({
        where: {
            username: {
                equals: normalizedUsername,
                mode: "insensitive"
            }
        }
    });
}
export async function findUserById(userId) {
    return prisma.user.findUnique({
        where: { id: userId }
    });
}
export async function findUserWithWalletsByTelegramId(telegramId) {
    return prisma.user.findUnique({
        where: { telegramId },
        include: {
            activeWallet: true,
            wallets: true
        }
    });
}
