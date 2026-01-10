import { NextResponse } from "next/server";
import { getYieldPoolConfig, setYieldPoolConfig } from "@/lib/yieldPoolStore";

const parseValue = (raw: unknown) => {
  if (raw == null) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
};

export async function GET() {
  return NextResponse.json(getYieldPoolConfig(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  let payload: { currentPoolXnt?: unknown; nextPoolXnt?: unknown } | null = null;
  try {
    payload = (await req.json()) as { currentPoolXnt?: unknown; nextPoolXnt?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const currentPoolXnt = parseValue(payload?.currentPoolXnt);
  const nextPoolXnt = parseValue(payload?.nextPoolXnt);
  if (currentPoolXnt == null || nextPoolXnt == null) {
    return NextResponse.json({ error: "Invalid pool values" }, { status: 400 });
  }

  setYieldPoolConfig(currentPoolXnt, nextPoolXnt);
  return NextResponse.json(getYieldPoolConfig(), { headers: { "Cache-Control": "no-store" } });
}
