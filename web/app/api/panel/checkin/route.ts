import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseTelegramWebAppAuth } from "@/lib/webAppAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CHECKIN_POINTS = 10;

const STREAK_BONUSES = [
  { days: 3,  points: 50 },
  { days: 7,  points: 150 },
  { days: 14, points: 350 },
  { days: 21, points: 700 },
] as const;

function todayUTC(): { start: Date; end: Date } {
  const start = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  return { start, end: new Date(start.getTime() + 86400000) };
}


function yesterdayUTCStr(): string {
  return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
}

function todayUTCStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
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
      update: { lastSeenAt: new Date() },
    });

    const season = await prisma.season.findFirst({
      where: { status: "ACTIVE" },
      orderBy: { startsAt: "asc" },
    });

    if (!season) {
      return NextResponse.json({ ok: false, error: "No active season." });
    }

    const { start: todayStart, end: todayEnd } = todayUTC();

    // Check if already done today
    const existing = await prisma.seasonPoint.findFirst({
      where: {
        userId: user.id,
        seasonId: season.id,
        category: "daily_checkin",
        createdAt: { gte: todayStart, lt: todayEnd },
      },
    });

    if (existing) {
      const stats = await prisma.userSeasonStats.findUnique({
        where: { userId_seasonId: { userId: user.id, seasonId: season.id } },
      });
      return NextResponse.json({
        ok: true,
        alreadyDone: true,
        totalPoints: stats?.totalPoints ?? 0,
        rank: stats?.rank ?? null,
        streak: stats?.streakCount ?? 0,
      });
    }

    // Award check-in points
    await prisma.seasonPoint.create({
      data: {
        userId: user.id,
        seasonId: season.id,
        points: CHECKIN_POINTS,
        category: "daily_checkin",
        source: "EVENT",
        reason: "Daily check-in",
      },
    });

    // ── Streak logic (requires both check-in + MIND claim today) ──────────────
    const claimToday = await prisma.seasonPoint.findFirst({
      where: {
        userId: user.id,
        seasonId: season.id,
        category: "claim_mind_daily",
        createdAt: { gte: todayStart, lt: todayEnd },
      },
    });

    let updatedStats = await prisma.userSeasonStats.upsert({
      where: { userId_seasonId: { userId: user.id, seasonId: season.id } },
      create: {
        userId: user.id,
        seasonId: season.id,
        totalPoints: CHECKIN_POINTS,
        eventsCount: 1,
        lastEventAt: new Date(),
        streakCount: 0,
      },
      update: {
        totalPoints: { increment: CHECKIN_POINTS },
        eventsCount: { increment: 1 },
        lastEventAt: new Date(),
      },
    });

    // ── Streak bonus (only when both check-in + claim done today) ──────────────
    let streakBonus = 0;
    let newStreak = updatedStats.streakCount;

    if (claimToday) {
      const lastDate = updatedStats.lastCheckinAt?.toISOString().slice(0, 10);
      const today = todayUTCStr();
      const yesterday = yesterdayUTCStr();

      if (lastDate !== today) {
        if (lastDate === yesterday) newStreak = (updatedStats.streakCount || 0) + 1;
        else newStreak = 1;

        updatedStats = await prisma.userSeasonStats.update({
          where: { userId_seasonId: { userId: user.id, seasonId: season.id } },
          data: { streakCount: newStreak, lastCheckinAt: new Date() },
        });

        const milestone = STREAK_BONUSES.find(b => b.days === newStreak);
        if (milestone) {
          streakBonus = milestone.points;
          await prisma.seasonPoint.create({
            data: {
              userId: user.id,
              seasonId: season.id,
              points: streakBonus,
              category: "streak_bonus",
              source: "BONUS",
              reason: `${newStreak}-day streak bonus`,
            },
          });
          updatedStats = await prisma.userSeasonStats.update({
            where: { userId_seasonId: { userId: user.id, seasonId: season.id } },
            data: { totalPoints: { increment: streakBonus } },
          });
        }
      }
    }

    return NextResponse.json({
      ok: true,
      alreadyDone: false,
      pointsAwarded: CHECKIN_POINTS,
      streakBonus,
      streak: newStreak,
      totalPoints: updatedStats.totalPoints,
      rank: updatedStats.rank ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Check-in failed.";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
