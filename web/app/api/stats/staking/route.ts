import { NextResponse } from "next/server";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { createHash } from "crypto";
import fs from "fs/promises";
import { fetchConfig, getProgramId, getRpcUrl } from "@/lib/solana";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";
const SIGNATURE_PAGE_LIMIT = 1000;
const TX_BATCH_SIZE = 25;
const CLAIM_CACHE_MS = 60 * 1000;
const EVENT_DISCRIMINATOR = createHash("sha256")
  .update("event:XntClaimed")
  .digest()
  .subarray(0, 8);
type ClaimStats = {
  totalBase: bigint;
  totalXnt: string;
  total7dBase: bigint;
  total7dXnt: string;
  last24hBase: bigint;
  last24hXnt: string;
  apr7dPct: number | null;
  events: number;
  updatedAt: string;
};

let claimCache: { ts: number; data: ClaimStats; newestSig: string | null } | null = null;
const CACHE_PATH = "/tmp/staking_stats_cache.json";

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]) as Promise<T>;
};

const loadPersistentCache = async () => {
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.claim) {
      claimCache = {
        ts: parsed.claim.ts,
        newestSig: parsed.claim.newestSig ?? null,
        data: {
          ...parsed.claim.data,
          totalBase: BigInt(parsed.claim.data.totalBase),
          total7dBase: BigInt(parsed.claim.data.total7dBase),
          last24hBase: BigInt(parsed.claim.data.last24hBase),
        },
      };
    }
  } catch {
    // ignore missing/invalid cache
  }
};

void loadPersistentCache();

const formatUi = (amountBase: bigint, decimals: number) => {
  if (decimals <= 0) return amountBase.toString();
  const denom = 10n ** BigInt(decimals);
  const whole = amountBase / denom;
  const frac = (amountBase % denom).toString().padStart(decimals, "0");
  return `${whole}.${frac}`;
};

const parseClaimEventsFromLogs = (logs: string[]) => {
  const events: Array<{ amount: bigint }> = [];
  const prefix = "Program data: ";
  for (const log of logs) {
    if (!log.startsWith(prefix)) continue;
    const raw = log.slice(prefix.length).trim();
    let buf: Buffer;
    try {
      buf = Buffer.from(raw, "base64");
    } catch {
      continue;
    }
    if (buf.length < 50) continue; // 8 disc + 32 pubkey + 8 amount + 2 bonus_bps
    if (!buf.subarray(0, 8).equals(EVENT_DISCRIMINATOR)) continue;
    const amount = buf.readBigUInt64LE(40);
    events.push({ amount });
  }
  return events;
};

