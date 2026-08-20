import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  AccountMeta,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  BEDROCK_RPC_URL,
  CLAIMS_V1_PROGRAM_ID,
  MELT_ROUND_V2_PROGRAM_ID,
  ORE_MINT,
  CONFIG_PDA,
  VEIN0_PDA,
  MELT_CONFIG_PDA,
  MELT_ROUND0_PDA,
  MELT_POT_VAULT,
  STAKING_REWARD_VAULT_PDA,
  TREASURY_VAULT_PDA,
  POL_TREASURY_PDA,
  deriveProfilePda,
  derivePositionPda,
} from "@/lib/bedrock/constants";
import { encodeClaimsIx, tryDecodeClaimsAccount } from "@/lib/bedrock/coder";
import { BN } from "@coral-xyz/anchor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function ix(programId: PublicKey, keys: AccountMeta[], data: Buffer): TransactionInstruction {
  return new TransactionInstruction({ programId, keys, data });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.action !== "string" || typeof body.owner !== "string") {
    return NextResponse.json({ error: "Missing action/owner" }, { status: 400 });
  }

  let owner: PublicKey;
  try {
    owner = new PublicKey(body.owner);
  } catch {
    return NextResponse.json({ error: "Invalid owner pubkey" }, { status: 400 });
  }

  const connection = new Connection(BEDROCK_RPC_URL, "confirmed");
  const tx = new Transaction();

  if (body.action === "buy_claim") {
    const tier = Number(body.tier);
    const requestedHp = BigInt(body.requestedHp ?? 0);
    if (!Number.isInteger(tier) || tier < 0 || tier > 3 || requestedHp <= 0n) {
      return NextResponse.json({ error: "Invalid tier/requestedHp" }, { status: 400 });
    }

    const profilePda = deriveProfilePda(owner);
    const profileInfo = await connection.getAccountInfo(profilePda);
    let nextPositionIndex = 0n;
    if (profileInfo) {
      const profile = tryDecodeClaimsAccount<{ nextPositionIndex: { toString(): string } }>(
        "UserProfile",
        profileInfo.data
      );
      if (profile) nextPositionIndex = BigInt(profile.nextPositionIndex.toString());
    }
    const positionPda = derivePositionPda(owner, nextPositionIndex);

    const data = encodeClaimsIx("buyClaim", { tier, requestedHp: new BN(requestedHp.toString()) });
    const keys: AccountMeta[] = [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
      { pubkey: VEIN0_PDA, isSigner: false, isWritable: true },
      { pubkey: profilePda, isSigner: false, isWritable: true },
      { pubkey: positionPda, isSigner: false, isWritable: true },
      { pubkey: STAKING_REWARD_VAULT_PDA, isSigner: false, isWritable: true },
      { pubkey: TREASURY_VAULT_PDA, isSigner: false, isWritable: true },
      { pubkey: POL_TREASURY_PDA, isSigner: false, isWritable: true },
      { pubkey: MELT_ROUND_V2_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MELT_CONFIG_PDA, isSigner: false, isWritable: true },
      { pubkey: MELT_POT_VAULT, isSigner: false, isWritable: true },
      { pubkey: MELT_ROUND0_PDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    tx.add(ix(CLAIMS_V1_PROGRAM_ID, keys, data));
  } else if (body.action === "claim_ore") {
    const positionIndex = BigInt(body.positionIndex ?? -1);
    if (positionIndex < 0n) {
      return NextResponse.json({ error: "Invalid positionIndex" }, { status: 400 });
    }
    const profilePda = deriveProfilePda(owner);
    const positionPda = derivePositionPda(owner, positionIndex);
    const ownerOreAta = await getAssociatedTokenAddress(ORE_MINT, owner);

    const ataInfo = await connection.getAccountInfo(ownerOreAta);
    if (!ataInfo) {
      tx.add(createAssociatedTokenAccountInstruction(owner, ownerOreAta, owner, ORE_MINT));
    }

    const data = encodeClaimsIx("claimOre", {});
    const keys: AccountMeta[] = [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
      { pubkey: VEIN0_PDA, isSigner: false, isWritable: true },
      { pubkey: profilePda, isSigner: false, isWritable: false },
      { pubkey: positionPda, isSigner: false, isWritable: true },
      { pubkey: ORE_MINT, isSigner: false, isWritable: true },
      { pubkey: ownerOreAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    tx.add(ix(CLAIMS_V1_PROGRAM_ID, keys, data));
  } else {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  tx.feePayer = owner;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return NextResponse.json({
    transaction: serialized.toString("base64"),
    lastValidBlockHeight,
  });
}
