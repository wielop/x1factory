import "server-only";

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import bs58 from "bs58";
import { NextResponse } from "next/server";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { fetchClockUnixTs } from "@/lib/solana";
import {
  deriveX1MindConfigPda,
  deriveX1MindMindVaultAuthority,
  deriveX1MindRoundPda,
} from "@/lib/x1mind";
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

const roundIdMemcmp = (roundId: bigint) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(roundId);
  // UserEntry layout: 8 discriminator + 32 owner + 8 round_id
  return { memcmp: { offset: 8 + 32, bytes: bs58.encode(buf) } };
};

const isAuthorized = (req: Request) => {
  const secret = (process.env.CRON_SECRET ?? "9988").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return token === secret;
};

async function payoutWinners(params: {
  program: anchor.Program;
  roundId: bigint;
  round: any;
  actions: string[];
}) {
  const { program, roundId, round, actions } = params;
  const connection = program.provider.connection;
  const walletPubkey = program.provider.publicKey as PublicKey;
  const winningIdx = Number(round.winningCell ?? 0);
  const totalWinning = toBigInt(round.totalPerCell?.[winningIdx] ?? 0n);
  if (totalWinning === 0n) return;

  const entries = await connection.getProgramAccounts(program.programId, {
    filters: [roundIdMemcmp(roundId)],
  });

  for (const { pubkey, account } of entries) {
    const entry = program.coder.accounts.decode("UserEntry", account.data) as any;
    if (entry.claimed) continue;
    const deposit = toBigInt(entry.deposits?.[winningIdx] ?? 0n);
    if (deposit === 0n) continue;

    const owner = entry.owner as PublicKey;
    const ownerAta = getAssociatedTokenAddressSync(new PublicKey(round.mindMint), owner, false);
    const ixs = [];
    const ataInfo = await connection.getAccountInfo(ownerAta);
    if (!ataInfo) {
      ixs.push(
        createAssociatedTokenAccountInstruction(
          walletPubkey,
          ownerAta,
          owner,
          new PublicKey(round.mindMint)
        )
      );
    }

    const payoutIx = await program.methods
      .payoutWinner()
      .accounts({
        round: deriveX1MindRoundPda(roundId),
        userEntry: pubkey,
        owner,
        ownerMindAta: ownerAta,
        mindVault: new PublicKey(round.mindVault),
        mindVaultAuthority: deriveX1MindMindVaultAuthority(),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    ixs.push(payoutIx);

    const tx = new Transaction().add(...ixs);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = walletPubkey;
    const provider = program.provider as anchor.AnchorProvider;
    const sig = await provider.sendAndConfirm(tx, []);
    actions.push(`payout:${pubkey.toBase58()}:${owner.toBase58()}:${sig}`);
  }
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { connection, keypair, program } = getX1MindAdminContext();
    const configPda = deriveX1MindConfigPda();
    const config = await program.account.config.fetch(configPda);
    const currentRoundId = toBigInt(config.currentRoundId);
    const adminKey = config.admin?.toBase58?.() ?? "";
    if (adminKey && adminKey !== keypair.publicKey.toBase58()) {
      return NextResponse.json(
        { error: "Admin key mismatch", adminKey, signer: keypair.publicKey.toBase58() },
        { status: 403 }
      );
    }

    const actions: string[] = [];
    const now = await fetchClockUnixTs(connection);

    let round: any | null = null;
    try {
      round = await program.account.round.fetch(deriveX1MindRoundPda(currentRoundId));
    } catch {
      round = null;
    }

    const nextRoundId = currentRoundId + 1n;

    if (!round) {
      actions.push("round_missing");
      const sig = await program.methods
        .startRound(new BN(nextRoundId.toString()))
        .accounts({
          config: configPda,
          admin: keypair.publicKey,
          round: deriveX1MindRoundPda(nextRoundId),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      actions.push(`start:${sig}`);
      return NextResponse.json({ ok: true, actions, now, currentRoundId: currentRoundId.toString() });
    }

    let finalizedRound: any | null = round.finalized ? round : null;

    if (!round.finalized && now > toNumber(round.endTs)) {
      const sig = await program.methods
        .finalizeRound(new BN(currentRoundId.toString()))
        .accounts({
          config: configPda,
          admin: keypair.publicKey,
          round: deriveX1MindRoundPda(currentRoundId),
          buybackWallet: config.buybackWallet,
          adminWallet: config.adminWallet,
          motherlodeVault: config.motherlodeVault,
          mindVault: config.mindVault,
          mindVaultAuthority: deriveX1MindMindVaultAuthority(),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      actions.push(`finalize:${sig}`);
      finalizedRound = await program.account.round.fetch(deriveX1MindRoundPda(currentRoundId));
    }

    if (finalizedRound) {
      await payoutWinners({ program, roundId: currentRoundId, round: finalizedRound, actions });
      let nextRoundExists = false;
      try {
        await program.account.round.fetch(deriveX1MindRoundPda(nextRoundId));
        nextRoundExists = true;
      } catch {
        nextRoundExists = false;
      }
      if (!nextRoundExists) {
        const sig = await program.methods
          .startRound(new BN(nextRoundId.toString()))
          .accounts({
            config: configPda,
            admin: keypair.publicKey,
            round: deriveX1MindRoundPda(nextRoundId),
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        actions.push(`start:${sig}`);
      }
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
