import { createHash } from "node:crypto";

import type { IX1FactoryAdapter, X1FactoryRecentEvent, X1FactoryState } from "./types.js";

const SLOT_WINDOW_MS = 2 * 60 * 1000;
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

function hashSeed(wallet: string): number {
  const hex = createHash("sha256").update(wallet).digest("hex").slice(0, 8);
  return parseInt(hex, 16);
}

function getCurrentSlot(): number {
  return Math.floor(Date.now() / SLOT_WINDOW_MS);
}

function getDayKeyAtSlot(slot: number): string {
  const date = new Date(slot * SLOT_WINDOW_MS);
  return date.toISOString().slice(0, 10);
}

function computeState(wallet: string, slot: number): X1FactoryState {
  const seed = hashSeed(wallet);
  const starterRigs = Math.floor((slot + (seed % 5)) / 12);
  const proRigs = Math.floor((slot + (seed % 7)) / 24);
  const industrialRigs = Math.floor((slot + (seed % 11)) / 48);
  const renewalsCount = Math.floor((slot + (seed % 13)) / 18);
  const totalMindClaimed = Math.floor((slot + (seed % 17)) / 6) * 10;
  const hasStake = slot >= 3 + (seed % 8);
  const totalMindBurned = Math.floor((slot + (seed % 19)) / 10) * 100;
  const totalRigs = starterRigs + proRigs + industrialRigs;
  const dayBucket = Math.floor((slot * SLOT_WINDOW_MS) / DAY_WINDOW_MS);
  const activeRigToday = totalRigs > 0 && ((dayBucket + seed) % 2 === 0);
  const activeRigDayKey = activeRigToday ? getDayKeyAtSlot(slot) : null;

  return {
    slot,
    starterRigs,
    proRigs,
    industrialRigs,
    renewalsCount,
    totalMindClaimed,
    hasStake,
    totalMindBurned,
    activeRigToday,
    activeRigDayKey
  };
}

export class MockX1FactoryAdapter implements IX1FactoryAdapter {
  async getUserFactoryState(wallet: string): Promise<X1FactoryState> {
    return computeState(wallet, getCurrentSlot());
  }

  async getRecentUserEvents(wallet: string, sinceSlot?: number): Promise<X1FactoryRecentEvent[]> {
    const currentSlot = getCurrentSlot();
    const startSlot = typeof sinceSlot === "number" ? sinceSlot + 1 : Math.max(currentSlot - 3, 0);
    const events: X1FactoryRecentEvent[] = [];

    for (let slot = startSlot; slot <= currentSlot; slot += 1) {
      const previous = computeState(wallet, Math.max(slot - 1, 0));
      const current = computeState(wallet, slot);

      if (current.starterRigs > previous.starterRigs) {
        for (let i = 0; i < current.starterRigs - previous.starterRigs; i += 1) {
          events.push({
            slot,
            txHash: `mock:${wallet}:starter_rig_purchase:${slot}:${i}`,
            category: "starter_rig_purchase",
            reason: "Detected starter rig purchase"
          });
        }
      }

      if (current.proRigs > previous.proRigs) {
        for (let i = 0; i < current.proRigs - previous.proRigs; i += 1) {
          events.push({
            slot,
            txHash: `mock:${wallet}:pro_rig_purchase:${slot}:${i}`,
            category: "pro_rig_purchase",
            reason: "Detected pro rig purchase"
          });
        }
      }

      if (current.industrialRigs > previous.industrialRigs) {
        for (let i = 0; i < current.industrialRigs - previous.industrialRigs; i += 1) {
          events.push({
            slot,
            txHash: `mock:${wallet}:industrial_rig_purchase:${slot}:${i}`,
            category: "industrial_rig_purchase",
            reason: "Detected industrial rig purchase"
          });
        }
      }

      if (current.renewalsCount > previous.renewalsCount) {
        for (let i = 0; i < current.renewalsCount - previous.renewalsCount; i += 1) {
          events.push({
            slot,
            txHash: `mock:${wallet}:rig_renewal:${slot}:${i}`,
            category: "rig_renewal",
            reason: "Detected rig renewal"
          });
        }
      }

      if (current.totalMindClaimed > previous.totalMindClaimed) {
        for (let i = 0; i < (current.totalMindClaimed - previous.totalMindClaimed) / 10; i += 1) {
          events.push({
            slot,
            txHash: `mock:${wallet}:mind_claim:${slot}:${i}`,
            category: "mind_claim",
            reason: "Detected MIND claim"
          });
        }
      }

      if (!previous.hasStake && current.hasStake) {
        events.push({
          slot,
          txHash: `mock:${wallet}:first_stake:${slot}`,
          category: "first_stake",
          reason: "Detected first MIND stake"
        });
      }

      if (current.totalMindBurned > previous.totalMindBurned) {
        events.push({
          slot,
          txHash: `mock:${wallet}:mind_burn_per_100:${slot}`,
          category: "mind_burn_per_100",
          multiplier: (current.totalMindBurned - previous.totalMindBurned) / 100,
          reason: `Detected MIND burn upgrade: ${current.totalMindBurned - previous.totalMindBurned} burned`
        });
      }

      if (
        current.activeRigToday &&
        current.activeRigDayKey &&
        current.activeRigDayKey !== previous.activeRigDayKey
      ) {
        events.push({
          slot,
          txHash: `mock:${wallet}:daily_active_rig:${current.activeRigDayKey}`,
          category: "daily_active_rig",
          reason: "Detected daily active rig status"
        });
      }
    }

    return events;
  }
}
