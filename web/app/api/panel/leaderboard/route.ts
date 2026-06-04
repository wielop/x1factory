import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseTelegramWebAppAuth } from "@/lib/webAppAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
      update: { lastSeenAt: new Date() },
    });

    const season = await prisma.season.findFirst({
      where: { status: { in: ["ACTIVE", "UPCOMING"] } },
      orderBy: { startsAt: "asc" },
    });

    if (!season) {
      return NextResponse.json({ ok: true, season: null, myRank: null, rows: [] });
    }

    const [topStats, myStats] = await Promise.all([
      prisma.userSeasonStats.findMany({
        where: { seasonId: season.id },
        orderBy: [{ rank: "asc" }, { totalPoints: "desc" }],
        take: 50,
        include: { user: true },
      }),
      prisma.userSeasonStats.findUnique({
        where: { userId_seasonId: { userId: user.id, seasonId: season.id } },
      }),
    ]);

    return NextResponse.json({
      ok: true,
      season: { id: season.id, name: season.name },
      myRank: myStats?.rank ?? null,
      rows: topStats.map((s, i) => ({
        rank: s.rank ?? i + 1,
        telegramId: s.user.telegramId.toString(),
        username: s.user.username,
        firstName: s.user.firstName,
        points: s.totalPoints,
        eventsCount: s.eventsCount,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
