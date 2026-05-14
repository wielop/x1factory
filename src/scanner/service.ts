import { POINTS_CONFIG } from "../config/points.js";
import { logger } from "../config/logger.js";
import { getWalletScannerCursor, upsertWalletScannerCursor } from "../db/scannerRepository.js";
import { getActiveSeasonRegistrationsWithWallets } from "../db/seasonRepository.js";
import { addSeasonPoints } from "../services/pointsService.js";

import { createX1FactoryAdapter } from "./adapter.js";
import { deriveEventsFromSnapshotDiff } from "./diff.js";
import type { X1FactoryState } from "./types.js";

type ScannerDependencies = {
  adapterMode: string;
};

function parseSnapshot(snapshot: unknown): X1FactoryState | null {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const state = snapshot as Record<string, unknown>;

  if (typeof state.slot !== "number") {
    return null;
  }

  return {
    slot: state.slot,
    starterRigs: Number(state.starterRigs ?? 0),
    proRigs: Number(state.proRigs ?? 0),
    industrialRigs: Number(state.industrialRigs ?? 0),
    renewalsCount: Number(state.renewalsCount ?? 0),
    totalMindClaimed: Number(state.totalMindClaimed ?? 0),
    hasStake: Boolean(state.hasStake),
    totalMindBurned: Number(state.totalMindBurned ?? 0),
    activeRigToday: Boolean(state.activeRigToday),
    activeRigDayKey: typeof state.activeRigDayKey === "string" ? state.activeRigDayKey : null
  };
}

export async function runScannerCycle(deps: ScannerDependencies): Promise<void> {
  const adapter = createX1FactoryAdapter(deps.adapterMode);
  const { season, registrations } = await getActiveSeasonRegistrationsWithWallets();

  if (!season) {
    logger.debug("Scanner skipped: no active season");
    return;
  }

  for (const registration of registrations) {
    try {
      const cursor = await getWalletScannerCursor(registration.walletId);
      const previousState = parseSnapshot(cursor?.snapshot);
      const sinceSlot = cursor?.lastSlot ? Number(cursor.lastSlot) : undefined;
      const currentState = await adapter.getUserFactoryState(registration.wallet.address);

      if (!currentState) {
        continue;
      }

      const recentEvents = await adapter.getRecentUserEvents(registration.wallet.address, sinceSlot);
      const derivedEvents =
        recentEvents.length > 0
          ? recentEvents
          : deriveEventsFromSnapshotDiff(registration.wallet.address, previousState, currentState);

      for (const event of derivedEvents) {
        const basePoints = POINTS_CONFIG[event.category];
        const amount = basePoints * (event.multiplier ?? 1);

        if (amount <= 0) {
          continue;
        }

        const result = await addSeasonPoints(
          registration.userId,
          season.id,
          amount,
          event.category,
          event.reason,
          event.txHash
        );

        if (result.created) {
          logger.info(
            {
              seasonId: season.id,
              userId: registration.userId,
              walletId: registration.walletId,
              category: event.category,
              amount,
              txHash: event.txHash
            },
            "Scanner awarded season points"
          );
        }
      }

      await upsertWalletScannerCursor({
        walletId: registration.walletId,
        lastSlot: currentState.slot,
        snapshot: currentState,
        scannedAt: new Date()
      });
    } catch (error) {
      logger.error(
        {
          error,
          seasonId: season.id,
          userId: registration.userId,
          walletId: registration.walletId
        },
        "Scanner failed for wallet"
      );
    }
  }
}
