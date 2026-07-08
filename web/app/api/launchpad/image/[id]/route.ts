import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const image = await prisma.launchpadImage.findUnique({ where: { id: params.id } });
  if (!image) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(image.data), {
    headers: {
      "Content-Type": image.mimeType,
      // Immutable: uploads are never edited in place, a new upload gets a new id.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
