import type { PointCategory } from "../config/points.js";

export type RigTier = "starter" | "pro" | "industrial";

export type X1FactoryState = {
  slot: number;
  starterRigs: number;
  proRigs: number;
  industrialRigs: number;
  renewalsCount: number;
  totalMindClaimed: number;
  hasStake: boolean;
  totalMindBurned: number;
  activeRigToday: boolean;
  activeRigDayKey: string | null;
};

export type X1FactoryRecentEvent = {
  slot: number;
  txHash: string;
  category: PointCategory;
  reason: string;
  multiplier?: number;
  metadata?: Record<string, unknown>;
};

export interface IX1FactoryAdapter {
  getUserFactoryState(wallet: string): Promise<X1FactoryState | null>;
  getRecentUserEvents(wallet: string, sinceSlot?: number): Promise<X1FactoryRecentEvent[]>;
}

export type ScannerRegistration = {
  userId: number;
  walletId: number;
  walletAddress: string;
};

export type ScannerDerivedEvent = {
  txHash: string;
  category: PointCategory;
  reason: string;
  multiplier?: number;
};
