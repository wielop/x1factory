import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  AccountMeta,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import {
  LAUNCHPAD_PROGRAM_ID,
  CONFIG_PDA,
  TREASURY_VAULT_PDA,
  curvePda,
  curveXntVaultPda,
  rewardPoolXntVaultPda,
  curveTokenVaultPda,
  rewardPoolTokenVaultPda,
  anchorDiscriminator,
  encodeU64LE,
  parseBondingCurve,
  BONDING_CURVE_SIZE,
  quoteBuy,
  quoteSell,
} from "@/lib/launchpad";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RPC = "https://rpc.mainnet.x1.xyz";
const DISC_BUY = anchorDiscriminator("buy");
const DISC_SELL = anchorDiscriminator("sell");

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      walletAddress?: string;
      mint?: string;
      side?: "buy" | "sell";
      amount?: string;
      slippageBps?: number;
    };
    const { walletAddress, mint: mintStr, side, amount: amountStr, slippageBps = 100 } = body;

    if (!walletAddress || !mintStr || !side || !amountStr) {
      return NextResponse.json(
        { ok: false, error: "walletAddress, mint, side and amount are required" },
        { status: 400 }
      );
    }
    if (side !== "buy" && side !== "sell") {
      return NextResponse.json({ ok: false, error: "side must be buy or sell" }, { status: 400 });
    }

    let user: PublicKey;
    let mint: PublicKey;
    try {
      user = new PublicKey(walletAddress);
      mint = new PublicKey(mintStr);
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid public key" }, { status: 400 });
    }

    const amount = BigInt(amountStr);
    if (amount <= 0n) return NextResponse.json({ ok: false, error: "amount must be > 0" }, { status: 400 });

    const conn = new Connection(RPC, "confirmed");
    const curve = curvePda(mint);
    const curveXntVault = curveXntVaultPda(mint);
    const rewardPoolXntVault = rewardPoolXntVaultPda(mint);
    const curveTokenVault = curveTokenVaultPda(mint);
    const rewardPoolTokenVault = rewardPoolTokenVaultPda(mint);

    const curveInfo = await conn.getAccountInfo(curve);
    if (!curveInfo || curveInfo.data.length < BONDING_CURVE_SIZE) {
      return NextResponse.json({ ok: false, error: "Curve not found for this mint" }, { status: 404 });
    }
    const curveState = parseBondingCurve(curveInfo.data, curve);
    if (curveState.complete) {
      return NextResponse.json({ ok: false, error: "This curve has already graduated" }, { status: 400 });
    }

    const userTokenAccount = await getAssociatedTokenAddress(mint, user);
    const preIxs: TransactionInstruction[] = [];
    const userAtaInfo = await conn.getAccountInfo(userTokenAccount);
    if (!userAtaInfo) {
      preIxs.push(createAssociatedTokenAccountInstruction(user, userTokenAccount, user, mint));
    }

    let minOut: bigint;
    let estOut: bigint;
    if (side === "buy") {
      const q = quoteBuy(curveState, amount);
      if (q.soldOut) return NextResponse.json({ ok: false, error: "Not enough tokens left on the curve" }, { status: 400 });
      estOut = q.tokensOut;
      minOut = (q.tokensOut * BigInt(10_000 - slippageBps)) / 10_000n;
    } else {
      const q = quoteSell(curveState, amount);
      if (q.insufficientLiquidity) return NextResponse.json({ ok: false, error: "Not enough XNT liquidity on the curve" }, { status: 400 });
      estOut = q.netXntOut;
      minOut = (q.netXntOut * BigInt(10_000 - slippageBps)) / 10_000n;
    }

    const keys: AccountMeta[] = [
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
      { pubkey: TREASURY_VAULT_PDA, isSigner: false, isWritable: true },
      { pubkey: curve, isSigner: false, isWritable: true },
      { pubkey: curveXntVault, isSigner: false, isWritable: true },
      { pubkey: rewardPoolXntVault, isSigner: false, isWritable: true },
      { pubkey: curveTokenVault, isSigner: false, isWritable: true },
      { pubkey: rewardPoolTokenVault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    const disc = side === "buy" ? DISC_BUY : DISC_SELL;
    const data = Buffer.concat([disc, encodeU64LE(amount), encodeU64LE(minOut)]);
    const tradeIx = new TransactionInstruction({ programId: LAUNCHPAD_PROGRAM_ID, keys, data });

    const tx = new Transaction();
    for (const pre of preIxs) tx.add(pre);
    tx.add(tradeIx);

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = user;

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

    return NextResponse.json({
      ok: true,
      transaction: serialized.toString("base64"),
      lastValidBlockHeight,
      estimatedOut: estOut.toString(),
      minOut: minOut.toString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Prepare failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
