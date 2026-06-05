import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseTelegramWebAppAuth } from "@/lib/webAppAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CHECKIN_POINTS = 10;
const ENERGY_TAP_POINTS = 2;
const ENERGY_MAX = 5;
const WEEKLY_CHECKIN_GOAL = 5;
const WEEKLY_CHECKIN_BONUS = 200;

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

function weekStartUTC(): Date {
  const now = new Date();
  const day = now.getUTCDay();
  const diffDays = day === 0 ? 6 : day - 1;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffDays));
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

    // Count energy already used today (first tap = daily_checkin, subsequent = energy_tap)
    const todayTaps = await prisma.seasonPoint.count({
      where: {
        userId: user.id,
        seasonId: season.id,
        category: { in: ["daily_checkin", "energy_tap"] },
        createdAt: { gte: todayStart, lt: todayEnd },
      },
    });

    if (todayTaps >= ENERGY_MAX) {
      const stats = await prisma.userSeasonStats.findUnique({
        where: { userId_seasonId: { userId: user.id, seasonId: season.id } },
      });
      return NextResponse.json({
        ok: true,
        alreadyDone: true,
        energyCurrent: 0,
        energyMax: ENERGY_MAX,
        totalPoints: stats?.totalPoints ?? 0,
        rank: stats?.rank ?? null,
        streak: stats?.streakCount ?? 0,
      });
    }

    const isFirstTap = todayTaps === 0;
    const pts = isFirstTap ? CHECKIN_POINTS : ENERGY_TAP_POINTS;
    const category = isFirstTap ? "daily_checkin" : "energy_tap";

    await prisma.seasonPoint.create({
      data: {
        userId: user.id,
        seasonId: season.id,
        points: pts,
        category,
        source: "EVENT",
        reason: isFirstTap ? "Daily check-in" : "Energy tap",
      },
    });

    // ── Streak logic ──────────────────────────────────────
    const existingStats = await prisma.userSeasonStats.findUnique({
      where: { userId_seasonId: { userId: user.id, seasonId: season.id } },
    });

    let newStreak = 1;
    if (existingStats?.lastCheckinAt) {
      const lastDate = existingStats.lastCheckinAt.toISOString().slice(0, 10);
      const today = todayUTCStr();
      const yesterday = yesterdayUTCStr();
      if (lastDate === yesterday) newStreak = (existingStats.streakCount || 0) + 1;
      else if (lastDate === today) newStreak = existingStats.streakCount || 1;
      else newStreak = 1;
    } else if (!isFirstTap) {
      // Legacy: user has daily_checkin today but streak was never initialized
      const hasTodayCheckin = await prisma.seasonPoint.findFirst({
        where: { userId: user.id, seasonId: season.id, category: "daily_checkin", createdAt: { gte: todayStart } },
      });
      if (hasTodayCheckin) {
        newStreak = 1;
        await prisma.userSeasonStats.update({
          where: { userId_seasonId: { userId: user.id, seasonId: season.id } },
          data: { streakCount: 1, lastCheckinAt: new Date() },
        });
      }
    }

    const statsUpdateData = isFirstTap
      ? {
          totalPoints: { increment: pts },
          eventsCount: { increment: 1 },
          lastEventAt: new Date(),
          streakCount: newStreak,
          lastCheckinAt: new Date(),
        }
      : {
          totalPoints: { increment: pts },
          eventsCount: { increment: 1 },
          lastEventAt: new Date(),
        };

    let updatedStats = await prisma.userSeasonStats.upsert({
      where: { userId_seasonId: { userId: user.id, seasonId: season.id } },
      create: {
        userId: user.id,
        seasonId: season.id,
        totalPoints: pts,
        eventsCount: 1,
        lastEventAt: new Date(),
        streakCount: isFirstTap ? 1 : 0,
        lastCheckinAt: isFirstTap ? new Date() : null,
      },
      update: statsUpdateData,
    });

    // ── Streak bonus ──────────────────────────────────────
    let streakBonus = 0;
    if (isFirstTap) {
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

    // ── Weekly mission: 5 check-ins this week ────────────
    let weeklyBonus = 0;
    let weeklyCheckins = 0;
    if (isFirstTap) {
      const weekStart = weekStartUTC();
      weeklyCheckins = await prisma.seasonPoint.count({
        where: {
          userId: user.id,
          seasonId: season.id,
          category: "daily_checkin",
          createdAt: { gte: weekStart },
        },
      });

      if (weeklyCheckins === WEEKLY_CHECKIN_GOAL) {
        const alreadyAwarded = await prisma.seasonPoint.findFirst({
          where: {
            userId: user.id,
            seasonId: season.id,
            category: "weekly_mission_checkin",
            createdAt: { gte: weekStart },
          },
        });
        if (!alreadyAwarded) {
          weeklyBonus = WEEKLY_CHECKIN_BONUS;
          await prisma.seasonPoint.create({
            data: {
              userId: user.id,
              seasonId: season.id,
              points: weeklyBonus,
              category: "weekly_mission_checkin",
              source: "BONUS",
              reason: `Weekly mission: ${WEEKLY_CHECKIN_GOAL} check-ins`,
            },
          });
          updatedStats = await prisma.userSeasonStats.update({
            where: { userId_seasonId: { userId: user.id, seasonId: season.id } },
            data: { totalPoints: { increment: weeklyBonus } },
          });
        }
      }
    }

    const energyAfter = Math.max(0, ENERGY_MAX - (todayTaps + 1));

    return NextResponse.json({
      ok: true,
      alreadyDone: false,
      isFirstTap,
      pointsAwarded: pts,
      streakBonus,
      weeklyBonus,
      totalBonus: pts + streakBonus + weeklyBonus,
      streak: isFirstTap ? newStreak : (existingStats?.streakCount ?? 0),
      energyCurrent: energyAfter,
      energyMax: ENERGY_MAX,
      weeklyCheckins,
      weeklyGoal: WEEKLY_CHECKIN_GOAL,
      totalPoints: updatedStats.totalPoints,
      rank: updatedStats.rank ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Check-in failed.";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
