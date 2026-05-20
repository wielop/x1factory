import type { ClickerBoost, ClickerProfile, ClickerUpgrade, ReactorEnergyBalance, Season, User } from "@prisma/client";

import { prisma } from "../db/prisma.js";
import { getActiveSeason } from "../db/seasonRepository.js";
import { upsertTelegramUser } from "../db/userRepository.js";
import { addPoints } from "./pointsService.js";

type TelegramUserPayload = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
};

type UpgradeType = "pickaxe" | "passive_rig" | "battery";
type BoostType = "energy_refill" | "turbo_1h" | "auto_miner_24h" | "storage_12h" | "season_boost_24h";

const MAX_DAILY_CLICKS = 500;
const MINE_COOLDOWN_MS = 1000;
const ENERGY_REGEN_MS = 3 * 60 * 1000;
const BASE_ENERGY_CAP = 100;
const BASE_HASH_PER_CLICK = 1;
const BASE_STORAGE_HOURS = 4;

const PICKAXE_LEVELS = [
  { level: 1, cost: 0n, hashPerClick: 1 },
  { level: 2, cost: 500n, hashPerClick: 2 },
  { level: 3, cost: 1500n, hashPerClick: 3 },
  { level: 4, cost: 4000n, hashPerClick: 5 },
  { level: 5, cost: 10000n, hashPerClick: 8 }
] as const;

const PASSIVE_RIG_LEVELS = [
  { level: 0, cost: 0n, passiveHashPerHour: 0 },
  { level: 1, cost: 1000n, passiveHashPerHour: 20 },
  { level: 2, cost: 3000n, passiveHashPerHour: 60 },
  { level: 3, cost: 8000n, passiveHashPerHour: 150 },
  { level: 4, cost: 20000n, passiveHashPerHour: 400 }
] as const;

const BATTERY_LEVELS = [
  { level: 1, cost: 0n, energyCap: 100 },
  { level: 2, cost: 2000n, energyCap: 150 },
  { level: 3, cost: 7000n, energyCap: 250 },
  { level: 4, cost: 15000n, energyCap: 400 }
] as const;

const BOOSTS: Record<BoostType, { cost: number; label: string; durationMs?: number; multiplier?: number }> = {
  energy_refill: { cost: 50, label: "Energy Refill" },
  turbo_1h: { cost: 100, label: "Turbo 1h", durationMs: 60 * 60 * 1000, multiplier: 2 },
  auto_miner_24h: { cost: 300, label: "Auto Miner 24h", durationMs: 24 * 60 * 60 * 1000 },
  storage_12h: { cost: 500, label: "Storage 12h", durationMs: 7 * 24 * 60 * 60 * 1000 },
  season_boost_24h: { cost: 700, label: "Season Boost 24h", durationMs: 24 * 60 * 60 * 1000, multiplier: 1.2 }
};

export type HashRushDashboard = {
  user: User;
  season: Season;
  profile: ClickerProfile;
  upgrades: ClickerUpgrade[];
  activeBoosts: ClickerBoost[];
  energyBalance: ReactorEnergyBalance;
  rank: number | null;
  totalSeasonPoints: number;
  effectivePassiveHashPerHour: number;
  effectiveStorageHours: number;
  effectiveMineMultiplier: number;
};

export type HashRushActionResult = HashRushDashboard & {
  message: string;
  seasonPointsAwarded?: number;
};

function startOfUtcDay(input: Date): Date {
  return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
}

function addMs(input: Date, ms: number): Date {
  return new Date(input.getTime() + ms);
}

function formatHp(value: bigint): string {
  return value.toLocaleString("en-US");
}

function isUniqueError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function getUpgradeLevel(upgrades: ClickerUpgrade[], type: UpgradeType): number {
  return upgrades.find((upgrade) => upgrade.upgradeType === type)?.level ?? (type === "passive_rig" ? 0 : 1);
}

function getPickaxe(level: number) {
  return PICKAXE_LEVELS.find((entry) => entry.level === level) ?? PICKAXE_LEVELS[0];
}

function getPassiveRig(level: number) {
  return PASSIVE_RIG_LEVELS.find((entry) => entry.level === level) ?? PASSIVE_RIG_LEVELS[0];
}

