import { createHash } from "node:crypto";

import type { Wallet } from "@prisma/client";
import { Connection, PublicKey } from "@solana/web3.js";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createDetectedEvent, findDetectedEvent } from "../db/eventRepository.js";
import { getWalletScannerCursor, upsertWalletScannerCursor } from "../db/scannerRepository.js";
import { getActiveSeason, getActiveSeasonRegistrationsWithWallets } from "../db/seasonRepository.js";
import { checkSeasonEndNotifications, processDailyClaim, processEvent, processStakeSnapshot } from "../services/pointsService.js";
import { broadcastPoolFunded } from "../services/dailyNotificationService.js";

import { RealX1FactoryAdapter } from "./realAdapter.js";
import type {
  ScannerCursorSnapshot,
  ScannerDiagnosticCandidate,
  ScannerRunSummary,
  ScannerWalletResult,
  UserFactoryState,
  X1FactoryEvent
} from "./types.js";

type ScannerErrorEntry = {
  at: Date;
  message: string;
  wallet?: string;
};

type ManualWalletScanOutcome = {
  wallet: string;
  parserConfirmed: boolean;
  parserMessage: string;
  state: UserFactoryState | null;
  eventsDetected: number;
  pointsAwarded: number;
  diagnostics: ScannerDiagnosticCandidate[];
  applied: boolean;
};

const adapter = new RealX1FactoryAdapter();
const recentErrors: ScannerErrorEntry[] = [];

let timer: NodeJS.Timeout | null = null;
let cycleInFlight = false;
let lastScanAt: Date | null = null;
let lastSummary: ScannerRunSummary | null = null;

function rememberError(entry: ScannerErrorEntry): void {
  recentErrors.push(entry);

  if (recentErrors.length > 10) {
    recentErrors.shift();
  }
}

function dateKeyFromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isWithinSeasonWindow(date: Date, startsAt: Date, endsAt: Date): boolean {
  return date >= startsAt && date <= endsAt;
}

function hasCompletedFirst24Hours(startTs: number, now: Date): boolean {
  return now.getTime() >= startTs * 1000 + 24 * 60 * 60 * 1000;
}

function formatIgnoredEventReason(reason: "missing_block_time" | "outside_season_window", startsAt: Date, endsAt: Date): string {
  if (reason === "missing_block_time") {
    return "Ignored automatic award: missing blockTime";
  }

  return `Ignored automatic award: outside active season window ${startsAt.toISOString()} - ${endsAt.toISOString()}`;
}

function getScannerEventKey(event: X1FactoryEvent): string {
  const positionIndex = event.raw.positionIndex;

  if (typeof positionIndex === "number" || typeof positionIndex === "string") {
    return `${event.txHash}:${event.eventType}:position:${positionIndex}`;
  }

  const positionAddress = event.raw.positionAddress;

  if (typeof positionAddress === "string" && positionAddress.length > 0) {
    return `${event.txHash}:${event.eventType}:position:${positionAddress}`;
  }

  const eventIndex = event.raw.eventIndex;

  if (typeof eventIndex === "number" || typeof eventIndex === "string") {
    return `${event.txHash}:${event.eventType}:event:${eventIndex}`;
  }

  return event.txHash;
}

function parseCursorSnapshot(snapshot: unknown): ScannerCursorSnapshot {
  if (!snapshot || typeof snapshot !== "object") {
    return {
      seasonId: null,
      state: null,
      claimDailyTotals: {},
      awardedDailyActiveKeys: {},
      stakeBaselineAmount: null
    };
  }

  const record = snapshot as Record<string, unknown>;

  return {
    seasonId: typeof record.seasonId === "number" ? record.seasonId : null,
    state: (record.state as UserFactoryState | null | undefined) ?? null,
    claimDailyTotals: (record.claimDailyTotals as Record<string, number> | undefined) ?? {},
    awardedDailyActiveKeys: (record.awardedDailyActiveKeys as Record<string, string[]> | undefined) ?? {},
    stakeBaselineAmount: typeof record.stakeBaselineAmount === "number" ? record.stakeBaselineAmount : null
  };
}

