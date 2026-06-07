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

    type SwapRow = {
      userId: number;
      username: string | null;
      firstName: string | null;
      swapCount: bigint;
      volumeCents: bigint;
      gigaWins: bigint;
      totalWinLamports: bigint;
    };

    let rows: SwapRow[];

    if (mode === "season" && activeSeason) {
      rows = await prisma.$queryRaw<SwapRow[]>`
        SELECT
          u.id                                                                         AS "userId",
          u.username                                                                   AS username,
          u."firstName"                                                                AS "firstName",
          COUNT(CASE WHEN sp.category = 'swap_mind_xnt' THEN 1 END)                  AS "swapCount",
          COALESCE(SUM(CASE WHEN sp.category = 'swap_mind_xnt'
            THEN (sp.metadata->>'usdCents')::bigint ELSE 0 END), 0)                  AS "volumeCents",
          COUNT(CASE WHEN sp.category = 'giga_swap_win' THEN 1 END)                  AS "gigaWins",
          COALESCE(SUM(CASE WHEN sp.category = 'giga_swap_win'
            THEN (sp.metadata->>'payout')::bigint ELSE 0 END), 0)                    AS "totalWinLamports"
        FROM "User" u
        JOIN "SeasonPoint" sp ON sp."userId" = u.id AND sp."seasonId" = ${activeSeason.id}
        GROUP BY u.id, u.username, u."firstName"
        HAVING COUNT(CASE WHEN sp.category = 'swap_mind_xnt' THEN 1 END) > 0
        ORDER BY "volumeCents" DESC
        LIMIT 20
      `;
    } else {
      rows = await prisma.$queryRaw<SwapRow[]>`
        SELECT
          u.id                                                                         AS "userId",
          u.username                                                                   AS username,
          u."firstName"                                                                AS "firstName",
          COUNT(CASE WHEN sp.category = 'swap_mind_xnt' THEN 1 END)                  AS "swapCount",
          COALESCE(SUM(CASE WHEN sp.category = 'swap_mind_xnt'
            THEN (sp.metadata->>'usdCents')::bigint ELSE 0 END), 0)                  AS "volumeCents",
          COUNT(CASE WHEN sp.category = 'giga_swap_win' THEN 1 END)                  AS "gigaWins",
          COALESCE(SUM(CASE WHEN sp.category = 'giga_swap_win'
            THEN (sp.metadata->>'payout')::bigint ELSE 0 END), 0)                    AS "totalWinLamports"
        FROM "User" u
        JOIN "SeasonPoint" sp ON sp."userId" = u.id
        GROUP BY u.id, u.username, u."firstName"
        HAVING COUNT(CASE WHEN sp.category = 'swap_mind_xnt' THEN 1 END) > 0
        ORDER BY "volumeCents" DESC
        LIMIT 20
      `;
    }

    const maxVol = rows.length > 0 ? Number(rows[0].volumeCents) : 1;

    const entries = rows.map((r, i) => ({
      rank: i + 1,
      userId: r.userId,
      name: r.username ? `@${r.username}` : (r.firstName ?? `Operator #${r.userId}`),
      swapCount: Number(r.swapCount),
      volumeUsd: Number(r.volumeCents) / 100,
      gigaWins: Number(r.gigaWins),
      totalWinXnt: Number(r.totalWinLamports) / 1e9,
      volPct: maxVol > 0 ? Math.round((Number(r.volumeCents) / maxVol) * 100) : 0,
      winRate: Number(r.swapCount) > 0
        ? Math.round((Number(r.gigaWins) / Number(r.swapCount)) * 100)
        : 0,
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