function getBattery(level: number) {
  return BATTERY_LEVELS.find((entry) => entry.level === level) ?? BATTERY_LEVELS[0];
}

function getNextUpgrade(type: UpgradeType, currentLevel: number) {
  if (type === "pickaxe") {
    return PICKAXE_LEVELS.find((entry) => entry.level === currentLevel + 1) ?? null;
  }

  if (type === "passive_rig") {
    return PASSIVE_RIG_LEVELS.find((entry) => entry.level === currentLevel + 1) ?? null;
  }

  return BATTERY_LEVELS.find((entry) => entry.level === currentLevel + 1) ?? null;
}

function activeBoostsWhere(now: Date) {
  return {
    expiresAt: {
      gt: now
    }
  };
}

function hasBoost(boosts: ClickerBoost[], boostType: BoostType): boolean {
  return boosts.some((boost) => boost.boostType === boostType);
}

function getMineMultiplier(boosts: ClickerBoost[]): number {
  return hasBoost(boosts, "turbo_1h") ? 2 : 1;
}

function getEffectivePassiveHashPerHour(profile: ClickerProfile, boosts: ClickerBoost[]): number {
  return profile.passiveHashPerHour + (hasBoost(boosts, "auto_miner_24h") ? 100 : 0);
}

function getEffectiveStorageHours(profile: ClickerProfile, boosts: ClickerBoost[]): number {
  return hasBoost(boosts, "storage_12h") ? Math.max(profile.storageHours, 12) : profile.storageHours;
}

function getSeasonPointsAmount(basePoints: number, boosts: ClickerBoost[]): number {
  return hasBoost(boosts, "season_boost_24h") ? Math.floor(basePoints * 1.2) : basePoints;
}

async function getRegisteredActiveSeason(userId: number): Promise<Season> {
  const season = await getActiveSeason();

  if (!season) {
    throw new Error("No active season found.");
  }

  const registration = await prisma.seasonRegistration.findUnique({
    where: {
      userId_seasonId: {
        userId,
        seasonId: season.id
      }
    }
  });

  if (!registration || registration.status !== "ACTIVE") {
    throw new Error("Register your wallet in the active season before playing Hash Rush.");
  }

  return season;
}

async function upsertHashRushUser(from: TelegramUserPayload): Promise<User> {
  return upsertTelegramUser({
    telegramId: BigInt(from.id),
    username: from.username,
    firstName: from.first_name,
    lastName: from.last_name,
    languageCode: from.language_code
  });
}

async function ensureProfile(userId: number, seasonId: number, now: Date): Promise<ClickerProfile> {
  return prisma.clickerProfile.upsert({
    where: {
      userId_seasonId: {
        userId,
        seasonId
      }
    },
    create: {
      userId,
      seasonId,
      hashPoints: 0n,
      totalHashPoints: 0n,
      energy: BASE_ENERGY_CAP,
      energyCap: BASE_ENERGY_CAP,
      hashPerClick: BASE_HASH_PER_CLICK,
      passiveHashPerHour: 0,
      storageHours: BASE_STORAGE_HOURS,
      lastCollectedAt: now,
      lastEnergyAt: now,
      dailyClicks: 0,
      dailyClicksDate: startOfUtcDay(now),
      factoryLevel: 1
    },
    update: {}
  });
}

async function ensureEnergyBalance(userId: number, seasonId: number): Promise<ReactorEnergyBalance> {
  return prisma.reactorEnergyBalance.upsert({
    where: {
      userId_seasonId: {
        userId,
        seasonId
      }
    },
    create: {
      userId,
      seasonId
    },
    update: {}
  });
}

async function refreshEnergy(profile: ClickerProfile, now: Date): Promise<ClickerProfile> {
  const lastEnergyAt = profile.lastEnergyAt ?? profile.updatedAt ?? now;
  const regenerated = Math.floor((now.getTime() - lastEnergyAt.getTime()) / ENERGY_REGEN_MS);

  if (regenerated <= 0) {
    return profile;
  }

  const energy = Math.min(profile.energyCap, profile.energy + regenerated);
  const lastEnergyAtNext = addMs(lastEnergyAt, regenerated * ENERGY_REGEN_MS);

  return prisma.clickerProfile.update({
    where: { id: profile.id },
    data: {
      energy,
      lastEnergyAt: energy >= profile.energyCap ? now : lastEnergyAtNext
    }
  });
}