function normalizeCursorSnapshotForSeason(snapshot: ScannerCursorSnapshot, seasonId: number): ScannerCursorSnapshot {
  if (snapshot.seasonId === seasonId) {
    return snapshot;
  }

  return {
    seasonId,
    state: null,
    claimDailyTotals: {},
    awardedDailyActiveKeys: {},
    stakeBaselineAmount: null
  };
}

async function upsertRawDetectedEvent(params: {
  txHash: string;
  eventType: string;
  walletId: number;
  seasonId: number | null;
  slot: number;
  blockTime: Date | null;
  rawData: Record<string, unknown>;
}): Promise<boolean> {
  const existing = await findDetectedEvent({
    txHash: params.txHash,
    eventType: params.eventType,
    walletId: params.walletId
  });

  if (existing) {
    return false;
  }

  await createDetectedEvent({
    txHash: params.txHash,
    eventType: params.eventType,
    walletId: params.walletId,
    seasonId: params.seasonId,
    blockNumber: BigInt(params.slot),
    occurredAt: params.blockTime ?? new Date(),
    rawData: params.rawData as never
  });

  return true;
}

async function applyWalletEvents(params: {
  seasonId: number;
  userId: number;
  wallet: Wallet;
  scan: ScannerWalletResult;
  cursorSnapshot: ScannerCursorSnapshot;
  seasonStartsAt: Date;
  seasonEndsAt: Date;
}): Promise<{
  pointsAwarded: number;
  eventsDetected: number;
  nextSnapshot: ScannerCursorSnapshot;
  ignoredDiagnostics: ScannerDiagnosticCandidate[];
}> {
  let pointsAwarded = 0;
  let eventsDetected = 0;
  const ignoredDiagnostics: ScannerDiagnosticCandidate[] = [];
  let recordedStakeSnapshot = false;
  const nextSnapshot: ScannerCursorSnapshot = {
    seasonId: params.seasonId,
    state: params.scan.state,
    claimDailyTotals: { ...params.cursorSnapshot.claimDailyTotals },
    awardedDailyActiveKeys: { ...params.cursorSnapshot.awardedDailyActiveKeys },
    stakeBaselineAmount: params.cursorSnapshot.stakeBaselineAmount ?? null
  };

  const dailyClaimIncrements = new Map<string, number>();

  for (const event of params.scan.events) {
    if (!event.blockTime) {
      ignoredDiagnostics.push({
        txHash: event.txHash,
        slot: event.slot,
        blockTime: null,
        instructionNames: [event.raw.instruction].filter((value): value is string => typeof value === "string"),
        eventNames: [],
        rawSummary: `${event.txHash} | ${event.eventType}`,
        reason: formatIgnoredEventReason("missing_block_time", params.seasonStartsAt, params.seasonEndsAt)
      });
      continue;
    }

    if (!isWithinSeasonWindow(event.blockTime, params.seasonStartsAt, params.seasonEndsAt)) {
      ignoredDiagnostics.push({
        txHash: event.txHash,
        slot: event.slot,
        blockTime: event.blockTime,
        instructionNames: [event.raw.instruction].filter((value): value is string => typeof value === "string"),
        eventNames: [],
        rawSummary: `${event.txHash} | ${event.eventType}`,
        reason: formatIgnoredEventReason("outside_season_window", params.seasonStartsAt, params.seasonEndsAt)
      });
      continue;
    }

    const eventKey = getScannerEventKey(event);

    if (event.eventType === "claim_mind_daily") {
      const recorded = await upsertRawDetectedEvent({
        txHash: eventKey,
        eventType: event.eventType,
        walletId: params.wallet.id,
        seasonId: params.seasonId,
        slot: event.slot,
        blockTime: event.blockTime,
        rawData: {
          ...event.raw,
          originalTxHash: event.txHash
        }
      });

      if (!recorded || event.amount == null) {
        continue;
      }

      const claimDay = dateKeyFromDate(event.blockTime ?? new Date());
      dailyClaimIncrements.set(claimDay, (dailyClaimIncrements.get(claimDay) ?? 0) + event.amount);
      eventsDetected += 1;
      continue;
    }

    if (event.eventType === "stake_snapshot") {
      const recorded = await upsertRawDetectedEvent({
        txHash: eventKey,
        eventType: event.eventType,
        walletId: params.wallet.id,
        seasonId: params.seasonId,
        slot: event.slot,
        blockTime: event.blockTime,
        rawData: {
          ...event.raw,
          originalTxHash: event.txHash
        }
      });

      if (recorded) {
        eventsDetected += 1;
        recordedStakeSnapshot = true;
      }

      continue;
    }

    const result = await processEvent(params.userId, params.seasonId, event.eventType, {
      txHash: eventKey,
      originalTxHash: event.txHash,
      blockTime: event.blockTime?.toISOString(),
      slot: event.slot,
      amount: event.amount,
      rigType: event.rigType,
      ...event.raw
    });

    if (result.created) {
      pointsAwarded += result.points;
      eventsDetected += 1;
    }
  }

  for (const [claimDay, increment] of dailyClaimIncrements.entries()) {
    const totalClaimed = (nextSnapshot.claimDailyTotals[claimDay] ?? 0) + increment;
    nextSnapshot.claimDailyTotals[claimDay] = totalClaimed;
    const result = await processDailyClaim(
      params.userId,
      params.seasonId,
      totalClaimed,
      `${claimDay}T00:00:00.000Z`,
      increment
    );

    if (result.created) {
      pointsAwarded += result.points;
    }
  }

  if (params.scan.state) {
    const now = new Date();

    if (isWithinSeasonWindow(now, params.seasonStartsAt, params.seasonEndsAt)) {
      const currentStakeAmount = params.scan.state.stakedMindAmount;
      const previousStakeAmount = params.cursorSnapshot.state?.stakedMindAmount ?? null;
      const stakeBaselineAmount = nextSnapshot.stakeBaselineAmount ?? currentStakeAmount;
      nextSnapshot.stakeBaselineAmount = stakeBaselineAmount;
      const effectiveStakeAmount = Math.max(0, currentStakeAmount - stakeBaselineAmount);
      const stakeAmountIncreased = previousStakeAmount != null && currentStakeAmount > previousStakeAmount;

      if (recordedStakeSnapshot || stakeAmountIncreased) {
        const stakeResult = await processStakeSnapshot(
          params.userId,
          params.seasonId,
          effectiveStakeAmount,
          currentStakeAmount,
          stakeBaselineAmount
        );

        if (stakeResult.created) {
          pointsAwarded += stakeResult.points;
        }
      }

      const todayKey = dateKeyFromDate(now);
      const awardedKeys = new Set(nextSnapshot.awardedDailyActiveKeys[todayKey] ?? []);

      for (const position of params.scan.state.positions) {
        if (!position.active) {
          continue;
        }

        if (!hasCompletedFirst24Hours(position.startTs, now)) {
          continue;
        }

        const dailyEventType =
          position.rigType === "starter"
            ? "daily_active_starter"
            : position.rigType === "pro"
              ? "daily_active_pro"
              : "daily_active_industrial";
        const rewardKey = `${todayKey}:${position.rigType}:${position.index}`;

        if (awardedKeys.has(rewardKey)) {
          continue;
        }

        const result = await processEvent(params.userId, params.seasonId, dailyEventType, {
          txHash: `daily-active:${params.wallet.address}:${todayKey}:${position.rigType}:${position.index}`,
          positionIndex: position.index,
          activeDay: todayKey
        });

        if (result.created) {
          awardedKeys.add(rewardKey);
          pointsAwarded += result.points;
          eventsDetected += 1;
        }
      }

      nextSnapshot.awardedDailyActiveKeys[todayKey] = Array.from(awardedKeys);
    }
  }

  return {
    pointsAwarded,
    eventsDetected,
    nextSnapshot,
    ignoredDiagnostics
  };
}

