import { Keypair } from "@solana/web3.js";
import type {
  ClickerClaim,
  ClickerProfile,
  ClickerSession,
  Prisma,
  TreasuryConfig,
  User,
  Wallet
} from "@prisma/client";

import { prisma } from "../db/prisma.js";
import { getActiveOrUpcomingSeason } from "../db/seasonRepository.js";
import { getActiveWalletForUser } from "../db/walletRepository.js";
import { upsertTelegramUser } from "../db/userRepository.js";

const MICROS_PER_MIND = 1_000_000n;
const DEFAULT_REFERENCE_XNT_PER_MIND_MICRO = 75_000n;
const DEFAULT_CLAIM_BASE_XNT_PER_MIND_MICRO = 50_000n;
const TAPS_PER_MIND_BY_REACTOR_LEVEL = [20, 19, 18, 17, 16, 15, 14, 13, 12, 10] as const;
const DAILY_TAP_CAP_BY_FUEL_LEVEL = [40, 50, 60, 70, 80, 90, 100, 110, 120, 140] as const;
const CLAIM_XNT_PER_MIND_BY_LEVEL = [50_000n, 49_000n, 48_000n, 47_000n, 46_000n, 45_000n, 44_000n, 43_000n, 42_000n, 40_000n] as const;
const TAP_REWARD_BASE_MIND_MICRO = 50_000n;
const DEFAULT_DAILY_TAP_CAP = 40;
const DEFAULT_CLAIM_TIMEOUT_MINUTES = 10;
type PrismaTx = typeof prisma | Prisma.TransactionClient;

type TelegramUserPayload = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
};

type ClickerProfileRecord = ClickerProfile & {
  clickerWallet: Wallet | null;
};

type ClickerSessionRecord = ClickerSession & {
  clickerWallet: Wallet | null;
};

type ClickerClaimRecord = ClickerClaim & {
  wallet: Wallet;
  clickerWallet: Wallet;
};

export type ClickerDashboard = {
  user: User;
  payoutWallet: Wallet | null;
  clickerWallet: Wallet | null;
  seasonName: string | null;
  profile: ClickerProfileRecord | null;
  treasury: TreasuryConfig;
  pendingClaim: ClickerClaimRecord | null;
  todaySession: ClickerSessionRecord | null;
  dailyTapCap: number;
  tapsLeft: number;
  claimableMindMicro: bigint;
  referenceXntPerMindMicro: bigint;
  claimPricePerMindMicro: bigint;
  tapRewardMindMicro: bigint;
  operatorLevel: number;
  reactorCoreLevel: number;
  fuelCellLevel: number;
  claimTerminalLevel: number;
  stabilityModuleLevel: number;
  streakDays: number;
  nextReactorCostMind: bigint;
  nextFuelCostMind: bigint;
  nextClaimCostMind: bigint;
  nextStabilityCostMind: bigint;
  currentBoost: string | null;
  boostExpiresAt: Date | null;
};

export type ClickerActionResult = ClickerDashboard & {
  message: string;
};

export type ClickerSettlementResult = ClickerActionResult & {
  claimId: number;
  settledMindMicro: bigint;
  settledXntMicro: bigint;
  payoutTxHash: string | null;
  paymentTxHash: string | null;
};

function startOfUtcDay(input: Date): Date {
  return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
}

function isSameUtcDay(left: Date | null | undefined, right: Date): boolean {
  if (!left) {
    return false;
  }

  return startOfUtcDay(left).getTime() === startOfUtcDay(right).getTime();
}

function addUtcMinutes(input: Date, minutes: number): Date {
  return new Date(input.getTime() + minutes * 60 * 1000);
}

