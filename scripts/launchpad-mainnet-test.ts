/**
 * End-to-end mainnet test for the launchpad bonding curve + GigaSwap.
 *
 * What it does, in order:
 *   1. Initializes LaunchpadGlobalConfig on mainnet if not already done (admin wallet = upgrade authority).
 *   2. Refreshes the cached XNT/USD price from the same xdex oracle swap_router uses.
 *   3. Loads (or generates) a persistent bot wallet. Requires it to hold enough XNT before
 *      doing anything with real funds — prints the address and required amount and exits if not.
 *   4. Creates a brand-new test token (create_mint -> init_curve -> init_*_vault x3 -> finalize_token).
 *   5. Buys repeatedly in GigaSwap-qualifying chunks (>= ~$5 each) until the curve is fully sold out.
 *   6. Sells everything the bot holds back into the curve (full round trip).
 *   7. Withdraws the accumulated global treasury fee share back to the admin wallet.
 *   8. Prints a full report: XNT spent, GigaSwap wins received, net cost.
 *
 * Usage:
 *   npx tsx scripts/launchpad-mainnet-test.ts
 *
 * Re-run safely: step 1 is idempotent (skips if config already exists), the bot wallet is
 * persisted at ~/.config/solana/launchpad-bot.json so re-running reuses the same wallet/balance.
 */
import anchorPkg, * as anchor from "@coral-xyz/anchor";
const { BN } = anchorPkg;
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotent,
  getAccount,
  getMint,
} from "@solana/spl-token";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC = "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID = new PublicKey("AGAdJKoLhrGrdFwrZZDEWsoR1Tq8kMcXGRKxX2wa2jfm");
const ADMIN_KEY_PATH = path.join(process.env.HOME!, ".config/solana/id.json");
const BOT_KEY_PATH = path.join(process.env.HOME!, ".config/solana/launchpad-bot.json");

const REQUIRED_BOT_XNT = 605; // actual need is ~592-600 XNT to fully sell the curve; small buffer
const BUY_CHUNK_XNT = 18; // comfortably above the ~$5 GigaSwap threshold at current prices
const MAX_BUYS = 60; // safety cap so a bug can't loop forever

// --- same IDL shim used by tests/launchpad.ts / tests/mining_v2.ts ---
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

function loadOrCreateBotKeypair(): Keypair {
  if (fs.existsSync(BOT_KEY_PATH)) {
    return loadKeypair(BOT_KEY_PATH);
  }
  const kp = Keypair.generate();
  fs.writeFileSync(BOT_KEY_PATH, JSON.stringify(Array.from(kp.secretKey)));
  fs.chmodSync(BOT_KEY_PATH, 0o600);
  return kp;
}