// ── Reward pool monitor ───────────────────────────────────────────────────────

const MIND_MINT    = new PublicKey("DohWBfvXER6qs8zFGtdZRDpgbHmm97ZZwgCUTCdtHQNT");
const WXNT_MINT    = new PublicKey("So11111111111111111111111111111111111111112");
const POOL_PDA     = new PublicKey("91NeymGDdHYyLsMU9ULhha3cQ89qvXRPMX5o2L92BxLu");
const TOKEN_PROGRAM   = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM     = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bXp");

function findAta(mint: PublicKey, owner: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM
  );
  return ata;
}

const POOL_MIND_ATA = findAta(MIND_MINT, POOL_PDA);
const POOL_XNT_ATA  = findAta(WXNT_MINT, POOL_PDA);

// discriminator for deposit_reward_pool instruction
const DEPOSIT_DISC = createHash("sha256").update("global:deposit_reward_pool").digest().subarray(0, 8).toString("hex");

let lastSeenDepositSig: string | null = null;

async function checkRewardPoolDeposit(): Promise<void> {
  try {
    // Watch for new deposit_reward_pool instructions on the pool PDA
    const sigs = await swapConn.getSignaturesForAddress(POOL_PDA, { limit: 5 });
    if (!sigs.length) return;

    // Init cursor on first run — don't broadcast old deposits
    if (lastSeenDepositSig === null) {
      lastSeenDepositSig = sigs[0].signature;
      return;
    }

    // Collect only new signatures (newer than last seen)
    const newSigs: string[] = [];
    for (const s of sigs) {
      if (s.signature === lastSeenDepositSig) break;
      newSigs.push(s.signature);
    }
    if (!newSigs.length) return;

    lastSeenDepositSig = sigs[0].signature;

    // Check each new tx for deposit_reward_pool instruction discriminator
    for (const sig of newSigs) {
      const tx = await swapConn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
      if (!tx) continue;

      const isDeposit = (tx.transaction.message as { instructions?: Array<{ data?: string }> })
        .instructions?.some(ix => {
          if (!("data" in ix) || typeof ix.data !== "string") return false;
          try {
            const buf = Buffer.from(ix.data, "base64");
            return buf.length >= 8 && buf.subarray(0, 8).toString("hex") === DEPOSIT_DISC;
          } catch { return false; }
        });

      if (!isDeposit) continue;

      // Read current pool balances
      const [mindInfo, xntInfo] = await swapConn.getMultipleAccountsInfo([POOL_MIND_ATA, POOL_XNT_ATA]);
      const poolMind = mindInfo && mindInfo.data.length >= 72 ? mindInfo.data.readBigUInt64LE(64) : 0n;
      const poolXnt  = xntInfo  && xntInfo.data.length  >= 72 ? xntInfo.data.readBigUInt64LE(64)  : 0n;

      logger.info({ sig, poolMind: poolMind.toString(), poolXnt: poolXnt.toString() }, "[pool] admin deposit detected, broadcasting");

      const MIND_USD = 0.026;
      const XNT_USD  = 0.50;
      const poolUsdCents = Math.round(
        (Number(poolMind) / 1e9 * MIND_USD + Number(poolXnt) / 1e9 * XNT_USD) * 100
      );
      await broadcastPoolFunded({
        poolMind:     (Number(poolMind) / 1e9).toFixed(2),
        poolXnt:      (Number(poolXnt)  / 1e9).toFixed(2),
        poolUsdCents,
      });
      break; // one broadcast per scan cycle
    }
  } catch (err) {
    logger.warn({ err }, "[pool] reward pool check failed");
  }
}