function formatUnits(value: bigint, decimals = 6): string {
  const negative = value < 0n;
  const absValue = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = absValue / scale;
  const fraction = absValue % scale;

  if (fraction === 0n) {
    return `${negative ? "-" : ""}${whole.toString()}`;
  }

  const trimmedFraction = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}.${trimmedFraction}`;
}

function formatMind(value: bigint): string {
  return formatUnits(value);
}

function formatXnt(value: bigint): string {
  return formatUnits(value);
}

function clampLevel(level: number | null | undefined): number {
  if (!level || level < 1) {
    return 1;
  }

  return Math.min(10, Math.floor(level));
}

function getLevelCost(level: number, costs: readonly bigint[]): bigint {
  return costs[clampLevel(level) - 1] ?? costs[0] ?? 0n;
}

function getReactorTapsPerMind(level: number): number {
  return TAPS_PER_MIND_BY_REACTOR_LEVEL[clampLevel(level) - 1] ?? TAPS_PER_MIND_BY_REACTOR_LEVEL[0];
}

function getFuelDailyTapCap(level: number): number {
  return DAILY_TAP_CAP_BY_FUEL_LEVEL[clampLevel(level) - 1] ?? DAILY_TAP_CAP_BY_FUEL_LEVEL[0];
}

function getClaimPricePerMindMicro(level: number): bigint {
  return CLAIM_XNT_PER_MIND_BY_LEVEL[clampLevel(level) - 1] ?? CLAIM_XNT_PER_MIND_BY_LEVEL[0];
}

function getStreakMultiplier(streakDays: number, stabilityLevel: number): number {
  let base = 1;

  if (streakDays >= 14) {
    base = 1.5;
  } else if (streakDays >= 7) {
    base = 1.25;
  } else if (streakDays >= 3) {
    base = 1.1;
  }

  const bonus = Math.min(0.25, Math.max(0, clampLevel(stabilityLevel) - 1) * 0.02);
  return base * (1 + bonus);
}

function getTapRewardMindMicro(profile: ClickerProfileRecord): bigint {
  const tapsPerMind = getReactorTapsPerMind(profile.reactorCoreLevel);
  const baseReward = Number(TAP_REWARD_BASE_MIND_MICRO) / tapsPerMind;
  const streakMultiplier = getStreakMultiplier(profile.streakDays, profile.stabilityModuleLevel);
  const reward = Math.max(1, Math.round(baseReward * streakMultiplier));
  return BigInt(reward);
}

function getNextStreakDays(profile: ClickerProfileRecord | null, now: Date): number {
  if (!profile?.lastTapAt) {
    return 1;
  }

  const today = startOfUtcDay(now).getTime();
  const lastDay = startOfUtcDay(profile.lastTapAt).getTime();
  const diffDays = Math.round((today - lastDay) / (24 * 60 * 60 * 1000));

  if (diffDays <= 0) {
    return Math.max(1, profile.streakDays);
  }

  if (diffDays === 1) {
    return Math.min(999, (profile.streakDays || 0) + 1);
  }

  return 1;
}

function getModuleSnapshot(profile: ClickerProfileRecord) {
  const reactorCoreLevel = clampLevel(profile.reactorCoreLevel);
  const fuelCellLevel = clampLevel(profile.fuelCellLevel);
  const claimTerminalLevel = clampLevel(profile.claimTerminalLevel);
  const stabilityModuleLevel = clampLevel(profile.stabilityModuleLevel);
  const currentTapCap = profile.dailyTapCap || getFuelDailyTapCap(fuelCellLevel);

  return {
    reactorCoreLevel,
    fuelCellLevel,
    claimTerminalLevel,
    stabilityModuleLevel,
    operatorLevel: Math.max(reactorCoreLevel, fuelCellLevel, claimTerminalLevel, stabilityModuleLevel),
    tapsPerMind: getReactorTapsPerMind(reactorCoreLevel),
    tapRewardMindMicro: getTapRewardMindMicro(profile),
    dailyTapCap: currentTapCap,
    claimPricePerMindMicro: getClaimPricePerMindMicro(claimTerminalLevel),
    nextReactorCostMind: getUpgradeCost("reactor", reactorCoreLevel),
    nextFuelCostMind: getUpgradeCost("fuel", fuelCellLevel),
    nextClaimCostMind: getUpgradeCost("claim", claimTerminalLevel),
    nextStabilityCostMind: getUpgradeCost("stability", stabilityModuleLevel),
    streakDays: profile.streakDays || 0
  };
}

function getUpgradeCost(module: ClickerUpgradeModule, currentLevel: number): bigint {
  const costsByModule: Record<ClickerUpgradeModule, readonly bigint[]> = {
    reactor: [0n, 25n, 50n, 90n, 150n, 240n, 360n, 520n, 740n, 1000n],
    fuel: [0n, 20n, 45n, 80n, 130n, 210n, 330n, 500n, 740n, 1100n],
    claim: [0n, 30n, 70n, 130n, 220n, 350n, 520n, 760n, 1080n, 1500n],
    stability: [0n, 25n, 60n, 110n, 180n, 280n, 420n, 620n, 900n, 1300n]
  };

  return getLevelCost(currentLevel + 1, costsByModule[module]);
}

function getUpgradeEffectLabel(module: ClickerUpgradeModule, nextLevel: number): string {
  const level = clampLevel(nextLevel);

  if (module === "reactor") {
    return `1 MIND per ${getReactorTapsPerMind(level)} taps`;
  }

  if (module === "fuel") {
    return `${getFuelDailyTapCap(level)} taps/day`;
  }

  if (module === "claim") {
    return `${formatUnits(getClaimPricePerMindMicro(level), 6)} XNT / MIND`;
  }

  const extra = Math.max(0, level - 1) * 2;
  return `+${extra}% streak bonus`;
}

export type ClickerUpgradeModule = "reactor" | "fuel" | "claim" | "stability";

function getUpgradeLabel(module: ClickerUpgradeModule): string {
  switch (module) {
    case "reactor":
      return "Reactor Core";
    case "fuel":
      return "Fuel Cell";
    case "claim":
      return "Claim Terminal";
    case "stability":
      return "Stability Module";
  }
}

export function formatClickerMicroAmount(value: bigint): string {
  return formatMind(value);
}

function shortWallet(address?: string | null): string {
  if (!address) {
    return "not set";
  }

  if (address.length <= 12) {
    return address;
  }

  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function getTapLimit(profile: ClickerProfileRecord | null, treasury: TreasuryConfig): number {
  if (profile) {
    return Math.max(profile.dailyTapCap ?? 0, getFuelDailyTapCap(profile.fuelCellLevel));
  }

  return treasury.dailyTapCap ?? DEFAULT_DAILY_TAP_CAP;
}

function getEffectiveTapsUsed(profile: ClickerProfileRecord | null, now: Date): number {
  if (!profile) {
    return 0;
  }

  return isSameUtcDay(profile.lastTapAt, now) ? profile.dailyTapsUsed : 0;
}

async function getTreasuryConfig(tx: PrismaTx = prisma): Promise<TreasuryConfig> {
  return tx.treasuryConfig.upsert({
    where: { id: 1 },
    create: {
      id: 1
    },
    update: {}
  });
}

async function generateClickerWallet(tx: PrismaTx, userId: number, seasonName: string): Promise<Wallet> {
  return tx.wallet.create({
    data: {
      address: Keypair.generate().publicKey.toBase58(),
      label: `Clicker Wallet // ${seasonName}`,
      userId,
      isActive: false
    }
  });
}

