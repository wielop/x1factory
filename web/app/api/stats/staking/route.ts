import { NextResponse } from "next/server";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { createHash } from "crypto";
import { fetchConfig, getRpcUrl } from "@/lib/solana";

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
  events: number;
  updatedAt: string;
};

let claimCache: { ts: number; data: ClaimStats; newestSig: string | null } | null = null;

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

const collectClaimStats = async (connection: Connection, rewardVault: PublicKey, decimals: number) => {
  const now = Date.now();
  if (claimCache && now - claimCache.ts < CLAIM_CACHE_MS) {
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
  let events = claimCache ? claimCache.data.events : 0;
  for (let i = 0; i < newSignatures.length; i += TX_BATCH_SIZE) {
    const chunk = newSignatures.slice(i, i + TX_BATCH_SIZE);
    const txs = await connection.getTransactions(chunk, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    txs.forEach((tx) => {
      if (!tx?.meta?.logMessages) return;
      const parsed = parseClaimEventsFromLogs(tx.meta.logMessages);
      parsed.forEach((evt) => {
        total += evt.amount;
        events += 1;
      });
    });
  }

  const newestSig = newSignatures[0] ?? claimCache?.newestSig ?? null;
  const data: ClaimStats = {
    totalBase: total,
    totalXnt: formatUi(total, decimals),
    events,
    updatedAt: new Date().toISOString(),
  };
  claimCache = { ts: now, data, newestSig };
  return data;
};

export async function GET() {
  try {
    const connection = new Connection(getRpcUrl(), { commitment: "confirmed" });
    const cfg = await fetchConfig(connection);
    if (!cfg) {
      return NextResponse.json({ error: "Config not found" }, { status: 404 });
    }

    let xntDecimals = 9;
    if (!cfg.xntMint.equals(SystemProgram.programId)) {
      try {
        const mintInfo = await getMint(connection, cfg.xntMint, "confirmed");
        xntDecimals = mintInfo.decimals;
      } catch {
        xntDecimals = 9;
      }
    }

    const stats = await collectClaimStats(connection, cfg.stakingRewardVault, xntDecimals);
    return NextResponse.json(
      { ...stats, totalBase: stats.totalBase.toString() },
      { status: 200 }
    );
  } catch (err) {
    console.error("Failed to collect staking claim stats", err);
    return NextResponse.json({ error: "Failed to load stats" }, { status: 500 });
  }
}
