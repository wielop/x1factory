import type { Wallet } from "@prisma/client";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createDetectedEvent, findDetectedEvent } from "../db/eventRepository.js";
import { getWalletScannerCursor, upsertWalletScannerCursor } from "../db/scannerRepository.js";
import { getActiveSeason, getActiveSeasonRegistrationsWithWallets } from "../db/seasonRepository.js";
import { processDailyClaim, processEvent, processStakeSnapshot } from "../services/pointsService.js";
import { scanAndSettlePendingClickerClaims } from "../services/clickerSettlementService.js";

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

  return {
    pointsAwarded: applied.pointsAwarded,
    eventsDetected: applied.eventsDetected,
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

  const clickerSettlement = await scanAndSettlePendingClickerClaims().catch((error) => {
    errors += 1;
    logger.error({ error, seasonId: season.id }, "Clicker settlement scan failed");
    return {
      walletsScanned: 0,
      topUpsDetected: 0,
      claimsSettled: 0,
      errors: 1,
      message: error instanceof Error ? error.message : "Clicker settlement scan failed"
    };
  });

  return {
    startedAt,
    finishedAt: new Date(),
    seasonId: season.id,
    walletsScanned,
    eventsDetected,
    pointsAwarded,
    clickerTopUpsDetected: clickerSettlement.topUpsDetected,
    clickerClaimsSettled: clickerSettlement.claimsSettled,
    errors,
    message: clickerSettlement.claimsSettled > 0
      ? `Scanner run completed; clicker claims settled: ${clickerSettlement.claimsSettled}`
      : "Scanner run completed"
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
