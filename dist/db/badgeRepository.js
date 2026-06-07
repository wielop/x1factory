import { prisma } from "./prisma.js";
export async function upsertBadge(data) {
    return prisma.badge.upsert({
        where: { code: data.code },
        create: data,
        update: data
    });
}
export async function awardBadgeToUser(data) {
    return prisma.userBadge.create({
        data
    });
}
