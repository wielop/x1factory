import {
  CLAIM_MIND_DAILY_CAP,
  CLAIM_MIND_DAILY_THRESHOLDS,
  FIXED_EVENT_TYPES,
  POINT_VALUES,
  STAKE_THRESHOLDS,
  STREAK_BONUSES,
  type SupportedEventType
} from "../config/points.js";
import type { Prisma } from "@prisma/client";
import { notifyTelegramUser } from "../bot/notifier.js";
import { FACTORY_XP, factoryHeader } from "../bot/ui.js";
import { prisma } from "../db/prisma.js";
import { recalculateUserSeasonStatsTx } from "../db/seasonRepository.js";
import { findUserById } from "../db/userRepository.js";
import { formatEventCategory } from "./eventLabels.js";

type PointsMetadata = Record<string, unknown>;

type AddPointsResult = {
  created: boolean;
  points: number;
  totalPoints: number;
  rank: number | null;
};

function formatMindAmount(amount: number): string {
  return amount.toFixed(9).replace(/\.?0+$/, "");
}

function startOfUtcDay(input: Date): Date {
  return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
}

function addUtcDays(input: Date, days: number): Date {
  return new Date(input.getTime() + days * 24 * 60 * 60 * 1000);
}

function normalizeDate(input?: string | Date): Date {
  if (!input) {
    return new Date();
  }

  return input instanceof Date ? input : new Date(input);
}

function parseMetadataDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  return null;
}

function resolvePointOccurredAt(metadata?: PointsMetadata): Date {
  return (
    parseMetadataDate(metadata?.eventOccurredAt) ??
    parseMetadataDate(metadata?.blockTime) ??
    parseMetadataDate(metadata?.claimDate) ??
    parseMetadataDate(metadata?.checkinDate) ??
    (typeof metadata?.activeDay === "string" ? parseMetadataDate(`${metadata.activeDay}T00:00:00.000Z`) : null) ??
    new Date()
  );
}

function getClaimPointsForAmount(amount: number): number {
  for (const threshold of CLAIM_MIND_DAILY_THRESHOLDS) {
    if (amount >= threshold.minAmount) {
      return threshold.points;
    }
  }

  return 0;
}

function getNextClaimThreshold(amount: number): (typeof CLAIM_MIND_DAILY_THRESHOLDS)[number] | null {
  const ascending = [...CLAIM_MIND_DAILY_THRESHOLDS].sort((left, right) => left.minAmount - right.minAmount);
  return ascending.find((threshold) => amount < threshold.minAmount) ?? null;
}

function getStakeThresholdForAmount(amount: number): (typeof STAKE_THRESHOLDS)[number] | null {
  for (const threshold of STAKE_THRESHOLDS) {
    if (amount >= threshold.minAmount) {
      return threshold;
    }
  }

  return null;
}

function getNextStakeThreshold(amount: number): (typeof STAKE_THRESHOLDS)[number] | null {
  const ascending = [...STAKE_THRESHOLDS].sort((left, right) => left.minAmount - right.minAmount);
  return ascending.find((threshold) => amount < threshold.minAmount) ?? null;
}

export async function addPoints(
  userId: number,
  seasonId: number,
  amount: number,
  category: string,
  reason: string,
  metadata?: PointsMetadata
): Promise<AddPointsResult> {
  const txHash = typeof metadata?.txHash === "string" ? metadata.txHash : undefined;
  return addSeasonPoints(userId, seasonId, amount, category, reason, txHash, metadata);
}

