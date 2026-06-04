import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseTelegramWebAppAuth } from "@/lib/webAppAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function shortWallet(address: string) {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

export async function POST(req: NextRequest) {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  const auth = parseTelegramWebAppAuth(initData, process.env.BOT_TOKEN ?? "");

  if (!auth) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { address?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  const address = (body.address ?? "").trim();

  if (!SOLANA_ADDRESS_RE.test(address)) {
    return NextResponse.json({ ok: false, error: "Invalid Solana wallet address." }, { status: 400 });
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

    const existing = await prisma.wallet.findUnique({ where: { address } });

    if (existing && existing.userId && existing.userId !== user.id) {
      return NextResponse.json(
        { ok: false, error: "This wallet is already registered to another account." },
        { status: 409 }
      );
    }

    const wallet = await prisma.$transaction(async (tx) => {
      const w = await tx.wallet.upsert({
        where: { address },
        create: { address, userId: user.id, isActive: true },
        update: { userId: user.id, isActive: true },
      });

      await tx.wallet.updateMany({
        where: { userId: user.id, NOT: { id: w.id } },
        data: { isActive: false },
      });

      await tx.user.update({
        where: { id: user.id },
        data: { activeWalletId: w.id },
      });

      return w;
    });

    return NextResponse.json({
      ok: true,
      wallet: { address: wallet.address, short: shortWallet(wallet.address) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
