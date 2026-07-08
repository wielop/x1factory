import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Keep this bounded — the keeper samples roughly once a minute, so a week is ~10k rows max.
const MAX_POINTS = 2000;

export async function GET(req: NextRequest, { params }: { params: { mint: string } }) {
  try {
    const { searchParams } = new URL(req.url);
    const sinceParam = searchParams.get("sinceHours");
    const sinceHours = sinceParam ? Number(sinceParam) : 24 * 7;
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

    const points = await prisma.launchpadPricePoint.findMany({
      where: { mint: params.mint, createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: { priceUsd: true, createdAt: true },
      take: MAX_POINTS,
    });

    return NextResponse.json({
      ok: true,
      points: points.map((p) => ({ t: p.createdAt.getTime(), priceUsd: p.priceUsd })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load history";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
