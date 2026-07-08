import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "No file provided" }, { status: 400 });
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json({ ok: false, error: "Only PNG, JPEG, GIF or WebP images are allowed" }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ ok: false, error: "Image too large (max 5MB)" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const image = await prisma.launchpadImage.create({
      data: { data: buffer, mimeType: file.type },
      select: { id: true },
    });

    const origin = req.nextUrl.origin;
    return NextResponse.json({ ok: true, url: `${origin}/api/launchpad/image/${image.id}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
