import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const revalidate = 60;

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const mode = searchParams.get("mode") ?? "season"; // "season" | "alltime"

    const activeSeason = await prisma.season.findFirst({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
    });

    type LaunchpadRow = {
      userId: number;
      username: string | null;
      firstName: string | null;
      tradeCount: bigint;
      volumeCents: bigint;
      gigaWins: bigint;
      totalWinCents: bigint;
    };

    let rows: LaunchpadRow[];

    if (mode === "season" && activeSeason) {
      rows = await prisma.$queryRaw<LaunchpadRow[]>`
        SELECT
          u.id                                                                              AS "userId",
          u.username                                                                        AS username,
          u."firstName"                                                                     AS "firstName",
          COUNT(CASE WHEN sp.category = 'launchpad_trade' THEN 1 END)                     AS "tradeCount",
          COALESCE(SUM(CASE WHEN sp.category = 'launchpad_trade'
            THEN (sp.metadata->>'usdCents')::bigint ELSE 0 END), 0)                       AS "volumeCents",
          COUNT(CASE WHEN sp.category = 'launchpad_giga_win' THEN 1 END)                  AS "gigaWins",
          COALESCE(SUM(CASE WHEN sp.category = 'launchpad_giga_win'
            THEN (sp.metadata->>'payoutUsdCents')::bigint ELSE 0 END), 0)                 AS "totalWinCents"
        FROM "User" u
        JOIN "SeasonPoint" sp ON sp."userId" = u.id AND sp."seasonId" = ${activeSeason.id}
        GROUP BY u.id, u.username, u."firstName"
        HAVING COUNT(CASE WHEN sp.category = 'launchpad_trade' THEN 1 END) > 0
        ORDER BY "volumeCents" DESC
        LIMIT 20
      `;
    } else {
      rows = await prisma.$queryRaw<LaunchpadRow[]>`
        SELECT
          u.id                                                                              AS "userId",
          u.username                                                                        AS username,
          u."firstName"                                                                     AS "firstName",
          COUNT(CASE WHEN sp.category = 'launchpad_trade' THEN 1 END)                     AS "tradeCount",
          COALESCE(SUM(CASE WHEN sp.category = 'launchpad_trade'
            THEN (sp.metadata->>'usdCents')::bigint ELSE 0 END), 0)                       AS "volumeCents",
          COUNT(CASE WHEN sp.category = 'launchpad_giga_win' THEN 1 END)                  AS "gigaWins",
          COALESCE(SUM(CASE WHEN sp.category = 'launchpad_giga_win'
            THEN (sp.metadata->>'payoutUsdCents')::bigint ELSE 0 END), 0)                 AS "totalWinCents"
        FROM "User" u
        JOIN "SeasonPoint" sp ON sp."userId" = u.id
        GROUP BY u.id, u.username, u."firstName"
        HAVING COUNT(CASE WHEN sp.category = 'launchpad_trade' THEN 1 END) > 0
        ORDER BY "volumeCents" DESC
        LIMIT 20
      `;
    }

    const maxVol = rows.length > 0 ? Number(rows[0].volumeCents) : 1;

    const entries = rows.map((r, i) => ({
      rank: i + 1,
      userId: r.userId,
      name: r.username ? `@${r.username}` : (r.firstName ?? `Operator #${r.userId}`),
      tradeCount: Number(r.tradeCount),
      volumeUsd: Number(r.volumeCents) / 100,
      gigaWins: Number(r.gigaWins),
      totalWinUsd: Number(r.totalWinCents) / 100,
      volPct: maxVol > 0 ? Math.round((Number(r.volumeCents) / maxVol) * 100) : 0,
    }));

    return NextResponse.json({
      ok: true,
      mode,
      season: activeSeason ? { id: activeSeason.id, name: activeSeason.name } : null,
      entries,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Leaderboard failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
