/**
 * Creates a brand-new launchpad test token with the bot wallet (current constants: 200 XNT
 * initial virtual reserves). Prints the mint address for use by other scripts.
 *
 * Usage: npx tsx scripts/launchpad-create-token-mainnet.ts
 */
import anchorPkg, * as anchor from "@coral-xyz/anchor";
const { BN } = anchorPkg;
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
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

async function main() {
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

  const mint = Keypair.generate();
  const [curve] = PublicKey.findProgramAddressSync([Buffer.from("curve"), mint.publicKey.toBuffer()], PROGRAM_ID);
  const [curveXntVault] = PublicKey.findProgramAddressSync([Buffer.from("curve_xnt_vault"), mint.publicKey.toBuffer()], PROGRAM_ID);
  const [rewardPoolXntVault] = PublicKey.findProgramAddressSync([Buffer.from("reward_pool_xnt"), mint.publicKey.toBuffer()], PROGRAM_ID);
  const [curveTokenVault] = PublicKey.findProgramAddressSync([Buffer.from("curve_token_vault"), mint.publicKey.toBuffer()], PROGRAM_ID);
  const [rewardPoolTokenVault] = PublicKey.findProgramAddressSync([Buffer.from("reward_pool_token"), mint.publicKey.toBuffer()], PROGRAM_ID);
  const [gradReserveVault] = PublicKey.findProgramAddressSync([Buffer.from("grad_reserve"), mint.publicKey.toBuffer()], PROGRAM_ID);
  const creatorTokenAccount = getAssociatedTokenAddressSync(mint.publicKey, bot.publicKey);

  const tx = new anchor.web3.Transaction();
  tx.add(await program.methods.createMint("Graduate Test 2", "GRADT2", "").accounts({
    config: configPda, treasuryVault: treasuryVaultPda, creator: bot.publicKey, mint: mint.publicKey,
    creatorTokenAccount, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: anchor.web3.SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  } as any).instruction());
  tx.add(await program.methods.initCurve().accounts({
    creator: bot.publicKey, mint: mint.publicKey, curve, curveXntVault, rewardPoolXntVault,
    systemProgram: anchor.web3.SystemProgram.programId,
  } as any).instruction());
  tx.add(await program.methods.initCurveTokenVault().accounts({
    creator: bot.publicKey, mint: mint.publicKey, curve, curveTokenVault,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: anchor.web3.SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  } as any).instruction());
  tx.add(await program.methods.initRewardPoolTokenVault().accounts({
    creator: bot.publicKey, mint: mint.publicKey, curve, rewardPoolTokenVault,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: anchor.web3.SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  } as any).instruction());
  tx.add(await program.methods.initGradReserveVault().accounts({
    creator: bot.publicKey, mint: mint.publicKey, curve, gradReserveVault,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: anchor.web3.SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  } as any).instruction());
  tx.add(await program.methods.finalizeToken(new BN(0)).accounts({
    config: configPda, creator: bot.publicKey, mint: mint.publicKey, curve, curveTokenVault,
    rewardPoolTokenVault, gradReserveVault, rewardPoolXntVault,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: anchor.web3.SystemProgram.programId,
  } as any).instruction());

  const sig = await provider.sendAndConfirm(tx, [bot, mint]);
  console.log("Mint: ", mint.publicKey.toBase58());
  console.log("Curve:", curve.toBase58());
  console.log("Tx:   ", sig);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