async function getOrCreateClickerProfile(params: {
  tx?: PrismaTx;
  userId: number;
  seasonId: number;
  seasonName: string;
  now: Date;
  dailyTapCap: number;
}): Promise<ClickerProfileRecord> {
  const tx = params.tx ?? prisma;
  const existing = await tx.clickerProfile.findUnique({
    where: {
      userId_seasonId: {
        userId: params.userId,
        seasonId: params.seasonId
      }
    },
    include: {
      clickerWallet: true
    }
  });

  if (!existing) {
    const clickerWallet = await generateClickerWallet(tx, params.userId, params.seasonName);

    return tx.clickerProfile.create({
      data: {
        userId: params.userId,
        seasonId: params.seasonId,
        clickerWalletId: clickerWallet.id,
        dailyTapCap: params.dailyTapCap
      },
      include: {
        clickerWallet: true
      }
    });
  }

  const clickerWallet = existing.clickerWallet ?? (await generateClickerWallet(tx, params.userId, params.seasonName));

  return tx.clickerProfile.update({
    where: {
      userId_seasonId: {
        userId: params.userId,
        seasonId: params.seasonId
      }
    },
    data: {
      clickerWalletId: clickerWallet.id,
      dailyTapCap: params.dailyTapCap,
      currentBoostType:
        existing.boostExpiresAt && existing.boostExpiresAt > params.now ? existing.currentBoostType : null,
      boostExpiresAt: existing.boostExpiresAt && existing.boostExpiresAt > params.now ? existing.boostExpiresAt : null
    },
    include: {
      clickerWallet: true
    }
  });
}

async function getPendingClaim(
  tx: PrismaTx = prisma,
  params: { userId: number; seasonId: number; now: Date }
): Promise<ClickerClaimRecord | null> {
  const expiredClaims = await tx.clickerClaim.findMany({
    where: {
      userId: params.userId,
      seasonId: params.seasonId,
      paymentStatus: "PENDING",
      expiresAt: {
        lte: params.now
      }
    }
  });

  if (expiredClaims.length > 0) {
    await tx.clickerClaim.updateMany({
      where: {
        id: {
          in: expiredClaims.map((claim) => claim.id)
        }
      },
      data: {
        paymentStatus: "EXPIRED"
      }
    });
  }

  return tx.clickerClaim.findFirst({
    where: {
      userId: params.userId,
      seasonId: params.seasonId,
      paymentStatus: "PENDING",
      expiresAt: {
        gt: params.now
      }
    },
    orderBy: {
      createdAt: "desc"
    },
    include: {
      wallet: true,
      clickerWallet: true
    }
  });
}

async function getTodaySession(
  tx: PrismaTx = prisma,
  params: { userId: number; seasonId: number; dayStart: Date }
): Promise<ClickerSessionRecord | null> {
  return tx.clickerSession.findUnique({
    where: {
      userId_seasonId_sessionDate: {
        userId: params.userId,
        seasonId: params.seasonId,
        sessionDate: params.dayStart
      }
    },
    include: {
      clickerWallet: true
    }
  });
}

function formatClaimPaidMessage(claim: ClickerClaimRecord): string {
  return [
    "Claim confirmed.",
    "",
    `${formatXnt(claim.xntRequiredMicro)} XNT received on the funding wallet.`,
    `${formatMind(claim.claimableMindMicro)} MIND sent to the registered payout wallet.`,
    "",
    "Factory output secured."
  ].join("\n");
}

