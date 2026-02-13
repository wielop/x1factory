import "server-only";

import { NextResponse } from "next/server";
import { SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  createMeltConnection,
  deriveMeltRoundPda,
  getMeltProgramId,
  getMeltRpcUrl,
  isCronAuthorized,
  ixDiscriminator,
  loadKeeper,
  readMeltConfigSnapshot,
  readMeltRoundSnapshot,
} from "@/lib/server/meltCron";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const connection = createMeltConnection();
    const programId = getMeltProgramId();
    const keeper = loadKeeper();
    const dryRun = process.env.CRON_DRY_RUN === "1";
    const nowTs = Math.floor(Date.now() / 1000);

    console.log("[melt-cron] finalize:start", {
      rpc: getMeltRpcUrl(),
      programId: programId.toBase58(),
      keeper: keeper.publicKey.toBase58(),
      dryRun,
    });

    const config = await readMeltConfigSnapshot(connection, programId);
    if (!config || !config.activeRoundActive) {
      console.log("[melt-cron] finalize:skip no active round");
      return NextResponse.json({ ok: true, skipped: "no active round" });
    }

    const roundPda = deriveMeltRoundPda(programId, config.activeRoundSeq);
    const round = await readMeltRoundSnapshot(connection, roundPda);
    if (!round || round.status !== 1) {
      console.log("[melt-cron] finalize:skip no active round account");
      return NextResponse.json({ ok: true, skipped: "no active round" });
    }
    if (nowTs < round.endTs) {
      console.log("[melt-cron] finalize:skip not ended", {
        seq: round.seq.toString(),
        nowTs,
        endTs: round.endTs,
      });
      return NextResponse.json({
        ok: true,
        skipped: "not ended",
        nowTs,
        round: { seq: round.seq.toString(), endTs: round.endTs },
      });
    }

    const nextRoundPda = deriveMeltRoundPda(programId, config.roundSeq);
    const plan = {
      nowTs,
      round: { seq: round.seq.toString(), endTs: round.endTs, pda: roundPda.toBase58() },
      nextRoundPda: nextRoundPda.toBase58(),
      configPda: config.configPda.toBase58(),
      vault: config.vault.toBase58(),
    };

    if (dryRun) {
      console.log("[melt-cron] finalize:dry-run", plan);
      return NextResponse.json({ ok: true, dryRun: true, would: "finalize", ...plan });
    }

    const ix = new TransactionInstruction({
      programId,
      data: ixDiscriminator("finalize_round"),
      keys: [
        { pubkey: keeper.publicKey, isSigner: true, isWritable: true }, // admin
        { pubkey: config.configPda, isSigner: false, isWritable: true }, // config
        { pubkey: roundPda, isSigner: false, isWritable: true }, // round
        { pubkey: config.vault, isSigner: false, isWritable: false }, // vault
        { pubkey: nextRoundPda, isSigner: false, isWritable: true }, // next_round (init_if_needed)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = keeper.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.sign(keeper);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );

    console.log("[melt-cron] finalize:ok", { sig, seq: round.seq.toString() });
    return NextResponse.json({
      ok: true,
      signature: sig,
      round: { seq: round.seq.toString(), pda: roundPda.toBase58() },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[melt-cron] finalize:error", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

