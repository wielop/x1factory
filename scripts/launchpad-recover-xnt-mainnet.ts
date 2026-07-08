/**
 * Recovers XNT by selling the bot's entire GRADT2 balance into the new xdex pool
 * (swap_base_input CPI, same interface swap_router already uses for MIND/XNT), then
 * closing the WXNT ATA to unwrap the proceeds back into native XNT.
 *
 * Usage: npx tsx scripts/launchpad-recover-xnt-mainnet.ts
 */
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  AccountMeta,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  createCloseAccountInstruction,
} from "@solana/spl-token";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = "https://rpc.mainnet.x1.xyz";
const BOT_KEY_PATH = path.join(process.env.HOME!, ".config/solana/launchpad-bot.json");

const XDEX_PROGRAM_ID = new PublicKey("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
const XDEX_AMM_CONFIG = new PublicKey("2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c");
const WXNT_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const GRADT2_MINT = new PublicKey("FwprhprzDdxo1LN4P7sjoQf66gtbiJD7TosHpso3Hocy");
const POOL_STATE = new PublicKey("717qN815iXh72ezGGhT58KKK6eKUiE6md7RAEx3Enu6n");

const SWAP_BASE_INPUT_DISC = Buffer.from(
  createHash("sha256").update("global:swap_base_input").digest().slice(0, 8)
);

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as number[];
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const bot = loadKeypair(BOT_KEY_PATH);

  const [xdexAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_and_lp_mint_auth_seed")],
    XDEX_PROGRAM_ID
  );
  const [vaultGradt2] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), POOL_STATE.toBuffer(), GRADT2_MINT.toBuffer()],
    XDEX_PROGRAM_ID
  );
  const [vaultWxnt] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), POOL_STATE.toBuffer(), WXNT_MINT.toBuffer()],
    XDEX_PROGRAM_ID
  );
  const [observationState] = PublicKey.findProgramAddressSync(
    [Buffer.from("observation"), POOL_STATE.toBuffer()],
    XDEX_PROGRAM_ID
  );

  const botGradt2Ata = getAssociatedTokenAddressSync(GRADT2_MINT, bot.publicKey);
  const balBefore = await getAccount(connection, botGradt2Ata);
  const amountIn = balBefore.amount;
  console.log(`Bot GRADT2 balance to sell: ${amountIn.toString()}`);

  const xntBefore = await connection.getBalance(bot.publicKey);
  console.log(`Bot XNT balance before: ${(xntBefore / 1e9).toFixed(4)} XNT`);

  console.log("\n[1/2] Ensuring bot has a WXNT ATA...");
  const botWxntAtaInfo = await getOrCreateAssociatedTokenAccount(
    connection,
    bot,
    WXNT_MINT,
    bot.publicKey
  );
  const botWxntAta = botWxntAtaInfo.address;
  console.log(`      WXNT ATA: ${botWxntAta.toBase58()}`);

  console.log("\n[2/2] Swapping all GRADT2 -> WXNT via xdex, then unwrapping...");

  const le8 = (n: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    return b;
  };
  const data = Buffer.concat([
    SWAP_BASE_INPUT_DISC,
    le8(amountIn),
    le8(1n), // minimum_amount_out = 1 (accept any nonzero output)
  ]);

  const accounts: AccountMeta[] = [
    { pubkey: bot.publicKey, isSigner: true, isWritable: false },
    { pubkey: xdexAuthority, isSigner: false, isWritable: false },
    { pubkey: XDEX_AMM_CONFIG, isSigner: false, isWritable: false },
    { pubkey: POOL_STATE, isSigner: false, isWritable: true },
    { pubkey: botGradt2Ata, isSigner: false, isWritable: true },
    { pubkey: botWxntAta, isSigner: false, isWritable: true },
    { pubkey: vaultGradt2, isSigner: false, isWritable: true },
    { pubkey: vaultWxnt, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: GRADT2_MINT, isSigner: false, isWritable: false },
    { pubkey: WXNT_MINT, isSigner: false, isWritable: false },
    { pubkey: observationState, isSigner: false, isWritable: true },
  ];

  const swapIx = new TransactionInstruction({ programId: XDEX_PROGRAM_ID, keys: accounts, data });
  const closeIx = createCloseAccountInstruction(botWxntAta, bot.publicKey, bot.publicKey);

  const tx = new Transaction().add(swapIx).add(closeIx);
  const sig = await sendAndConfirmTransaction(connection, tx, [bot], { commitment: "confirmed" });
  console.log(`      tx: ${sig}`);

  const xntAfter = await connection.getBalance(bot.publicKey);
  console.log(`\nBot XNT balance after: ${(xntAfter / 1e9).toFixed(4)} XNT`);
  console.log(`Recovered: ${((xntAfter - xntBefore) / 1e9).toFixed(4)} XNT`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