// ── Swap Router scanner ───────────────────────────────────────────────────────

const SWAP_ROUTER_ID   = new PublicKey("2xXG9bbggrffG976okAbEHzw1BJgfA58d9zHTToke2Z6");
const SWAP_ROUTER_DISC = createHash("sha256").update("event:SwapRouterEvent").digest().subarray(0, 8).toString("hex");
const GIGA_SWAP_DISC   = createHash("sha256").update("event:GigaSwapEvent").digest().subarray(0, 8).toString("hex");
const swapConn = new Connection(env.x1RpcUrl ?? "https://rpc.mainnet.x1.xyz", "confirmed");

type SwapRouterEventData = {
  txHash: string;
  slot: number;
  blockTime: Date | null;
  amountIn: bigint;
  swapAmount: bigint;
  feeTotalLamports: bigint;
  swapCounter: bigint;
  usdCents: bigint;
};

type GigaSwapEventData = { payout: bigint; paidMind: boolean };

function parseGigaSwapEventFromLogs(logs: string[]): GigaSwapEventData | null {
  for (const log of logs) {
    if (!log.startsWith("Program data: ")) continue;
    const raw = Buffer.from(log.slice("Program data: ".length), "base64");
    if (raw.length < 8) continue;
    if (raw.subarray(0, 8).toString("hex") !== GIGA_SWAP_DISC) continue;
    // GigaSwapEvent layout after discriminator (8):
    // user: Pubkey (32), swap_counter: u64 (8), usd_cents: u64 (8),
    // multiplier: u64 (8), payout: u64 (8), paid_mind: bool (1)
    if (raw.length < 73) continue;
    const payout   = raw.readBigUInt64LE(8 + 32 + 8 + 8 + 8); // offset 64
    const paidMind = raw[72] !== 0;
    return { payout, paidMind };
  }
  return null;
}

