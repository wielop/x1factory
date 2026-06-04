import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseTelegramWebAppAuth } from "@/lib/webAppAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function shortWallet(address: string) {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

function formatEventCategory(category: string): string {
  switch (category) {
    case "claim_mind_daily":        return "Daily MIND claim";
    case "stake_snapshot":          return "Stake milestone";
    case "wallet_registration":     return "Wallet registration";
    case "starter_rig_purchase":    return "Starter rig purchase";
    case "pro_rig_purchase":        return "Pro rig purchase";
    case "industrial_rig_purchase": return "Industrial rig purchase";
    case "starter_renewal":         return "Starter renewal";
    case "pro_renewal":             return "Pro renewal";
    case "industrial_renewal":      return "Industrial renewal";
    case "daily_active_starter":    return "Starter rig active";
    case "daily_active_pro":        return "Pro rig active";
    case "daily_active_industrial": return "Industrial rig active";
    case "daily_checkin":           return "Daily check-in";
    default:                        return category.replaceAll("_", " ");
  }
}

function operatorId(userId: number): string {
  return "OP-" + String(userId).padStart(4, "0");
}

// ── Prize pool ────────────────────────────────────────
const PRIZE_TIERS = [
  { label: "1st place",  rankMin: 1,  rankMax: 1,  sharePct: 35 },
  { label: "2nd place",  rankMin: 2,  rankMax: 2,  sharePct: 20 },
  { label: "3rd place",  rankMin: 3,  rankMax: 3,  sharePct: 15 },
  { label: "Top 5",      rankMin: 4,  rankMax: 5,  sharePct: 15 }, // 7.5% each
  { label: "Top 10",     rankMin: 6,  rankMax: 10, sharePct: 15 }, // 3% each
];

function getPrizePool() {
  const raw = process.env.SEASON_PRIZE_POOL_XNT;
  return raw ? Number(raw) : 0;
}

function getPrizeForRank(rank: number | null | undefined, total: number) {
  if (!rank || total <= 0) return { amount: 0, tier: null as string | null };
  const tier = PRIZE_TIERS.find(t => rank >= t.rankMin && rank <= t.rankMax);
  if (!tier) return { amount: 0, tier: null };
  const perPerson = total * (tier.sharePct / 100) / (tier.rankMax - tier.rankMin + 1);
  return { amount: Math.round(perPerson), tier: tier.label };
}

function buildPrizeBreakdown(total: number) {
  return PRIZE_TIERS.map(t => {
    const count = t.rankMax - t.rankMin + 1;
    const perPerson = Math.round(total * (t.sharePct / 100) / count);
    const rankLabel = t.rankMin === t.rankMax ? `#${t.rankMin}` : `#${t.rankMin}–${t.rankMax}`;
    return { rankLabel, label: t.label, perPerson, total: Math.round(total * t.sharePct / 100) };
  });
}

function computeBadges(cats: Set<string>, allTimeStats: { rank: number | null }[], seasonsCount: number) {
  const badges: { key: string; label: string; icon: string }[] = [];
  const bestRank = allTimeStats.reduce<number | null>((best, s) => {
    if (s.rank === null) return best;
    return best === null ? s.rank : Math.min(best, s.rank);
  }, null);

  if (cats.has("wallet_registration"))
    badges.push({ key: "registered", label: "Registered", icon: "🔑" });

  if (cats.has("starter_rig_purchase") || cats.has("pro_rig_purchase") || cats.has("industrial_rig_purchase"))
    badges.push({ key: "rig_owner", label: "Rig Owner", icon: "🏭" });

  if (cats.has("industrial_rig_purchase"))
    badges.push({ key: "industrial", label: "Industrial", icon: "⚙️" });

  if (cats.has("claim_mind_daily"))
    badges.push({ key: "miner", label: "Miner", icon: "⛏️" });

  if (cats.has("stake_snapshot"))
    badges.push({ key: "staker", label: "Staker", icon: "🔒" });

  if (bestRank !== null && bestRank <= 10)
    badges.push({ key: "top10", label: "Top 10", icon: "🏆" });

  if (bestRank !== null && bestRank <= 3)
    badges.push({ key: "podium", label: "Podium", icon: "🥇" });

  if (bestRank === 1)
    badges.push({ key: "champion", label: "Champion", icon: "👑" });

  if (seasonsCount >= 2)
    badges.push({ key: "veteran", label: "Veteran", icon: "⭐" });

  if (seasonsCount >= 4)
    badges.push({ key: "legend", label: "Legend", icon: "💫" });

  return badges;
}

