import { prisma } from "../db/prisma.js";
import {
  endActiveSeason,
  getActiveOrUpcomingSeason,
  getActiveSeason,
  startSeasonNow
} from "../db/seasonRepository.js";

const SEASON_DURATION_DAYS = 21;
const BREAK_DURATION_DAYS = 7;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

export function getSeasonTestingNotice(seasonName?: string | null): string | null {
  if (!seasonName) {
    return null;
  }

  if (!/^season 0\b/i.test(seasonName.trim())) {
    return null;
  }

  return "Season 0 is for testing only. Season 1 starts from zero.";
}

function startOfUtcDay(input: Date): Date {
  return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
}

function formatDurationParts(milliseconds: number): string {
  if (milliseconds <= 0) {
    return "ended";
  }

  const totalMinutes = Math.floor(milliseconds / (1000 * 60));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  return `${days}d ${hours}h ${minutes}m`;
}

export async function getSeasonOverview() {
  const season = await getActiveOrUpcomingSeason();

  if (!season) {
    return null;
  }

  const now = new Date();
  const todayStart = startOfUtcDay(now);

  const [registeredMiners, activeMinersToday, totalPointsDistributed] = await Promise.all([
    prisma.seasonRegistration.count({
      where: {
        seasonId: season.id,
        status: "ACTIVE"
      }
    }),
    prisma.detectedEvent.findMany({
      where: {
        seasonId: season.id,
        occurredAt: {
          gte: todayStart
        }
      },
      distinct: ["walletId"],
      select: {
        walletId: true
      }
    }),
    prisma.seasonPoint.aggregate({
      where: {
        seasonId: season.id
      },
      _sum: {
        points: true
      }
    })
  ]);

  const dayNumber =
    season.status === "ACTIVE"
      ? Math.max(1, Math.floor((now.getTime() - season.startsAt.getTime()) / DAY_IN_MS) + 1)
      : 0;

  const timeLeft =
    season.status === "ACTIVE"
      ? formatDurationParts(season.endsAt.getTime() - now.getTime())
      : `starts in ${formatDurationParts(season.startsAt.getTime() - now.getTime())}`;

  return {
    season,
    dayNumber,
    timeLeft,
    registeredMiners,
    activeMinersToday: activeMinersToday.length,
    totalPointsDistributed: totalPointsDistributed._sum.points ?? 0,
    defaults: {
      seasonDurationDays: SEASON_DURATION_DAYS,
      breakDurationDays: BREAK_DURATION_DAYS
    }
  };
}

export async function adminStartSeason(name: string) {
  return startSeasonNow({
    name,
    durationDays: SEASON_DURATION_DAYS
  });
}

export async function adminEndSeason() {
  return endActiveSeason();
}

export async function getCurrentSeason() {
  return getActiveSeason();
}

export async function getAdminSeasonStatus() {
  const activeSeason = await getActiveSeason();

  if (!activeSeason) {
    return null;
  }

  const [registeredUsers, totalPointsResult, topUsers] = await Promise.all([
    prisma.seasonRegistration.count({
      where: {
        seasonId: activeSeason.id,
        status: "ACTIVE"
      }
    }),
    prisma.seasonPoint.aggregate({
      where: {
        seasonId: activeSeason.id
      },
      _sum: {
        points: true
      }
    }),
    prisma.userSeasonStats.findMany({
      where: {
        seasonId: activeSeason.id
      },
      orderBy: [
        { rank: "asc" },
        { totalPoints: "desc" }
      ],
      take: 5,
      include: {
        user: true
      }
    })
  ]);

  return {
    season: activeSeason,
    registeredUsers,
    totalPoints: totalPointsResult._sum.points ?? 0,
    topUsers
  };
}