async function settleClickerClaimById(params: {
  claimId: number;
  paymentTxHash?: string | null;
  payoutTxHash?: string | null;
}): Promise<ClickerSettlementResult> {
  const now = new Date();

  const pendingClaim = await prisma.clickerClaim.findUnique({
    where: {
      id: params.claimId
    },
    include: {
      wallet: true,
      clickerWallet: true
    }
  });

  if (!pendingClaim) {
    throw new Error("Claim not found.");
  }

  if (pendingClaim.paymentStatus !== "PENDING") {
    throw new Error("Claim is no longer pending.");
  }

  const result = await prisma.$transaction(async (tx) => {
    const treasury = await getTreasuryConfig(tx);
    const profile = await tx.clickerProfile.findUnique({
      where: {
        userId_seasonId: {
          userId: pendingClaim.userId,
          seasonId: pendingClaim.seasonId
        }
      }
    });

    if (!profile) {
      throw new Error("Clicker profile not found.");
    }

    if (profile.claimableMindMicro < pendingClaim.claimableMindMicro) {
      throw new Error("Claimable balance changed before settlement.");
    }

    const nextTreasuryBalance = treasury.mindTreasuryBalanceMicro - pendingClaim.claimableMindMicro;

    if (nextTreasuryBalance < treasury.mindReserveFloorMicro) {
      throw new Error("Treasury reserve would fall below the safety floor.");
    }

    const updatedTreasury = await tx.treasuryConfig.update({
      where: {
        id: treasury.id
      },
      data: {
        mindTreasuryBalanceMicro: {
          decrement: pendingClaim.claimableMindMicro
        },
        xntTreasuryBalanceMicro: {
          increment: pendingClaim.xntRequiredMicro
        }
      }
    });

    await tx.clickerProfile.update({
      where: {
        userId_seasonId: {
          userId: pendingClaim.userId,
          seasonId: pendingClaim.seasonId
        }
      },
      data: {
        claimableMindMicro: {
          decrement: pendingClaim.claimableMindMicro
        }
      }
    });

    const settledClaim = await tx.clickerClaim.update({
      where: {
        id: pendingClaim.id
      },
      data: {
        paymentStatus: "PAID",
        paymentTxHash: params.paymentTxHash ?? null,
        payoutTxHash: params.payoutTxHash ?? null,
        paidAt: now,
        claimedAt: now
      },
      include: {
        wallet: true,
        clickerWallet: true
      }
    });

    return {
      treasury: updatedTreasury,
      claim: settledClaim
    };
  });

  const dashboard = await resolveClickerContextForUserId(pendingClaim.userId);

  if (!dashboard) {
    throw new Error("Unable to resolve clicker dashboard.");
  }

  return {
    ...dashboard,
    pendingClaim: null,
    claimableMindMicro: dashboard.claimableMindMicro,
    message: formatClaimPaidMessage(result.claim),
    claimId: result.claim.id,
    settledMindMicro: result.claim.claimableMindMicro,
    settledXntMicro: result.claim.xntRequiredMicro,
    payoutTxHash: result.claim.payoutTxHash,
    paymentTxHash: result.claim.paymentTxHash
  };
}

async function resolveClickerContext(telegramUser: TelegramUserPayload): Promise<ClickerDashboard | null> {
  const user = await upsertTelegramUser({
    telegramId: BigInt(telegramUser.id),
    username: telegramUser.username,
    firstName: telegramUser.first_name,
    lastName: telegramUser.last_name,
    languageCode: telegramUser.language_code
  });

  const season = await getActiveOrUpcomingSeason();
  const treasury = await getTreasuryConfig();
  const payoutWallet = await getActiveWalletForUser(user.id);
  const now = new Date();

  if (!season) {
    return {
      user,
      payoutWallet,
      clickerWallet: null,
      seasonName: null,
      profile: null,
      treasury,
      pendingClaim: null,
      todaySession: null,
      dailyTapCap: getTapLimit(null, treasury),
      tapsLeft: getTapLimit(null, treasury),
      claimableMindMicro: 0n,
      referenceXntPerMindMicro: DEFAULT_REFERENCE_XNT_PER_MIND_MICRO,
      claimPricePerMindMicro: DEFAULT_CLAIM_BASE_XNT_PER_MIND_MICRO,
      tapRewardMindMicro: TAP_REWARD_BASE_MIND_MICRO,
      operatorLevel: 1,
      reactorCoreLevel: 1,
      fuelCellLevel: 1,
      claimTerminalLevel: 1,
      stabilityModuleLevel: 1,
      streakDays: 0,
      nextReactorCostMind: getUpgradeCost("reactor", 1),
      nextFuelCostMind: getUpgradeCost("fuel", 1),
      nextClaimCostMind: getUpgradeCost("claim", 1),
      nextStabilityCostMind: getUpgradeCost("stability", 1),
      currentBoost: null,
      boostExpiresAt: null
    };
  }

  if (!payoutWallet) {
    return {
      user,
      payoutWallet: null,
      clickerWallet: null,
      seasonName: season.name,
      profile: null,
      treasury,
      pendingClaim: null,
      todaySession: null,
      dailyTapCap: getTapLimit(null, treasury),
      tapsLeft: getTapLimit(null, treasury),
      claimableMindMicro: 0n,
      referenceXntPerMindMicro: DEFAULT_REFERENCE_XNT_PER_MIND_MICRO,
      claimPricePerMindMicro: DEFAULT_CLAIM_BASE_XNT_PER_MIND_MICRO,
      tapRewardMindMicro: TAP_REWARD_BASE_MIND_MICRO,
      operatorLevel: 1,
      reactorCoreLevel: 1,
      fuelCellLevel: 1,
      claimTerminalLevel: 1,
      stabilityModuleLevel: 1,
      streakDays: 0,
      nextReactorCostMind: getUpgradeCost("reactor", 1),
      nextFuelCostMind: getUpgradeCost("fuel", 1),
      nextClaimCostMind: getUpgradeCost("claim", 1),
      nextStabilityCostMind: getUpgradeCost("stability", 1),
      currentBoost: null,
      boostExpiresAt: null
    };
  }

  const profile = await getOrCreateClickerProfile({
    userId: user.id,
    seasonId: season.id,
    seasonName: season.name,
    now,
    dailyTapCap: treasury.dailyTapCap ?? DEFAULT_DAILY_TAP_CAP
  });

  const effectiveTapsUsed = getEffectiveTapsUsed(profile, now);
  const pendingClaim = await getPendingClaim(prisma, {
    userId: user.id,
    seasonId: season.id,
    now
  });
  const todaySession = await getTodaySession(prisma, {
    userId: user.id,
    seasonId: season.id,
    dayStart: startOfUtcDay(now)
  });

  return {
    user,
    payoutWallet,
    clickerWallet: profile.clickerWallet,
    seasonName: season.name,
    profile,
    treasury,
    pendingClaim,
    todaySession,
    tapsLeft: Math.max(0, getTapLimit(profile, treasury) - effectiveTapsUsed),
    claimableMindMicro: profile.claimableMindMicro,
    ...getModuleSnapshot(profile),
    referenceXntPerMindMicro: DEFAULT_REFERENCE_XNT_PER_MIND_MICRO,
    currentBoost: profile.currentBoostType,
    boostExpiresAt: profile.boostExpiresAt
  };
}