const collectClaimStats = async (
  connection: Connection,
  rewardVault: PublicKey,
  decimals: number,
  totalStakedMind: bigint,
  mindDecimals: number
) => {
  const now = Date.now();
  if (claimCache && now - claimCache.ts < CLAIM_CACHE_MS && claimCache.data.totalBase > 0n) {
    return claimCache.data;
  }

  const newSignatures: string[] = [];
  let before: string | undefined;
  let reachedCached = false;
  while (true) {
    const batch = await connection.getSignaturesForAddress(rewardVault, { before, limit: SIGNATURE_PAGE_LIMIT });
    if (batch.length === 0) break;
    for (const sig of batch) {
      if (claimCache?.newestSig && sig.signature === claimCache.newestSig) {
        reachedCached = true;
        break;
      }
      newSignatures.push(sig.signature);
    }
    if (reachedCached || batch.length < SIGNATURE_PAGE_LIMIT) break;
    before = batch[batch.length - 1].signature;
  }

  let total = claimCache ? claimCache.data.totalBase : 0n;
  let total7d = 0n;
  let last24h = 0n;
  let events = claimCache ? claimCache.data.events : 0;
  const sevenDaysAgo = Math.floor(now / 1000) - 7 * 86_400;
  const oneDayAgo = Math.floor(now / 1000) - 86_400;
  for (let i = 0; i < newSignatures.length; i += TX_BATCH_SIZE) {
    const chunk = newSignatures.slice(i, i + TX_BATCH_SIZE);
    const txs = await connection.getTransactions(chunk, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    txs.forEach((tx) => {
      if (!tx?.meta?.logMessages) return;
      const blockTime = tx.blockTime ?? 0;
      const parsed = parseClaimEventsFromLogs(tx.meta.logMessages);
      parsed.forEach((evt) => {
        total += evt.amount;
        events += 1;
        if (blockTime >= sevenDaysAgo) {
          total7d += evt.amount;
        }
        if (blockTime >= oneDayAgo) {
          last24h += evt.amount;
        }
      });
    });
  }

  if (claimCache && !newSignatures.length) {
    total7d = claimCache.data.total7dBase;
    last24h = claimCache.data.last24hBase;
  }

  const perSec7d =
    total7d > 0n
      ? Number(total7d) /
        Math.pow(10, decimals) /
        (7 * 86_400)
      : 0;
  const totalStakedUi =
    totalStakedMind > 0n ? Number(totalStakedMind) / Math.pow(10, mindDecimals) : 0;
  const apr7dPct =
    totalStakedUi > 0 && perSec7d > 0
      ? ((perSec7d * 31_536_000) / totalStakedUi) * 100
      : null;

  const newestSig = newSignatures[0] ?? claimCache?.newestSig ?? null;
  const data: ClaimStats = {
    totalBase: total,
    totalXnt: formatUi(total, decimals),
    total7dBase: total7d,
    total7dXnt: formatUi(total7d, decimals),
    last24hBase: last24h,
    last24hXnt: formatUi(last24h, decimals),
    apr7dPct,
    events,
    updatedAt: new Date().toISOString(),
  };
  claimCache = { ts: now, data, newestSig };
  return data;
};

type PoolState = {
  token0Vault: PublicKey;
  token1Vault: PublicKey;
  token0Mint: PublicKey;
  token1Mint: PublicKey;
  mint0Decimals: number;
  mint1Decimals: number;
};

const POOL_MIND_XNT = new PublicKey("FAVw1iDioK69epJf1YY3Z1oakSCUYtmfUpVBxR14BGpm");
const POOL_XNT_USDC = new PublicKey("CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR");
const MIND_MINT = new PublicKey("DohWBfvXER6qs8zFGtdZRDpgbHmm97ZZwgCUTCdtHQNT");
const XNT_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq");
const RAYDIUM_PROGRAM = new PublicKey("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");

const decodePoolState = (data: Buffer): PoolState => {
  const offset = 8; // anchor account discriminator
  let idx = offset;
  const readPubkey = () => {
    const pk = new PublicKey(data.subarray(idx, idx + 32));
    idx += 32;
    return pk;
  };
  const skipPubkeys = (count: number) => {
    idx += 32 * count;
  };
  // order per IDL
  skipPubkeys(0);
  const ammConfig = readPubkey();
  const poolCreator = readPubkey();
  const token0Vault = readPubkey();
  const token1Vault = readPubkey();
  const lpMint = readPubkey();
  const token0Mint = readPubkey();
  const token1Mint = readPubkey();
  const token0Program = readPubkey();
  const token1Program = readPubkey();
  const observationKey = readPubkey();
  // bumps / status / decimals
  const authBump = data.readUInt8(idx);
  idx += 1;
  const status = data.readUInt8(idx);
  idx += 1;
  const lpMintDecimals = data.readUInt8(idx);
  idx += 1;
  const mint0Decimals = data.readUInt8(idx);
  idx += 1;
  const mint1Decimals = data.readUInt8(idx);
  idx += 1;
  return {
    token0Vault,
    token1Vault,
    token0Mint,
    token1Mint,
    mint0Decimals,
    mint1Decimals,
  };
};

const fetchPoolState = async (connection: Connection, address: PublicKey): Promise<PoolState> => {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) {
    throw new Error(`PoolState not found: ${address.toBase58()}`);
  }
  if (!info.owner.equals(RAYDIUM_PROGRAM)) {
    throw new Error(`PoolState owner mismatch: ${info.owner.toBase58()}`);
  }
  return decodePoolState(info.data);
};

const getMintDecimals = async (connection: Connection, mint: PublicKey, fallback = 9) => {
  try {
    const info = await getMint(connection, mint, "confirmed");
    return info.decimals ?? fallback;
  } catch {
    return fallback;
  }
};

