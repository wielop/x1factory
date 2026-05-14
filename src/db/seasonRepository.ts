import type { Prisma, Season, SeasonRegistration, UserSeasonStats } from "@prisma/client";

import { prisma } from "./prisma.js";

function slugifySeasonName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function upsertSeason(data: Prisma.SeasonUncheckedCreateInput): Promise<Season> {
  return prisma.season.upsert({
    where: { slug: data.slug },
    create: data,
    update: data
  });
}

export async function getActiveSeason(): Promise<Season | null> {
  return prisma.season.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startsAt: "asc" }
  });
}

export async function getActiveOrUpcomingSeason(): Promise<Season | null> {
  const activeSeason = await getActiveSeason();

  if (activeSeason) {
    return activeSeason;
  }

  return prisma.season.findFirst({
    where: { status: "UPCOMING" },
    orderBy: { startsAt: "asc" }
  });
}

export async function getLatestSeason(): Promise<Season | null> {
  return prisma.season.findFirst({
    orderBy: [{ startsAt: "desc" }, { id: "desc" }]
  });
}

export async function startSeasonNow(params: { name: string; durationDays: number }): Promise<Season> {
  const activeSeason = await getActiveSeason();

  if (activeSeason) {
    throw new Error("An active season already exists.");
  }

  const now = new Date();
  const endsAt = new Date(now.getTime() + params.durationDays * 24 * 60 * 60 * 1000);
  const slugBase = slugifySeasonName(params.name);
  const slug = slugBase || `season-${now.getTime()}`;

  return prisma.season.create({
    data: {
      slug: `${slug}-${now.getTime()}`,
      name: params.name,
      status: "ACTIVE",
      startsAt: now,
      endsAt
    }
  });
}

export async function endActiveSeason(): Promise<Season> {
  const activeSeason = await getActiveSeason();

  if (!activeSeason) {
    throw new Error("No active season found.");
  }

  return prisma.season.update({
    where: { id: activeSeason.id },
    data: {
      status: "COMPLETED",
      endsAt: new Date()
    }
  });
}

export async function createSeasonAfterBreak(params: {
  durationDays: number;
  breakDays: number;
}): Promise<Season> {
  const activeSeason = await getActiveSeason();

  if (activeSeason) {
    throw new Error("End the active season before creating the next one.");
  }

  const latestSeason = await getLatestSeason();
  const baseStart = latestSeason?.endsAt ?? new Date();
  const startsAt = new Date(baseStart.getTime() + params.breakDays * 24 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + params.durationDays * 24 * 60 * 60 * 1000);
  const nextSeasonNumber = (latestSeason?.id ?? 0) + 1;
  const name = `Season ${nextSeasonNumber}`;
  const slug = `${slugifySeasonName(name)}-${startsAt.getTime()}`;

  return prisma.season.create({
    data: {
      slug,
      name,
      status: "UPCOMING",
      startsAt,
      endsAt
    }
  });
}

export async function registerUserForSeason(params: {
  userId: number;
  walletId: number;
  seasonId: number;
}): Promise<SeasonRegistration> {
  return prisma.seasonRegistration.upsert({
    where: {
      userId_seasonId: {
        userId: params.userId,
        seasonId: params.seasonId
      }
    },
    create: {
      userId: params.userId,
      walletId: params.walletId,
      seasonId: params.seasonId,
      status: "ACTIVE"
    },
    update: {
      walletId: params.walletId,
      status: "ACTIVE"
    }
  });
}

export async function getActiveSeasonRegistrationsWithWallets() {
  const activeSeason = await getActiveSeason();

  if (!activeSeason) {
    return {
      season: null,
      registrations: []
    };
  }

  const registrations = await prisma.seasonRegistration.findMany({
    where: {
      seasonId: activeSeason.id,
      status: "ACTIVE"
    },
    include: {
      user: true,
      wallet: true
    }
  });

  return {
    season: activeSeason,
    registrations
  };
}

export async function upsertUserSeasonStats(params: {
  userId: number;
  seasonId: number;
  totalPoints?: number;
  rank?: number | null;
  eventsCount?: number;
  badgesCount?: number;
  lastEventAt?: Date | null;
}): Promise<UserSeasonStats> {
  return prisma.userSeasonStats.upsert({
    where: {
      userId_seasonId: {
        userId: params.userId,
        seasonId: params.seasonId
      }
    },
    create: {
      userId: params.userId,
      seasonId: params.seasonId,
      totalPoints: params.totalPoints ?? 0,
      rank: params.rank ?? null,
      eventsCount: params.eventsCount ?? 0,
      badgesCount: params.badgesCount ?? 0,
      lastEventAt: params.lastEventAt ?? null
    },
    update: {
      totalPoints: params.totalPoints,
      rank: params.rank,
      eventsCount: params.eventsCount,
      badgesCount: params.badgesCount,
      lastEventAt: params.lastEventAt
    }
  });
}

export async function recalculateUserSeasonStats(userId: number, seasonId: number): Promise<UserSeasonStats> {
  return prisma.$transaction((tx) => recalculateUserSeasonStatsTx(tx, userId, seasonId));
}

export async function recalculateUserSeasonStatsTx(
  tx: Prisma.TransactionClient,
  userId: number,
  seasonId: number
): Promise<UserSeasonStats> {
  const [pointsAgg, eventCount, badgesCount] = await Promise.all([
    tx.seasonPoint.aggregate({
      where: {
        userId,
        seasonId
      },
      _sum: {
        points: true
      },
      _max: {
        createdAt: true
      }
    }),
    tx.seasonPoint.count({
      where: {
        userId,
        seasonId
      }
    }),
    tx.userBadge.count({
      where: {
        userId,
        seasonId
      }
    })
  ]);

  const totalPoints = pointsAgg._sum.points ?? 0;
  const lastEventAt = pointsAgg._max.createdAt ?? null;

  await tx.userSeasonStats.upsert({
    where: {
      userId_seasonId: {
        userId,
        seasonId
      }
    },
    create: {
      userId,
      seasonId,
      totalPoints,
      eventsCount: eventCount,
      badgesCount,
      lastEventAt
    },
    update: {
      totalPoints,
      eventsCount: eventCount,
      badgesCount,
      lastEventAt
    }
  });

  const leaderboard = await tx.userSeasonStats.findMany({
    where: {
      seasonId
    },
    orderBy: [
      { totalPoints: "desc" },
      { lastEventAt: "asc" },
      { userId: "asc" }
    ],
    select: {
      id: true
    }
  });

  await Promise.all(
    leaderboard.map((entry, index) =>
      tx.userSeasonStats.update({
        where: { id: entry.id },
        data: {
          rank: index + 1
        }
      })
    )
  );

  return tx.userSeasonStats.findUniqueOrThrow({
    where: {
      userId_seasonId: {
        userId,
        seasonId
      }
    }
  });
}