async function resolveClickerContextForUserId(userId: number): Promise<ClickerDashboard | null> {
  const user = await prisma.user.findUnique({
    where: {
      id: userId
    }
  });

  if (!user) {
    return null;
  }

  const season = await getActiveOrUpcomingSeason();
  const treasury = await getTreasuryConfig();
  const payoutWallet = await getActiveWalletForUser(user.id);
  const now = new Date();

  if (!season) {
    return {
      user,
      payoutWallet,
      clickerWallet: null,
      seasonName: null,
      profile: null,
      treasury,
      pendingClaim: null,
      todaySession: null,
      dailyTapCap: getTapLimit(null, treasury),
      tapsLeft: getTapLimit(null, treasury),
      claimableMindMicro: 0n,
      referenceXntPerMindMicro: DEFAULT_REFERENCE_XNT_PER_MIND_MICRO,
      claimPricePerMindMicro: DEFAULT_CLAIM_BASE_XNT_PER_MIND_MICRO,
      tapRewardMindMicro: TAP_REWARD_BASE_MIND_MICRO,
      operatorLevel: 1,
      reactorCoreLevel: 1,
      fuelCellLevel: 1,
      claimTerminalLevel: 1,
      stabilityModuleLevel: 1,
      streakDays: 0,
      nextReactorCostMind: getUpgradeCost("reactor", 1),
      nextFuelCostMind: getUpgradeCost("fuel", 1),
      nextClaimCostMind: getUpgradeCost("claim", 1),
      nextStabilityCostMind: getUpgradeCost("stability", 1),
      currentBoost: null,
      boostExpiresAt: null
    };
  }

  const profile = await getOrCreateClickerProfile({
    userId: user.id,
    seasonId: season.id,
    seasonName: season.name,
    now,
    dailyTapCap: treasury.dailyTapCap ?? DEFAULT_DAILY_TAP_CAP
  });

  const effectiveTapsUsed = getEffectiveTapsUsed(profile, now);
  const pendingClaim = await getPendingClaim(prisma, {
    userId: user.id,
    seasonId: season.id,
    now
  });
  const todaySession = await getTodaySession(prisma, {
    userId: user.id,
    seasonId: season.id,
    dayStart: startOfUtcDay(now)
  });

  return {
    user,
    payoutWallet,
    clickerWallet: profile.clickerWallet,
    seasonName: season.name,
    profile,
    treasury,
    pendingClaim,
    todaySession,
    tapsLeft: Math.max(0, getTapLimit(profile, treasury) - effectiveTapsUsed),
    claimableMindMicro: profile.claimableMindMicro,
    ...getModuleSnapshot(profile),
    referenceXntPerMindMicro: DEFAULT_REFERENCE_XNT_PER_MIND_MICRO,
    claimPricePerMindMicro: getModuleSnapshot(profile).claimPricePerMindMicro,
    currentBoost: profile.currentBoostType,
    boostExpiresAt: profile.boostExpiresAt
  };
}

function formatClaimStatus(claim: ClickerClaimRecord | null): string {
  if (!claim) {
    return "none";
  }

  if (claim.paymentStatus === "EXPIRED") {
    return "expired";
  }

  if (claim.paymentStatus === "CANCELLED") {
    return "cancelled";
  }

  return `pending ${formatMind(claim.claimableMindMicro)} MIND`;
}