export async function GET() {
  // Always return 200 with best-effort data to avoid frontend failures
  const fallbackStats: ClaimStats = {
    totalBase: 0n,
    totalXnt: "0",
    total7dBase: 0n,
    total7dXnt: "0",
    last24hBase: 0n,
    last24hXnt: "0",
    apr7dPct: null,
    events: 0,
    updatedAt: new Date().toISOString(),
  };

  try {
    // Avoid hitting on-chain during build-time prerender attempts
    if (process.env.NEXT_PHASE === "phase-production-build") {
      return NextResponse.json(
        { status: "skip-during-build", cached: claimCache?.data ?? fallbackStats },
        { status: 200 }
      );
    }

    const connection = new Connection(getRpcUrl(), { commitment: "confirmed" });
    const cfg = await fetchConfig(connection);
    if (!cfg) {
      return NextResponse.json({ ...fallbackStats, error: "Config not found" }, { status: 200 });
    }

    let xntDecimals = 9;
    let mindDecimals = 9;
    if (!cfg.xntMint.equals(SystemProgram.programId)) {
      try {
        const mintInfo = await getMint(connection, cfg.xntMint, "confirmed");
        xntDecimals = mintInfo.decimals;
      } catch {
        xntDecimals = 9;
      }
    }
    try {
      const mindMintInfo = await getMint(connection, cfg.mindMint, "confirmed");
      mindDecimals = mindMintInfo.decimals;
    } catch {
      mindDecimals = 9;
    }

    const preferCached = claimCache && (claimCache.data.totalBase > 0n || claimCache.data.events > 0);
    let stats: ClaimStats | null = preferCached ? claimCache!.data : null;

    // If no cache, block once to build it (generous timeout to avoid infinite wait)
    if (!stats) {
      try {
        stats = await withTimeout(
          collectClaimStats(
            connection,
            cfg.stakingRewardVault,
            xntDecimals,
            cfg.stakingTotalStakedMind,
            mindDecimals
          ),
          30_000
        );
      } catch {
        stats = claimCache?.data ?? fallbackStats;
      }
    } else if (Date.now() - claimCache!.ts > CLAIM_CACHE_MS) {
      // Cache is stale; refresh in the background but still return cached data immediately
      void collectClaimStats(
        connection,
        cfg.stakingRewardVault,
        xntDecimals,
        cfg.stakingTotalStakedMind,
        mindDecimals
      ).catch(() => null);
    }

    if (!stats) {
      stats = fallbackStats;
    }

    // Pricing via xDEX (Raydium CP swap) pools; tolerate failures
    let mindInUsd: number | null = null;
    let mindInXnt: number | null = null;
    let xntInUsd: number | null = null;
    let tvlUsd: number | null = null;
    try {
      const poolMind = await fetchPoolState(connection, POOL_MIND_XNT);
      const poolUsdc = await fetchPoolState(connection, POOL_XNT_USDC);

      const mindDecimalsPool = await getMintDecimals(connection, MIND_MINT, mindDecimals);
      const xntDecimalsPool = await getMintDecimals(connection, XNT_MINT, xntDecimals);
      const usdcDecimalsPool = await getMintDecimals(connection, USDC_MINT, 6);

      const [vault0Mind, vault1Mind, vault0Usdc, vault1Usdc] = await Promise.all([
        connection.getTokenAccountBalance(poolMind.token0Vault, "confirmed"),
        connection.getTokenAccountBalance(poolMind.token1Vault, "confirmed"),
        connection.getTokenAccountBalance(poolUsdc.token0Vault, "confirmed"),
        connection.getTokenAccountBalance(poolUsdc.token1Vault, "confirmed"),
      ]);

      const getReserve = (bal: { value: { amount?: string } }) => BigInt(bal.value.amount || "0");

      const mindVaultReserve =
        poolMind.token0Mint.equals(MIND_MINT) ? getReserve(vault0Mind) : getReserve(vault1Mind);
      const xntVaultReserveMind =
        poolMind.token0Mint.equals(XNT_MINT) ? getReserve(vault0Mind) : getReserve(vault1Mind);

      const xntVaultReserveUsdc =
        poolUsdc.token0Mint.equals(XNT_MINT) ? getReserve(vault0Usdc) : getReserve(vault1Usdc);
      const usdcVaultReserve =
        poolUsdc.token0Mint.equals(USDC_MINT) ? getReserve(vault0Usdc) : getReserve(vault1Usdc);

      const toUi = (amount: bigint, decimals: number) => Number(amount) / 10 ** decimals;
      const priceFromReserves = (
        baseReserve: bigint,
        quoteReserve: bigint,
        baseDecimals: number,
        quoteDecimals: number
      ) => {
        if (baseReserve === 0n || quoteReserve === 0n) return null;
        const baseUi = toUi(baseReserve, baseDecimals);
        const quoteUi = toUi(quoteReserve, quoteDecimals);
        if (!Number.isFinite(baseUi) || baseUi === 0 || !Number.isFinite(quoteUi)) return null;
        return quoteUi / baseUi;
      };

      mindInXnt = priceFromReserves(
        mindVaultReserve,
        xntVaultReserveMind,
        mindDecimalsPool,
        xntDecimalsPool
      );
      xntInUsd = priceFromReserves(
        xntVaultReserveUsdc,
        usdcVaultReserve,
        xntDecimalsPool,
        usdcDecimalsPool
      );

      mindInUsd = mindInXnt != null && xntInUsd != null ? mindInXnt * xntInUsd : null;
      tvlUsd =
        mindInUsd != null
          ? toUi(cfg.stakingTotalStakedMind, mindDecimals) * mindInUsd
          : null;
    } catch {
      // ignore pricing failures; return other stats
    }

    const responsePayload = {
      ...stats,
      totalBase: stats.totalBase.toString(),
      total7dBase: stats.total7dBase.toString(),
      last24hBase: stats.last24hBase.toString(),
      price:
        mindInUsd != null && mindInXnt != null && xntInUsd != null
          ? {
              mindUsd: mindInUsd,
              mindXnt: mindInXnt,
              xntUsd: xntInUsd,
            }
          : null,
      tvlUsd,
    };

    // persist for future cold starts
    void fs.writeFile(
      CACHE_PATH,
      JSON.stringify({
        claim: claimCache,
      }),
      "utf8"
    ).catch(() => null);

    return NextResponse.json(responsePayload, { status: 200 });
  } catch (err) {
    console.error("Failed to collect staking claim stats", err);
    return NextResponse.json(fallbackStats, { status: 200 });
  }
}