export async function GET(req: NextRequest) {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  const auth = parseTelegramWebAppAuth(initData, process.env.BOT_TOKEN ?? "");

  if (!auth) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const telegramId = BigInt(auth.user.id);

    const user = await prisma.user.upsert({
      where: { telegramId },
      create: {
        telegramId,
        username: auth.user.username,
        firstName: auth.user.first_name,
        lastName: auth.user.last_name,
        languageCode: auth.user.language_code,
        lastSeenAt: new Date(),
      },
      update: {
        username: auth.user.username,
        firstName: auth.user.first_name,
        lastName: auth.user.last_name,
        languageCode: auth.user.language_code,
        lastSeenAt: new Date(),
      },
    });

    const now = Date.now();
    const todayUtcStart = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");

    // Parallel: current season, wallet, all seasons, all-time stats, event categories
    const [season, wallet, allSeasons, allTimeStatsList, eventCategoryRows] = await Promise.all([
      prisma.season.findFirst({
        where: { status: { in: ["ACTIVE", "UPCOMING"] } },
        orderBy: { startsAt: "asc" },
      }),
      prisma.wallet.findFirst({ where: { userId: user.id, isActive: true } }),
      prisma.season.findMany({ orderBy: { startsAt: "asc" } }),
      prisma.userSeasonStats.findMany({
        where: { userId: user.id },
        select: { seasonId: true, totalPoints: true, rank: true },
      }),
      prisma.seasonPoint.findMany({
        where: { userId: user.id },
        select: { category: true },
        distinct: ["category"],
      }),
    ]);

    // Current season data
    const [stats, recentPoints, todayPoints] = await Promise.all([
      season
        ? prisma.userSeasonStats.findUnique({
            where: { userId_seasonId: { userId: user.id, seasonId: season.id } },
          })
        : Promise.resolve(null),
      season
        ? prisma.seasonPoint.findMany({
            where: { userId: user.id, seasonId: season.id },
            orderBy: { createdAt: "desc" },
            take: 10,
          })
        : Promise.resolve([]),
      season
        ? prisma.seasonPoint.findMany({
            where: { userId: user.id, seasonId: season.id, createdAt: { gte: todayUtcStart } },
            select: { category: true, points: true },
          })
        : Promise.resolve([]),
    ]);

    // Battle card: who's just above and just below in rankings
    let nearbyRanks: { above: object | null; below: object | null } = { above: null, below: null };
    if (season && stats?.rank) {
      const [rankAbove, rankBelow] = await Promise.all([
        prisma.userSeasonStats.findFirst({
          where: { seasonId: season.id, rank: stats.rank - 1 },
          include: { user: { select: { username: true, firstName: true, telegramId: true } } },
        }),
        prisma.userSeasonStats.findFirst({
          where: { seasonId: season.id, rank: stats.rank + 1 },
          include: { user: { select: { username: true, firstName: true, telegramId: true } } },
        }),
      ]);

      nearbyRanks = {
        above: rankAbove
          ? {
              rank: rankAbove.rank,
              username: rankAbove.user.username,
              firstName: rankAbove.user.firstName,
              points: rankAbove.totalPoints,
              gap: rankAbove.totalPoints - stats.totalPoints,
            }
          : null,
        below: rankBelow
          ? {
              rank: rankBelow.rank,
              username: rankBelow.user.username,
              firstName: rankBelow.user.firstName,
              points: rankBelow.totalPoints,
              gap: stats.totalPoints - rankBelow.totalPoints,
            }
          : null,
      };
    }

    // All-time stats
    const participatedSeasonIds = new Set(allTimeStatsList.map((s) => s.seasonId));
    const allTimePoints = allTimeStatsList.reduce((sum, s) => sum + s.totalPoints, 0);
    const seasonsCount = allTimeStatsList.length;
    const bestRank = allTimeStatsList.reduce<number | null>((best, s) => {
      if (s.rank === null) return best;
      return best === null ? s.rank : Math.min(best, s.rank);
    }, null);

    // Season stamps
    const seasonStamps = allSeasons.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status.toLowerCase(),
      participated: participatedSeasonIds.has(s.id),
    }));

    // Badges
    const cats = new Set(eventCategoryRows.map((e) => e.category));
    const badges = computeBadges(cats, allTimeStatsList, seasonsCount);

    // Daily missions
    const todayCats = new Set(todayPoints.map((p) => p.category));
    const dailyMissions = [
      {
        key: "checkin",
        label: "Daily Check-in",
        icon: "📅",
        pts: 10,
        done: todayCats.has("daily_checkin"),
      },
      {
        key: "claim",
        label: "Claim MIND",
        icon: "💎",
        pts: 5,
        done: todayCats.has("claim_mind_daily"),
      },
      {
        key: "active_rig",
        label: "Active Rig",
        icon: "⚡",
        pts: 2,
        done: ["daily_active_starter", "daily_active_pro", "daily_active_industrial"].some((c) =>
          todayCats.has(c)
        ),
      },
    ];

    // Prize pool
    const prizeTotal = getPrizePool();
    const myPrize = getPrizeForRank(stats?.rank, prizeTotal);
    const prizePool = prizeTotal > 0
      ? {
          total: prizeTotal,
          currency: "XNT",
          myEstimated: myPrize.amount,
          myTier: myPrize.tier,
          breakdown: buildPrizeBreakdown(prizeTotal),
        }
      : null;

    // Season days
    const totalDays = season
      ? Math.max(1, Math.ceil((season.endsAt.getTime() - season.startsAt.getTime()) / 86400000))
      : 21;
    const day = season
      ? Math.max(1, Math.min(totalDays, Math.floor((now - season.startsAt.getTime()) / 86400000) + 1))
      : 1;

    return NextResponse.json({
      ok: true,
      user: {
        telegramId: user.telegramId.toString(),
        username: user.username,
        firstName: user.firstName,
        createdAt: user.createdAt.toISOString(),
        operatorId: operatorId(user.id),
      },
      wallet: wallet ? { address: wallet.address, short: shortWallet(wallet.address) } : null,
      season: season
        ? {
            id: season.id,
            name: season.name,
            status: season.status,
            startsAt: season.startsAt.toISOString(),
            endsAt: season.endsAt.toISOString(),
            day,
            totalDays,
            timeLeftMs: Math.max(0, season.endsAt.getTime() - now),
          }
        : null,
      stats: stats
        ? {
            totalPoints: stats.totalPoints,
            rank: stats.rank,
            eventsCount: stats.eventsCount,
            lastEventAt: stats.lastEventAt?.toISOString() ?? null,
          }
        : null,
      allTime: {
        totalPoints: allTimePoints,
        seasonsCount,
        bestRank,
        eventsCount: allTimeStatsList.reduce((sum, s) => sum + (s as { totalPoints: number; rank: number | null; seasonsCount?: number }).totalPoints, 0),
      },
      seasonStamps,
      badges,
      nearbyRanks,
      dailyMissions,
      prizePool,
      syncedAt: new Date().toISOString(),
      recentEvents: recentPoints.map((p) => ({
        points: p.points,
        category: p.category,
        reason: formatEventCategory(p.category),
        createdAt: p.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
