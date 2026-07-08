/**
 * Real mainnet run: fully drain the launchpad-bot's untouched test curve
 * (mint 7gu7e9C6r3KK6oxGRfmX1NoDu3GwWUVKCy976MfvRAyY) down to the graduation
 * dust threshold, then call graduate_prepare + graduate_finalize for real —
 * creating a permanent xdex pool and burning the LP tokens it mints.
 *
 * Uses the bot wallet (~/.config/solana/launchpad-bot.json, ~625 XNT) as both
 * buyer and graduate_prepare's payer. Irreversible: real pool creation, real
 * LP burn, real XNT spent (~586 XNT migrates into the new pool's liquidity).
 *
 * Usage: npx tsx scripts/launchpad-graduate-mainnet.ts
 */
import anchorPkg, * as anchor from "@coral-xyz/anchor";
const { BN } = anchorPkg;
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
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
const BOT_KEY_PATH = path.join(process.env.HOME!, ".config/solana/launchpad-bot.json");

const MINT = new PublicKey("FwprhprzDdxo1LN4P7sjoQf66gtbiJD7TosHpso3Hocy");
const XDEX_PROGRAM_ID = new PublicKey("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
const XDEX_AMM_CONFIG = new PublicKey("2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c");
const XDEX_CREATE_POOL_FEE_RECEIVER = new PublicKey("SKc6b6zAv2kkB9EtitjppbzPVR48bCMfRtE5B8KDuF1");
const WXNT_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const DUST_THRESHOLD = 1000n;

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

function simulateTokensOut(virtualToken: bigint, virtualXnt: bigint, xntToCurve: bigint): bigint {
  const k = virtualToken * virtualXnt;
  const newVirtualXnt = virtualXnt + xntToCurve;
  const newVirtualToken = k / newVirtualXnt;
  return virtualToken - newVirtualToken;
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
  const [curve] = PublicKey.findProgramAddressSync([Buffer.from("curve"), MINT.toBuffer()], PROGRAM_ID);
  const [curveXntVault] = PublicKey.findProgramAddressSync([Buffer.from("curve_xnt_vault"), MINT.toBuffer()], PROGRAM_ID);
  const [rewardPoolXntVault] = PublicKey.findProgramAddressSync([Buffer.from("reward_pool_xnt"), MINT.toBuffer()], PROGRAM_ID);
  const [curveTokenVault] = PublicKey.findProgramAddressSync([Buffer.from("curve_token_vault"), MINT.toBuffer()], PROGRAM_ID);
  const [rewardPoolTokenVault] = PublicKey.findProgramAddressSync([Buffer.from("reward_pool_token"), MINT.toBuffer()], PROGRAM_ID);
  const [gradReserveVault] = PublicKey.findProgramAddressSync([Buffer.from("grad_reserve"), MINT.toBuffer()], PROGRAM_ID);
  const botTokenAccount = getAssociatedTokenAddressSync(MINT, bot.publicKey);

  console.log("Bot:   ", bot.publicKey.toBase58());
  console.log("Mint:  ", MINT.toBase58());
  console.log("Curve: ", curve.toBase58());

  const botBalanceBefore = await connection.getBalance(bot.publicKey);
  console.log(`Bot balance: ${(botBalanceBefore / LAMPORTS_PER_SOL).toFixed(4)} XNT\n`);

  // --- Bulk buys, then precise final buys down to the dust threshold ---
  console.log("[1/3] Draining the curve...");
  const buyChunk = new BN(40).mul(new BN(LAMPORTS_PER_SOL));
  let buys = 0;
  for (let i = 0; i < 40; i++) {
    const curveState: any = await (program.account as any).bondingCurve.fetch(curve);
    const remaining = BigInt(curveState.realTokenReserves.toString());
    if (remaining < 20_000_000_000_000n) break; // ~20M tokens left, switch to precise mode
    await program.methods
      .buy(buyChunk, new BN(0))
      .accounts({
        config: configPda, treasuryVault: treasuryVaultPda, curve, curveXntVault, rewardPoolXntVault,
        curveTokenVault, rewardPoolTokenVault, mint: MINT, user: bot.publicKey,
        userTokenAccount: botTokenAccount, tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([bot])
      .rpc();
    buys++;
    process.stdout.write(`      bulk buy #${buys}\r`);
  }
  console.log(`\n      ${buys} bulk buys done, switching to precise final buys...`);

  for (let attempt = 0; attempt < 25; attempt++) {
    const curveState: any = await (program.account as any).bondingCurve.fetch(curve);
    const remaining = BigInt(curveState.realTokenReserves.toString());
    if (remaining <= DUST_THRESHOLD) {
      console.log(`      drained to ${remaining} raw units (<= dust threshold)`);
      break;
    }
    const virtualToken = BigInt(curveState.virtualTokenReserves.toString());
    const virtualXnt = BigInt(curveState.virtualXntReserves.toString());
    const k = virtualToken * virtualXnt;
    const target = virtualToken - remaining;
    let xntToCurve = k / target - virtualXnt;
    if (xntToCurve <= 0n) continue;
    while (simulateTokensOut(virtualToken, virtualXnt, xntToCurve) > remaining) xntToCurve -= 1n;

    const feeBps = 100n;
    const denom = 10000n - feeBps;
    let xntIn = (xntToCurve * 10000n + denom - 1n) / denom;
    while (xntIn - (xntIn * feeBps) / 10000n > xntToCurve) xntIn -= 1n;
    if (xntIn <= 0n) continue;

    await program.methods
      .buy(new BN(xntIn.toString()), new BN(0))
      .accounts({
        config: configPda, treasuryVault: treasuryVaultPda, curve, curveXntVault, rewardPoolXntVault,
        curveTokenVault, rewardPoolTokenVault, mint: MINT, user: bot.publicKey,
        userTokenAccount: botTokenAccount, tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([bot])
      .rpc();
    console.log(`      precise buy #${attempt}: remaining was ${remaining}`);
  }

  const curveBeforeGrad: any = await (program.account as any).bondingCurve.fetch(curve);
  console.log(`\n      real_token_reserves: ${curveBeforeGrad.realTokenReserves.toString()}`);
  console.log(`      real_xnt_reserves:   ${curveBeforeGrad.realXntReserves.toString()}`);
  if (BigInt(curveBeforeGrad.realTokenReserves.toString()) > DUST_THRESHOLD) {
    throw new Error("Did not converge below dust threshold — aborting before graduate.");
  }

  // --- Graduate ---
  console.log("\n[2/3] graduate_prepare + graduate_finalize...");
  const [xdexCreator] = PublicKey.findProgramAddressSync(
    [Buffer.from("xdex_creator"), MINT.toBuffer()],
    PROGRAM_ID
  );
  const [xdexAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_and_lp_mint_auth_seed")],
    XDEX_PROGRAM_ID
  );
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), XDEX_AMM_CONFIG.toBuffer(), WXNT_MINT.toBuffer(), MINT.toBuffer()],
    XDEX_PROGRAM_ID
  );
  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_lp_mint"), poolState.toBuffer()],
    XDEX_PROGRAM_ID
  );
  const [vault0] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), poolState.toBuffer(), WXNT_MINT.toBuffer()],
    XDEX_PROGRAM_ID
  );
  const [vault1] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_vault"), poolState.toBuffer(), MINT.toBuffer()],
    XDEX_PROGRAM_ID
  );
  const [observationState] = PublicKey.findProgramAddressSync(
    [Buffer.from("observation"), poolState.toBuffer()],
    XDEX_PROGRAM_ID
  );
  const curveWxntAta = getAssociatedTokenAddressSync(WXNT_MINT, xdexCreator, true);
  const curveMintAta = getAssociatedTokenAddressSync(MINT, xdexCreator, true);
  const curveLpAta = getAssociatedTokenAddressSync(lpMint, xdexCreator, true);

  await program.methods
    .graduatePrepare()
    .accounts({
      payer: bot.publicKey,
      mint: MINT,
      curve,
      curveXntVault,
      gradReserveVault,
      wxntMint: WXNT_MINT,
      xdexCreator,
      curveWxntAta,
      curveMintAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    } as any)
    .signers([bot])
    .rpc();
  console.log("      graduate_prepare done.");

  const finalizeSig = await program.methods
    .graduateFinalize()
    .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
    .accounts({
      mint: MINT,
      curve,
      xdexCreator,
      curveWxntAta,
      curveMintAta,
      wxntMint: WXNT_MINT,
      xdexAmmConfig: XDEX_AMM_CONFIG,
      xdexAuthority,
      xdexPoolState: poolState,
      xdexLpMint: lpMint,
      curveLpAta,
      xdexVault0: vault0,
      xdexVault1: vault1,
      xdexCreatePoolFeeReceiver: XDEX_CREATE_POOL_FEE_RECEIVER,
      xdexObservationState: observationState,
      xdexProgram: XDEX_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    } as any)
    .signers([bot])
    .rpc();
  console.log(`      graduate_finalize tx: ${finalizeSig}`);

  // --- Report ---
  console.log("\n[3/3] Final report");
  const curveAfter: any = await (program.account as any).bondingCurve.fetch(curve);
  const vault0Bal = await getAccount(connection, vault0);
  const vault1Bal = await getAccount(connection, vault1);
  const lpMintInfo = await getMint(connection, lpMint);
  const botBalanceAfter = await connection.getBalance(bot.publicKey);

  console.log(`      curve.complete: ${curveAfter.complete}`);
  console.log(`      pool_state: ${poolState.toBase58()}`);
  console.log(`      lp_mint:    ${lpMint.toBase58()} (supply ${lpMintInfo.supply} — should be 0, fully burned)`);
  console.log(`      new pool vaults: WXNT=${vault0Bal.amount} token=${vault1Bal.amount}`);
  console.log(`      bot balance before: ${(botBalanceBefore / LAMPORTS_PER_SOL).toFixed(4)} XNT`);
  console.log(`      bot balance after:  ${(botBalanceAfter / LAMPORTS_PER_SOL).toFixed(4)} XNT`);
  console.log(`      xdex_creator: ${xdexCreator.toBase58()}`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