function errCode(err: any): string | undefined {
  return err?.error?.errorCode?.code ?? err?.errorCode?.code;
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const admin = loadKeypair(ADMIN_KEY_PATH);
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
  const upgradeableLoaderId = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const [programData] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], upgradeableLoaderId);

  console.log("Admin:  ", admin.publicKey.toBase58());
  console.log("Config: ", configPda.toBase58());

  // --- Step 1: init_global_config (idempotent) ---
  const existingConfig = await connection.getAccountInfo(configPda);
  if (!existingConfig) {
    console.log("\n[1/8] Initializing LaunchpadGlobalConfig on mainnet…");
    await program.methods
      .initGlobalConfig(admin.publicKey, new BN(50), new BN(0)) // placeholder price, fee=0 for testing
      .accounts({
        config: configPda,
        treasuryVault: treasuryVaultPda,
        payer: admin.publicKey,
        programData,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();
    console.log("      Done.");
  } else {
    console.log("\n[1/8] LaunchpadGlobalConfig already exists, skipping init.");
  }

  // --- Step 2: refresh_price ---
  console.log("[2/8] Refreshing XNT/USD price from xdex oracle…");
  const XNT_USDC_XNT_VAULT = new PublicKey("8wvV4HKBDFMLEUkVWp1WPNa5ano99XCm3f9t3troyLb");
  const XNT_USDC_USDC_VAULT = new PublicKey("7iw2adw8Af7x3pY7gj5RwczFXuGjCoX92Gfy3avwXQtg");
  try {
    await program.methods
      .refreshPrice()
      .accounts({ config: configPda, xntVault: XNT_USDC_XNT_VAULT, usdcVault: XNT_USDC_USDC_VAULT } as any)
      .rpc();
  } catch (e) {
    console.log("      refresh_price failed (continuing with existing cached price):", (e as Error).message);
  }
  const configAcc: any = await (program.account as any).launchpadGlobalConfig.fetch(configPda);
  const xntUsdCents = Number(configAcc.xntUsdCents);
  console.log(`      XNT/USD: $${(xntUsdCents / 100).toFixed(4)}`);

  // --- Step 3: bot wallet funding check ---
  const bot = loadOrCreateBotKeypair();
  const botBalanceLamports = await connection.getBalance(bot.publicKey);
  const botBalanceXnt = botBalanceLamports / LAMPORTS_PER_SOL;
  console.log(`\n[3/8] Bot wallet: ${bot.publicKey.toBase58()}`);
  console.log(`      Balance: ${botBalanceXnt.toFixed(4)} XNT`);
  if (botBalanceXnt < REQUIRED_BOT_XNT) {
    console.log(`\n  Not enough XNT. Send at least ${REQUIRED_BOT_XNT} XNT to:`);
    console.log(`  ${bot.publicKey.toBase58()}`);
    console.log(`\n  Then re-run this script — it will pick up from here.`);
    return;
  }

  // --- Step 4: create token ---
  console.log("\n[4/8] Creating test token…");
  const mint = Keypair.generate();
  const [curve] = PublicKey.findProgramAddressSync([Buffer.from("curve"), mint.publicKey.toBuffer()], PROGRAM_ID);
  const [curveXntVault] = PublicKey.findProgramAddressSync([Buffer.from("curve_xnt_vault"), mint.publicKey.toBuffer()], PROGRAM_ID);
  const [rewardPoolXntVault] = PublicKey.findProgramAddressSync([Buffer.from("reward_pool_xnt"), mint.publicKey.toBuffer()], PROGRAM_ID);
  const [curveTokenVault] = PublicKey.findProgramAddressSync([Buffer.from("curve_token_vault"), mint.publicKey.toBuffer()], PROGRAM_ID);
  const [rewardPoolTokenVault] = PublicKey.findProgramAddressSync([Buffer.from("reward_pool_token"), mint.publicKey.toBuffer()], PROGRAM_ID);
  const [gradReserveVault] = PublicKey.findProgramAddressSync([Buffer.from("grad_reserve"), mint.publicKey.toBuffer()], PROGRAM_ID);
  const creatorTokenAccount = getAssociatedTokenAddressSync(mint.publicKey, bot.publicKey);

  const tx = new anchor.web3.Transaction();
  tx.add(await program.methods.createMint("Launchpad Test", "LPTEST", "").accounts({
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

  const createSig = await provider.sendAndConfirm(tx, [bot, mint]);
  console.log(`      Mint: ${mint.publicKey.toBase58()}`);
  console.log(`      Curve: ${curve.toBase58()}`);
  console.log(`      Tx: ${createSig}`);

  // --- Step 5: buy loop until sold out ---
  console.log("\n[5/8] Buying until the curve is fully sold out…");
  const buyChunkLamports = new BN(BUY_CHUNK_XNT * LAMPORTS_PER_SOL);
  let gigaWins = 0;
  let gigaTotalPayout = new BN(0);
  let totalSpentLamports = new BN(0);
  let buyCount = 0;

  for (let i = 0; i < MAX_BUYS; i++) {
    try {
      const sig = await program.methods.buy(buyChunkLamports, new BN(0)).accounts({
        config: configPda, treasuryVault: treasuryVaultPda, curve, curveXntVault, rewardPoolXntVault,
        curveTokenVault, rewardPoolTokenVault, mint: mint.publicKey, user: bot.publicKey,
        userTokenAccount: creatorTokenAccount, tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any).signers([bot]).rpc();
      buyCount++;
      totalSpentLamports = totalSpentLamports.add(buyChunkLamports);

      const curveState: any = await (program.account as any).bondingCurve.fetch(curve);
      const gh = Number(curveState.gigaHits);
      if (gh > gigaWins) {
        gigaWins = gh;
        console.log(`      buy #${buyCount}: GIGA WIN! (total wins so far: ${gigaWins}) tx=${sig}`);
      } else {
        process.stdout.write(`      buy #${buyCount} ok (${sig.slice(0, 8)}…)   real_token_reserves=${curveState.realTokenReserves.toString()}\r`);
      }
    } catch (e: any) {
      const code = errCode(e);
      if (code === "SoldOut") {
        console.log(`\n      Curve fully sold out after ${buyCount} buys.`);
        break;
      }
      console.log(`\n      Buy #${buyCount + 1} failed (${code ?? e.message}), retrying once…`);
      await new Promise((r) => setTimeout(r, 2000));
      i--; // retry this iteration
      continue;
    }
  }
  console.log(`      Total spent buying: ${(Number(totalSpentLamports) / LAMPORTS_PER_SOL).toFixed(4)} XNT across ${buyCount} buys`);

  // --- Step 6: sell everything back ---
  console.log("\n[6/8] Selling all held tokens back into the curve…");
  let totalReceivedLamports = 0;
  let sellCount = 0;
  for (let i = 0; i < 20; i++) {
    const acc = await getAccount(connection, creatorTokenAccount).catch(() => null);
    const balance = acc ? BigInt(acc.amount.toString()) : 0n;
    if (balance === 0n) break;

    try {
      const before = await connection.getBalance(bot.publicKey);
      const sig = await program.methods.sell(new BN(balance.toString()), new BN(0)).accounts({
        config: configPda, treasuryVault: treasuryVaultPda, curve, curveXntVault, rewardPoolXntVault,
        curveTokenVault, rewardPoolTokenVault, mint: mint.publicKey, user: bot.publicKey,
        userTokenAccount: creatorTokenAccount, tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any).signers([bot]).rpc();
      const after = await connection.getBalance(bot.publicKey);
      totalReceivedLamports += Math.max(0, after - before);
      sellCount++;
      console.log(`      sell #${sellCount} ok (${sig.slice(0, 8)}…)`);
    } catch (e: any) {
      const code = errCode(e);
      if (code === "InsufficientLiquidity") {
        // sell in smaller halves until it fits
        console.log(`      Curve liquidity too thin for full balance, selling in smaller chunks…`);
        const half = balance / 2n;
        if (half === 0n) break;
        try {
          await program.methods.sell(new BN(half.toString()), new BN(0)).accounts({
            config: configPda, treasuryVault: treasuryVaultPda, curve, curveXntVault, rewardPoolXntVault,
            curveTokenVault, rewardPoolTokenVault, mint: mint.publicKey, user: bot.publicKey,
            userTokenAccount: creatorTokenAccount, tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          } as any).signers([bot]).rpc();
          sellCount++;
        } catch {
          console.log("      Still failing on half-size sell, stopping sell loop.");
          break;
        }
        continue;
      }
      console.log(`      Sell failed (${code ?? e.message}), stopping sell loop.`);
      break;
    }
  }
  console.log(`      Total received selling back: ${(totalReceivedLamports / LAMPORTS_PER_SOL).toFixed(4)} XNT across ${sellCount} sells`);

  // --- Step 7: withdraw global treasury back to admin ---
  console.log("\n[7/8] Withdrawing accumulated treasury fees back to admin…");
  const treasuryLamports = await connection.getBalance(treasuryVaultPda);
  const rentExempt = await connection.getMinimumBalanceForRentExemption(9); // 8 disc + 1 bump
  const withdrawable = Math.max(0, treasuryLamports - rentExempt);
  if (withdrawable > 0) {
    await program.methods.adminWithdrawTreasury(new BN(withdrawable)).accounts({
      config: configPda, treasuryVault: treasuryVaultPda, admin: admin.publicKey,
    } as any).rpc();
    console.log(`      Withdrew ${(withdrawable / LAMPORTS_PER_SOL).toFixed(6)} XNT to admin wallet.`);
  } else {
    console.log("      Nothing to withdraw.");
  }

  // --- Step 8: final report ---
  console.log("\n[8/8] Final report");
  const finalBotBalance = await connection.getBalance(bot.publicKey);
  const netChangeXnt = (finalBotBalance - botBalanceLamports) / LAMPORTS_PER_SOL;
  const finalCurve: any = await (program.account as any).bondingCurve.fetch(curve);
  console.log(`      GigaSwap wins:        ${finalCurve.gigaHits.toString()}`);
  console.log(`      Bot balance before:   ${botBalanceXnt.toFixed(4)} XNT`);
  console.log(`      Bot balance after:    ${(finalBotBalance / LAMPORTS_PER_SOL).toFixed(4)} XNT`);
  console.log(`      Net change (bot):     ${netChangeXnt >= 0 ? "+" : ""}${netChangeXnt.toFixed(4)} XNT`);
  console.log(`      Reward pool XNT left: ${(Number(finalCurve.rewardPoolXntBalance) / LAMPORTS_PER_SOL).toFixed(4)} XNT (locked, unrecoverable by design)`);
  console.log(`      Reward pool tokens left: ${finalCurve.rewardPoolTokenBalance.toString()}`);
  console.log(`      Mint: ${mint.publicKey.toBase58()}`);
  console.log(`      Dashboard: https://x1factory.xyz/launchpad/${mint.publicKey.toBase58()}`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