function buildDashboardMessage(dashboard: ClickerDashboard): string {
  const claimStatus = formatClaimStatus(dashboard.pendingClaim);
  const seasonWallet = dashboard.payoutWallet ? shortWallet(dashboard.payoutWallet.address) : "connect first";
  const fundingWallet = dashboard.clickerWallet ? shortWallet(dashboard.clickerWallet.address) : "not created yet";
  const statusLine = dashboard.payoutWallet
    ? dashboard.pendingClaim?.paymentStatus === "PENDING"
      ? "Claim pending - top up the funding wallet"
      : "Reactor online - tap to build claimable MIND"
    : "Connect your season wallet to unlock the reactor";

  const lines: string[] = [
    "MIND FACTORY // FACTORY CLICKER",
    "",
    `Status: ${statusLine}`,
    `Season line: ${dashboard.seasonName ?? "not open yet"}`,
    `Season wallet: ${seasonWallet}`,
    `Funding wallet: ${fundingWallet}`,
    "",
    `Claimable MIND: ${formatMind(dashboard.claimableMindMicro)}`,
    `Tap budget: ${dashboard.tapsLeft}/${getTapLimit(dashboard.profile, dashboard.treasury)} left today`,
    `Operator level: ${dashboard.operatorLevel}`,
    `Reactor Core: ${dashboard.reactorCoreLevel} | Fuel Cell: ${dashboard.fuelCellLevel} | Claim Terminal: ${dashboard.claimTerminalLevel} | Stability: ${dashboard.stabilityModuleLevel}`,
    `Tap power: 1 MIND per ${dashboard.reactorCoreLevel ? getReactorTapsPerMind(dashboard.reactorCoreLevel) : 20} taps`,
    `Claim price: 1 MIND = ${formatXnt(dashboard.claimPricePerMindMicro)} XNT`,
    `Reference rate: 1 MIND = ${formatXnt(dashboard.referenceXntPerMindMicro)} XNT`,
    `Treasury reserve: ${formatMind(dashboard.treasury.mindTreasuryBalanceMicro)} MIND`,
    `Streak: ${dashboard.streakDays} days`,
    "",
    dashboard.clickerWallet
      ? "Top up the funding wallet with XNT. MIND still pays out to your registered season wallet."
      : "Connect your season wallet to generate a funding wallet.",
    ""
  ];

  if (dashboard.currentBoost) {
    lines.push(`Active boost: ${dashboard.currentBoost}`);
  }

  if (dashboard.boostExpiresAt) {
    lines.push(`Boost expires: ${dashboard.boostExpiresAt.toISOString()}`);
  }

  if (dashboard.pendingClaim?.paymentStatus === "PENDING") {
    lines.push(
      "",
      `Claim pending: ${formatMind(dashboard.pendingClaim.claimableMindMicro)} MIND`,
      `XNT needed: ${formatXnt(dashboard.pendingClaim.xntRequiredMicro)} XNT`,
      `Funding wallet: ${shortWallet(dashboard.pendingClaim.clickerWallet.address)}`,
      `Season wallet: ${shortWallet(dashboard.pendingClaim.wallet.address)}`
    );
  }

  return lines.join("\n");
}

export async function getClickerDashboard(telegramUser: TelegramUserPayload): Promise<ClickerDashboard> {
  const dashboard = await resolveClickerContext(telegramUser);

  if (!dashboard) {
    throw new Error("Unable to resolve clicker dashboard.");
  }

  return dashboard;
}

export async function runFactoryTap(telegramUser: TelegramUserPayload): Promise<ClickerActionResult> {
  const user = await upsertTelegramUser({
    telegramId: BigInt(telegramUser.id),
    username: telegramUser.username,
    firstName: telegramUser.first_name,
    lastName: telegramUser.last_name,
    languageCode: telegramUser.language_code
  });

  const season = await getActiveOrUpcomingSeason();

  if (!season) {
    throw new Error("No active season is open yet.");
  }

  const payoutWallet = await getActiveWalletForUser(user.id);

  if (!payoutWallet) {
    throw new Error("Connect your season wallet first.");
  }

  const treasury = await getTreasuryConfig();
  const now = new Date();

  const profile = await getOrCreateClickerProfile({
    userId: user.id,
    seasonId: season.id,
    seasonName: season.name,
    now,
    dailyTapCap: treasury.dailyTapCap ?? DEFAULT_DAILY_TAP_CAP
  });

  const effectiveTapsUsed = getEffectiveTapsUsed(profile, now);

  if (effectiveTapsUsed >= getTapLimit(profile, treasury)) {
    const dashboard = await resolveClickerContext(telegramUser);

    if (!dashboard) {
      throw new Error("Unable to resolve clicker dashboard.");
    }

    return {
      ...dashboard,
      message: "Daily tap limit reached."
    };
  }

  const sessionDay = startOfUtcDay(now);

  const result = await prisma.$transaction(async (tx) => {
    const updatedProfile = await tx.clickerProfile.update({
      where: {
        userId_seasonId: {
          userId: user.id,
          seasonId: season.id
        }
      },
      data: {
        clickerWalletId: profile.clickerWalletId ?? undefined,
        dailyTapCap: treasury.dailyTapCap ?? DEFAULT_DAILY_TAP_CAP,
        dailyTapsUsed: effectiveTapsUsed + 1,
        claimableMindMicro: {
          increment: getTapRewardMindMicro(profile)
        },
        lastTapAt: now,
        streakDays: getNextStreakDays(profile, now),
        currentBoostType:
          profile.boostExpiresAt && profile.boostExpiresAt > now ? profile.currentBoostType : null,
        boostExpiresAt: profile.boostExpiresAt && profile.boostExpiresAt > now ? profile.boostExpiresAt : null
      },
      include: {
        clickerWallet: true
      }
    });

    const session = await tx.clickerSession.upsert({
      where: {
        userId_seasonId_sessionDate: {
          userId: user.id,
          seasonId: season.id,
          sessionDate: sessionDay
        }
      },
      create: {
        userId: user.id,
        seasonId: season.id,
        clickerWalletId: updatedProfile.clickerWalletId,
        sessionDate: sessionDay,
        tapsUsed: 1,
        mindEarnedMicro: getTapRewardMindMicro(profile),
        xntSpentMicro: 0n,
        status: "ACTIVE"
      },
      update: {
        clickerWalletId: updatedProfile.clickerWalletId,
        tapsUsed: {
          increment: 1
        },
        mindEarnedMicro: {
          increment: getTapRewardMindMicro(profile)
        },
        status: "ACTIVE"
      },
      include: {
        clickerWallet: true
      }
    });

    return {
      profile: updatedProfile,
      session
    };
  });

  const dashboard = await resolveClickerContext(telegramUser);

  if (!dashboard) {
    throw new Error("Unable to resolve clicker dashboard.");
  }

  return {
    ...dashboard,
    profile: result.profile,
    todaySession: result.session,
    tapsLeft: Math.max(0, getTapLimit(result.profile, treasury) - result.profile.dailyTapsUsed),
    claimableMindMicro: result.profile.claimableMindMicro,
    message: `Factory line active. +${formatMind(getTapRewardMindMicro(profile))} MIND added to your claimable balance.`
  };
}