async function resetDailyClicksIfNeeded(profile: ClickerProfile, now: Date): Promise<ClickerProfile> {
  const today = startOfUtcDay(now);

  if (profile.dailyClicksDate?.getTime() === today.getTime()) {
    return profile;
  }

  return prisma.clickerProfile.update({
    where: { id: profile.id },
    data: {
      dailyClicks: 0,
      dailyClicksDate: today
    }
  });
}

async function loadDashboard(user: User, season: Season, now = new Date()): Promise<HashRushDashboard> {
  let profile = await ensureProfile(user.id, season.id, now);
  profile = await refreshEnergy(profile, now);
  profile = await resetDailyClicksIfNeeded(profile, now);

  const [upgrades, activeBoosts, energyBalance, stats] = await Promise.all([
    prisma.clickerUpgrade.findMany({
      where: {
        userId: user.id,
        seasonId: season.id
      },
      orderBy: {
        upgradeType: "asc"
      }
    }),
    prisma.clickerBoost.findMany({
      where: {
        userId: user.id,
        seasonId: season.id,
        ...activeBoostsWhere(now)
      },
      orderBy: {
        expiresAt: "asc"
      }
    }),
    ensureEnergyBalance(user.id, season.id),
    prisma.userSeasonStats.findUnique({
      where: {
        userId_seasonId: {
          userId: user.id,
          seasonId: season.id
        }
      }
    })
  ]);

  return {
    user,
    season,
    profile,
    upgrades,
    activeBoosts,
    energyBalance,
    rank: stats?.rank ?? null,
    totalSeasonPoints: stats?.totalPoints ?? 0,
    effectivePassiveHashPerHour: getEffectivePassiveHashPerHour(profile, activeBoosts),
    effectiveStorageHours: getEffectiveStorageHours(profile, activeBoosts),
    effectiveMineMultiplier: getMineMultiplier(activeBoosts)
  };
}

async function awardMilestone(params: {
  userId: number;
  seasonId: number;
  key: string;
  basePoints: number;
  reason: string;
  boosts: ClickerBoost[];
}): Promise<number> {
  const points = getSeasonPointsAmount(params.basePoints, params.boosts);

  try {
    await prisma.clickerMilestone.create({
      data: {
        userId: params.userId,
        seasonId: params.seasonId,
        key: params.key,
        points
      }
    });
  } catch (error) {
    if (isUniqueError(error)) {
      return 0;
    }

    throw error;
  }

  const result = await addPoints(params.userId, params.seasonId, points, "hash_rush", params.reason, {
    clickerMilestone: params.key,
    suppressDefaultNotification: true
  });

  return result.created ? points : 0;
}

async function getUserDashboardFromTelegram(from: TelegramUserPayload): Promise<HashRushDashboard> {
  const user = await upsertHashRushUser(from);
  const season = await getRegisteredActiveSeason(user.id);
  return loadDashboard(user, season);
}

export async function getHashRushDashboard(from: TelegramUserPayload): Promise<HashRushDashboard> {
  return getUserDashboardFromTelegram(from);
}

