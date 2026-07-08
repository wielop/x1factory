import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Keep this bounded — the keeper samples roughly once a minute, so 90 days is ~130k rows max
// for a mint. Fetch the most RECENT points up to this cap (not the oldest), since callers
// asking for a long range (e.g. daily candles over 90 days) still mainly care about recency.
const MAX_POINTS = 5000;

export async function GET(req: NextRequest, { params }: { params: { mint: string } }) {
  try {
    const { searchParams } = new URL(req.url);
    const sinceParam = searchParams.get("sinceHours");
    const sinceHours = sinceParam ? Number(sinceParam) : 24 * 7;
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

    const points = await prisma.launchpadPricePoint.findMany({
      where: { mint: params.mint, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      select: { priceUsd: true, createdAt: true },
      take: MAX_POINTS,
    });
    points.reverse(); // back to ascending order for charting

    return NextResponse.json({
      ok: true,
      points: points.map((p) => ({ t: p.createdAt.getTime(), priceUsd: p.priceUsd })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load history";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
