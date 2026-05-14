import { prisma } from "./prisma.js";

export async function getSeasonPointsTotalForUser(userId: number, seasonId: number): Promise<number> {
  const result = await prisma.seasonPoint.aggregate({
    where: {
      userId,
      seasonId
    },
    _sum: {
      points: true
    }
  });

  return result._sum.points ?? 0;
}

export async function getSeasonPointEventCountForUser(userId: number, seasonId: number): Promise<number> {
  return prisma.seasonPoint.count({
    where: {
      userId,
      seasonId
    }
  });
}
