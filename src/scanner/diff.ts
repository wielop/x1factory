import type { ScannerDerivedEvent, X1FactoryState } from "./types.js";

export function deriveEventsFromSnapshotDiff(
  walletAddress: string,
  previous: X1FactoryState | null,
  current: X1FactoryState
): ScannerDerivedEvent[] {
  if (!previous) {
    return [];
  }

  const events: ScannerDerivedEvent[] = [];

  if (current.starterRigs > previous.starterRigs) {
    for (let i = 0; i < current.starterRigs - previous.starterRigs; i += 1) {
      events.push({
        txHash: `snapshot:${walletAddress}:starter_rig_purchase:${current.slot}:${i}`,
        category: "starter_rig_purchase",
        reason: "Detected starter rig purchase from state diff"
      });
    }
  }

  if (current.proRigs > previous.proRigs) {
    for (let i = 0; i < current.proRigs - previous.proRigs; i += 1) {
      events.push({
        txHash: `snapshot:${walletAddress}:pro_rig_purchase:${current.slot}:${i}`,
        category: "pro_rig_purchase",
        reason: "Detected pro rig purchase from state diff"
      });
    }
  }

  if (current.industrialRigs > previous.industrialRigs) {
    for (let i = 0; i < current.industrialRigs - previous.industrialRigs; i += 1) {
      events.push({
        txHash: `snapshot:${walletAddress}:industrial_rig_purchase:${current.slot}:${i}`,
        category: "industrial_rig_purchase",
        reason: "Detected industrial rig purchase from state diff"
      });
    }
  }

  if (current.renewalsCount > previous.renewalsCount) {
    for (let i = 0; i < current.renewalsCount - previous.renewalsCount; i += 1) {
      events.push({
        txHash: `snapshot:${walletAddress}:rig_renewal:${current.slot}:${i}`,
        category: "rig_renewal",
        reason: "Detected rig renewal from state diff"
      });
    }
  }

  if (current.totalMindClaimed > previous.totalMindClaimed) {
    for (let i = 0; i < (current.totalMindClaimed - previous.totalMindClaimed) / 10; i += 1) {
      events.push({
        txHash: `snapshot:${walletAddress}:mind_claim:${current.slot}:${i}`,
        category: "mind_claim",
        reason: "Detected MIND claim from state diff"
      });
    }
  }

  if (!previous.hasStake && current.hasStake) {
    events.push({
      txHash: `snapshot:${walletAddress}:first_stake:${current.slot}`,
      category: "first_stake",
      reason: "Detected first MIND stake from state diff"
    });
  }

  if (current.totalMindBurned > previous.totalMindBurned) {
    events.push({
      txHash: `snapshot:${walletAddress}:mind_burn_per_100:${current.slot}`,
      category: "mind_burn_per_100",
      multiplier: (current.totalMindBurned - previous.totalMindBurned) / 100,
      reason: `Detected MIND burn upgrade from state diff: ${current.totalMindBurned - previous.totalMindBurned} burned`
    });
  }

  if (
    current.activeRigToday &&
    current.activeRigDayKey &&
    current.activeRigDayKey !== previous.activeRigDayKey
  ) {
    events.push({
      txHash: `snapshot:${walletAddress}:daily_active_rig:${current.activeRigDayKey}`,
      category: "daily_active_rig",
      reason: "Detected daily active rig status from state diff"
    });
  }

  return events;
}
