import { prisma } from "../db/prisma.js";
import { getCurrentSeason } from "./seasonService.js";

export type LeaderboardEntry = {
  rank: number;
  telegramId: bigint;
  username: string;
  points: number;
};

function getDisplayUsername(user: { username: string | null; telegramId: bigint }) {
  return user.username ?? user.telegramId.toString();
}

function isTestingSeasonName(name: string): boolean {
  return /^season 0\b/i.test(name.trim());
}

export async function getSeasonLeaderboard(limit = 8): Promise<LeaderboardEntry[]> {
  const season = await getCurrentSeason();

  if (!season) {
    return [];
  }

  const stats = await prisma.userSeasonStats.findMany({
    where: {
      seasonId: season.id
    },
    include: {
      user: true
    },
    orderBy: [
      { rank: "asc" },
      { totalPoints: "desc" },
      { userId: "asc" }
    ],
    take: limit
  });

  return stats.map((entry, index) => ({
    rank: entry.rank ?? index + 1,
    telegramId: entry.user.telegramId,
    username: getDisplayUsername(entry.user),
    points: entry.totalPoints
  }));
}

export async function getAllTimeLeaderboard(limit = 8): Promise<LeaderboardEntry[]> {
  const testingSeasons = await prisma.season.findMany({
    select: {
      id: true,
      name: true
    }
  });
  const excludedSeasonIds = testingSeasons.filter((season) => isTestingSeasonName(season.name)).map((season) => season.id);
  const users = await prisma.user.findMany({
    include: {
      seasonPoints: {
        where: excludedSeasonIds.length > 0 ? { seasonId: { notIn: excludedSeasonIds } } : undefined,
        select: {
          points: true
        }
      }
    }
  });

  return users
    .map((user) => ({
      telegramId: user.telegramId,
      username: getDisplayUsername(user),
      points: user.seasonPoints.reduce((sum, entry) => sum + entry.points, 0)
    }))
    .filter((entry) => entry.points !== 0)
    .sort((a, b) => b.points - a.points || a.username.localeCompare(b.username))
    .slice(0, limit)
    .map((entry, index) => ({
      rank: index + 1,
      telegramId: entry.telegramId,
      username: entry.username,
      points: entry.points
    }));
}
