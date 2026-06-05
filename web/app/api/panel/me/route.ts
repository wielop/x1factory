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
    case "energy_tap":              return "Energy tap";
    case "streak_bonus":            return "Streak bonus";
    default:                        return category.replaceAll("_", " ");
  }
}

function operatorId(userId: number): string {
  return "OP-" + String(userId).padStart(4, "0");
}

async function getTelegramPhotoUrl(telegramId: bigint, botToken: string): Promise<string | null> {
  try {
    const r1 = await fetch(`https://api.telegram.org/bot${botToken}/getUserProfilePhotos?user_id=${telegramId}&limit=1`);
    const d1 = await r1.json() as { ok: boolean; result: { photos: { file_id: string }[][] } };
    if (!d1.ok || !d1.result.photos.length) return null;
    const photos = d1.result.photos[0];
    const fileId = photos[photos.length - 1].file_id;
    const r2 = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
    const d2 = await r2.json() as { ok: boolean; result: { file_path: string } };
    if (!d2.ok) return null;
    return `https://api.telegram.org/file/bot${botToken}/${d2.result.file_path}`;
  } catch {
    return null;
  }
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

interface LeveledBadge {
  key: string; icon: string; label: string;
  level: 0 | 1 | 2 | 3 | 4; levelLabel: string;
  nextAt: string | null;
}
interface TrophyBadge { key: string; icon: string; label: string; }

function computeBadges(params: {
  cats: Set<string>;
  allTimeStats: { seasonId: number; totalPoints: number; rank: number | null; streakCount: number }[];
  allSeasons: { id: number; name: string; status: string }[];
  claimCount: number;
  maxStakePts: number;
  seasonsCount: number;
  isGenesis: boolean;
}): { leveled: LeveledBadge[]; trophies: TrophyBadge[] } {
  const { cats, allTimeStats, allSeasons, claimCount, maxStakePts, seasonsCount, isGenesis } = params;
  const maxStreak = allTimeStats.reduce((max, s) => Math.max(max, s.streakCount || 0), 0);
  const L = ['', 'Bronze', 'Silver', 'Gold', 'Platinum'] as const;

  function lvl(v: number, t: readonly [number, number, number, number]): 0 | 1 | 2 | 3 | 4 {
    for (let i = 3; i >= 0; i--) if (v >= t[i]) return (i + 1) as 1 | 2 | 3 | 4;
    return 0;
  }

  function badge(
    key: string, icon: string, label: string,
    value: number, t: readonly [number, number, number, number],
    hint: (n: number) => string,
  ): LeveledBadge {
    const level = lvl(value, t);
    const nextAt = level < 4 ? hint(t[level as 0 | 1 | 2 | 3] - value) : null;
    return { key, icon, label, level, levelLabel: L[level], nextAt };
  }

  const rigLevel: 0 | 1 | 2 | 3 = cats.has('industrial_rig_purchase') ? 3
    : cats.has('pro_rig_purchase') ? 2
    : cats.has('starter_rig_purchase') ? 1 : 0;

  const stakeLevel = lvl(maxStakePts, [25, 100, 600, 1200]);
  const STAKE_L = ['', 'Holder', 'Believer', 'Whale', 'Titan'] as const;
  const STAKE_N = ['Stake 100 MIND', 'Stake 500 MIND', 'Stake 2,500 MIND', 'Stake 5,000 MIND'] as const;

  const leveled: LeveledBadge[] = [
    badge('miner',   '⛏️', 'Miner',   claimCount,   [10, 50, 150, 500], n => `${n} more claims`),
    badge('streak',  '🔥', 'Streak',  maxStreak,    [3, 7, 14, 21],     n => `${n} more days`),
    badge('seasons', '📅', 'Seasons', seasonsCount, [2, 4, 6, 10],      n => `${n} more seasons`),
    {
      key: 'rig', icon: '🏭', label: 'Rig',
      level: rigLevel as 0 | 1 | 2 | 3 | 4,
      levelLabel: (['', 'Starter', 'Pro', 'Industrial'] as const)[rigLevel],
      nextAt: rigLevel < 3
        ? (['Buy a Starter Rig', 'Upgrade to Pro Rig', 'Upgrade to Industrial Rig'] as const)[rigLevel as 0 | 1 | 2]
        : null,
    },
    {
      key: 'staker', icon: '🔒', label: 'Staker',
      level: stakeLevel,
      levelLabel: STAKE_L[stakeLevel],
      nextAt: stakeLevel < 4 ? STAKE_N[stakeLevel as 0 | 1 | 2 | 3] : null,
    },
  ];

  if (isGenesis) {
    leveled.push({ key: 'genesis', icon: '🌟', label: 'Genesis', level: 4, levelLabel: 'Genesis', nextAt: null });
  }

  const trophies: TrophyBadge[] = [];
  for (const s of allTimeStats) {
    if (s.rank === null) continue;
    const season = allSeasons.find(a => a.id === s.seasonId);
    if (!season || season.status !== 'COMPLETED') continue;
    if (s.rank === 1)      trophies.push({ key: `winner_${s.seasonId}`, icon: '👑', label: `Winner · ${season.name}` });
    else if (s.rank <= 3)  trophies.push({ key: `top3_${s.seasonId}`,   icon: '🥇', label: `Top 3 · ${season.name}` });
    else if (s.rank <= 10) trophies.push({ key: `top10_${s.seasonId}`,  icon: '🏆', label: `Top 10 · ${season.name}` });
  }

  return { leveled, trophies };
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

    const botToken = process.env.BOT_TOKEN ?? "";

    // Parallel: current season, wallet, all seasons, all-time stats, event categories, photo
    const [season, wallet, allSeasons, allTimeStatsList, eventCategoryRows, photoUrl, claimCount, maxStakePtsRow] = await Promise.all([
      prisma.season.findFirst({
        where: { status: { in: ["ACTIVE", "UPCOMING"] } },
        orderBy: { startsAt: "asc" },
      }),
      prisma.wallet.findFirst({ where: { userId: user.id, isActive: true } }),
      prisma.season.findMany({ orderBy: { startsAt: "asc" }, select: { id: true, name: true, status: true } }),
      prisma.userSeasonStats.findMany({
        where: { userId: user.id },
        select: { seasonId: true, totalPoints: true, rank: true, streakCount: true },
      }),
      prisma.seasonPoint.findMany({
        where: { userId: user.id },
        select: { category: true },
        distinct: ["category"],
      }),
      getTelegramPhotoUrl(telegramId, botToken),
      prisma.seasonPoint.count({ where: { userId: user.id, category: "claim_mind_daily" } }),
      prisma.seasonPoint.findFirst({
        where: { userId: user.id, category: "stake_snapshot" },
        orderBy: { points: "desc" },
        select: { points: true },
      }),
    ]);

    const todayUtcEnd = new Date(todayUtcStart.getTime() + 86400000);

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
    const seasonStamps = allSeasons.map((s) => {
      const st = allTimeStatsList.find(r => r.seasonId === s.id);
      return {
        id: s.id,
        name: s.name,
        status: s.status.toLowerCase(),
        participated: participatedSeasonIds.has(s.id),
        points: st?.totalPoints ?? 0,
        rank: st?.rank ?? null,
      };
    });

    // Today's passive earnings
    const claimTodayPts = (season ? todayPoints : [])
      .filter(p => p.category === "claim_mind_daily")
      .reduce((s, p) => s + p.points, 0);
    const rigTodayPts = (season ? todayPoints : [])
      .filter(p => ["daily_active_starter", "daily_active_pro", "daily_active_industrial"].includes(p.category))
      .reduce((s, p) => s + p.points, 0);
    const stakeTodayPts = (season ? todayPoints : [])
      .filter(p => p.category === "stake_snapshot")
      .reduce((s, p) => s + p.points, 0);

    // Badges
    const cats = new Set(eventCategoryRows.map((e) => e.category));
    const maxStakePts = maxStakePtsRow?.points ?? 0;
    const badges = computeBadges({
      cats,
      allTimeStats: allTimeStatsList,
      allSeasons,
      claimCount,
      maxStakePts,
      seasonsCount,
      isGenesis: user.id <= 200,
    });

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
        photoUrl: photoUrl ?? null,
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
      streak: {
        count: stats?.streakCount || (todayCats.has("daily_checkin") ? 1 : 0),
        lastAt: stats?.lastCheckinAt?.toISOString() ?? null,
      },
      allTime: {
        totalPoints: allTimePoints,
        seasonsCount,
        bestRank,
        eventsCount: allTimeStatsList.reduce((sum, s) => sum + (s as { totalPoints: number; rank: number | null; seasonsCount?: number }).totalPoints, 0),
      },
      seasonStamps,
      badges,
      claimTodayPts,
      rigTodayPts,
      stakeTodayPts,
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
