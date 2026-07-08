/**
 * Long-running keeper for the launchpad program. Three jobs, on a fixed poll interval:
 *
 *   1. refresh_price — keeps LaunchpadGlobalConfig.xnt_usd_cents current (permissionless,
 *      reads the same xdex XNT/USDC pool swap_router's oracle uses).
 *   2. graduate scan — finds any curve that sold out (real_token_reserves <= the on-chain
 *      GRADUATION_DUST_THRESHOLD) but hasn't graduated yet, and calls
 *      graduate_prepare + graduate_finalize on it. Without this, a curve that fully sells
 *      out from real trading gets permanently stuck — no one can buy or sell it — exactly
 *      the failure mode graduate() exists to close, so it needs someone actually calling it.
 *   3. price sampling — records every curve's current price into LaunchpadPricePoint
 *      (Postgres, same DB web/ already uses for everything else) so the token page can chart
 *      real price over time. There's no per-trade indexer yet, so this poll-based sampling
 *      (once a minute, whenever this keeper runs) *is* the price history — coarser than a
 *      per-trade log, but a big step up from no history at all.
 *
 * Uses the low-privilege launchpad-bot keypair (~/.config/solana/launchpad-bot.json) as payer
 * for both jobs — deliberately NOT the program's upgrade-authority admin key, since this runs
 * unattended on a VPS: graduate_prepare/refresh_price are permissionless and need no special
 * authority, just a funded wallet, so a compromised VPS only risks this wallet's balance
 * (~0.25 XNT rent buffer per graduation; the pool's own liquidity comes from the curve itself).
 *
 * Usage: npx tsx scripts/launchpad-keeper.ts
 * Deploy: pm2 start --name launchpad-keeper --interpreter node -- \
 *           node_modules/.bin/tsx scripts/launchpad-keeper.ts
 */
import anchorPkg, * as anchor from "@coral-xyz/anchor";
const { BN } = anchorPkg;
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";

const prisma = new PrismaClient();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID = new PublicKey("AGAdJKoLhrGrdFwrZZDEWsoR1Tq8kMcXGRKxX2wa2jfm");
const KEEPER_KEY_PATH = path.join(process.env.HOME!, ".config/solana/launchpad-bot.json");

