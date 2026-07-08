/**
 * Winds down a specific launchpad test run: sells everything the bot wallet holds of a given
 * mint back into its curve, then withdraws the accumulated global treasury back to admin, then
 * prints a final report. Companion to launchpad-mainnet-test.ts, used when a run needs to stop
 * early (e.g. curve sized much bigger than expected) instead of continuing to buy.
 *
 * Usage: npx tsx scripts/launchpad-wind-down.ts <mint> <curve>
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
const ADMIN_KEY_PATH = path.join(process.env.HOME!, ".config/solana/id.json");
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
  const curveArg = process.argv[3];
  if (!mintArg || !curveArg) {
    console.error("Usage: npx tsx scripts/launchpad-wind-down.ts <mint> <curve>");
    process.exit(1);
  }
  const mint = new PublicKey(mintArg);
  const curve = new PublicKey(curveArg);

  const connection = new Connection(RPC, "confirmed");
  const admin = loadKeypair(ADMIN_KEY_PATH);
  const bot = loadKeypair(BOT_KEY_PATH);
  const adminWallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, adminWallet, {
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
  const [curveXntVault] = PublicKey.findProgramAddressSync([Buffer.from("curve_xnt_vault"), mint.toBuffer()], PROGRAM_ID);
  const [rewardPoolXntVault] = PublicKey.findProgramAddressSync([Buffer.from("reward_pool_xnt"), mint.toBuffer()], PROGRAM_ID);
  const [curveTokenVault] = PublicKey.findProgramAddressSync([Buffer.from("curve_token_vault"), mint.toBuffer()], PROGRAM_ID);
  const [rewardPoolTokenVault] = PublicKey.findProgramAddressSync([Buffer.from("reward_pool_token"), mint.toBuffer()], PROGRAM_ID);
  const userTokenAccount = getAssociatedTokenAddressSync(mint, bot.publicKey);

  const botBalanceBefore = await connection.getBalance(bot.publicKey);
  console.log(`Bot:   ${bot.publicKey.toBase58()}`);
  console.log(`Bot XNT balance before wind-down: ${(botBalanceBefore / LAMPORTS_PER_SOL).toFixed(4)}`);

  console.log("\n[1/3] Selling all held tokens back into the curve…");
  let sellCount = 0;
  let totalReceivedLamports = 0;
  for (let i = 0; i < 30; i++) {
    const acc = await getAccount(connection, userTokenAccount).catch(() => null);
    const balance = acc ? BigInt(acc.amount.toString()) : 0n;
    if (balance === 0n) {
      console.log("      Nothing left to sell.");
      break;
    }
    console.log(`      Attempting to sell ${balance.toString()} raw token units…`);
    try {
      const before = await connection.getBalance(bot.publicKey);
      const sig = await program.methods.sell(new BN(balance.toString()), new BN(0)).accounts({
        config: configPda, treasuryVault: treasuryVaultPda, curve, curveXntVault, rewardPoolXntVault,
        curveTokenVault, rewardPoolTokenVault, mint, user: bot.publicKey,
        userTokenAccount, tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any).signers([bot]).rpc();
      const after = await connection.getBalance(bot.publicKey);
      totalReceivedLamports += Math.max(0, after - before);
      sellCount++;
      console.log(`      sell #${sellCount} ok (${sig.slice(0, 8)}…)`);
      break; // full balance sold in one shot
    } catch (e: any) {
      const code = errCode(e);
      if (code === "InsufficientLiquidity") {
        console.log("      Curve liquidity too thin for full balance, selling in halves…");
        let chunk = balance / 2n;
        let sold = false;
        while (chunk > 0n && !sold) {
          try {
            const before = await connection.getBalance(bot.publicKey);
            const sig = await program.methods.sell(new BN(chunk.toString()), new BN(0)).accounts({
              config: configPda, treasuryVault: treasuryVaultPda, curve, curveXntVault, rewardPoolXntVault,
              curveTokenVault, rewardPoolTokenVault, mint, user: bot.publicKey,
              userTokenAccount, tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: anchor.web3.SystemProgram.programId,
            } as any).signers([bot]).rpc();
            const after = await connection.getBalance(bot.publicKey);
            totalReceivedLamports += Math.max(0, after - before);
            sellCount++;
            console.log(`      sell #${sellCount} ok, chunk=${chunk.toString()} (${sig.slice(0, 8)}…)`);
            sold = true;
          } catch {
            chunk = chunk / 2n;
          }
        }
        if (!sold) {
          console.log("      Could not sell even a tiny chunk, stopping.");
          break;
        }
        continue;
      }
      console.log(`      Sell failed (${code ?? e.message}), stopping sell loop.`);
      break;
    }
  }
  console.log(`      Total received selling back: ${(totalReceivedLamports / LAMPORTS_PER_SOL).toFixed(4)} XNT across ${sellCount} sells`);

  console.log("\n[2/3] Withdrawing accumulated treasury fees back to admin…");
  const treasuryLamports = await connection.getBalance(treasuryVaultPda);
  const rentExempt = await connection.getMinimumBalanceForRentExemption(9);
  const withdrawable = Math.max(0, treasuryLamports - rentExempt);
  if (withdrawable > 0) {
    const sig = await program.methods.adminWithdrawTreasury(new BN(withdrawable)).accounts({
      config: configPda, treasuryVault: treasuryVaultPda, admin: admin.publicKey,
    } as any).rpc();
    console.log(`      Withdrew ${(withdrawable / LAMPORTS_PER_SOL).toFixed(6)} XNT to admin wallet. tx=${sig}`);
  } else {
    console.log("      Nothing to withdraw.");
  }

  console.log("\n[3/3] Final report");
  const botBalanceAfter = await connection.getBalance(bot.publicKey);
  const finalCurve: any = await (program.account as any).bondingCurve.fetch(curve);
  const remainingTokenAcc = await getAccount(connection, userTokenAccount).catch(() => null);
  console.log(`      Bot XNT balance after:  ${(botBalanceAfter / LAMPORTS_PER_SOL).toFixed(4)} XNT`);
  console.log(`      Net change (this wind-down step): ${((botBalanceAfter - botBalanceBefore) / LAMPORTS_PER_SOL).toFixed(4)} XNT`);
  console.log(`      Remaining token balance: ${remainingTokenAcc ? remainingTokenAcc.amount.toString() : "0"}`);
  console.log(`      GigaSwap wins on this curve: ${finalCurve.gigaHits.toString()}`);
  console.log(`      Curve real_xnt_reserves left: ${(Number(finalCurve.realXntReserves) / LAMPORTS_PER_SOL).toFixed(4)} XNT`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
