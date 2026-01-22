import "server-only";

import { NextResponse } from "next/server";
import { BN } from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import { fetchClockUnixTs } from "@/lib/solana";
import { deriveX1MindConfigPda, deriveX1MindRoundPda } from "@/lib/x1mind";
import { getX1MindAdminContext } from "@/lib/x1mindAdmin";

export const runtime = "nodejs";

const toBigInt = (value: unknown): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) {
    return BigInt((value as { toString: () => string }).toString());
  }
  return 0n;
};

const toNumber = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "toString" in value) {
    return Number((value as { toString: () => string }).toString());
  }
  return 0;
};

const isAuthorized = (req: Request) => {
  // Fallback token if env not set; override with CRON_SECRET in production.
  const secret = (process.env.CRON_SECRET ?? "9988").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return token === secret;
};

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { connection, keypair, program } = getX1MindAdminContext();
    const config = await program.account.config.fetch(deriveX1MindConfigPda());
    const currentRoundId = toBigInt(config.currentRoundId);
    const adminKey = config.admin?.toBase58?.() ?? "";
    if (adminKey && adminKey !== keypair.publicKey.toBase58()) {
      return NextResponse.json(
        { error: "Admin key mismatch", adminKey, signer: keypair.publicKey.toBase58() },
        { status: 403 }
      );
    }

    let round: any | null = null;
    try {
      round = await program.account.round.fetch(deriveX1MindRoundPda(currentRoundId));
    } catch {
      round = null;
    }

    const actions: string[] = [];
    const now = await fetchClockUnixTs(connection);
    const nextRoundId = currentRoundId + 1n;
    let finalized = false;

    if (!round) {
      actions.push("round_missing");
      if (currentRoundId === 0n) {
        const sig = await program.methods
          .startRound(new BN(nextRoundId.toString()))
          .accounts({
            config: deriveX1MindConfigPda(),
            admin: keypair.publicKey,
            round: deriveX1MindRoundPda(nextRoundId),
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        actions.push(`start:${sig}`);
      }
      return NextResponse.json({ ok: true, actions, now, currentRoundId: currentRoundId.toString() });
    }

    const revealEnd = toNumber(round.revealEndTs);
    const isFinalized = Boolean(round.finalized);
    if (!isFinalized && now > revealEnd) {
      const sig = await program.methods
        .finalizeRound(new BN(currentRoundId.toString()))
        .accounts({
          config: deriveX1MindConfigPda(),
          admin: keypair.publicKey,
          round: deriveX1MindRoundPda(currentRoundId),
          buybackWallet: config.buybackWallet,
          adminWallet: config.adminWallet,
          motherlodeVault: config.motherlodeVault,
          mindVault: config.mindVault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      actions.push(`finalize:${sig}`);
      finalized = true;
    }

    if (isFinalized || finalized) {
      const sig = await program.methods
        .startRound(new BN(nextRoundId.toString()))
        .accounts({
          config: deriveX1MindConfigPda(),
          admin: keypair.publicKey,
          round: deriveX1MindRoundPda(nextRoundId),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      actions.push(`start:${sig}`);
    }

    return NextResponse.json({
      ok: true,
      actions,
      now,
      currentRoundId: currentRoundId.toString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