const XDEX_PROGRAM_ID = new PublicKey("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
const XDEX_AMM_CONFIG = new PublicKey("2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c");
const XDEX_CREATE_POOL_FEE_RECEIVER = new PublicKey("SKc6b6zAv2kkB9EtitjppbzPVR48bCMfRtE5B8KDuF1");
const WXNT_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const XNT_USDC_XNT_VAULT = new PublicKey("8wvV4HKBDFMLEUkVWp1WPNa5ano99XCm3f9t3troyLb");
const XNT_USDC_USDC_VAULT = new PublicKey("7iw2adw8Af7x3pY7gj5RwczFXuGjCoX92Gfy3avwXQtg");

const DUST_THRESHOLD = 1000n; // mirrors GRADUATION_DUST_THRESHOLD in programs/launchpad/src/lib.rs
const POLL_INTERVAL_MS = 60_000;
// BondingCurve layout (after 8-byte disc): mint(32) creator(32) virtual_token(8) virtual_xnt(8)
// real_token(8) real_xnt(8) reward_pool_xnt(8) reward_pool_token(8) trade_counter(8)
// giga_hits(8) complete(1) created_at(8) + 5 bump bytes.
const BONDING_CURVE_SIZE = 8 + 32 + 32 + 8 * 8 + 1 + 8 + 6;

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

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function parseCurve(data: Buffer) {
  let o = 8;
  const mint = new PublicKey(data.subarray(o, o + 32));
  o += 32 + 32; // skip creator
  const virtualTokenReserves = data.readBigUInt64LE(o);
  o += 8;
  const virtualXntReserves = data.readBigUInt64LE(o);
  o += 8;
  const realTokenReserves = data.readBigUInt64LE(o);
  o += 8;
  const realXntReserves = data.readBigUInt64LE(o);
  o += 8 + 8 + 8 + 8 + 8; // skip reward pools, trade_counter, giga_hits
  const complete = data[o] !== 0;
  return { mint, virtualTokenReserves, virtualXntReserves, realTokenReserves, realXntReserves, complete };
}

const TOKEN_DECIMALS = 6;
const XNT_DECIMALS = 9;

function priceUsd(virtualTokenReserves: bigint, virtualXntReserves: bigint, xntUsdCents: number): number {
  if (virtualTokenReserves === 0n) return 0;
  const priceXnt = Number(virtualXntReserves) / 10 ** XNT_DECIMALS / (Number(virtualTokenReserves) / 10 ** TOKEN_DECIMALS);
  return priceXnt * (xntUsdCents / 100);
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const keeper = loadKeypair(KEEPER_KEY_PATH);
  const wallet = new anchor.Wallet(keeper);
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

  log(`launchpad-keeper started. keeper=${keeper.publicKey.toBase58()}`);

  async function refreshPrice() {
    try {
      await program.methods
        .refreshPrice()
        .accounts({ config: configPda, xntVault: XNT_USDC_XNT_VAULT, usdcVault: XNT_USDC_USDC_VAULT } as any)
        .rpc();
    } catch (e: any) {
      log(`refresh_price failed (non-fatal): ${e?.message ?? e}`);
    }
  }

  async function graduateCurve(mint: PublicKey) {
    const [curve] = PublicKey.findProgramAddressSync([Buffer.from("curve"), mint.toBuffer()], PROGRAM_ID);
    const [curveXntVault] = PublicKey.findProgramAddressSync([Buffer.from("curve_xnt_vault"), mint.toBuffer()], PROGRAM_ID);
    const [gradReserveVault] = PublicKey.findProgramAddressSync([Buffer.from("grad_reserve"), mint.toBuffer()], PROGRAM_ID);
    const [xdexCreator] = PublicKey.findProgramAddressSync([Buffer.from("xdex_creator"), mint.toBuffer()], PROGRAM_ID);
    const [xdexAuthority] = PublicKey.findProgramAddressSync([Buffer.from("vault_and_lp_mint_auth_seed")], XDEX_PROGRAM_ID);
    const [poolState] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), XDEX_AMM_CONFIG.toBuffer(), WXNT_MINT.toBuffer(), mint.toBuffer()],
      XDEX_PROGRAM_ID
    );
    const [lpMint] = PublicKey.findProgramAddressSync([Buffer.from("pool_lp_mint"), poolState.toBuffer()], XDEX_PROGRAM_ID);
    const [vault0] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_vault"), poolState.toBuffer(), WXNT_MINT.toBuffer()],
      XDEX_PROGRAM_ID
    );
    const [vault1] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_vault"), poolState.toBuffer(), mint.toBuffer()],
      XDEX_PROGRAM_ID
    );
    const [observationState] = PublicKey.findProgramAddressSync(
      [Buffer.from("observation"), poolState.toBuffer()],
      XDEX_PROGRAM_ID
    );
    const curveWxntAta = getAssociatedTokenAddressSync(WXNT_MINT, xdexCreator, true);
    const curveMintAta = getAssociatedTokenAddressSync(mint, xdexCreator, true);
    const curveLpAta = getAssociatedTokenAddressSync(lpMint, xdexCreator, true);

    log(`graduating ${mint.toBase58()}...`);

    await program.methods
      .graduatePrepare()
      .accounts({
        payer: keeper.publicKey,
        mint,
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
      .rpc();

    const sig = await program.methods
      .graduateFinalize()
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
      .accounts({
        mint,
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
      .rpc();

    log(`graduated ${mint.toBase58()} -> pool ${poolState.toBase58()} (tx ${sig})`);
  }

  async function getXntUsdCents(): Promise<number> {
    const info = await connection.getAccountInfo(configPda);
    if (!info || info.data.length < 40 + 8) return 50; // fallback, matches web/lib/launchpad.ts default
    const cents = Number(info.data.readBigUInt64LE(40));
    return cents > 0 ? cents : 50;
  }

  async function scanCurves() {
    const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
      filters: [{ dataSize: BONDING_CURVE_SIZE }],
    });
    return accounts.map(({ account }) => parseCurve(account.data));
  }

  async function samplePrices(curves: ReturnType<typeof parseCurve>[], xntUsdCents: number) {
    try {
      await prisma.launchpadPricePoint.createMany({
        data: curves.map((c) => ({
          mint: c.mint.toBase58(),
          priceUsd: priceUsd(c.virtualTokenReserves, c.virtualXntReserves, xntUsdCents),
        })),
      });
    } catch (e: any) {
      log(`price sampling failed (non-fatal): ${e?.message ?? e}`);
    }
  }

  async function scanAndGraduate(curves: ReturnType<typeof parseCurve>[]) {
    for (const curve of curves) {
      if (curve.complete) continue;
      if (curve.realTokenReserves > DUST_THRESHOLD) continue;
      if (curve.realXntReserves === 0n) continue; // never traded — nothing to migrate
      try {
        await graduateCurve(curve.mint);
      } catch (e: any) {
        log(`graduate FAILED for ${curve.mint.toBase58()}: ${e?.message ?? e}`);
        if (e?.logs) log(e.logs.join("\n"));
      }
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await refreshPrice();
    try {
      const curves = await scanCurves();
      const xntUsdCents = await getXntUsdCents();
      await samplePrices(curves, xntUsdCents);
      await scanAndGraduate(curves);
    } catch (e: any) {
      log(`poll cycle failed: ${e?.message ?? e}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
