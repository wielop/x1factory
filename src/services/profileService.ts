import { prisma } from "../db/prisma.js";
import { getActiveOrUpcomingSeason, registerUserForSeason } from "../db/seasonRepository.js";
import { upsertTelegramUser } from "../db/userRepository.js";
import { assignActiveWalletToUser, getActiveWalletForUser } from "../db/walletRepository.js";
import { formatEventCategory } from "./eventLabels.js";
import { processEvent } from "./pointsService.js";

export async function registerProfile(telegramUser: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
}) {
  return upsertTelegramUser({
    telegramId: BigInt(telegramUser.id),
    username: telegramUser.username,
    firstName: telegramUser.first_name,
    lastName: telegramUser.last_name,
    languageCode: telegramUser.language_code
  });
}

async function awardWalletRegistrationPoints(params: {
  userId: number;
  seasonId: number;
  walletAddress: string;
  registeredAt: Date;
}) {
  await processEvent(params.userId, params.seasonId, "wallet_registration", {
    txHash: `wallet-registration:${params.seasonId}:${params.walletAddress}`,
    eventOccurredAt: params.registeredAt.toISOString(),
    walletAddress: params.walletAddress
  });
}

export async function registerActiveWalletForCurrentSeason(params: {
  userId: number;
  walletId: number;
  walletAddress: string;
}) {
  const season = await getActiveOrUpcomingSeason();

  if (!season) {
    return {
      season: null,
      registration: null
    };
  }

  const registration = await registerUserForSeason({
    userId: params.userId,
    walletId: params.walletId,
    seasonId: season.id
  });

  await awardWalletRegistrationPoints({
    userId: params.userId,
    seasonId: season.id,
    walletAddress: params.walletAddress,
    registeredAt: registration.registeredAt
  });

  return {
    season,
    registration
  };
}

export async function registerWalletForTelegramUser(params: {
  telegramUser: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
    language_code?: string;
  };
  walletAddress: string;
  allowWalletChange?: boolean;
}) {
  const user = await registerProfile(params.telegramUser);
  const activeWallet = await getActiveWalletForUser(user.id);

  if (activeWallet && activeWallet.address !== params.walletAddress && !params.allowWalletChange) {
    throw new Error("Wallet already registered. Wallet changes require an admin command.");
  }

  const wallet = await assignActiveWalletToUser({
    userId: user.id,
    address: params.walletAddress,
    allowReassignment: params.allowWalletChange
  });

  const { season, registration } = await registerActiveWalletForCurrentSeason({
    userId: user.id,
    walletId: wallet.id,
    walletAddress: wallet.address
  });

  return {
    user,
    wallet,
    season,
    registration
  };
}

export async function getProfileWithStats(telegramId: number) {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    include: {
      activeWallet: true,
      userBadges: {
        include: {
          badge: true
        },
        orderBy: {
          awardedAt: "desc"
        },
        take: 5
      }
    }
  });

  if (!user) {
    return null;
  }

  const currentSeason = await getActiveOrUpcomingSeason();
  const currentSeasonStats = currentSeason
    ? await prisma.userSeasonStats.findUnique({
        where: {
          userId_seasonId: {
            userId: user.id,
            seasonId: currentSeason.id
          }
        }
      })
    : null;

  const allTimePointsResult = await prisma.seasonPoint.aggregate({
    where: {
      userId: user.id
    },
    _sum: {
      points: true
    }
  });

  const recentPoints = await prisma.seasonPoint.findMany({
    where: {
      userId: user.id
    },
    orderBy: {
      createdAt: "desc"
    },
    take: 5
  });

  return {
    user,
    currentSeason,
    currentSeasonStats,
    allTimePoints: allTimePointsResult._sum.points ?? 0,
    badges: user.userBadges.map((entry) => entry.badge.name),
    recentEvents: recentPoints.map((entry) => {
      const sign = entry.points >= 0 ? "+" : "";
      return `${sign}${entry.points} ${formatEventCategory(entry.category)}: ${entry.reason}`;
    })
  };
}
