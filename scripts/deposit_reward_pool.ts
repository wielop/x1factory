/**
 * Deposit MIND (or WXNT) into the GigaSwap reward pool.
 * Usage:
 *   npx ts-node scripts/deposit_reward_pool.ts --amount 10000 --token mind
 *   npx ts-node scripts/deposit_reward_pool.ts --amount 500 --token xnt
 *
 * --amount: number of tokens (not lamports) e.g. 10000 = 10000 MIND
 * --token:  "mind" or "xnt"
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";

const RPC = "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID = new PublicKey("2xXG9bbggrffG976okAbEHzw1BJgfA58d9zHTToke2Z6");
const MIND_MINT   = new PublicKey("DohWBfvXER6qs8zFGtdZRDpgbHmm97ZZwgCUTCdtHQNT");
const WXNT_MINT   = new PublicKey("So11111111111111111111111111111111111111112");
const DECIMALS    = 9;

// Derive PDAs from seeds (same as on-chain)
const [CONFIG_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("router_config")],
  PROGRAM_ID
);
const [REWARD_POOL_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("reward_pool"), CONFIG_PDA.toBuffer()],
  PROGRAM_ID
);

const DEPOSIT_DISC = Buffer.from(
  createHash("sha256").update("global:deposit_reward_pool").digest().subarray(0, 8)
);

async function main() {
  const args = process.argv.slice(2);
  const amountIdx = args.indexOf("--amount");
  const tokenIdx  = args.indexOf("--token");

  if (amountIdx === -1 || tokenIdx === -1) {
    console.error("Usage: ts-node deposit_reward_pool.ts --amount <n> --token <mind|xnt>");
    process.exit(1);
  }

  const amountTokens = parseFloat(args[amountIdx + 1]);
  const tokenArg = args[tokenIdx + 1].toLowerCase();
  const isMind = tokenArg === "mind";
  const mint = isMind ? MIND_MINT : WXNT_MINT;
  const amountLamports = BigInt(Math.round(amountTokens * 10 ** DECIMALS));

  // Load wallet keypair
  const walletPath = process.env.WALLET_PATH ?? `${process.env.HOME}/.config/solana/id.json`;
  const secretKey = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secretKey));

  const conn = new Connection(RPC, "confirmed");

  const depositorAta = await getAssociatedTokenAddress(mint, payer.publicKey, false);
  const rewardPoolAta = await getAssociatedTokenAddress(mint, REWARD_POOL_PDA, true);

  console.log("CONFIG_PDA       :", CONFIG_PDA.toBase58());
  console.log("REWARD_POOL_PDA  :", REWARD_POOL_PDA.toBase58());
  console.log("Reward pool ATA  :", rewardPoolAta.toBase58());
  console.log("Depositor ATA    :", depositorAta.toBase58());
  console.log(`Depositing       : ${amountTokens} ${tokenArg.toUpperCase()} = ${amountLamports} lamports`);

  const tx = new Transaction();

  // For XNT: wrap native → WXNT ATA first
  if (!isMind) {
    const depositorAtaInfo = await conn.getAccountInfo(depositorAta);
    if (!depositorAtaInfo) {
      console.log("Creating depositor WXNT ATA...");
      tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, depositorAta, payer.publicKey, WXNT_MINT));
    }
    console.log(`Wrapping ${amountTokens} XNT → WXNT...`);
    tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: depositorAta, lamports: amountLamports }));
    tx.add(createSyncNativeInstruction(depositorAta, TOKEN_PROGRAM_ID));
  }

  // Create reward pool ATA if it doesn't exist
  const poolAtaInfo = await conn.getAccountInfo(rewardPoolAta);
  if (!poolAtaInfo) {
    console.log("Creating reward pool ATA...");
    tx.add(createAssociatedTokenAccountInstruction(
      payer.publicKey, rewardPoolAta, REWARD_POOL_PDA, mint
    ));
  }

  // Build deposit_reward_pool instruction
  const data = Buffer.allocUnsafe(8 + 8 + 1);
  DEPOSIT_DISC.copy(data, 0);
  data.writeBigUInt64LE(amountLamports, 8);
  data.writeUInt8(isMind ? 1 : 0, 16);

  const ix = {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: CONFIG_PDA,     isSigner: false, isWritable: true  },
      { pubkey: depositorAta,   isSigner: false, isWritable: true  },
      { pubkey: rewardPoolAta,  isSigner: false, isWritable: true  },
      { pubkey: payer.publicKey, isSigner: true,  isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  };

  tx.add(ix);

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;

  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  console.log("✅ Deposited! Tx:", sig);
  console.log(`   Reward pool ${tokenArg.toUpperCase()} ATA: ${rewardPoolAta.toBase58()}`);
}

main().catch(err => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
