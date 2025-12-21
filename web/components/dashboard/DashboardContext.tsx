"use client";

import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { fetchConfig } from "@/lib/solana";
import {
  decodeStakingPositionAccount,
  decodeUserPositionAccount,
  decodeUserProfileAccount,
} from "@/lib/decoders";

export type UserPosition = { pubkey: string; data: ReturnType<typeof decodeUserPositionAccount> };
export type StakingPosition = { pubkey: string; data: ReturnType<typeof decodeStakingPositionAccount> };

export type MiningPlanOption = { d: 7 | 14 | 30; mult: string; price: string; xp: string };

export type XpStats = {
  tier: number;
  tierName: string;
  boostBps: number;
  progress: number;
  remaining: bigint;
  nextTierName: string | null;
};

export type BusyAction =
  | "buy"
  | "heartbeat"
  | "claim"
  | "claim-all"
  | "close"
  | "stake"
  | `claim-stake-${string}`
  | `withdraw-stake-${string}`;

export type DashboardContextValue = {
  publicKey: PublicKey | null;
  config: Awaited<ReturnType<typeof fetchConfig>> | null;
  nowTs: number | null;
  currentEpoch: number | null;
  nextEpochCountdown: { label: string; seconds: number } | null;
  positions: UserPosition[];
  activePositions: UserPosition[];
  anyActive: boolean;
  stakingPositions: StakingPosition[];
  durationDays: 7 | 14 | 30;
  setDurationDays: (v: 7 | 14 | 30) => void;
  planOptions: MiningPlanOption[];
  emissionNotStarted: boolean;
  heartbeatDone: boolean;
  claimed: boolean;
  onDeposit: () => Promise<void>;
  onHeartbeat: () => Promise<void>;
  onClaim: () => Promise<void>;
  onClaimAll: () => Promise<void>;
  onClosePosition: (pubkey: string) => Promise<void>;
  onStake: () => Promise<void>;
  onClaimStake: (stake: StakingPosition) => Promise<void>;
  onWithdrawStake: (stake: StakingPosition) => Promise<void>;
  busy: BusyAction | null;
  loading: boolean;
  error: string | null;
  lastSig: string | null;
  refresh: () => Promise<void>;
  xntBalanceUi: string | null;
  mindBalanceUi: string | null;
  mindBalanceBase: bigint;
  stakingVaultXntBalanceUi: string | null;
  stakingVaultXntBalanceBase: bigint | null;
  stakingVaultMindBalanceUi: string | null;
  stakeAmountUi: string;
  setStakeAmountUi: (v: string) => void;
  stakeDurationDays: 7 | 14 | 30 | 60;
  setStakeDurationDays: (v: 7 | 14 | 30 | 60) => void;
  stakeEstimate: { base: bigint; boosted: bigint } | null;
  handleStakeMax: () => void;
  estimatedRewardBase: bigint | null;
  userProfile: ReturnType<typeof decodeUserProfileAccount> | null;
  xpStats: XpStats | null;
  rewardPoolSeries: { points: string; min: bigint; max: bigint } | null;
  unclaimedEpochs: Array<{ epochIndex: bigint; pubkey: string }>;
};

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useDashboard must be used within DashboardContext");
  return ctx;
}

export function DashboardProvider({
  value,
  children,
}: {
  value: DashboardContextValue;
  children: ReactNode;
}) {
  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}