export async function mineHashRush(from: TelegramUserPayload): Promise<HashRushActionResult> {
  const dashboard = await getUserDashboardFromTelegram(from);
  const { profile, user, season, activeBoosts } = dashboard;
  const now = new Date();

  if (profile.lastMineAt && now.getTime() - profile.lastMineAt.getTime() < MINE_COOLDOWN_MS) {
    throw new Error("Mining cooldown active. Wait 1 second between Mine actions.");
  }

  if (profile.dailyClicks >= MAX_DAILY_CLICKS) {
    throw new Error("Daily mine limit reached. Come back tomorrow.");
  }

  if (profile.energy <= 0) {
    throw new Error("Energy depleted. Wait for regeneration or use Energy Refill.");
  }

  const earned = BigInt(profile.hashPerClick * dashboard.effectiveMineMultiplier);
  const nextDailyClicks = profile.dailyClicks + 1;
  const updatedProfile = await prisma.clickerProfile.update({
    where: { id: profile.id },
    data: {
      hashPoints: profile.hashPoints + earned,
      totalHashPoints: profile.totalHashPoints + earned,
      energy: profile.energy - 1,
      lastMineAt: now,
      dailyClicks: nextDailyClicks
    }
  });

  let seasonPointsAwarded = 0;
  const dayKey = startOfUtcDay(now).toISOString().slice(0, 10);

  if (nextDailyClicks >= 100) {
    seasonPointsAwarded += await awardMilestone({
      userId: user.id,
      seasonId: season.id,
      key: `daily_clicks_100:${dayKey}`,
      basePoints: 10,
      reason: "Hash Rush daily 100 mines",
      boosts: activeBoosts
    });
  }

  if (nextDailyClicks >= 500) {
    seasonPointsAwarded += await awardMilestone({
      userId: user.id,
      seasonId: season.id,
      key: `daily_clicks_500:${dayKey}`,
      basePoints: 50,
      reason: "Hash Rush daily 500 mines",
      boosts: activeBoosts
    });
  }

  const refreshed = await loadDashboard(user, season, now);

  return {
    ...refreshed,
    profile: updatedProfile,
    message: `Mined +${formatHp(earned)} Hash Points.`,
    seasonPointsAwarded
  };
}

export async function collectHashRush(from: TelegramUserPayload): Promise<HashRushActionResult> {
  const dashboard = await getUserDashboardFromTelegram(from);
  const now = new Date();
  const lastCollectedAt = dashboard.profile.lastCollectedAt ?? dashboard.profile.createdAt;
  const elapsedHours = Math.max(0, (now.getTime() - lastCollectedAt.getTime()) / (60 * 60 * 1000));
  const collectibleHours = Math.min(elapsedHours, dashboard.effectiveStorageHours);
  const earned = BigInt(Math.floor(collectibleHours * dashboard.effectivePassiveHashPerHour));

  const updatedProfile = await prisma.clickerProfile.update({
    where: { id: dashboard.profile.id },
    data: {
      hashPoints: dashboard.profile.hashPoints + earned,
      totalHashPoints: dashboard.profile.totalHashPoints + earned,
      lastCollectedAt: now
    }
  });

  let seasonPointsAwarded = 0;

  if (earned > 0n) {
    const dayKey = startOfUtcDay(now).toISOString().slice(0, 10);
    seasonPointsAwarded = await awardMilestone({
      userId: dashboard.user.id,
      seasonId: dashboard.season.id,
      key: `daily_collect:${dayKey}`,
      basePoints: 10,
      reason: "Hash Rush first collect of the day",
      boosts: dashboard.activeBoosts
    });
  }

  const refreshed = await loadDashboard(dashboard.user, dashboard.season, now);

  return {
    ...refreshed,
    profile: updatedProfile,
    message: earned > 0n ? `Collected +${formatHp(earned)} passive Hash Points.` : "Nothing to collect yet.",
    seasonPointsAwarded
  };
}