export async function addSeasonPoints(
  userId: number,
  seasonId: number,
  amount: number,
  category: string,
  reason: string,
  txHash?: string,
  metadata?: PointsMetadata
): Promise<AddPointsResult> {
  const suppressDefaultNotification = metadata?.suppressDefaultNotification === true;
  const occurredAt = resolvePointOccurredAt(metadata);

  if (amount < 0 && category !== "manual_admin_correction") {
    throw new Error("Negative points are not allowed for this category.");
  }

  if (amount === 0) {
    const existingStats = await prisma.userSeasonStats.findUnique({
      where: {
        userId_seasonId: {
          userId,
          seasonId
        }
      }
    });

    return {
      created: false,
      points: 0,
      totalPoints: existingStats?.totalPoints ?? 0,
      rank: existingStats?.rank ?? null
    };
  }

  const user = await findUserById(userId);

  if (!user) {
    throw new Error("User not found.");
  }

  const result = await prisma.$transaction(async (tx) => {
    const fullUser = await tx.user.findUnique({
      where: { id: userId },
      include: {
        activeWallet: true
      }
    });

    if (!fullUser) {
      throw new Error("User not found.");
    }

    let detectedEventId: number | null = null;
    let walletId: number | null = fullUser.activeWalletId ?? null;

    if (txHash) {
      if (!fullUser.activeWallet) {
        throw new Error("Active wallet required for tx-based point events.");
      }

      const existingEvent = await tx.detectedEvent.findUnique({
        where: {
          txHash_eventType_walletId: {
            txHash,
            eventType: category,
            walletId: fullUser.activeWallet.id
          }
        }
      });

      if (existingEvent) {
        const existingPoint = await tx.seasonPoint.findFirst({
          where: {
            detectedEventId: existingEvent.id
          }
        });

        const existingStats = await tx.userSeasonStats.findUnique({
          where: {
            userId_seasonId: {
              userId,
              seasonId
            }
          }
        });

        return {
          created: false,
          points: existingPoint?.points ?? 0,
          totalPoints: existingStats?.totalPoints ?? 0,
          rank: existingStats?.rank ?? null
        };
      }

      const event = await tx.detectedEvent.create({
        data: {
          txHash,
          eventType: category,
          walletId: fullUser.activeWallet.id,
          seasonId,
          occurredAt,
          rawData: metadata as Prisma.InputJsonValue | undefined
        }
      });

      detectedEventId = event.id;
      walletId = fullUser.activeWallet.id;
    }

    await tx.seasonPoint.create({
      data: {
        userId,
        seasonId,
        walletId,
        detectedEventId,
        points: amount,
        category,
        reason,
        metadata: metadata as Prisma.InputJsonValue | undefined,
        source: txHash ? "EVENT" : "MANUAL",
        createdAt: occurredAt
      }
    });

    const updatedStats = await recalculateUserSeasonStatsTx(tx, userId, seasonId);

    return {
      created: true,
      points: amount,
      totalPoints: updatedStats.totalPoints,
      rank: updatedStats.rank
    };
  });

  if (result.created && !suppressDefaultNotification) {
    await notifyTelegramUser(
      user.telegramId,
      [
        factoryHeader("PRODUCTION LOG"),
        "",
        amount >= 0 ? `Factory output: +${amount} ${FACTORY_XP}` : `Factory correction: -${Math.abs(amount)} ${FACTORY_XP}`,
        `Source: ${formatEventCategory(category)}`,
        `Why: ${reason}`,
        "",
        `Season total: ${result.totalPoints} ${FACTORY_XP}`,
        `Operator rank: ${result.rank ? `#${result.rank}` : "unranked"}`
      ].join("\n")
    );
  }

  return result;
}

export async function processEvent(
  userId: number,
  seasonId: number,
  eventType: SupportedEventType,
  metadata?: PointsMetadata
): Promise<AddPointsResult> {
  if ((FIXED_EVENT_TYPES as readonly string[]).includes(eventType)) {
    const amount = POINT_VALUES[eventType as keyof typeof POINT_VALUES];
    return addPoints(userId, seasonId, amount, eventType, formatEventCategory(eventType), metadata);
  }

  if (eventType === "claim_mind_daily") {
    const claimedMindAmount = Number(metadata?.value ?? metadata?.claimedMindAmount);
    const date = metadata?.date instanceof Date || typeof metadata?.date === "string" ? metadata.date : undefined;
    return processDailyClaim(userId, seasonId, claimedMindAmount, date);
  }

  if (eventType === "stake_snapshot") {
    const stakedMindAmount = Number(metadata?.value ?? metadata?.stakedMindAmount);
    return processStakeSnapshot(userId, seasonId, stakedMindAmount);
  }

  throw new Error(`Unsupported event type: ${eventType}`);
}

