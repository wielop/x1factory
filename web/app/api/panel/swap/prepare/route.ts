import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  AccountMeta,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash } from "node:crypto";
import { parseTelegramWebAppAuth } from "@/lib/webAppAuth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ── Constants ────────────────────────────────────────────────────────────────
const RPC = "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID = new PublicKey("2xXG9bbggrffG976okAbEHzw1BJgfA58d9zHTToke2Z6");
const CONFIG_PDA = new PublicKey("2jphFVpP8M7yPC9syAis7sN28aTWBU4MssmXiQGxrZb6");
const REWARD_POOL_PDA = new PublicKey("91NeymGDdHYyLsMU9ULhha3cQ89qvXRPMX5o2L92BxLu");
const TREASURY = new PublicKey("AHrSKaFPWxt2YMZ7Q3xxpuC4wb622C3jUhER2p1V6VZS");
const MIND_MINT = new PublicKey("DohWBfvXER6qs8zFGtdZRDpgbHmm97ZZwgCUTCdtHQNT");
const WXNT_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// MIND/XNT xdex pool accounts
const XDEX_AUTHORITY = new PublicKey("GcjQWtbVQfgD4KSucTHun1CBSy9wgSSimK9tHMtRCC1n");
const AMM_CONFIG = new PublicKey("2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c");
const POOL_STATE = new PublicKey("FAVw1iDioK69epJf1YY3Z1oakSCUYtmfUpVBxR14BGpm");
const XNT_VAULT = new PublicKey("AGy9mSe6pmmHzVTuagfSHzJBe4hn2FpYq3hrsoF5i2ys");
const MIND_VAULT = new PublicKey("94F7JppAqiJkkwy31CqvfLd1a8BcT3AzESE8j533zGjg");
const OBSERVATION_STATE = new PublicKey("2KzhxLTb5x17ddAWAywmFCb9ZMZtHS7tvxAXiFAR5ag3");

const SWAP_BASE_INPUT_DISC = Buffer.from(
  createHash("sha256").update("global:swap_base_input").digest().subarray(0, 8)
);

