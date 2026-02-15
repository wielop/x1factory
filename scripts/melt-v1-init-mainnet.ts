import "dotenv/config";

import crypto from "crypto";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

const MAINNET_RPC_URL = "https://rpc.mainnet.x1.xyz";
const LAMPORTS_PER_XNT = 1_000_000_000n;

function assertMainnetOnly(provider: anchor.AnchorProvider) {
  const envRpc = (process.env.ANCHOR_PROVIDER_URL || "").trim();
  if (envRpc !== MAINNET_RPC_URL) {
    throw new Error("MAINNET ONLY: ANCHOR_PROVIDER_URL must be https://rpc.mainnet.x1.xyz");
  }
  const rpc = provider.connection.rpcEndpoint;
  if (rpc !== MAINNET_RPC_URL || rpc.includes("testnet") || envRpc.includes("testnet")) {
    throw new Error("MAINNET ONLY");
  }
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  assertMainnetOnly(provider);

  const programId = new PublicKey(
    process.env.MELT_V1_PROGRAM_ID ?? "HAWdiMtvTfiFhENgxPdWEgBQmoa3A5oN1KV9N3LSmxXz"
  );

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("melt_config")], programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("melt_vault")], programId);

  const cfgInfo = await provider.connection.getAccountInfo(configPda, "confirmed");
  if (cfgInfo) {
    console.log("MELT config already initialized:", configPda.toBase58());
    return;
  }

  const mindMintStr = process.env.MIND_MINT;
  if (!mindMintStr) {
    throw new Error("Missing MIND_MINT env var.");
  }
  const mindMint = new PublicKey(mindMintStr);
  const capXnt = BigInt(process.env.MELT_CAP_XNT ?? "10");
  const windowSec = BigInt(process.env.MELT_WINDOW_SEC ?? "600");
  const rolloverBps = Number(process.env.MELT_ROLLOVER_BPS ?? "2000");
  const burnMinMind = BigInt(process.env.MELT_BURN_MIN_MIND ?? "10");

  const disc = crypto
    .createHash("sha256")
    .update("global:init_melt")
    .digest()
    .subarray(0, 8);
  const capBuf = Buffer.alloc(8);
  capBuf.writeBigUInt64LE(capXnt * LAMPORTS_PER_XNT, 0);
  const rolloverBuf = Buffer.alloc(2);
  rolloverBuf.writeUInt16LE(rolloverBps, 0);
  const burnMinBuf = Buffer.alloc(8);
  burnMinBuf.writeBigUInt64LE(burnMinMind * LAMPORTS_PER_XNT, 0);
  const windowBuf = Buffer.alloc(8);
  windowBuf.writeBigUInt64LE(windowSec, 0);
  const testModeBuf = Buffer.from([0]); // false on mainnet
  const data = Buffer.concat([disc, capBuf, rolloverBuf, burnMinBuf, windowBuf, testModeBuf]);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true }, // payer
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true }, // admin
      { pubkey: mindMint, isSigner: false, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const sig = await provider.sendAndConfirm(new Transaction().add(ix), []);

  console.log("init_sig", sig);
  console.log("programId", programId.toBase58());
  console.log("configPda", configPda.toBase58());
  console.log("vaultPda", vaultPda.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