function parseSwapRouterEventFromLogs(logs: string[]): Pick<SwapRouterEventData, "amountIn" | "swapAmount" | "feeTotalLamports" | "swapCounter" | "usdCents"> | null {
  for (const log of logs) {
    if (!log.startsWith("Program data: ")) continue;
    const raw = Buffer.from(log.slice("Program data: ".length), "base64");
    if (raw.length < 8) continue;
    if (raw.subarray(0, 8).toString("hex") !== SWAP_ROUTER_DISC) continue;
    // SwapRouterEvent layout after discriminator (8 bytes):
    // user: Pubkey (32), amount_in: u64 (8), swap_amount: u64 (8),
    // fee_total: u64 (8), swap_counter: u64 (8), usd_cents: u64 (8)
    if (raw.length < 8 + 32 + 40) continue;
    let o = 8 + 32; // skip discriminator + user pubkey
    return {
      amountIn: raw.readBigUInt64LE(o),
      swapAmount: raw.readBigUInt64LE((o += 8)),
      feeTotalLamports: raw.readBigUInt64LE((o += 8)),
      swapCounter: raw.readBigUInt64LE((o += 8)),
      usdCents: raw.readBigUInt64LE((o += 8)),
    };
  }
  return null;
}

const MIND_USD = 0.026;

async function getPoolXntUsd(): Promise<number> {
  try {
    const [mindInfo, xntInfo] = await swapConn.getMultipleAccountsInfo([POOL_MIND_ATA, POOL_XNT_ATA]);
    const poolMind = mindInfo && mindInfo.data.length >= 72 ? Number(mindInfo.data.readBigUInt64LE(64)) : 0;
    const poolXnt  = xntInfo  && xntInfo.data.length  >= 72 ? Number(xntInfo.data.readBigUInt64LE(64))  : 0;
    if (poolXnt > 0 && poolMind > 0) {
      return MIND_USD * (poolMind / poolXnt);
    }
  } catch { /* ignore */ }
  return 0.50;
}

