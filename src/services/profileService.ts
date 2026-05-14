import { prisma } from "../db/prisma.js";
import { getActiveOrUpcomingSeason, registerUserForSeason } from "../db/seasonRepository.js";
import { upsertTelegramUser } from "../db/userRepository.js";
import { assignActiveWalletToUser, getActiveWalletForUser } from "../db/walletRepository.js";
import { getMockProfileStats } from "./mockPointsService.js";

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

  const season = await getActiveOrUpcomingSeason();
  const registration = season
    ? await registerUserForSeason({
        userId: user.id,
        walletId: wallet.id,
        seasonId: season.id
      })
    : null;

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
      activeWallet: true
    }
  });

  if (!user) {
    return null;
  }

  const currentSeason = await getActiveOrUpcomingSeason();
  const mockStats = getMockProfileStats(user.telegramId);

  return {
    user,
    currentSeason,
    currentSeasonStats: {
      totalPoints: mockStats.currentSeasonPoints,
      rank: mockStats.currentRank
    },
    allTimePoints: mockStats.allTimePoints,
    badges: mockStats.badges,
    recentEvents: mockStats.recentEvents
  };
}