export async function createClaimCheckout(telegramUser: TelegramUserPayload): Promise<ClickerActionResult> {
  const user = await upsertTelegramUser({
    telegramId: BigInt(telegramUser.id),
    username: telegramUser.username,
    firstName: telegramUser.first_name,
    lastName: telegramUser.last_name,
    languageCode: telegramUser.language_code
  });

  const season = await getActiveOrUpcomingSeason();

  if (!season) {
    throw new Error("No active season is open yet.");
  }

  const payoutWallet = await getActiveWalletForUser(user.id);

  if (!payoutWallet) {
    throw new Error("Connect your season wallet first.");
  }

  const treasury = await getTreasuryConfig();
  const now = new Date();
  const profile = await getOrCreateClickerProfile({
    userId: user.id,
    seasonId: season.id,
    seasonName: season.name,
    now,
    dailyTapCap: treasury.dailyTapCap ?? DEFAULT_DAILY_TAP_CAP
  });
  const pendingClaim = await getPendingClaim(prisma, {
    userId: user.id,
    seasonId: season.id,
    now
  });

  if (pendingClaim) {
    const dashboard = await resolveClickerContext(telegramUser);

    if (!dashboard) {
      throw new Error("Unable to resolve clicker dashboard.");
    }

    return {
      ...dashboard,
      message: "You already have a pending claim."
    };
  }

  if (!profile.clickerWallet) {
    throw new Error("Clicker wallet has not been created yet.");
  }

  if (profile.claimableMindMicro < treasury.minimumClaimMindMicro) {
    throw new Error(`Minimum claim is ${formatMind(treasury.minimumClaimMindMicro)} MIND.`);
  }

  const claimPricePerMindMicro = getClaimPricePerMindMicro(profile.claimTerminalLevel);
  const xntRequiredMicro = (profile.claimableMindMicro * claimPricePerMindMicro + MICROS_PER_MIND - 1n) / MICROS_PER_MIND;
  const expiresAt = addUtcMinutes(now, treasury.claimTimeoutMinutes ?? DEFAULT_CLAIM_TIMEOUT_MINUTES);

  const claim = await prisma.clickerClaim.create({
    data: {
      userId: user.id,
      walletId: payoutWallet.id,
      clickerWalletId: profile.clickerWallet.id,
      seasonId: season.id,
      claimableMindMicro: profile.claimableMindMicro,
      xntRequiredMicro,
      paymentStatus: "PENDING",
      expiresAt
    },
    include: {
      wallet: true,
      clickerWallet: true
    }
  });

  const dashboard = await resolveClickerContext(telegramUser);

  if (!dashboard) {
    throw new Error("Unable to resolve clicker dashboard.");
  }

  return {
    ...dashboard,
    pendingClaim: claim,
    message: `MIND ready to claim. Top up the clicker wallet with ${formatXnt(claim.xntRequiredMicro)} XNT.`
  };
}