async function scanSwapEventsForWallet(params: {
  userId: number;
  seasonId: number;
  wallet: Wallet;
  seasonStartsAt: Date;
  seasonEndsAt: Date;
  sinceSlot?: number;
}): Promise<{ pointsAwarded: number; eventsDetected: number }> {
  let pointsAwarded = 0;
  let eventsDetected = 0;

  try {
    const walletPk = new PublicKey(params.wallet.address);
    const sigs = await swapConn.getSignaturesForAddress(walletPk, {
      limit: 30,
      minContextSlot: params.sinceSlot,
    });

    const filtered = sigs.filter(s => !s.err && (params.sinceSlot == null || s.slot > params.sinceSlot));
    if (filtered.length === 0) return { pointsAwarded: 0, eventsDetected: 0 };

    const txs = await swapConn.getParsedTransactions(
      filtered.map(s => s.signature),
      { maxSupportedTransactionVersion: 0, commitment: "confirmed" }
    );

    let xntUsd: number | null = null;

    for (let i = 0; i < filtered.length; i++) {
      const sig = filtered[i];
      const tx = txs[i];
      if (!tx?.meta?.logMessages) continue;

      // Only process txs that touched swap_router
      const involvedPrograms = tx.transaction.message.instructions.map((ix: { programId?: { toBase58?: () => string } }) =>
        typeof ix.programId?.toBase58 === "function" ? ix.programId.toBase58() : ""
      );
      if (!involvedPrograms.includes(SWAP_ROUTER_ID.toBase58()) &&
          !tx.meta.logMessages.some(l => l.includes(SWAP_ROUTER_ID.toBase58()))) {
        continue;
      }

      const parsed = parseSwapRouterEventFromLogs(tx.meta.logMessages);
      if (!parsed) continue;

      const blockTime = sig.blockTime ? new Date(sig.blockTime * 1000) : null;
      if (!blockTime || !isWithinSeasonWindow(blockTime, params.seasonStartsAt, params.seasonEndsAt)) continue;

      const txKey = `swap:${sig.signature}`;
      const result = await processEvent(params.userId, params.seasonId, "swap_mind_xnt", {
        txHash: txKey,
        originalTxHash: sig.signature,
        blockTime: blockTime.toISOString(),
        slot: sig.slot,
        amountIn: parsed.amountIn.toString(),
        swapAmount: parsed.swapAmount.toString(),
        usdCents: parsed.usdCents.toString(),
        swapCounter: parsed.swapCounter.toString(),
      });

      if (result.created) {
        pointsAwarded += result.points;
        eventsDetected += 1;
      }

      // Check if this tx also contains a GigaSwap win event
      const giga = parseGigaSwapEventFromLogs(tx.meta.logMessages);
      if (giga && giga.payout > 0n) {
        if (xntUsd === null) xntUsd = await getPoolXntUsd();
        const tokenUsd  = giga.paidMind ? MIND_USD : xntUsd;
        const payoutUsdCents = Math.round((Number(giga.payout) / 1e9) * tokenUsd * 100);

        const gigaKey = `giga:${sig.signature}`;
        await processEvent(params.userId, params.seasonId, "giga_swap_win", {
          txHash: gigaKey,
          originalTxHash: sig.signature,
          blockTime: blockTime.toISOString(),
          slot: sig.slot,
          payout: giga.payout.toString(),
          paidMind: giga.paidMind,
          payoutUsdCents,
        });
      }
    }
  } catch (err) {
    logger.warn({ wallet: params.wallet.address, err }, "Swap router scan failed for wallet");
  }

  return { pointsAwarded, eventsDetected };
}

