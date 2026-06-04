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
    case "claim_mind_daily":       return "Daily MIND claim";
    case "stake_snapshot":         return "Stake milestone";
    case "wallet_registration":    return "Wallet registration";
    case "starter_rig_purchase":   return "Starter rig purchase";
    case "pro_rig_purchase":       return "Pro rig purchase";
    case "industrial_rig_purchase":return "Industrial rig purchase";
    case "starter_renewal":        return "Starter renewal";
    case "pro_renewal":            return "Pro renewal";
    case "industrial_renewal":     return "Industrial renewal";
    case "daily_active_starter":   return "Starter daily active";
    case "daily_active_pro":       return "Pro daily active";
    case "daily_active_industrial":return "Industrial daily active";
    case "daily_checkin":          return "Daily check-in";
    default:                       return category.replaceAll("_", " ");
  }
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

    const [season, wallet] = await Promise.all([
      prisma.season.findFirst({
        where: { status: { in: ["ACTIVE", "UPCOMING"] } },
        orderBy: { startsAt: "asc" },
      }),
      prisma.wallet.findFirst({ where: { userId: user.id, isActive: true } }),
    ]);

    const stats = season
      ? await prisma.userSeasonStats.findUnique({
          where: { userId_seasonId: { userId: user.id, seasonId: season.id } },
        })
      : null;

    const recentPoints = season
      ? await prisma.seasonPoint.findMany({
          where: { userId: user.id, seasonId: season.id },
          orderBy: { createdAt: "desc" },
          take: 10,
        })
      : [];

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
      },
      wallet: wallet
        ? { address: wallet.address, short: shortWallet(wallet.address) }
        : null,
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
