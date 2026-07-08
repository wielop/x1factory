import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PINATA_UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function gatewayUrl(cid: string): string {
  const domain = process.env.PINATA_GATEWAY_DOMAIN || "gateway.pinata.cloud";
  return `https://${domain}/ipfs/${cid}`;
}

export async function POST(req: NextRequest) {
  try {
    const jwt = process.env.PINATA_JWT;
    if (!jwt) {
      return NextResponse.json({ ok: false, error: "Image upload not configured (missing PINATA_JWT)" }, { status: 500 });
    }

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

    const uploadForm = new FormData();
    uploadForm.append("file", file, file.name || "token-image");
    uploadForm.append("network", "public");
    uploadForm.append("name", file.name || "token-image");

    const res = await fetch(PINATA_UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: uploadForm,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return NextResponse.json({ ok: false, error: `Pinata upload failed (${res.status}): ${errText}` }, { status: 502 });
    }
    const data = await res.json();
    const cid = data?.data?.cid;
    if (!cid) {
      return NextResponse.json({ ok: false, error: "Pinata did not return a cid" }, { status: 502 });
    }

    return NextResponse.json({ ok: true, url: gatewayUrl(cid) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
