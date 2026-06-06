import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { prisma } from "@/lib/prisma";
import { parseTelegramWebAppAuth } from "@/lib/webAppAuth";

const RPC = "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID = new PublicKey("2xXG9bbggrffG976okAbEHzw1BJgfA58d9zHTToke2Z6");
const [CONFIG_PDA] = PublicKey.findProgramAddressSync([Buffer.from("router_config")], PROGRAM_ID);
const CONFIG_XNT_USD_OFFSET     = 72;
const CONFIG_REWARD_MIND_OFFSET  = 96;
const CONFIG_REWARD_XNT_OFFSET   = 104;
const CONFIG_SWAP_COUNTER_OFFSET = 80;
const CONFIG_GIGA_HITS_OFFSET    = 88;

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

interface Badge { key: string; icon: string; label: string; desc: string; colorClass: string; }
interface TrophyBadge { key: string; icon: string; label: string; }

function computeBadges(params: {
  isGenesis: boolean;
  hasPioneer: boolean;
  hasBigClaim: boolean;
  allTimeStats: { seasonId: number; rank: number | null }[];
  allSeasons: { id: number; name: string; status: string }[];
}): { badges: Badge[]; trophies: TrophyBadge[] } {
  const { isGenesis, hasPioneer, hasBigClaim, allTimeStats, allSeasons } = params;

  const badges: Badge[] = [];
  if (isGenesis)    badges.push({ key: 'genesis',         icon: '🌟', label: 'Genesis',      desc: 'First 100 users',           colorClass: 'badge-lvl-genesis'   });
  if (hasPioneer)   badges.push({ key: 'pioneer',         icon: '🛸', label: 'Pioneer',       desc: 'Wallet + first check-in',   colorClass: 'badge-lvl-platinum' });
  if (hasBigClaim)  badges.push({ key: 'first_big_claim', icon: '⚡', label: 'Big Claimer',   desc: 'Claim ≥ 500 MIND',          colorClass: 'badge-lvl-gold'      });

  const trophies: TrophyBadge[] = [];
  for (const s of allTimeStats) {
    if (s.rank === null) continue;
    const season = allSeasons.find(a => a.id === s.seasonId);
    if (!season || season.status !== 'COMPLETED') continue;
    if (s.rank === 1)     trophies.push({ key: `champion_${s.seasonId}`, icon: '👑', label: `Champion · ${season.name}` });
    else if (s.rank <= 3) trophies.push({ key: `podium_${s.seasonId}`,   icon: '🏆', label: `Podium · ${season.name}` });
  }

  return { badges, trophies };
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

    // Fetch reward pool info from chain (non-blocking — fallback to null on error)
    const gigaPoolPromise = (async () => {
      try {
        const conn = new Connection(RPC, "confirmed");
        const info = await conn.getAccountInfo(CONFIG_PDA);
        if (!info || info.data.length < CONFIG_REWARD_XNT_OFFSET + 8) return null;
        const xntUsdCents   = info.data.readBigUInt64LE(CONFIG_XNT_USD_OFFSET);
        const mindBal       = info.data.readBigUInt64LE(CONFIG_REWARD_MIND_OFFSET);
        const xntBal        = info.data.readBigUInt64LE(CONFIG_REWARD_XNT_OFFSET);
        const swapCounter   = info.data.readBigUInt64LE(CONFIG_SWAP_COUNTER_OFFSET);
        const gigaHits      = info.data.readBigUInt64LE(CONFIG_GIGA_HITS_OFFSET);
        const xntUsd = Number(xntUsdCents) / 100;
        const mindUsd = xntUsd / 21; // approximate MIND price
        const poolUsd = (Number(mindBal) / 1e9) * mindUsd + (Number(xntBal) / 1e9) * xntUsd;
        return {
          mindBalance: mindBal.toString(),
          xntBalance: xntBal.toString(),
          poolUsd: Math.round(poolUsd * 100) / 100,
          xntUsdCents: xntUsdCents.toString(),
          swapCounter: swapCounter.toString(),
          gigaHits: gigaHits.toString(),
          active: poolUsd > 0.01,
        };
      } catch {
        return null;
      }
    })();

    // Parallel: current season, wallet, all seasons, all-time stats, event categories, photo
    const [season, wallet, allSeasons, allTimeStatsList, eventCategoryRows, photoUrl, hasBigClaimRow] = await Promise.all([
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
      prisma.seasonPoint.findFirst({
        where: { userId: user.id, category: 'claim_mind_daily', points: { gte: 150 } },
        select: { id: true },
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
    const badges = computeBadges({
      isGenesis: user.id <= 100,
      hasPioneer: !!wallet && cats.has('daily_checkin'),
      hasBigClaim: !!hasBigClaimRow,
      allTimeStats: allTimeStatsList,
      allSeasons,
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

    // Await pool info (was kicked off in parallel)
    const gigaPool = await gigaPoolPromise;

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
      gigaPool,
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
