import "server-only";

import { NextResponse } from "next/server";
import {
  EXPECTED_KEEPER_PUBKEY,
  getMeltProgramId,
  getMeltRpcUrl,
  loadKeeper,
} from "@/lib/server/meltCron";

export const runtime = "nodejs";

export async function GET() {
  try {
    const keeper = loadKeeper();
    const programId = getMeltProgramId();
    const rpcUrl = getMeltRpcUrl();
    return NextResponse.json({
      ok: true,
      rpcUrl,
      programId: programId.toBase58(),
      keeperPubkey: keeper.publicKey.toBase58(),
      expectedKeeperPubkey: EXPECTED_KEEPER_PUBKEY.toBase58(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