export async function buyHashRushUpgrade(from: TelegramUserPayload, upgradeType: string): Promise<HashRushActionResult> {
  if (!["pickaxe", "passive_rig", "battery"].includes(upgradeType)) {
    throw new Error("Unknown upgrade. Use pickaxe, passive_rig, or battery.");
  }

  const dashboard = await getUserDashboardFromTelegram(from);
  const type = upgradeType as UpgradeType;
  const currentLevel = getUpgradeLevel(dashboard.upgrades, type);
  const next = getNextUpgrade(type, currentLevel);

  if (!next) {
    throw new Error("This upgrade is already maxed.");
  }

  if (dashboard.profile.hashPoints < next.cost) {
    throw new Error(`Not enough Hash Points. Need ${formatHp(next.cost)} HP.`);
  }

  const nextFactoryLevel = Math.max(dashboard.profile.factoryLevel, Math.max(1, next.level));
  const data =
    type === "pickaxe"
      ? { hashPerClick: "hashPerClick" in next ? next.hashPerClick : dashboard.profile.hashPerClick }
      : type === "passive_rig"
        ? { passiveHashPerHour: "passiveHashPerHour" in next ? next.passiveHashPerHour : dashboard.profile.passiveHashPerHour }
        : { energyCap: "energyCap" in next ? next.energyCap : dashboard.profile.energyCap };

  const updatedProfile = await prisma.$transaction(async (tx) => {
    await tx.clickerUpgrade.upsert({
      where: {
        userId_seasonId_upgradeType: {
          userId: dashboard.user.id,
          seasonId: dashboard.season.id,
          upgradeType: type
        }
      },
      create: {
        userId: dashboard.user.id,
        seasonId: dashboard.season.id,
        upgradeType: type,
        level: next.level
      },
      update: {
        level: next.level
      }
    });

    return tx.clickerProfile.update({
      where: { id: dashboard.profile.id },
      data: {
        hashPoints: dashboard.profile.hashPoints - next.cost,
        factoryLevel: nextFactoryLevel,
        ...data
      }
    });
  });

  const seasonPointsAwarded = await awardMilestone({
    userId: dashboard.user.id,
    seasonId: dashboard.season.id,
    key: `factory_level:${nextFactoryLevel}`,
    basePoints: 50,
    reason: `Hash Rush factory level ${nextFactoryLevel}`,
    boosts: dashboard.activeBoosts
  });

  const refreshed = await loadDashboard(dashboard.user, dashboard.season);

  return {
    ...refreshed,
    profile: updatedProfile,
    message: `Bought ${type} level ${next.level}.`,
    seasonPointsAwarded
  };
}

export async function buyHashRushBoost(from: TelegramUserPayload, boostType: string): Promise<HashRushActionResult> {
  if (!Object.keys(BOOSTS).includes(boostType)) {
    throw new Error("Unknown boost. Use energy_refill, turbo_1h, auto_miner_24h, storage_12h, or season_boost_24h.");
  }

  const dashboard = await getUserDashboardFromTelegram(from);
  const type = boostType as BoostType;
  const boost = BOOSTS[type];
  const now = new Date();

  if (dashboard.energyBalance.balance < boost.cost) {
    throw new Error(`Not enough Reactor Energy. Need ${boost.cost}.`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.reactorEnergyBalance.update({
      where: {
        userId_seasonId: {
          userId: dashboard.user.id,
          seasonId: dashboard.season.id
        }
      },
      data: {
        balance: {
          decrement: boost.cost
        },
        totalSpent: {
          increment: boost.cost
        }
      }
    });

    if (type === "energy_refill") {
      await tx.clickerProfile.update({
        where: { id: dashboard.profile.id },
        data: {
          energy: dashboard.profile.energyCap,
          lastEnergyAt: now
        }
      });
      return;
    }

    await tx.clickerBoost.create({
      data: {
        userId: dashboard.user.id,
        seasonId: dashboard.season.id,
        boostType: type,
        multiplier: boost.multiplier ?? 1,
        expiresAt: addMs(now, boost.durationMs ?? 0)
      }
    });
  });

  const refreshed = await loadDashboard(dashboard.user, dashboard.season, now);

  return {
    ...refreshed,
    message: `Activated ${boost.label}.`
  };
}

export async function creditReactorEnergy(params: {
  userId: number;
  amount: number;
  reason: string;
}): Promise<ReactorEnergyBalance> {
  if (!Number.isInteger(params.amount) || params.amount <= 0) {
    throw new Error("Energy amount must be a positive integer.");
  }

  const season = await getActiveSeason();

  if (!season) {
    throw new Error("No active season found.");
  }

  return prisma.reactorEnergyBalance.upsert({
    where: {
      userId_seasonId: {
        userId: params.userId,
        seasonId: season.id
      }
    },
    create: {
      userId: params.userId,
      seasonId: season.id,
      balance: params.amount,
      totalEarned: params.amount
    },
    update: {
      balance: {
        increment: params.amount
      },
      totalEarned: {
        increment: params.amount
      }
    }
  });
}