async function scanRegisteredWallet(params: {
  seasonId: number;
  seasonStartsAt: Date;
  seasonEndsAt: Date;
  userId: number;
  wallet: Wallet;
}): Promise<{ pointsAwarded: number; eventsDetected: number; scan: ScannerWalletResult }> {
  const cursor = await getWalletScannerCursor(params.wallet.id);
  const cursorSnapshot = normalizeCursorSnapshotForSeason(parseCursorSnapshot(cursor?.snapshot), params.seasonId);
  const sinceSlot = cursor?.lastSlot != null ? Number(cursor.lastSlot) : undefined;
  const scan = await adapter.inspectWallet(params.wallet.address, sinceSlot);

  if (!scan.parserConfirmed) {
    await upsertWalletScannerCursor({
      walletId: params.wallet.id,
      lastSlot: sinceSlot,
      snapshot: cursorSnapshot,
      scannedAt: new Date()
    });

    return {
      pointsAwarded: 0,
      eventsDetected: 0,
      scan
    };
  }

  const currentSlot = scan.currentSlot ?? (await adapter.getCurrentSlot());
  const applied = await applyWalletEvents({
    seasonId: params.seasonId,
    userId: params.userId,
    wallet: params.wallet,
    scan,
    cursorSnapshot,
    seasonStartsAt: params.seasonStartsAt,
    seasonEndsAt: params.seasonEndsAt
  });

  if (applied.ignoredDiagnostics.length > 0) {
    logger.info(
      {
        wallet: params.wallet.address,
        ignoredEvents: applied.ignoredDiagnostics.map((entry) => ({
          txHash: entry.txHash,
          slot: entry.slot,
          blockTime: entry.blockTime?.toISOString() ?? null,
          reason: entry.reason
        }))
      },
      "Scanner ignored events outside season window or without blockTime"
    );
  }

  await upsertWalletScannerCursor({
    walletId: params.wallet.id,
    lastSlot: currentSlot,
    snapshot: applied.nextSnapshot,
    scannedAt: new Date()
  });

  const swapResult = await scanSwapEventsForWallet({
    userId: params.userId,
    seasonId: params.seasonId,
    wallet: params.wallet,
    seasonStartsAt: params.seasonStartsAt,
    seasonEndsAt: params.seasonEndsAt,
    sinceSlot: sinceSlot,
  });

  return {
    pointsAwarded: applied.pointsAwarded + swapResult.pointsAwarded,
    eventsDetected: applied.eventsDetected + swapResult.eventsDetected,
    scan: {
      ...scan,
      diagnostics: [...scan.diagnostics, ...applied.ignoredDiagnostics]
    }
  };
}

async function runSeasonScan(): Promise<ScannerRunSummary> {
  const startedAt = new Date();
  const { season, registrations } = await getActiveSeasonRegistrationsWithWallets();

  if (!season) {
    return {
      startedAt,
      finishedAt: new Date(),
      seasonId: null,
      walletsScanned: 0,
      eventsDetected: 0,
      pointsAwarded: 0,
      clickerTopUpsDetected: 0,
      clickerClaimsSettled: 0,
      errors: 0,
      message: "No active season found"
    };
  }

  let walletsScanned = 0;
  let eventsDetected = 0;
  let pointsAwarded = 0;
  let errors = 0;

  for (const registration of registrations) {
    try {
      const result = await scanRegisteredWallet({
        seasonId: season.id,
        seasonStartsAt: season.startsAt,
        seasonEndsAt: season.endsAt,
        userId: registration.userId,
        wallet: registration.wallet
      });

      walletsScanned += 1;
      eventsDetected += result.eventsDetected;
      pointsAwarded += result.pointsAwarded;
    } catch (error) {
      errors += 1;
      rememberError({
        at: new Date(),
        wallet: registration.wallet.address,
        message: error instanceof Error ? error.message : "Unknown scanner error"
      });
      logger.error({ error, wallet: registration.wallet.address, seasonId: season.id }, "Scanner wallet run failed");
    }
  }

  return {
    startedAt,
    finishedAt: new Date(),
    seasonId: season.id,
    walletsScanned,
    eventsDetected,
    pointsAwarded,
    clickerTopUpsDetected: 0,
    clickerClaimsSettled: 0,
    errors,
    message: "Scanner run completed"
  };
}

