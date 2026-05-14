import type { Badge, Prisma, UserBadge } from "@prisma/client";

import { prisma } from "./prisma.js";

export async function upsertBadge(data: Prisma.BadgeUncheckedCreateInput): Promise<Badge> {
  return prisma.badge.upsert({
    where: { code: data.code },
    create: data,
    update: data
  });
}

export async function awardBadgeToUser(data: Prisma.UserBadgeUncheckedCreateInput): Promise<UserBadge> {
  return prisma.userBadge.create({
    data
  });
}