export async function processDailyClaim(
  userId: number,
  seasonId: number,
  claimedMindAmount: number,
  date?: string | Date,
  claimIncrementAmount?: number
): Promise<AddPointsResult> {
  if (!Number.isFinite(claimedMindAmount) || claimedMindAmount < 0) {
    throw new Error("claimedMindAmount must be a non-negative number.");
  }

  const normalizedDate = normalizeDate(date);
  const dayStart = startOfUtcDay(normalizedDate);
  const dayEnd = addUtcDays(dayStart, 1);
  const targetPoints = Math.min(getClaimPointsForAmount(claimedMindAmount), CLAIM_MIND_DAILY_CAP);

  const existingPoints = await prisma.seasonPoint.aggregate({
    where: {
      userId,
      seasonId,
      category: "claim_mind_daily",
      createdAt: {
        gte: dayStart,
        lt: dayEnd
      }
    },
    _sum: {
      points: true
    }
  });

  const alreadyAwarded = existingPoints._sum.points ?? 0;
  const pointsToAward = Math.max(0, targetPoints - alreadyAwarded);

  const result = await addPoints(userId, seasonId, pointsToAward, "claim_mind_daily", `Daily MIND claim total ${claimedMindAmount}`, {
    claimDate: dayStart.toISOString(),
    claimedMindAmount,
    claimIncrementAmount,
    suppressDefaultNotification: true
  });

  const user = await findUserById(userId);

  if (user) {
    const nextThreshold = getNextClaimThreshold(claimedMindAmount);
    const progressLines = [
      factoryHeader("MIND CLAIM"),
      "",
      "Your claim line updated.",
      ...(typeof claimIncrementAmount === "number" ? [`Last claim: ${formatMindAmount(claimIncrementAmount)} MIND`] : []),
      `Today produced: ${formatMindAmount(claimedMindAmount)} MIND`,
      `Daily claim value: ${targetPoints} ${FACTORY_XP}`
    ];

    if (result.points > 0) {
      progressLines.push(`Factory output: +${result.points} ${FACTORY_XP}`);
    } else {
      progressLines.push(`Factory output: +0 ${FACTORY_XP}`);
    }

    if (nextThreshold) {
      progressLines.push(
        "",
        `Next MIND crate: ${formatMindAmount(nextThreshold.minAmount)} MIND`,
        `Missing: ${formatMindAmount(nextThreshold.minAmount - claimedMindAmount)} MIND`
      );
    } else {
      progressLines.push("", "Highest daily MIND crate reached.");
    }

    progressLines.push("", `Season total: ${result.totalPoints} ${FACTORY_XP}`, `Operator rank: ${result.rank ? `#${result.rank}` : "unranked"}`);

    await notifyTelegramUser(user.telegramId, progressLines.join("\n"));
  }

  return result;
}

export async function processStakeSnapshot(
  userId: number,
  seasonId: number,
  stakedMindAmount: number,
  actualStakedMindAmount = stakedMindAmount,
  stakeBaselineAmount = 0
): Promise<AddPointsResult> {
  if (!Number.isFinite(stakedMindAmount) || stakedMindAmount < 0) {
    throw new Error("stakedMindAmount must be a non-negative number.");
  }

  const reachedThreshold = getStakeThresholdForAmount(stakedMindAmount);
  const targetPoints = reachedThreshold?.points ?? 0;
  const existingPoints = await prisma.seasonPoint.aggregate({
    where: {
      userId,
      seasonId,
      category: "stake_snapshot"
    },
    _sum: {
      points: true
    }
  });

  const alreadyAwarded = existingPoints._sum.points ?? 0;
  const pointsToAward = Math.max(0, targetPoints - alreadyAwarded);

  const result = await addPoints(
    userId,
    seasonId,
    pointsToAward,
    "stake_snapshot",
    reachedThreshold
      ? `Stake milestone ${reachedThreshold.minAmount} reached with eligible snapshot ${stakedMindAmount}`
      : `Stake snapshot ${stakedMindAmount}`,
    {
      stakedMindAmount,
      actualStakedMindAmount,
      stakeBaselineAmount,
      stakeMilestoneMinAmount: reachedThreshold?.minAmount ?? null,
      stakeMilestoneTargetPoints: targetPoints,
      suppressDefaultNotification: true
    }
  );

  const user = await findUserById(userId);

  if (user) {
    const nextThreshold = getNextStakeThreshold(stakedMindAmount);
    const progressLines = [
      factoryHeader("STAKE ENGINE"),
      "",
      "Your stake engine updated.",
      `Total staked: ${formatMindAmount(actualStakedMindAmount)} MIND`,
      `Season baseline: ${formatMindAmount(stakeBaselineAmount)} MIND`,
      `Season growth: ${formatMindAmount(stakedMindAmount)} MIND`,
      `Milestone value: ${targetPoints} ${FACTORY_XP}`
    ];

    if (result.points > 0) {
      progressLines.push(`Factory output: +${result.points} ${FACTORY_XP}`);
    } else {
      progressLines.push(`Factory output: +0 ${FACTORY_XP}`);
    }

    if (reachedThreshold) {
      progressLines.push(`Milestone reached: ${formatMindAmount(reachedThreshold.minAmount)} MIND`);
    }

    if (nextThreshold) {
      progressLines.push(
        "",
        `Next stake crate: ${formatMindAmount(nextThreshold.minAmount)} MIND`,
        `Missing: ${formatMindAmount(nextThreshold.minAmount - stakedMindAmount)} MIND`
      );
    } else {
      progressLines.push("", "Highest stake crate reached.");
    }

    progressLines.push("", `Season total: ${result.totalPoints} ${FACTORY_XP}`, `Operator rank: ${result.rank ? `#${result.rank}` : "unranked"}`);

    await notifyTelegramUser(user.telegramId, progressLines.join("\n"));
  }

  return result;
}

export async function processDailyCheckin(
  userId: number,
  seasonId: number,
  date?: string | Date
): Promise<AddPointsResult> {
  const normalizedDate = normalizeDate(date);
  const dayStart = startOfUtcDay(normalizedDate);
  const dayEnd = addUtcDays(dayStart, 1);

  const existingCheckin = await prisma.seasonPoint.findFirst({
    where: {
      userId,
      seasonId,
      category: "daily_checkin",
      createdAt: {
        gte: dayStart,
        lt: dayEnd
      }
    }
  });

  if (existingCheckin) {
    const existingStats = await prisma.userSeasonStats.findUnique({
      where: {
        userId_seasonId: {
          userId,
          seasonId
        }
      }
    });

    return {
      created: false,
      points: 0,
      totalPoints: existingStats?.totalPoints ?? 0,
      rank: existingStats?.rank ?? null
    };
  }

  const checkinResult = await addPoints(userId, seasonId, POINT_VALUES.daily_checkin, "daily_checkin", "Daily check-in", {
    checkinDate: dayStart.toISOString()
  });

  const allCheckins = await prisma.seasonPoint.findMany({
    where: {
      userId,
      seasonId,
      category: "daily_checkin"
    },
    orderBy: {
      createdAt: "asc"
    },
    select: {
      createdAt: true
    }
  });

  const checkinDays = new Set(allCheckins.map((entry) => startOfUtcDay(entry.createdAt).toISOString()));
  let streakLength = 0;
  let cursor = dayStart;

  while (checkinDays.has(cursor.toISOString())) {
    streakLength += 1;
    cursor = addUtcDays(cursor, -1);
  }

  const streakBonus = STREAK_BONUSES.find((entry) => entry.days === streakLength);

  if (!streakBonus) {
    return checkinResult;
  }

  await addPoints(
    userId,
    seasonId,
    streakBonus.points,
    `streak_bonus_${streakBonus.days}_day`,
    `${streakBonus.days}-day streak bonus`,
    {
      checkinDate: dayStart.toISOString(),
      streakLength
    }
  );

  const refreshedStats = await prisma.userSeasonStats.findUnique({
    where: {
      userId_seasonId: {
        userId,
        seasonId
      }
    }
  });

  return {
    created: true,
    points: checkinResult.points + streakBonus.points,
    totalPoints: refreshedStats?.totalPoints ?? checkinResult.totalPoints,
    rank: refreshedStats?.rank ?? checkinResult.rank
  };
}
