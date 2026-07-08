/**
 * Sells everything the bot wallet holds of a given mint back into its curve, in halving
 * chunks on InsufficientLiquidity, to recover XNT before starting a fresh graduate() test.
 *
 * Usage: npx tsx scripts/launchpad-sell-back-mainnet.ts <mint>
 */
import anchorPkg, * as anchor from "@coral-xyz/anchor";
const { BN } = anchorPkg;
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID = new PublicKey("AGAdJKoLhrGrdFwrZZDEWsoR1Tq8kMcXGRKxX2wa2jfm");
const BOT_KEY_PATH = path.join(process.env.HOME!, ".config/solana/launchpad-bot.json");

const normalizeIdl = (raw: anchor.Idl): anchor.Idl => {
  const clone = JSON.parse(JSON.stringify(raw)) as anchor.Idl;
  const toSnakeCase = (value: string) =>
    value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
  const discriminator = (namespace: string, name: string) =>
    Buffer.from(createHash("sha256").update(`${namespace}:${name}`).digest().slice(0, 8));
  const fixDefined = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(fixDefined);
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.defined === "string") record.defined = { name: record.defined, generics: [] };
      for (const key of Object.keys(record)) record[key] = fixDefined(record[key]);
      return record;
    }
    if (typeof value === "string") return value === "publicKey" ? "pubkey" : value;
    return value;
  };
  const idl = fixDefined(clone) as anchor.Idl;
  const normalizeAccounts = (items: Array<Record<string, unknown>>) => {
    for (const item of items) {
      if (Array.isArray(item.accounts)) normalizeAccounts(item.accounts as Array<Record<string, unknown>>);
      if (Object.prototype.hasOwnProperty.call(item, "isMut")) { item.writable = item.isMut; delete item.isMut; }
      if (Object.prototype.hasOwnProperty.call(item, "isSigner")) { item.signer = item.isSigner; delete item.isSigner; }
    }
  };
  for (const ix of (idl as any).instructions ?? []) {
    if (Array.isArray(ix.accounts)) normalizeAccounts(ix.accounts);
    if (!ix.discriminator) ix.discriminator = discriminator("global", toSnakeCase(ix.name));
  }
  for (const acc of (idl as any).accounts ?? []) {
    if (!acc.discriminator) acc.discriminator = discriminator("account", acc.name);
  }
  const types = ((idl as any).types ?? []) as Array<{ name: string; type: unknown }>;
  (idl as any).types = types;
  for (const acc of (idl as any).accounts ?? []) {
    if (acc.type && !types.some((ty) => ty.name === acc.name)) types.push({ name: acc.name, type: acc.type });
  }
  for (const evt of (idl as any).events ?? []) {
    if (!evt.discriminator) evt.discriminator = discriminator("event", evt.name);
    if (evt.fields && !types.some((ty) => ty.name === evt.name)) {
      types.push({ name: evt.name, type: { kind: "struct", fields: evt.fields } });
    }
  }
  return idl;
};

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as number[];
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

function errCode(err: any): string | undefined {
  return err?.error?.errorCode?.code ?? err?.errorCode?.code;
}

async function main() {
  const mintArg = process.argv[2];
  if (!mintArg) throw new Error("Usage: launchpad-sell-back-mainnet.ts <mint>");
  const MINT = new PublicKey(mintArg);

  const connection = new Connection(RPC, "confirmed");
  const bot = loadKeypair(BOT_KEY_PATH);
  const wallet = new anchor.Wallet(bot);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idlRaw = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/launchpad.json"), "utf8"));
  const idl = normalizeIdl(idlRaw);
  (idl as any).address = PROGRAM_ID.toBase58();
  const program = new anchor.Program(idl as anchor.Idl, provider);

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("launchpad_config")], PROGRAM_ID);
  const [treasuryVaultPda] = PublicKey.findProgramAddressSync([Buffer.from("launchpad_treasury")], PROGRAM_ID);
  const [curve] = PublicKey.findProgramAddressSync([Buffer.from("curve"), MINT.toBuffer()], PROGRAM_ID);
  const [curveXntVault] = PublicKey.findProgramAddressSync([Buffer.from("curve_xnt_vault"), MINT.toBuffer()], PROGRAM_ID);
  const [rewardPoolXntVault] = PublicKey.findProgramAddressSync([Buffer.from("reward_pool_xnt"), MINT.toBuffer()], PROGRAM_ID);
  const [curveTokenVault] = PublicKey.findProgramAddressSync([Buffer.from("curve_token_vault"), MINT.toBuffer()], PROGRAM_ID);
  const [rewardPoolTokenVault] = PublicKey.findProgramAddressSync([Buffer.from("reward_pool_token"), MINT.toBuffer()], PROGRAM_ID);
  const botTokenAccount = getAssociatedTokenAddressSync(MINT, bot.publicKey);

  const balBefore = await connection.getBalance(bot.publicKey);
  console.log(`Bot: ${bot.publicKey.toBase58()}, balance before: ${(balBefore / LAMPORTS_PER_SOL).toFixed(4)} XNT`);

  const sellAccounts = {
    config: configPda, treasuryVault: treasuryVaultPda, curve, curveXntVault, rewardPoolXntVault,
    curveTokenVault, rewardPoolTokenVault, mint: MINT, user: bot.publicKey,
    userTokenAccount: botTokenAccount, tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: anchor.web3.SystemProgram.programId,
  };

  let sellCount = 0;
  for (let i = 0; i < 60; i++) {
    const acc = await getAccount(connection, botTokenAccount).catch(() => null);
    let amount = acc ? BigInt(acc.amount.toString()) : 0n;
    if (amount === 0n) break;

    let sold = false;
    while (amount > 0n) {
      try {
        await program.methods.sell(new BN(amount.toString()), new BN(0)).accounts(sellAccounts as any).signers([bot]).rpc();
        sellCount++;
        console.log(`      sell #${sellCount} ok, amount ${amount}`);
        sold = true;
        break;
      } catch (e: any) {
        const code = errCode(e);
        if (code === "InsufficientLiquidity") {
          amount = amount / 2n;
          continue;
        }
        console.log(`      sell failed: ${code ?? e.message}`);
        break;
      }
    }
    if (!sold) break;
  }

  const balAfter = await connection.getBalance(bot.publicKey);
  console.log(`\nBot balance after: ${(balAfter / LAMPORTS_PER_SOL).toFixed(4)} XNT (recovered ${((balAfter - balBefore) / LAMPORTS_PER_SOL).toFixed(4)} XNT)`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