export async function runScannerOnce(): Promise<ScannerRunSummary> {
  if (cycleInFlight) {
    return (
      lastSummary ?? {
        startedAt: new Date(),
        finishedAt: new Date(),
        seasonId: null,
        walletsScanned: 0,
        eventsDetected: 0,
        pointsAwarded: 0,
        clickerTopUpsDetected: 0,
        clickerClaimsSettled: 0,
        errors: 0,
        message: "Scanner run already in progress"
      }
    );
  }

  cycleInFlight = true;

  try {
    const summary = await runSeasonScan();
    lastScanAt = summary.finishedAt;
    lastSummary = summary;

    logger.info(
      {
        seasonId: summary.seasonId,
        walletsScanned: summary.walletsScanned,
        eventsDetected: summary.eventsDetected,
        pointsAwarded: summary.pointsAwarded,
        clickerTopUpsDetected: summary.clickerTopUpsDetected,
        clickerClaimsSettled: summary.clickerClaimsSettled,
        errors: summary.errors
      },
      "X1Factory scanner run finished"
    );

    return summary;
  } catch (error) {
    const summary: ScannerRunSummary = {
      startedAt: new Date(),
      finishedAt: new Date(),
      seasonId: null,
      walletsScanned: 0,
      eventsDetected: 0,
      pointsAwarded: 0,
      clickerTopUpsDetected: 0,
      clickerClaimsSettled: 0,
      errors: 1,
      message: error instanceof Error ? error.message : "Scanner run failed"
    };

    lastSummary = summary;
    lastScanAt = summary.finishedAt;
    rememberError({
      at: summary.finishedAt,
      message: summary.message
    });
    throw error;
  } finally {
    cycleInFlight = false;
  }
}

export function startScanner(intervalSeconds: number): () => void {
  if (timer) {
    return () => undefined;
  }

  const intervalMs = intervalSeconds * 1000;
  void runScannerOnce().catch((error) => {
    logger.error({ error }, "Initial scanner run failed");
  });

  timer = setInterval(() => {
    void runScannerOnce().catch((error) => {
      logger.error({ error }, "Scheduled scanner run failed");
    });
    void checkSeasonEndNotifications().catch((error) => {
      logger.warn({ error }, "Season end notification check failed");
    });
    void checkRewardPoolDeposit().catch((error) => {
      logger.warn({ error }, "Reward pool deposit check failed");
    });
  }, intervalMs);

  logger.info({ intervalSeconds, rpcHost: adapter.getRpcHost() }, "X1Factory scanner started");

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
      logger.info("X1Factory scanner stopped");
    }
  };
}

export async function scanWalletManually(wallet: string): Promise<ManualWalletScanOutcome> {
  const activeSeason = await getActiveSeason();
  const existingWallet = activeSeason
    ? (
        await getActiveSeasonRegistrationsWithWallets()
      ).registrations.find((registration) => registration.wallet.address === wallet)
    : undefined;

  const scan = await adapter.inspectWallet(wallet);

  if (!activeSeason || !existingWallet || !scan.parserConfirmed) {
    return {
      wallet,
      parserConfirmed: scan.parserConfirmed,
      parserMessage: !scan.parserConfirmed
        ? scan.parserMessage
        : !activeSeason
          ? "No active season found"
          : "Wallet is not registered in the active season",
      state: scan.state,
      eventsDetected: scan.events.length,
      pointsAwarded: 0,
      diagnostics: scan.diagnostics,
      applied: false
    };
  }

  const result = await scanRegisteredWallet({
    seasonId: activeSeason.id,
    seasonStartsAt: activeSeason.startsAt,
    seasonEndsAt: activeSeason.endsAt,
    userId: existingWallet.userId,
    wallet: existingWallet.wallet
  });

  return {
    wallet,
    parserConfirmed: result.scan.parserConfirmed,
    parserMessage: result.scan.parserMessage,
    state: result.scan.state,
    eventsDetected: result.eventsDetected,
    pointsAwarded: result.pointsAwarded,
    diagnostics: result.scan.diagnostics,
    applied: true
  };
}

export function getScannerStatus() {
  return {
    enabled: env.x1ScannerEnabled,
    parserConfirmed: adapter.getParserStatus().confirmed,
    parserMessage: adapter.getParserStatus().message,
    rpcHost: adapter.getRpcHost(),
    programId: adapter.getProgramId(),
    idlPath: adapter.getIdlPath(),
    lastScanAt,
    lastSummary,
    recentErrors: [...recentErrors]
  };
}
