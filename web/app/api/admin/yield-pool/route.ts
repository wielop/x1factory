import { NextResponse } from "next/server";
import { getStoredPoolXnt, setStoredPoolXnt } from "@/lib/yieldPoolStore";
import { getWeeklyPoolXnt } from "@/lib/yieldMath";

type PostBody = { value?: unknown };

export async function GET() {
  const stored = getStoredPoolXnt();
  const fallback = getWeeklyPoolXnt();
  return NextResponse.json({
    value: stored?.value ?? fallback,
    updatedAt: stored?.updatedAt ?? null,
    source: stored ? "override" : "env",
  });
}

export async function POST(request: Request) {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = typeof body.value === "string" ? Number(body.value) : Number(body.value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return NextResponse.json({ error: "Invalid pool value" }, { status: 400 });
  }
  const stored = setStoredPoolXnt(parsed);
  return NextResponse.json({ ok: true, value: stored.value, updatedAt: stored.updatedAt });
}
