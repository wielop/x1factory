import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  AccountMeta,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
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
  gradReserveVaultPda,
  anchorDiscriminator,
  encodeBorshString,
  encodeU64LE,
  buildCreateMetadataV3Instruction,
  APP_BASE_URL,
} from "@/lib/launchpad";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RPC = "https://rpc.mainnet.x1.xyz";

const DISC_CREATE_MINT = anchorDiscriminator("create_mint");
const DISC_INIT_CURVE = anchorDiscriminator("init_curve");
const DISC_INIT_CURVE_TOKEN_VAULT = anchorDiscriminator("init_curve_token_vault");
const DISC_INIT_REWARD_POOL_TOKEN_VAULT = anchorDiscriminator("init_reward_pool_token_vault");
const DISC_INIT_GRAD_RESERVE_VAULT = anchorDiscriminator("init_grad_reserve_vault");
const DISC_FINALIZE_TOKEN = anchorDiscriminator("finalize_token");

function ix(programId: PublicKey, keys: AccountMeta[], data: Buffer): TransactionInstruction {
  return new TransactionInstruction({ programId, keys, data });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      walletAddress?: string;
      mintAddress?: string;
      name?: string;
      symbol?: string;
      uri?: string;
      initialRewardPoolXnt?: string;
    };
    const { walletAddress, mintAddress, name, symbol, uri, initialRewardPoolXnt = "0" } = body;

    if (!walletAddress || !mintAddress || !name || !symbol) {
      return NextResponse.json(
        { ok: false, error: "walletAddress, mintAddress, name and symbol are required" },
        { status: 400 }
      );
    }
    if (name.length > 32) return NextResponse.json({ ok: false, error: "Name too long (max 32)" }, { status: 400 });
    if (symbol.length > 10) return NextResponse.json({ ok: false, error: "Symbol too long (max 10)" }, { status: 400 });
    if ((uri ?? "").length > 200) return NextResponse.json({ ok: false, error: "URI too long (max 200)" }, { status: 400 });

    let creator: PublicKey;
    let mint: PublicKey;
    try {
      creator = new PublicKey(walletAddress);
      mint = new PublicKey(mintAddress);
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid public key" }, { status: 400 });
    }

    const conn = new Connection(RPC, "confirmed");
    const initialSeed = BigInt(initialRewardPoolXnt || "0");
    if (initialSeed < 0n) {
      return NextResponse.json({ ok: false, error: "initialRewardPoolXnt must be >= 0" }, { status: 400 });
    }

    const curve = curvePda(mint);
    const curveXntVault = curveXntVaultPda(mint);
    const rewardPoolXntVault = rewardPoolXntVaultPda(mint);
    const curveTokenVault = curveTokenVaultPda(mint);
    const rewardPoolTokenVault = rewardPoolTokenVaultPda(mint);
    const gradReserveVault = gradReserveVaultPda(mint);
    const creatorTokenAccount = await getAssociatedTokenAddress(mint, creator);

    const createMintIx = ix(
      LAUNCHPAD_PROGRAM_ID,
      [
        { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
        { pubkey: TREASURY_VAULT_PDA, isSigner: false, isWritable: true },
        { pubkey: creator, isSigner: true, isWritable: true },
        { pubkey: mint, isSigner: true, isWritable: true },
        { pubkey: creatorTokenAccount, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      Buffer.concat([DISC_CREATE_MINT, encodeBorshString(name), encodeBorshString(symbol), encodeBorshString(uri ?? "")])
    );

    const initCurveIx = ix(
      LAUNCHPAD_PROGRAM_ID,
      [
        { pubkey: creator, isSigner: true, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: curve, isSigner: false, isWritable: true },
        { pubkey: curveXntVault, isSigner: false, isWritable: true },
        { pubkey: rewardPoolXntVault, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      DISC_INIT_CURVE
    );

    const initCurveTokenVaultIx = ix(
      LAUNCHPAD_PROGRAM_ID,
      [
        { pubkey: creator, isSigner: true, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: curve, isSigner: false, isWritable: true },
        { pubkey: curveTokenVault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      DISC_INIT_CURVE_TOKEN_VAULT
    );

    const initRewardPoolTokenVaultIx = ix(
      LAUNCHPAD_PROGRAM_ID,
      [
        { pubkey: creator, isSigner: true, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: curve, isSigner: false, isWritable: true },
        { pubkey: rewardPoolTokenVault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      DISC_INIT_REWARD_POOL_TOKEN_VAULT
    );

    const initGradReserveVaultIx = ix(
      LAUNCHPAD_PROGRAM_ID,
      [
        { pubkey: creator, isSigner: true, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: curve, isSigner: false, isWritable: true },
        { pubkey: gradReserveVault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      DISC_INIT_GRAD_RESERVE_VAULT
    );

    const finalizeTokenIx = ix(
      LAUNCHPAD_PROGRAM_ID,
      [
        { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
        { pubkey: creator, isSigner: true, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: curve, isSigner: false, isWritable: true },
        { pubkey: curveTokenVault, isSigner: false, isWritable: true },
        { pubkey: rewardPoolTokenVault, isSigner: false, isWritable: true },
        { pubkey: gradReserveVault, isSigner: false, isWritable: true },
        { pubkey: rewardPoolXntVault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      Buffer.concat([DISC_FINALIZE_TOKEN, encodeU64LE(initialSeed)])
    );

    // Real on-chain Metaplex metadata, pointing at our own metadata endpoint (which re-derives
    // name/symbol/image live from this same transaction's LaunchpadMintCreated event — no DB).
    // Must land after create_mint (mint must exist, and mint authority is still `creator` here)
    // and before finalize_token (which permanently revokes mint authority).
    const metadataIx = buildCreateMetadataV3Instruction({
      mint,
      mintAuthority: creator,
      payer: creator,
      updateAuthority: creator,
      name,
      symbol,
      uri: `${APP_BASE_URL}/api/launchpad/metadata/${mint.toBase58()}`,
    });

    const tx = new Transaction();
    tx.add(
      createMintIx,
      metadataIx,
      initCurveIx,
      initCurveTokenVaultIx,
      initRewardPoolTokenVaultIx,
      initGradReserveVaultIx,
      finalizeTokenIx
    );

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = creator;

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

    return NextResponse.json({
      ok: true,
      transaction: serialized.toString("base64"),
      lastValidBlockHeight,
      curve: curve.toBase58(),
      mint: mint.toBase58(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Prepare failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