function buildSwapIx(params: {
  user: PublicKey;
  userInput: PublicKey;
  userOutput: PublicKey;
  treasuryInput: PublicKey;
  rewardPoolInput: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputVault: PublicKey;
  outputVault: PublicKey;
  amountIn: bigint;
  minAmountOut: bigint;
}): TransactionInstruction {
  const data = Buffer.allocUnsafe(8 + 8 + 8);
  SWAP_BASE_INPUT_DISC.copy(data, 0);
  data.writeBigUInt64LE(params.amountIn, 8);
  data.writeBigUInt64LE(params.minAmountOut, 16);

  const keys: AccountMeta[] = [
    { pubkey: CONFIG_PDA,              isSigner: false, isWritable: true  },
    { pubkey: REWARD_POOL_PDA,         isSigner: false, isWritable: false },
    { pubkey: params.user,             isSigner: true,  isWritable: false },
    { pubkey: params.userInput,        isSigner: false, isWritable: true  },
    { pubkey: params.userOutput,       isSigner: false, isWritable: true  },
    { pubkey: params.treasuryInput,    isSigner: false, isWritable: true  },
    { pubkey: params.rewardPoolInput,  isSigner: false, isWritable: true  },
    { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false },
    // remaining_accounts: xdex accounts (0..9)
    { pubkey: XDEX_AUTHORITY,          isSigner: false, isWritable: false },
    { pubkey: AMM_CONFIG,              isSigner: false, isWritable: false },
    { pubkey: POOL_STATE,              isSigner: false, isWritable: true  },
    { pubkey: params.inputVault,       isSigner: false, isWritable: true  },
    { pubkey: params.outputVault,      isSigner: false, isWritable: true  },
    { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false }, // input_token_program
    { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false }, // output_token_program
    { pubkey: params.inputMint,        isSigner: false, isWritable: false },
    { pubkey: params.outputMint,       isSigner: false, isWritable: false },
    { pubkey: OBSERVATION_STATE,       isSigner: false, isWritable: true  },
  ];

  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

async function ensureAta(
  conn: Connection,
  ixs: TransactionInstruction[],
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey
): Promise<PublicKey> {
  const ata = await getAssociatedTokenAddress(mint, owner, true);
  const existing = await conn.getAccountInfo(ata);
  if (!existing) {
    ixs.push(createAssociatedTokenAccountInstruction(payer, ata, owner, mint));
  }
  return ata;
}

export async function POST(req: NextRequest) {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  const auth = parseTelegramWebAppAuth(initData, process.env.BOT_TOKEN ?? "");
  if (!auth) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json() as {
      walletAddress?: string;
      amountIn?: string;
      direction?: string;
      slippageBps?: number;
    };

    const { walletAddress, amountIn: amountInStr, direction = "mind_to_xnt", slippageBps = 100 } = body;

    if (!walletAddress || !amountInStr) {
      return NextResponse.json({ ok: false, error: "walletAddress and amountIn required" }, { status: 400 });
    }

    // Verify wallet belongs to this user
    const telegramId = BigInt(auth.user.id);
    const wallet = await prisma.wallet.findFirst({
      where: { address: walletAddress, user: { telegramId } },
    });
    if (!wallet) return NextResponse.json({ ok: false, error: "Wallet not registered" }, { status: 403 });

    const user = new PublicKey(walletAddress);
    const amountIn = BigInt(amountInStr);
    if (amountIn <= 0n) return NextResponse.json({ ok: false, error: "amountIn must be > 0" }, { status: 400 });

    const conn = new Connection(RPC, "confirmed");
    const createAtaIxs: TransactionInstruction[] = [];

    const isMindToXnt = direction === "mind_to_xnt";
    const inputMint = isMindToXnt ? MIND_MINT : WXNT_MINT;
    const outputMint = isMindToXnt ? WXNT_MINT : MIND_MINT;
    const inputVault = isMindToXnt ? MIND_VAULT : XNT_VAULT;
    const outputVault = isMindToXnt ? XNT_VAULT : MIND_VAULT;

    const [userInput, userOutput, treasuryInput, rewardPoolInput] = await Promise.all([
      ensureAta(conn, createAtaIxs, user, user, inputMint),
      ensureAta(conn, createAtaIxs, user, user, outputMint),
      getAssociatedTokenAddress(inputMint, TREASURY, true),
      getAssociatedTokenAddress(inputMint, REWARD_POOL_PDA, true),
    ]);

    // Estimate min amount out (simple quote — slippage applied)
    const TOKEN_AMOUNT_OFFSET = 64;
    const [vaultInInfo, vaultOutInfo] = await Promise.all([
      conn.getAccountInfo(inputVault),
      conn.getAccountInfo(outputVault),
    ]);
    const vaultInAmt = vaultInInfo ? vaultInInfo.data.readBigUInt64LE(TOKEN_AMOUNT_OFFSET) : 0n;
    const vaultOutAmt = vaultOutInfo ? vaultOutInfo.data.readBigUInt64LE(TOKEN_AMOUNT_OFFSET) : 0n;

    const OUR_FEE = (amountIn * 40n) / 10_000n;
    const swapAmount = amountIn - OUR_FEE;
    const estimatedOut = vaultInAmt > 0n
      ? (vaultOutAmt * swapAmount) / (vaultInAmt + swapAmount)
      : 0n;
    const minAmountOut = (estimatedOut * BigInt(10_000 - slippageBps)) / 10_000n;

    const swapIx = buildSwapIx({
      user, userInput, userOutput, treasuryInput, rewardPoolInput,
      inputMint, outputMint, inputVault, outputVault,
      amountIn, minAmountOut,
    });

    const tx = new Transaction();
    for (const ix of createAtaIxs) tx.add(ix);
    tx.add(swapIx);

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = user;

    const serialized = tx.serialize({ requireAllSignatures: false });

    return NextResponse.json({
      ok: true,
      transaction: serialized.toString("base64"),
      estimatedOut: estimatedOut.toString(),
      minAmountOut: minAmountOut.toString(),
      lastValidBlockHeight,
      direction,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Prepare failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
