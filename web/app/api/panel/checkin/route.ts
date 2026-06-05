import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseTelegramWebAppAuth } from "@/lib/webAppAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CHECKIN_POINTS = 10;

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

    const todayUtcStart = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
    const todayUtcEnd = new Date(todayUtcStart.getTime() + 86400000);

    const existing = await prisma.seasonPoint.findFirst({
      where: {
        userId: user.id,
        seasonId: season.id,
        category: "daily_checkin",
        createdAt: { gte: todayUtcStart, lt: todayUtcEnd },
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
      });
    }

    // Award points
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

    // Update stats
    const updatedStats = await prisma.userSeasonStats.upsert({
      where: { userId_seasonId: { userId: user.id, seasonId: season.id } },
      create: {
        userId: user.id,
        seasonId: season.id,
        totalPoints: CHECKIN_POINTS,
        eventsCount: 1,
        lastEventAt: new Date(),
      },
      update: {
        totalPoints: { increment: CHECKIN_POINTS },
        eventsCount: { increment: 1 },
        lastEventAt: new Date(),
      },
    });

    return NextResponse.json({
      ok: true,
      alreadyDone: false,
      pointsAwarded: CHECKIN_POINTS,
      totalPoints: updatedStats.totalPoints,
      rank: updatedStats.rank ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Check-in failed.";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
