import type { PointCategory } from "../config/points.js";
import { notifyTelegramUser } from "../bot/notifier.js";
import { prisma } from "../db/prisma.js";
import { recalculateUserSeasonStatsTx } from "../db/seasonRepository.js";
import { findUserById } from "../db/userRepository.js";

type AddSeasonPointsResult = {
  created: boolean;
  points: number;
  totalPoints: number;
  rank: number | null;
};

export async function addSeasonPoints(
  userId: number,
  seasonId: number,
  amount: number,
  category: PointCategory,
  reason: string,
  txHash?: string
): Promise<AddSeasonPointsResult> {
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
          occurredAt: new Date()
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
        source: txHash ? "EVENT" : "MANUAL"
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

  if (result.created) {
    await notifyTelegramUser(
      user.telegramId,
      [
        `You received ${amount} season points.`,
        `Category: ${category}`,
        `Reason: ${reason}`,
        `Season Total: ${result.totalPoints}`,
        `Current Rank: ${result.rank ? `#${result.rank}` : "unranked"}`
      ].join("\n")
    );
  }

  return result;
}
