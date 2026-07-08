/**
 * Withdraw tokens from the GigaSwap reward pool (TREASURY only).
 * Usage:
 *   npx tsx scripts/withdraw_reward_pool.ts --amount 35 --token xnt
 *   npx tsx scripts/withdraw_reward_pool.ts --amount 1000 --token mind
 */

import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";

const RPC        = "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID = new PublicKey("2xXG9bbggrffG976okAbEHzw1BJgfA58d9zHTToke2Z6");
const MIND_MINT  = new PublicKey("DohWBfvXER6qs8zFGtdZRDpgbHmm97ZZwgCUTCdtHQNT");
const WXNT_MINT  = new PublicKey("So11111111111111111111111111111111111111112");
const DECIMALS   = 9;

const [CONFIG_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("router_config")], PROGRAM_ID
);
const [REWARD_POOL_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("reward_pool"), CONFIG_PDA.toBuffer()], PROGRAM_ID
);

const WITHDRAW_DISC = Buffer.from(
  createHash("sha256").update("global:withdraw_reward_pool").digest().subarray(0, 8)
);

async function main() {
  const args = process.argv.slice(2);
  const amountIdx = args.indexOf("--amount");
  const tokenIdx  = args.indexOf("--token");
  if (amountIdx === -1 || tokenIdx === -1) {
    console.error("Usage: tsx withdraw_reward_pool.ts --amount <n> --token <mind|xnt>");
    process.exit(1);
  }

  const amountTokens = parseFloat(args[amountIdx + 1]);
  const tokenArg = args[tokenIdx + 1].toLowerCase();
  const isMind = tokenArg === "mind";
  const mint = isMind ? MIND_MINT : WXNT_MINT;
  const amountLamports = BigInt(Math.round(amountTokens * 10 ** DECIMALS));

  const walletPath = process.env.WALLET_PATH ?? `${process.env.HOME}/.config/solana/treasury.json`;
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")));
  const authority = Keypair.fromSecretKey(secret);

  console.log("TREASURY         :", authority.publicKey.toBase58());
  console.log("CONFIG_PDA       :", CONFIG_PDA.toBase58());
  console.log("REWARD_POOL_PDA  :", REWARD_POOL_PDA.toBase58());
  console.log(`Withdrawing      : ${amountTokens} ${tokenArg.toUpperCase()} = ${amountLamports} lamports`);

  const conn = new Connection(RPC, "confirmed");

  // Pool ATA (source) — owned by REWARD_POOL_PDA
  const poolAta = await getAssociatedTokenAddress(mint, REWARD_POOL_PDA, true);
  // Destination ATA — authority's token account
  const destAta = await getAssociatedTokenAddress(mint, authority.publicKey);

  console.log("Pool ATA         :", poolAta.toBase58());
  console.log("Dest ATA         :", destAta.toBase58());

  const tx = new Transaction();

  // Create destination ATA if it doesn't exist
  const destAtaInfo = await conn.getAccountInfo(destAta);
  if (!destAtaInfo) {
    console.log("Creating destination ATA...");
    tx.add(createAssociatedTokenAccountInstruction(
      authority.publicKey, destAta, authority.publicKey, mint
    ));
  }

  // Build withdraw_reward_pool instruction
  // Account order matches WithdrawRewardPool struct exactly:
  // [0] config (mut, PDA)
  // [1] reward_pool_mind (PDA — signing authority for token transfer)
  // [2] reward_pool_account (mut — pool's token ATA, source)
  // [3] destination (mut — admin's token ATA)
  // [4] authority (signer — must be TREASURY)
  // [5] token_program
  const data = Buffer.allocUnsafe(8 + 8 + 1);
  WITHDRAW_DISC.copy(data, 0);
  data.writeBigUInt64LE(amountLamports, 8);
  data.writeUInt8(isMind ? 1 : 0, 16);

  tx.add({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: CONFIG_PDA,              isSigner: false, isWritable: true  }, // config
      { pubkey: REWARD_POOL_PDA,         isSigner: false, isWritable: false }, // reward_pool_mind
      { pubkey: poolAta,                 isSigner: false, isWritable: true  }, // reward_pool_account
      { pubkey: destAta,                 isSigner: false, isWritable: true  }, // destination
      { pubkey: authority.publicKey,     isSigner: true,  isWritable: false }, // authority
      { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false }, // token_program
    ],
    data,
  });

  const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });
  console.log(`✅ Withdrawn ${amountTokens} ${tokenArg.toUpperCase()}! Tx:`, sig);
}

main().catch(e => { console.error("Error:", e.message ?? e); process.exit(1); });