export async function resetHashRushForUser(userId: number): Promise<void> {
  const season = await getActiveSeason();

  if (!season) {
    throw new Error("No active season found.");
  }

  await prisma.$transaction([
    prisma.clickerMilestone.deleteMany({ where: { userId, seasonId: season.id } }),
    prisma.clickerBoost.deleteMany({ where: { userId, seasonId: season.id } }),
    prisma.clickerUpgrade.deleteMany({ where: { userId, seasonId: season.id } }),
    prisma.reactorEnergyBalance.deleteMany({ where: { userId, seasonId: season.id } }),
    prisma.reactorEnergyDeposit.deleteMany({ where: { userId, seasonId: season.id } }),
    prisma.clickerProfile.deleteMany({ where: { userId, seasonId: season.id } })
  ]);
}

export async function getHashRushLeaderboard(limit = 10) {
  const season = await getActiveSeason();

  if (!season) {
    throw new Error("No active season found.");
  }

  const profiles = await prisma.clickerProfile.findMany({
    where: {
      seasonId: season.id
    },
    include: {
      user: true
    },
    orderBy: [
      { totalHashPoints: "desc" },
      { dailyClicks: "desc" },
      { updatedAt: "asc" }
    ],
    take: limit
  });

  return {
    season,
    profiles
  };
}

export function renderHashRushDashboard(dashboard: HashRushDashboard): string {
  const { profile, energyBalance } = dashboard;
  const boosts = dashboard.activeBoosts.length
    ? dashboard.activeBoosts.map((boost) => `${boost.boostType} until ${boost.expiresAt.toISOString().slice(11, 16)} UTC`).join(", ")
    : "none";

  return [
    "X1Factory: Hash Rush",
    "",
    `Factory Level: ${profile.factoryLevel}`,
    `Hash Points: ${formatHp(profile.hashPoints)}`,
    `Season Points: ${dashboard.totalSeasonPoints}`,
    `Rank: ${dashboard.rank ? `#${dashboard.rank}` : "unranked"}`,
    "",
    `Energy: ${profile.energy} / ${profile.energyCap}`,
    `Hash per click: ${profile.hashPerClick}${dashboard.effectiveMineMultiplier > 1 ? ` x${dashboard.effectiveMineMultiplier}` : ""}`,
    `Passive income: ${dashboard.effectivePassiveHashPerHour} HP/hour`,
    `Storage: ${dashboard.effectiveStorageHours}h`,
    `Daily mines: ${profile.dailyClicks} / ${MAX_DAILY_CLICKS}`,
    "",
    `Reactor Energy: ${energyBalance.balance}`,
    `Active boosts: ${boosts}`,
    "",
    "Commands:",
    "/mine",
    "/collect",
    "/upgrades",
    "/boosts",
    "/clicker_leaderboard"
  ].join("\n");
}

export function renderHashRushUpgrades(dashboard: HashRushDashboard): string {
  const pickaxe = getUpgradeLevel(dashboard.upgrades, "pickaxe");
  const passive = getUpgradeLevel(dashboard.upgrades, "passive_rig");
  const battery = getUpgradeLevel(dashboard.upgrades, "battery");

  const rows = [
    ["pickaxe", pickaxe, getNextUpgrade("pickaxe", pickaxe)],
    ["passive_rig", passive, getNextUpgrade("passive_rig", passive)],
    ["battery", battery, getNextUpgrade("battery", battery)]
  ] as const;

  return [
    "Hash Rush Upgrades",
    "",
    ...rows.map(([type, level, next]) => {
      if (!next) {
        return `${type}: level ${level} maxed`;
      }

      return `${type}: level ${level} -> ${next.level}, cost ${formatHp(next.cost)} HP`;
    }),
    "",
    "Buy with: /buy_upgrade <upgradeId>"
  ].join("\n");
}

export function renderHashRushBoosts(dashboard: HashRushDashboard): string {
  return [
    "Hash Rush Boosts",
    "",
    `Reactor Energy: ${dashboard.energyBalance.balance}`,
    "",
    ...Object.entries(BOOSTS).map(([id, boost]) => `${id}: ${boost.cost} Energy - ${boost.label}`),
    "",
    "Buy with: /buy_boost <boostId>"
  ].join("\n");
}