export async function cancelPendingClaim(telegramUser: TelegramUserPayload): Promise<ClickerActionResult> {
  const user = await upsertTelegramUser({
    telegramId: BigInt(telegramUser.id),
    username: telegramUser.username,
    firstName: telegramUser.first_name,
    lastName: telegramUser.last_name,
    languageCode: telegramUser.language_code
  });

  const season = await getActiveOrUpcomingSeason();

  if (!season) {
    throw new Error("No active season is open yet.");
  }

  const pendingClaim = await getPendingClaim(prisma, {
    userId: user.id,
    seasonId: season.id,
    now: new Date()
  });

  if (!pendingClaim) {
    const dashboard = await resolveClickerContext(telegramUser);

    if (!dashboard) {
      throw new Error("Unable to resolve clicker dashboard.");
    }

    return {
      ...dashboard,
      message: "No pending claim to cancel."
    };
  }

  await prisma.clickerClaim.update({
    where: {
      id: pendingClaim.id
    },
    data: {
      paymentStatus: "CANCELLED",
      cancelledAt: new Date()
    }
  });

  const dashboard = await resolveClickerContext(telegramUser);

  if (!dashboard) {
    throw new Error("Unable to resolve clicker dashboard.");
  }

  return {
    ...dashboard,
    message: "Pending claim cancelled."
  };
}

export async function upgradeClickerModule(params: {
  telegramUser: TelegramUserPayload;
  module: ClickerUpgradeModule;
}): Promise<ClickerActionResult> {
  const user = await upsertTelegramUser({
    telegramId: BigInt(params.telegramUser.id),
    username: params.telegramUser.username,
    firstName: params.telegramUser.first_name,
    lastName: params.telegramUser.last_name,
    languageCode: params.telegramUser.language_code
  });

  const season = await getActiveOrUpcomingSeason();

  if (!season) {
    throw new Error("No active season is open yet.");
  }

  const treasury = await getTreasuryConfig();
  const now = new Date();
  const profile = await getOrCreateClickerProfile({
    userId: user.id,
    seasonId: season.id,
    seasonName: season.name,
    now,
    dailyTapCap: treasury.dailyTapCap ?? DEFAULT_DAILY_TAP_CAP
  });
  const snapshot = getModuleSnapshot(profile);
  const currentLevel =
    params.module === "reactor"
      ? snapshot.reactorCoreLevel
      : params.module === "fuel"
        ? snapshot.fuelCellLevel
        : params.module === "claim"
          ? snapshot.claimTerminalLevel
          : snapshot.stabilityModuleLevel;

  if (currentLevel >= 10) {
    const dashboard = await resolveClickerContext(params.telegramUser);

    if (!dashboard) {
      throw new Error("Unable to resolve clicker dashboard.");
    }

    return {
      ...dashboard,
      message: `${getUpgradeLabel(params.module)} is already at the max level.`
    };
  }

  const costMindMicro = getUpgradeCost(params.module, currentLevel);

  if (profile.claimableMindMicro < costMindMicro) {
    throw new Error(`Need ${formatMind(costMindMicro)} MIND to upgrade ${getUpgradeLabel(params.module)}.`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const nextLevel = currentLevel + 1;
    const updates: Prisma.ClickerProfileUpdateInput = {
      claimableMindMicro: {
        decrement: costMindMicro
      }
    };

    if (params.module === "reactor") {
      updates.reactorCoreLevel = nextLevel;
    } else if (params.module === "fuel") {
      updates.fuelCellLevel = nextLevel;
      updates.dailyTapCap = getFuelDailyTapCap(nextLevel);
    } else if (params.module === "claim") {
      updates.claimTerminalLevel = nextLevel;
    } else {
      updates.stabilityModuleLevel = nextLevel;
    }

    const updatedProfile = await tx.clickerProfile.update({
      where: {
        userId_seasonId: {
          userId: user.id,
          seasonId: season.id
        }
      },
      data: updates,
      include: {
        clickerWallet: true
      }
    });

    return updatedProfile;
  });

  const dashboard = await resolveClickerContext(params.telegramUser);

  if (!dashboard) {
    throw new Error("Unable to resolve clicker dashboard.");
  }

  const nextLevel = currentLevel + 1;

  return {
    ...dashboard,
    profile: updated,
    claimableMindMicro: updated.claimableMindMicro,
    tapsLeft: Math.max(0, getTapLimit(updated, treasury) - getEffectiveTapsUsed(updated, now)),
    message: `${getUpgradeLabel(params.module)} upgraded to level ${nextLevel}. ${getUpgradeEffectLabel(params.module, nextLevel)} unlocked.`
  };
}

export async function settlePendingClickerClaim(params: {
  userId: number;
  paymentTxHash?: string | null;
  payoutTxHash?: string | null;
}): Promise<ClickerSettlementResult> {
  const season = await getActiveOrUpcomingSeason();

  if (!season) {
    throw new Error("No active season is open yet.");
  }

  const now = new Date();
  const pendingClaim = await getPendingClaim(prisma, {
    userId: params.userId,
    seasonId: season.id,
    now
  });

  if (!pendingClaim) {
    throw new Error("No pending claim found for this user.");
  }

  return settleClickerClaimById({
    claimId: pendingClaim.id,
    paymentTxHash: params.paymentTxHash,
    payoutTxHash: params.payoutTxHash
  });
}

export async function settlePendingClickerClaimById(params: {
  claimId: number;
  paymentTxHash?: string | null;
  payoutTxHash?: string | null;
}): Promise<ClickerSettlementResult> {
  return settleClickerClaimById(params);
}

export function renderClickerScreen(dashboard: ClickerDashboard): string {
  return buildDashboardMessage(dashboard);
}
