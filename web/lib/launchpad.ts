import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";

export const LAUNCHPAD_PROGRAM_ID = new PublicKey("AGAdJKoLhrGrdFwrZZDEWsoR1Tq8kMcXGRKxX2wa2jfm");

export const TOKEN_DECIMALS = 6;
export const DECIMALS_MULTIPLIER = 1_000_000;
export const TOTAL_SUPPLY = 1_000_000_000 * DECIMALS_MULTIPLIER;
export const CURVE_ALLOCATION = 800_000_000 * DECIMALS_MULTIPLIER;
export const XNT_BASE = 1_000_000_000;
export const DEFAULT_FEE_BPS = 100n; // 1% — matches LaunchpadGlobalConfig.fee_bps default

export const [CONFIG_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("launchpad_config")],
  LAUNCHPAD_PROGRAM_ID
);
export const [TREASURY_VAULT_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("launchpad_treasury")],
  LAUNCHPAD_PROGRAM_ID
);

export function curvePda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("curve"), mint.toBuffer()],
    LAUNCHPAD_PROGRAM_ID
  )[0];
}
export function curveXntVaultPda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("curve_xnt_vault"), mint.toBuffer()],
    LAUNCHPAD_PROGRAM_ID
  )[0];
}
export function rewardPoolXntVaultPda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("reward_pool_xnt"), mint.toBuffer()],
    LAUNCHPAD_PROGRAM_ID
  )[0];
}
export function curveTokenVaultPda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("curve_token_vault"), mint.toBuffer()],
    LAUNCHPAD_PROGRAM_ID
  )[0];
}
export function rewardPoolTokenVaultPda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("reward_pool_token"), mint.toBuffer()],
    LAUNCHPAD_PROGRAM_ID
  )[0];
}
export function gradReserveVaultPda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("grad_reserve"), mint.toBuffer()],
    LAUNCHPAD_PROGRAM_ID
  )[0];
}

export function anchorDiscriminator(name: string): Buffer {
  return Buffer.from(createHash("sha256").update(`global:${name}`).digest().subarray(0, 8));
}

export function encodeBorshString(s: string): Buffer {
  const strBuf = Buffer.from(s, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(strBuf.length, 0);
  return Buffer.concat([lenBuf, strBuf]);
}

export function encodeU64LE(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n, 0);
  return buf;
}

export interface BondingCurveState {
  curve: string;
  mint: string;
  creator: string;
  virtualTokenReserves: bigint;
  virtualXntReserves: bigint;
  realTokenReserves: bigint;
  realXntReserves: bigint;
  rewardPoolXntBalance: bigint;
  rewardPoolTokenBalance: bigint;
  tradeCounter: bigint;
  gigaHits: bigint;
  complete: boolean;
  createdAt: number;
  bump: number;
}

// BondingCurve layout (after the 8-byte Anchor discriminator) — must match
// programs/launchpad/src/lib.rs's `BondingCurve` struct field order exactly.
export const BONDING_CURVE_SIZE = 8 + 32 + 32 + 8 * 8 + 1 + 8 + 6;

export function parseBondingCurve(data: Buffer, pubkey: PublicKey): BondingCurveState {
  let o = 8;
  const mint = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const creator = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const virtualTokenReserves = data.readBigUInt64LE(o);
  o += 8;
  const virtualXntReserves = data.readBigUInt64LE(o);
  o += 8;
  const realTokenReserves = data.readBigUInt64LE(o);
  o += 8;
  const realXntReserves = data.readBigUInt64LE(o);
  o += 8;
  const rewardPoolXntBalance = data.readBigUInt64LE(o);
  o += 8;
  const rewardPoolTokenBalance = data.readBigUInt64LE(o);
  o += 8;
  const tradeCounter = data.readBigUInt64LE(o);
  o += 8;
  const gigaHits = data.readBigUInt64LE(o);
  o += 8;
  const complete = data[o] !== 0;
  o += 1;
  const createdAt = data.readBigInt64LE(o);
  o += 8;
  const bump = data[o];

  return {
    curve: pubkey.toBase58(),
    mint: mint.toBase58(),
    creator: creator.toBase58(),
    virtualTokenReserves,
    virtualXntReserves,
    realTokenReserves,
    realXntReserves,
    rewardPoolXntBalance,
    rewardPoolTokenBalance,
    tradeCounter,
    gigaHits,
    complete,
    createdAt: Number(createdAt),
    bump,
  };
}

/** Mirrors the on-chain `buy()` math in programs/launchpad/src/lib.rs. */
export function quoteBuy(curve: BondingCurveState, xntIn: bigint, feeBps: bigint = DEFAULT_FEE_BPS) {
  const feeTotal = (xntIn * feeBps) / 10_000n;
  const xntToCurve = xntIn - feeTotal;
  const k = curve.virtualTokenReserves * curve.virtualXntReserves;
  const newVirtualXnt = curve.virtualXntReserves + xntToCurve;
  const newVirtualToken = k / newVirtualXnt;
  const tokensOut = curve.virtualTokenReserves - newVirtualToken;
  return { tokensOut, feeTotal, xntToCurve, soldOut: tokensOut > curve.realTokenReserves };
}

/** Mirrors the on-chain `sell()` math in programs/launchpad/src/lib.rs. */
export function quoteSell(curve: BondingCurveState, tokenIn: bigint, feeBps: bigint = DEFAULT_FEE_BPS) {
  const k = curve.virtualTokenReserves * curve.virtualXntReserves;
  const newVirtualToken = curve.virtualTokenReserves + tokenIn;
  const newVirtualXnt = k / newVirtualToken;
  const grossXntOut = curve.virtualXntReserves - newVirtualXnt;
  const feeTotal = (grossXntOut * feeBps) / 10_000n;
  const netXntOut = grossXntOut - feeTotal;
  return { netXntOut, grossXntOut, feeTotal, insufficientLiquidity: grossXntOut > curve.realXntReserves };
}

export function priceUsd(curve: BondingCurveState, xntUsdCents: number): number {
  if (curve.virtualTokenReserves === 0n) return 0;
  const priceXnt = Number(curve.virtualXntReserves) / Number(curve.virtualTokenReserves);
  return priceXnt * (xntUsdCents / 100);
}

export function fdvUsd(curve: BondingCurveState, xntUsdCents: number): number {
  return priceUsd(curve, xntUsdCents) * (TOTAL_SUPPLY / DECIMALS_MULTIPLIER);
}

export function progressPct(curve: BondingCurveState): number {
  const sold = CURVE_ALLOCATION - Number(curve.realTokenReserves);
  const pct = CURVE_ALLOCATION > 0 ? (sold / CURVE_ALLOCATION) * 100 : 0;
  return Math.max(0, Math.min(100, pct));
}
