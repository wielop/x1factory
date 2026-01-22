"use client";

import "@/lib/polyfillBufferClient";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction, type AccountMeta } from "@solana/web3.js";
import {
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TopBar } from "@/components/shared/TopBar";
import { AccountProgressionPanel } from "@/components/dashboard/AccountProgressionPanel";
import { useToast } from "@/components/shared/ToastProvider";
import { getProgram } from "@/lib/anchor";
import type { DecodedConfig, DecodedRigBuffConfig } from "@/lib/solana";
import {
  deriveConfigPda,
  deriveLevelConfigPda,
  deriveRigBuffConfigPda,
  derivePositionPda,
  deriveUserProfilePda,
  deriveUserStakePda,
  deriveVaultPda,
  fetchClockUnixTs,
  fetchConfig,
  fetchLevelConfig,
  fetchRigBuffConfig,
  getProgramId,
} from "@/lib/solana";
import type { DecodedUserStake } from "@/lib/decoders";
import {
  decodeMinerPositionAccount,
  decodeUserMiningProfileAccount,
  decodeUserStakeAccount,
  MINER_POSITION_LEN_V1,
  MINER_POSITION_LEN_V2,
  MINER_POSITION_LEN_V3,
  USER_PROFILE_LEN_V1,
  USER_PROFILE_LEN_V2,
  USER_PROFILE_LEN_V3,
  USER_PROFILE_LEN_V4,
  USER_STAKE_LEN,
  tryDecodeUserStakeAccount,
} from "@/lib/decoders";
import { formatDurationSeconds, formatTokenAmount, parseUiAmountToBase, shortPk } from "@/lib/format";
import { formatError } from "@/lib/formatError";
import { sendTelemetry } from "@/lib/telemetryClient";
import { LEVELING_ENABLED, LEVELING_DISABLED_MESSAGE } from "@/lib/leveling";
import { computeEstWeeklyXnt, getWeeklyPoolXnt, LEVELS, type Level } from "@/lib/yieldMath";
import { useYieldSummary } from "@/lib/useYieldSummary";
import {
  RIPPER_POOL_ADDRESS,
  calcPoolTokensForDeposit,
  createRipperDepositSolInstruction,
  fetchRipperStakePool,
  findRipperWithdrawAuthority,
  type RipperStakePool,
} from "@/lib/ripperPool";

const ACC_SCALE = 1_000_000_000_000_000_000n;
const AUTO_CLAIM_INTERVAL_MS = 15_000;
const NETWORK_BREAKDOWN_REFRESH_MS = 15_000;
const BPS_DENOMINATOR = 10_000n;
const RIG_BUFF_CAP_BPS = 1500n;
const RIPPER_FEE_BPS = 20n;
const BADGE_BONUS_CAP_BPS = 2_000n;
const LEVEL_CAP = 6;
const LEVEL_THRESHOLDS = [0n, 500n, 2_000n, 5_000n, 10_000n, 16_000n] as const;
const LEVEL_BONUS_BPS = [0, 160, 340, 550, 780, 1000] as const;
const LEVEL_UP_COSTS = [100, 200, 450, 1_000, 2_000] as const;
const DAY_SECONDS = 86_400n;
const STAKING_SECONDS_PER_YEAR = 31_536_000;
const XNT_DECIMALS = 9;
const NATIVE_VAULT_SPACE = 9;
const HP_SCALE = 100n;
const GRACE_DAYS = 2;
const RENEW_REMINDER_DAYS = 3;
type RigType = "starter" | "pro" | "industrial";
type LeaderboardRow = {
  owner: string;
  hp: bigint;
  buffedHp: bigint;
  stakedMind: bigint;
  activeRigs: number;
  level: number;
};

interface RigPlan {
  type: RigType;
  label: string;
  durationDays: number;
  baseHp: number;
  costXnt: number;
  maxBuffPercent: number;
}

const RIG_PLANS: RigPlan[] = [
  {
    type: "starter",
    label: "Starter Rig",
    durationDays: 7,
    baseHp: 1,
    costXnt: 1,
    maxBuffPercent: 0.01,
  },
  {
    type: "pro",
    label: "Pro Rig",
    durationDays: 14,
    baseHp: 8,
    costXnt: 9,
    maxBuffPercent: 0.035,
  },
  {
    type: "industrial",
    label: "Industrial Rig",
    durationDays: 28,
    baseHp: 16,
    costXnt: 24,
    maxBuffPercent: 0.05,
  },
];

const ACTIVE_STAKERS_SUMMARY = {
  unique: 13,
  totalStaked: "981.5273",
  updated: 1767202006,
};

const ACTIVE_STAKERS: Array<{
  owner: string;
  staked: string;
  share: string;
  reward: string;
}> = [
  {
    owner: "FPLV6bRcBj4i8sipkim2N7eZMsGJC2xfCsAgeoDsQhoD",
    staked: "228.2656",
    share: "23.25%",
    reward: "5.0299",
  },
  {
    owner: "2UQZkgiXwgRxvP4iYnGSnB97LnE9vwToQNCmZ5LtDLLx",
    staked: "165.9883",
    share: "16.91%",
    reward: "3.6576",
  },
  {
    owner: "AgxPPPEy4DAaUdCRuSpmXRirC9KXCA19vZA5gEmcVKaw",
    staked: "163.0982",
    share: "16.61%",
    reward: "3.5939",
  },
  {
    owner: "G1uYQXN4xTAxDqXgZoe4MonGv7icCz7BJStYFzNKzU72",
    staked: "141.1287",
    share: "14.37%",
    reward: "3.1098",
  },
  {
    owner: "HhqNYhvwU9X4ne3qHJKq8PPEYUEsk2g1LttyazEhL1Ld",
    staked: "119.4153",
    share: "12.16%",
    reward: "2.6313",
  },
  {
    owner: "BFrWAAd5yG1Lb4qaSKMZUm6wDzCoWCz69S5gkVtuyA1i",
    staked: "66.1287",
    share: "6.73%",
    reward: "1.4571",
  },
  {
    owner: "AYmTUbXhUA9gW6Q4QeqTPwKhniVPextiFR4YYCYi7SCK",
    staked: "44.6869",
    share: "4.55%",
    reward: "0.9847",
  },
  {
    owner: "BQ3ekHBPKEzxDpYXavSuctQLu6WqxgdEHvkXZqLTCi8m",
    staked: "29.5055",
    share: "3.00%",
    reward: "0.6501",
  },
  {
    owner: "97RSSwCMPrw2PCuRZk86oi33EFZYojtGxaUmpXnBgWAA",
    staked: "7.1283",
    share: "0.72%",
    reward: "0.1570",
  },
  {
    owner: "3365iM53o3btUUpZFh96Bgrehm8SE9smUfmZvgVb7RmY",
    staked: "7.0726",
    share: "0.72%",
    reward: "0.1558",
  },
  {
    owner: "BAavP6nxHDkVDowYXoyDaNDbc9CAgncfDPELAyjzoyTq",
    staked: "4.0467",
    share: "0.41%",
    reward: "0.0891",
  },
  {
    owner: "1f2kbCpezrEFUMgjjyruGQW6JeQnXXj8fJfYzdFmYgB",
    staked: "2.6706",
    share: "0.27%",
    reward: "0.0588",
  },
  {
    owner: "4Y2Pd7Uv8wRVFfMsNZbJ3Zb6YNYdG2iknb7QfQTS4Cxe",
    staked: "2.3914",
    share: "0.24%",
    reward: "0.0526",
  },
];

type ActiveStaker = {
  owner: string;
  staked: string;
  share: string;
  reward: string;
};

const RIG_PLAN_BY_TYPE: Record<RigType, RigPlan> = {
  starter: RIG_PLANS[0],
  pro: RIG_PLANS[1],
  industrial: RIG_PLANS[2],
};

const LEADER_MEDALS = ["🥇", "🥈", "🥉"];

const RIG_BEST_FOR: Record<RigType, string> = {
  starter: "Quick rotations, testing, small setups.",
  pro: "Balanced returns, mid-term strategy.",
  industrial: "Long-term compounding and stability.",
};

const RIG_STYLE_SUMMARY: Record<RigType, string> = {
  starter: "Short-term / flexible",
  pro: "Balanced, mid-term",
  industrial: "Long-term & stable",
};

const RIG_COMPARE_ROWS = [
  {
    plan: RIG_PLANS[0],
    riskDots: 4,
    riskLabel: "High activity",
    style: "Short-term / flexible",
  },
  {
    plan: RIG_PLANS[1],
    riskDots: 3,
    riskLabel: "Medium",
    style: "Balanced",
  },
  {
    plan: RIG_PLANS[2],
    riskDots: 2,
    riskLabel: "Low",
    style: "Long-term",
  },
] as const;

const PLAYSTYLE_HINTS = [
  {
    title: "I want to stay flexible",
    recommend: "Starter Rig",
    bullets: ["Fastest rotation", "Lowest entry cost", "Great for testing strategies"],
  },
  {
    title: "I want balance",
    recommend: "Pro Rig",
    bullets: ["Good base HP", "Solid buff potential", "Medium cycle length"],
  },
  {
    title: "I want long-term growth",
    recommend: "Industrial Rig",
    bullets: ["Highest HP", "Best long-term buff", "Fewer renewal clicks"],
  },
] as const;

const RISK_HELPER_TEXT =
  "Shorter cycles = more clicking and more chances to optimize. Longer cycles = fewer decisions, more stability.";

const EXCLUDED_MIND_LP_ADDRESS = "Cjk6T9VU2N4eUXC3E5TzazJjwUeMrC25xdJyqf3F1s2z";
const EXCLUDED_MIND_LP_OWNER = new PublicKey(EXCLUDED_MIND_LP_ADDRESS);
const EXCLUDED_MIND_OWNERS = [
  EXCLUDED_MIND_LP_OWNER,
  new PublicKey("1nc1nerator11111111111111111111111111111111"),
  new PublicKey("9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU"),
];

const CONTRACTS = RIG_PLANS.map((plan, key) => ({
  key,
  label: plan.label,
  durationDays: plan.durationDays,
  costXnt: plan.costXnt,
  hp: plan.baseHp,
}));

const BASE_HP_BY_TYPE: Record<RigType, number> = {
  starter: RIG_PLAN_BY_TYPE.starter.baseHp,
  pro: RIG_PLAN_BY_TYPE.pro.baseHp,
  industrial: RIG_PLAN_BY_TYPE.industrial.baseHp,
};

function getMaxBuffHp(plan: RigPlan): number {
  return plan.baseHp * (1 + plan.maxBuffPercent);
}

interface RigPosition {
  type: RigType;
  buffLevel: number;
  buffAppliedFromCycle: number;
  expiresAtTs: number;
  baseHpHundredths: bigint;
}

interface AccountLevelInfo {
  levelBonusBps: number;
}

type NetworkHpBreakdownResponse = {
  baseHp: string;
  rigBuffHp: string;
  accountBonusHp?: string;
  effectiveHp?: string;
  updatedAt?: string;
};

type NetworkHpBreakdown = {
  baseHp: bigint;
  rigBuffHp: bigint;
  accountBonusHp: bigint;
  effectiveHp: bigint;
  updatedAt: string;
};

function rigTypeFromDuration(startTs: number, endTs: number, secondsPerDay: number) {
  if (!Number.isFinite(secondsPerDay) || secondsPerDay <= 0) return 0;
  const duration = Math.max(0, endTs - startTs);
  const days = Math.round(duration / secondsPerDay);
  switch (days) {
    case 7:
      return 0;
    case 14:
      return 1;
    case 28:
      return 2;
    default:
      return 0;
  }
}

function rigTypeKey(rigType: number): RigType {
  if (rigType === 1) return "pro";
  if (rigType === 2) return "industrial";
  return "starter";
}

function rigMaxBuffLevel(rigType: number) {
  if (rigType === 0) return 1;
  if (rigType === 1 || rigType === 2) return 3;
  return 0;
}

function rigBuffBps(rigType: number, buffLevel: number) {
  if (rigType === 0) return buffLevel >= 1 ? 100 : 0;
  if (rigType === 1) {
    if (buffLevel >= 3) return 350;
    if (buffLevel === 2) return 200;
    if (buffLevel === 1) return 100;
    return 0;
  }
  if (rigType === 2) {
    if (buffLevel >= 3) return 500;
    if (buffLevel === 2) return 300;
    if (buffLevel === 1) return 150;
    return 0;
  }
  return 0;
}

function getRigBuffBpsForLevel(type: RigType, buffLevel: number) {
  if (type === "starter") return buffLevel >= 1 ? 100 : 0;
  if (type === "pro") {
    if (buffLevel >= 3) return 350;
    if (buffLevel === 2) return 200;
    if (buffLevel === 1) return 100;
    return 0;
  }
  if (type === "industrial") {
    if (buffLevel >= 3) return 500;
    if (buffLevel === 2) return 300;
    if (buffLevel === 1) return 150;
    return 0;
  }
  return 0;
}

function getRigBuffBpsNow(position: RigPosition, now: number) {
  if (position.buffLevel <= 0) return 0;
  if (position.buffAppliedFromCycle === 0 || now >= position.buffAppliedFromCycle) {
    return getRigBuffBpsForLevel(position.type, position.buffLevel);
  }
  return 0;
}

function getRigEffectiveHpNow(position: RigPosition, now: number) {
  const baseHundredths =
    position.baseHpHundredths ??
    BigInt(Math.round((BASE_HP_BY_TYPE[position.type] ?? 0) * 100));
  const buffBpsNow = getRigBuffBpsNow(position, now);
  const buffedHundredths =
    (baseHundredths * BigInt(10_000 + buffBpsNow)) / 10_000n;
  return Number(buffedHundredths) / 100;
}

function getRigEffectiveHpNextCycle(position: RigPosition) {
  return getRigEffectiveHpNow(position, position.expiresAtTs);
}

function formatIntegerBig(value: bigint) {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function formatFixed2(valueHundredths: bigint) {
  const whole = valueHundredths / 100n;
  const frac = valueHundredths % 100n;
  return `${formatIntegerBig(whole)}.${frac.toString().padStart(2, "0")}`;
}

function formatFixed2Number(value: number) {
  if (!Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatRoundedToken(amountBase: bigint, decimals: number, digits = 2) {
  const full = formatTokenAmount(amountBase, decimals, Math.max(decimals, digits));
  const numeric = Number(full);
  if (!Number.isFinite(numeric)) {
    return full;
  }
  return numeric.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatTokenDynamicUi(amountUi: number) {
  if (!Number.isFinite(amountUi)) return "-";
  if (amountUi === 0) return "0.00";
  if (amountUi > 0 && amountUi < 0.000001) {
    return "<0.000001";
  }
  let digits = 2;
  if (amountUi < 0.001) digits = 6;
  else if (amountUi < 0.01) digits = 4;
  return amountUi.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatPercent(value: number | null, digits = 2) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

function formatFullPrecisionToken(amountBase: bigint, decimals: number) {
  return formatTokenAmount(amountBase, decimals, decimals);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function isTxTooLargeError(err: unknown) {
  if (!(err instanceof Error)) return false;
  return err.message.toLowerCase().includes("transaction too large");
}

export function PublicDashboard() {
  const { connection } = useConnection();
  const { publicKey: walletPublicKey, signAllTransactions, signTransaction } = useWallet();
  const { data: yieldSummary, loading: yieldLoading } = useYieldSummary();
  const anchorWallet = useAnchorWallet();
  const publicKey = walletPublicKey;
  const canTransact = Boolean(anchorWallet && walletPublicKey);
  const { push: pushToast } = useToast();

  const [config, setConfig] = useState<DecodedConfig | null>(null);
  const [nowTs, setNowTs] = useState<number | null>(null);
  const [lastRefreshNowTs, setLastRefreshNowTs] = useState<number | null>(null);
  const [positions, setPositions] = useState<
    Array<{ pubkey: string; data: ReturnType<typeof decodeMinerPositionAccount> }>
  >([]);
  const [userProfile, setUserProfile] = useState<
    ReturnType<typeof decodeUserMiningProfileAccount> | null
  >(null);
  const [userStake, setUserStake] = useState<DecodedUserStake | null>(null);
  const [mintDecimals, setMintDecimals] = useState<{ xnt: number; mind: number } | null>(null);
  const [rigBuffConfig, setRigBuffConfig] = useState<DecodedRigBuffConfig | null>(null);
  const [ripperPool, setRipperPool] = useState<RipperStakePool | null>(null);
  const [ripperMintDecimals, setRipperMintDecimals] = useState<number | null>(null);
  const [xntBalance, setXntBalance] = useState<bigint>(0n);
  const [mindBalance, setMindBalance] = useState<bigint>(0n);
  const [stakingRewardBalance, setStakingRewardBalance] = useState<bigint>(0n);
  const [stakingMindBalance, setStakingMindBalance] = useState<bigint>(0n);
  const [claimStats, setClaimStats] = useState<{
    totalXnt: string;
    total7dXnt: string;
    apr7dPct: number | null;
    events: number;
    updatedAt: string;
    tvlUsd?: number;
    priceMindUsd?: number;
  } | null>(null);
  const [claimStatsError, setClaimStatsError] = useState<string | null>(null);
  const [statsTab, setStatsTab] = useState<"payouts" | "vault">("payouts");
  const [stakingShareOfCirculating, setStakingShareOfCirculating] = useState<number | null>(null);
  const [networkTrend, setNetworkTrend] = useState<{ delta: bigint; pct: number } | null>(null);
  const [activeMinerTotal, setActiveMinerTotal] = useState(0);
  const [activeRigTotal, setActiveRigTotal] = useState(0);
  const [networkBreakdown, setNetworkBreakdown] = useState<NetworkHpBreakdown | null>(null);
  const [leaderboardRows, setLeaderboardRows] = useState<LeaderboardRow[]>([]);
  const [activeStakersSummary, setActiveStakersSummary] = useState<{
    unique: number;
    totalStaked: string;
    updated: number | null;
  }>({
    unique: ACTIVE_STAKERS_SUMMARY.unique,
    totalStaked: ACTIVE_STAKERS_SUMMARY.totalStaked,
    updated: ACTIVE_STAKERS_SUMMARY.updated,
  });
  const [activeStakers, setActiveStakers] = useState<ActiveStaker[]>(ACTIVE_STAKERS);

  const isAdmin = Boolean(publicKey && config && publicKey.equals(config.admin));
  const levelingEnabled = LEVELING_ENABLED || isAdmin;

  const [selectedContract, setSelectedContract] = useState<number>(1);
  const [openRigDetails, setOpenRigDetails] = useState<RigType | null>(null);
  const [showRigInfoModal, setShowRigInfoModal] = useState(false);
  const [stakeAmountUi, setStakeAmountUi] = useState<string>("");
  const [unstakeAmountUi, setUnstakeAmountUi] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastClaimAmount, setLastClaimAmount] = useState<bigint | null>(null);
  const [lastClaimTs, setLastClaimTs] = useState<number | null>(null);
  const [lastClaimFailures, setLastClaimFailures] = useState<string[]>([]);
  const refreshIdRef = useRef(0);
  const rigCardsRef = useRef<HTMLDivElement | null>(null);
  const xpEstimateStartRef = useRef<number | null>(null);
  const xpEstimateKey =
    publicKey && typeof window !== "undefined"
      ? `mining_v2_xp_estimate_${publicKey.toBase58()}`
      : null;
  const hashpowerTooltip =
    "Hashpower gives you a share of daily emission. Your share changes if the network hashpower changes.";
  const [showShareFull, setShowShareFull] = useState(false);
  const [showEmissionFull, setShowEmissionFull] = useState(false);
  const [claimRipperPct, setClaimRipperPct] = useState(0);

  const setMindAmountFromPercent = useCallback(
    (amountBase: bigint, setter: (value: string) => void, pct: number) => {
      if (!mintDecimals) return;
      const clampedPct = Math.max(0, Math.min(100, pct));
      const portion = (amountBase * BigInt(clampedPct)) / 100n;
      setter(formatTokenAmount(portion, mintDecimals.mind, 6));
    },
    [mintDecimals]
  );
  const [showClaimableFull, setShowClaimableFull] = useState(false);

  useEffect(() => {
    if (!openRigDetails) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || !rigCardsRef.current) return;
      if (rigCardsRef.current.contains(target)) return;
      setOpenRigDetails(null);
    };
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("mousedown", handleClick);
    };
  }, [openRigDetails]);

  const contract = CONTRACTS.find((c) => c.key === selectedContract) ?? CONTRACTS[0];
  const selectedPlan = RIG_PLANS[selectedContract] ?? RIG_PLANS[0];
  const selectedMaxBuffHpLabel = getMaxBuffHp(selectedPlan).toFixed(2);
  const growthExamples = RIG_PLANS.map((plan) => ({
    key: plan.type,
    label: plan.label.replace(" Rig", ""),
    baseLabel: plan.baseHp.toFixed(2),
    maxLabel: getMaxBuffHp(plan).toFixed(2),
  }));

  const refresh = useCallback(async () => {
    const refreshId = ++refreshIdRef.current;
    const isStale = () => refreshId !== refreshIdRef.current;
    setError(null);
    setLoading(true);
    try {
      const cfg = await fetchConfig(connection);
      if (isStale()) return;
      setConfig(cfg);
      try {
        const buffCfg = await fetchRigBuffConfig(connection);
        if (isStale()) return;
        setRigBuffConfig(buffCfg);
      } catch (err) {
        console.warn("Rig buff config unavailable", err);
        if (isStale()) return;
        setRigBuffConfig(null);
      }
      const ts = await fetchClockUnixTs(connection);
      if (isStale()) return;
      setNowTs(ts);
      setLastRefreshNowTs(ts);

      let useNativeXnt = cfg.xntMint.equals(SystemProgram.programId);
      const rewardVaultInfo = await connection.getAccountInfo(cfg.stakingRewardVault, "confirmed");
      if (rewardVaultInfo && !rewardVaultInfo.owner.equals(TOKEN_PROGRAM_ID)) {
        useNativeXnt = true;
      }
      const mindMintInfo = await getMint(connection, cfg.mindMint, "confirmed");
      let xntDecimals = XNT_DECIMALS;
      if (!useNativeXnt) {
        try {
          const xntMintInfo = await getMint(connection, cfg.xntMint, "confirmed");
          xntDecimals = xntMintInfo.decimals;
        } catch {
          useNativeXnt = true;
          xntDecimals = XNT_DECIMALS;
        }
      }
      if (isStale()) return;
      setMintDecimals({ xnt: xntDecimals, mind: mindMintInfo.decimals });
      let sharePct: number | null = null;
      try {
        let excludedBalance = 0n;
        for (const owner of EXCLUDED_MIND_OWNERS) {
          const excludedAccounts = await connection.getTokenAccountsByOwner(
            owner,
            { mint: cfg.mindMint },
            "confirmed"
          );
          for (const entry of excludedAccounts.value) {
            const decoded = AccountLayout.decode(entry.account.data.slice(0, AccountLayout.span));
            excludedBalance += decoded.amount;
          }
        }
        const circulatingBalance =
          mindMintInfo.supply > excludedBalance ? mindMintInfo.supply - excludedBalance : 0n;
        if (circulatingBalance > 0n) {
          const pctHundredths = (cfg.stakingTotalStakedMind * 10_000n) / circulatingBalance;
          sharePct = Number(pctHundredths) / 100;
        }
      } catch (err) {
        console.warn("Failed to compute circulating share excluding LP", err);
      }
      if (isStale()) return;
      setStakingShareOfCirculating(sharePct);
      try {
        const stakeAccounts = await connection.getProgramAccounts(getProgramId(), {
          commitment: "confirmed",
          filters: [{ dataSize: USER_STAKE_LEN }],
        });
        if (isStale()) return;
        let totalStaked = 0n;
        const stakes: Array<{ owner: string; staked: bigint }> = [];
        for (const entry of stakeAccounts) {
          const decoded = tryDecodeUserStakeAccount(entry.account.data);
          if (!decoded) continue;
          if (!decoded.owner || decoded.stakedMind === 0n) continue;
          const ownerPk = new PublicKey(decoded.owner);
          stakes.push({ owner: ownerPk.toBase58(), staked: decoded.stakedMind });
          totalStaked += decoded.stakedMind;
        }
        if (stakes.length > 0 && totalStaked > 0n) {
          const rewardPerDayBase =
            BigInt(cfg.stakingRewardRateXntPerSec.toString()) * BigInt(DAY_SECONDS);
          const totalStakedNum = Number(totalStaked);
          const top = stakes
            .sort((a, b) => (a.staked > b.staked ? -1 : 1))
            .map((s) => {
              const sharePct = totalStakedNum > 0 ? (Number(s.staked) / totalStakedNum) * 100 : 0;
              const rewardBase = (rewardPerDayBase * s.staked) / totalStaked;
              return {
                owner: s.owner,
                staked: formatTokenAmount(s.staked, mindMintInfo.decimals, 4),
                share: `${sharePct.toFixed(2)}%`,
                reward: formatTokenAmount(rewardBase, xntDecimals, 4),
              };
            });
          setActiveStakersSummary({
            unique: stakes.length,
            totalStaked: formatTokenAmount(totalStaked, mindMintInfo.decimals, 4),
            updated: Number(ts),
          });
          setActiveStakers(top);
        }
      } catch (err) {
        console.warn("Failed to load active stakers", err);
      }
      try {
        const pool = await fetchRipperStakePool(connection);
        if (isStale()) return;
        setRipperPool(pool);
        if (pool) {
          const poolMintInfo = await getMint(connection, pool.poolMint, "confirmed");
          if (isStale()) return;
          setRipperMintDecimals(poolMintInfo.decimals);
        } else {
          setRipperMintDecimals(null);
        }
      } catch (err) {
        console.warn("Failed to load Ripper pool", err);
        if (isStale()) return;
        setRipperPool(null);
        setRipperMintDecimals(null);
      }

      let rewardBal: bigint;
      try {
        if (useNativeXnt) {
          rewardBal = BigInt(await connection.getBalance(cfg.stakingRewardVault, "confirmed"));
        } else {
          const rewardBalRaw = await connection.getTokenAccountBalance(
            cfg.stakingRewardVault,
            "confirmed"
          );
          rewardBal = BigInt(rewardBalRaw.value.amount || "0");
        }
      } catch {
        useNativeXnt = true;
        rewardBal = BigInt(await connection.getBalance(cfg.stakingRewardVault, "confirmed"));
      }
      if (useNativeXnt) {
        const rentLamports = BigInt(
          await connection.getMinimumBalanceForRentExemption(NATIVE_VAULT_SPACE)
        );
        rewardBal = rewardBal > rentLamports ? rewardBal - rentLamports : 0n;
      }
      const mindBal = await connection.getTokenAccountBalance(cfg.stakingMindVault, "confirmed");
      if (isStale()) return;
      setStakingRewardBalance(rewardBal);
      setStakingMindBalance(BigInt(mindBal.value.amount || "0"));

      if (!publicKey) {
        setPositions([]);
        setUserProfile(null);
        setUserStake(null);
        setXntBalance(0n);
        setMindBalance(0n);
        setLeaderboardRows([]);
        return;
      }

      const programId = getProgramId();
      const [
        posGpaV1,
        posGpaV2,
        posGpaV3,
        profileAcc,
        stakeAcc,
        allPositionsV1,
        allPositionsV2,
        allPositionsV3,
        allProfilesV1,
        allProfilesV2,
        allProfilesV3,
        allProfilesV4,
        allStakes,
      ] = await Promise.all([
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [
            { dataSize: MINER_POSITION_LEN_V1 },
            { memcmp: { offset: 8, bytes: publicKey.toBase58() } },
          ],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [
            { dataSize: MINER_POSITION_LEN_V2 },
            { memcmp: { offset: 8, bytes: publicKey.toBase58() } },
          ],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [
            { dataSize: MINER_POSITION_LEN_V3 },
            { memcmp: { offset: 8, bytes: publicKey.toBase58() } },
          ],
        }),
        connection.getAccountInfo(deriveUserProfilePda(publicKey), "confirmed"),
        connection.getAccountInfo(deriveUserStakePda(publicKey), "confirmed"),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: MINER_POSITION_LEN_V1 }],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: MINER_POSITION_LEN_V2 }],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: MINER_POSITION_LEN_V3 }],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: USER_PROFILE_LEN_V1 }],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: USER_PROFILE_LEN_V2 }],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: USER_PROFILE_LEN_V3 }],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: USER_PROFILE_LEN_V4 }],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: USER_STAKE_LEN }],
        }),
      ]);
      const posGpa = [...posGpaV1, ...posGpaV2, ...posGpaV3];
      const allPositions = [...allPositionsV1, ...allPositionsV2, ...allPositionsV3];
      const allProfiles = [...allProfilesV1, ...allProfilesV2, ...allProfilesV3, ...allProfilesV4];
      if (isStale()) return;

      const decodedPositions = posGpa
        .map((p) => ({
          pubkey: p.pubkey.toBase58(),
          data: decodeMinerPositionAccount(Buffer.from(p.account.data)),
        }))
        .sort((a, b) => b.data.startTs - a.data.startTs);
      setPositions(decodedPositions);

      setUserProfile(
        profileAcc?.data ? decodeUserMiningProfileAccount(Buffer.from(profileAcc.data)) : null
      );
      setUserStake(
        stakeAcc?.data ? tryDecodeUserStakeAccount(Buffer.from(stakeAcc.data)) : null
      );

      try {
        const now = ts;
        const unique = new Set<string>();
        let rigs = 0;
        const leaderboardMap = new Map<string, LeaderboardRow>();
        const levelByOwner = new Map<string, number>();
        const secondsPerDay = config ? Number(config.secondsPerDay) : 0;
        for (const entry of allProfiles) {
          try {
            const decoded = decodeUserMiningProfileAccount(Buffer.from(entry.account.data));
            const ownerKey = new PublicKey(decoded.owner).toBase58();
            const level = Math.max(decoded.level ?? 1, 1);
            levelByOwner.set(ownerKey, level);
          } catch {
            // ignore malformed profile accounts
          }
        }
        for (const entry of allPositions) {
          const decoded = decodeMinerPositionAccount(Buffer.from(entry.account.data));
          if (decoded.deactivated || decoded.expired || decoded.endTs <= now) continue;
          const ownerKey = new PublicKey(decoded.owner).toBase58();
          unique.add(ownerKey);
          rigs += 1;
          const current =
            leaderboardMap.get(ownerKey) ??
            {
              owner: ownerKey,
              hp: 0n,
              buffedHp: 0n,
              stakedMind: 0n,
              activeRigs: 0,
              level: levelByOwner.get(ownerKey) ?? 1,
            };
          if (!current.level) {
            current.level = levelByOwner.get(ownerKey) ?? 1;
          }
          const rigType = decoded.hpScaled
            ? decoded.rigType
            : rigTypeFromDuration(decoded.startTs, decoded.endTs, secondsPerDay);
          const buffBpsBase = rigBuffBps(rigType, decoded.buffLevel);
          const buffApplied =
            decoded.buffLevel > 0 &&
            (decoded.buffAppliedFromCycle === 0n ||
              BigInt(now) >= decoded.buffAppliedFromCycle);
          const buffBps = buffApplied ? BigInt(buffBpsBase) : 0n;
          const buffedHp = (decoded.hp * (BPS_DENOMINATOR + buffBps)) / BPS_DENOMINATOR;
          current.hp += decoded.hp;
          current.buffedHp += buffedHp;
          current.activeRigs += 1;
          leaderboardMap.set(ownerKey, current);
        }
        setActiveMinerTotal(unique.size);
        setActiveRigTotal(rigs);

        for (const entry of allStakes) {
          const decoded = tryDecodeUserStakeAccount(Buffer.from(entry.account.data));
          if (!decoded) continue;
          const ownerKey = new PublicKey(decoded.owner).toBase58();
          const current =
            leaderboardMap.get(ownerKey) ??
            {
              owner: ownerKey,
              hp: 0n,
              buffedHp: 0n,
              stakedMind: 0n,
              activeRigs: 0,
              level: levelByOwner.get(ownerKey) ?? 1,
            };
          if (!current.level) {
            current.level = levelByOwner.get(ownerKey) ?? 1;
          }
          current.stakedMind = decoded.stakedMind;
          leaderboardMap.set(ownerKey, current);
        }

        const rows = Array.from(leaderboardMap.values())
          .filter((row) => row.hp > 0n)
          .sort((a, b) => {
            if (a.hp === b.hp) {
              if (a.stakedMind === b.stakedMind) {
                return a.owner.localeCompare(b.owner);
              }
              return a.stakedMind > b.stakedMind ? -1 : 1;
            }
            return a.hp > b.hp ? -1 : 1;
          })
          .slice(0, 50);
        setLeaderboardRows(rows);
      } catch (err) {
        console.warn("Failed to load active miners", err);
        setActiveMinerTotal(0);
        setActiveRigTotal(0);
        setLeaderboardRows([]);
      }

      const mindAta = getAssociatedTokenAddressSync(cfg.mindMint, publicKey);
      let xntBal: bigint;
      if (useNativeXnt) {
        xntBal = BigInt(await connection.getBalance(publicKey, "confirmed"));
      } else {
        try {
          const xntRaw = await connection.getTokenAccountBalance(
            getAssociatedTokenAddressSync(cfg.xntMint, publicKey),
            "confirmed"
          );
          xntBal = BigInt(xntRaw.value.amount || "0");
        } catch {
          useNativeXnt = true;
          xntBal = BigInt(await connection.getBalance(publicKey, "confirmed"));
        }
      }
      const mindBalUser = await connection
        .getTokenAccountBalance(mindAta, "confirmed")
        .then((b) => BigInt(b.value.amount || "0"))
        .catch(() => 0n);
      if (isStale()) return;
      setXntBalance(xntBal);
      setMindBalance(mindBalUser);

      if (typeof window !== "undefined") {
        const key = "mining_v2_network_hp_history";
        const historyRaw = window.localStorage.getItem(key);
        const history: Array<{ ts: number; hp: string }> = historyRaw ? JSON.parse(historyRaw) : [];
        const pruned = history.filter((entry) => ts - entry.ts <= 86_400);
        const last = pruned[pruned.length - 1];
        if (!last || ts - last.ts >= 3_600) {
          pruned.push({ ts, hp: cfg.networkHpActive.toString() });
        } else {
          pruned[pruned.length - 1] = { ts, hp: cfg.networkHpActive.toString() };
        }
        while (pruned.length > 32) pruned.shift();
        window.localStorage.setItem(key, JSON.stringify(pruned));
        const oldest = pruned[0];
        if (oldest && ts - oldest.ts >= 86_400) {
          const prevHp = BigInt(oldest.hp);
          const delta = cfg.networkHpActive - prevHp;
          const pct = prevHp > 0n ? Number((delta * 10_000n) / prevHp) / 100 : 0;
          setNetworkTrend({ delta, pct });
        } else {
          setNetworkTrend(null);
        }
      }
    } catch (e: unknown) {
      console.error(e);
      setError(formatError(e));
    } finally {
      if (!isStale()) {
        setLoading(false);
      }
    }
  }, [connection, publicKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let active = true;
    const loadClaimStats = async () => {
      try {
        setClaimStatsError(null);
        const res = await fetch("/api/stats/staking", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!active) return;
        const totalXnt =
          typeof data.totalXnt === "string" ? data.totalXnt : (data.totalBase ?? "0").toString();
        const total7dXnt =
          typeof data.total7dXnt === "string"
            ? data.total7dXnt
            : (data.total7dBase ?? "0").toString();
        const events = typeof data.events === "number" ? data.events : 0;
        const updatedAt =
          typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString();
        const tvlUsd =
          typeof data.tvlUsd === "number"
            ? data.tvlUsd
            : typeof data.tvlUsd === "string"
            ? Number(data.tvlUsd)
            : undefined;
        const priceMindUsd =
          data.price && typeof data.price.mindUsd === "number"
            ? data.price.mindUsd
            : undefined;
        setClaimStats({
          totalXnt,
          total7dXnt,
          apr7dPct: typeof data.apr7dPct === "number" ? data.apr7dPct : null,
          events,
          updatedAt,
          tvlUsd,
          priceMindUsd,
        });
      } catch (err) {
        if (!active) return;
        setClaimStatsError("Failed to load payout stats");
      }
    };
    void loadClaimStats();
    const id = window.setInterval(loadClaimStats, 600_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const loadBreakdown = async () => {
      try {
        const res = await fetch("/api/network/hp-breakdown", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as Partial<NetworkHpBreakdownResponse>;
        if (!active) return;
        if (typeof data.baseHp !== "string" || typeof data.rigBuffHp !== "string") {
          return;
        }
        setNetworkBreakdown({
          baseHp: BigInt(data.baseHp),
          rigBuffHp: BigInt(data.rigBuffHp),
          accountBonusHp:
            typeof data.accountBonusHp === "string" ? BigInt(data.accountBonusHp) : 0n,
          effectiveHp: typeof data.effectiveHp === "string" ? BigInt(data.effectiveHp) : 0n,
          updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString(),
        });
      } catch (err) {
        if (active) {
          console.warn("Failed to load network HP breakdown", err);
        }
      }
    };
    void loadBreakdown();
    const id = window.setInterval(() => void loadBreakdown(), NETWORK_BREAKDOWN_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!publicKey || typeof window === "undefined") {
      setLastClaimAmount(null);
      setLastClaimTs(null);
      return;
    }
    const key = `mining_v2_last_claim_${publicKey.toBase58()}`;
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      setLastClaimAmount(null);
      setLastClaimTs(null);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { amount: string; ts?: number };
      setLastClaimAmount(BigInt(parsed.amount));
      setLastClaimTs(typeof parsed.ts === "number" ? parsed.ts : null);
    } catch {
      setLastClaimAmount(null);
      setLastClaimTs(null);
    }
  }, [publicKey]);

  useEffect(() => {
    const id = window.setInterval(
      () => setNowTs((prev) => (prev != null ? prev + 1 : prev)),
      1_000
    );
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => void refresh().catch(() => null), 15_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const rawUserLevel = Math.max(userProfile?.level ?? 1, 1);
  const userLevel = levelingEnabled ? rawUserLevel : 1;
  const userXp = levelingEnabled ? userProfile?.xp ?? 0n : 0n;
  const lastXpUpdateTs = levelingEnabled ? userProfile?.lastXpUpdateTs ?? 0 : 0;
  const profileHpScaled =
    userProfile == null
      ? 0n
      : userProfile.hpScaled
      ? userProfile.activeHp
      : userProfile.activeHp * HP_SCALE;

  useEffect(() => {
    if (!levelingEnabled) return;
    if (!nowTs || !userProfile) return;
    if (lastXpUpdateTs > 0) {
      xpEstimateStartRef.current = null;
      if (xpEstimateKey) {
        window.localStorage.removeItem(xpEstimateKey);
      }
      return;
    }
    if (profileHpScaled <= 0n) {
      xpEstimateStartRef.current = null;
      if (xpEstimateKey) {
        window.localStorage.removeItem(xpEstimateKey);
      }
      return;
    }
    if (xpEstimateKey) {
      const raw = window.localStorage.getItem(xpEstimateKey);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { ts: number; hp: string };
          const storedHp = BigInt(parsed.hp);
          if (storedHp === profileHpScaled) {
            xpEstimateStartRef.current = parsed.ts;
            return;
          }
        } catch {
          window.localStorage.removeItem(xpEstimateKey);
        }
      }
    }
    if (xpEstimateStartRef.current == null) {
      xpEstimateStartRef.current = nowTs;
      if (xpEstimateKey) {
        window.localStorage.setItem(
          xpEstimateKey,
          JSON.stringify({ ts: nowTs, hp: profileHpScaled.toString() })
        );
      }
    }
  }, [lastXpUpdateTs, nowTs, profileHpScaled, userProfile, xpEstimateKey]);
  const levelIdx = levelingEnabled
    ? Math.min(Math.max(userLevel, 1), LEVEL_CAP) - 1
    : 0;
  const levelBonusBps = levelingEnabled
    ? LEVEL_BONUS_BPS[levelIdx] ?? LEVEL_BONUS_BPS[LEVEL_BONUS_BPS.length - 1]
    : 0;
  const levelBonusFor = useCallback(
    (level: number) => {
      const idx = Math.min(Math.max(level, 1), LEVEL_CAP) - 1;
      return LEVEL_BONUS_BPS[idx] ?? LEVEL_BONUS_BPS[LEVEL_BONUS_BPS.length - 1];
    },
    []
  );
  const nextLevelXp = levelingEnabled && userLevel < LEVEL_CAP ? LEVEL_THRESHOLDS[userLevel] : null;
  const levelBonusPct = (levelBonusBps / 100).toFixed(1);
  const weeklyPoolXnt = yieldSummary?.poolXnt;
  const fallbackWeeklyPoolXnt = getWeeklyPoolXnt();
  const yieldTotalWeight = yieldSummary?.totalWeight ?? 0;
  const userLevelKey = LEVELS.includes(userLevel as Level) ? (userLevel as Level) : null;
  const levelYield = userLevelKey && yieldSummary?.byLevel ? yieldSummary.byLevel[userLevelKey] : null;
  const yieldDataReady =
    yieldSummary != null && weeklyPoolXnt != null && Number.isFinite(weeklyPoolXnt) && yieldTotalWeight > 0;
  const personalYieldEst = yieldDataReady
    ? computeEstWeeklyXnt(userLevel, yieldTotalWeight, weeklyPoolXnt ?? fallbackWeeklyPoolXnt)
    : null;
  const personalSharePct =
    levelYield?.sharePct ??
    (personalYieldEst != null && weeklyPoolXnt != null && weeklyPoolXnt > 0
      ? (personalYieldEst / weeklyPoolXnt) * 100
      : null);
  const personalYieldLine = walletPublicKey
    ? yieldDataReady && personalYieldEst != null
      ? `Est. weekly XNT (LVL yield): ${personalYieldEst.toFixed(2)} XNT`
      : yieldLoading
        ? "Loading LVL yield from on-chain snapshot..."
        : "LVL yield unavailable"
    : "Connect wallet to see your estimated weekly XNT";
  const levelBonusBpsBig = BigInt(levelBonusBps);
  const xpEstimate = useMemo(() => {
    if (!levelingEnabled) {
      return { whole: 0n, hundredths: 0n };
    }
    if (!nowTs || !userProfile) {
      return { whole: userXp, hundredths: userXp * 100n };
    }
    const baseline =
      lastXpUpdateTs > 0 ? lastXpUpdateTs : xpEstimateStartRef.current ?? null;
    if (!baseline) {
      return { whole: userXp, hundredths: userXp * 100n };
    }
    const deltaSeconds = Math.max(0, nowTs - baseline);
    if (deltaSeconds <= 0) {
      return { whole: userXp, hundredths: userXp * 100n };
    }
    const gainHundredths =
      (profileHpScaled * BigInt(deltaSeconds) * 100n) / (36_000n * HP_SCALE);
    const hundredths = userXp * 100n + gainHundredths;
    return { whole: hundredths / 100n, hundredths };
  }, [nowTs, profileHpScaled, userProfile, userXp, lastXpUpdateTs]);
  const xpDisplay = xpEstimate.whole;
  const xpDisplayHundredths = xpEstimate.hundredths;
  const xpRemainingHundredths =
    nextLevelXp != null && nextLevelXp > 0n
      ? nextLevelXp * 100n > xpDisplayHundredths
        ? nextLevelXp * 100n - xpDisplayHundredths
        : 0n
      : 0n;
  const levelProgressPct =
    nextLevelXp != null && nextLevelXp > 0n
      ? Math.min(
          100,
          Math.max(
            0,
            Number((xpDisplayHundredths * 10_000n) / (nextLevelXp * 100n)) / 100
          )
        )
      : 100;
  const levelUpCostTokens = userLevel < LEVEL_CAP ? LEVEL_UP_COSTS[userLevel - 1] ?? null : null;
  const levelUpCostBase =
    levelUpCostTokens != null && mintDecimals != null
      ? BigInt(levelUpCostTokens) * 10n ** BigInt(mintDecimals.mind)
      : null;
  const hasMindForLevelUp =
    levelUpCostBase != null ? mindBalance >= levelUpCostBase : false;
  const canLevelUp =
    levelingEnabled &&
    userProfile != null &&
    nextLevelXp != null &&
    xpDisplay >= nextLevelXp &&
    hasMindForLevelUp &&
    userLevel < LEVEL_CAP;
  const missingXpLabel = formatFixed2(xpRemainingHundredths);
  const requiredMindLabel = levelUpCostTokens != null ? `${levelUpCostTokens}` : "0";
  const maxLevel = userLevel >= LEVEL_CAP || nextLevelXp == null;
  const levelUpDisabled =
    !levelingEnabled || !canTransact || !canLevelUp || busy != null || maxLevel;
  const levelUpButtonLabel = !levelingEnabled
    ? "Levels disabled"
    : maxLevel
    ? "Max level reached"
    : canLevelUp
    ? "Level up"
    : "Requirements";
  const levelUpRequirements =
    !canLevelUp && !maxLevel
      ? {
          xp: missingXpLabel,
          cost: requiredMindLabel,
        }
      : null;
  const xpLine = nextLevelXp != null
    ? `XP: ${formatFixed2(xpDisplayHundredths)} / ${formatIntegerBig(nextLevelXp)}`
    : `XP: ${formatFixed2(xpDisplayHundredths)} (max level)`;
  const xpPerHourHundredths =
    userProfile?.activeHp != null ? (profileHpScaled * 10n) / HP_SCALE : 0n;
  const xpRateLine =
    userProfile?.activeHp != null && profileHpScaled > 0n
      ? `≈ ${formatFixed2(xpPerHourHundredths)} XP/hour`
      : null;
  const bonusLine = `HP bonus: +${levelBonusPct}%`;
  const progressionDescription = levelingEnabled
    ? "Your account earns XP while your rigs are mining. Higher levels give a small HP bonus on top of your rigs."
    : LEVELING_DISABLED_MESSAGE;
  const xpEstimateNote =
    levelingEnabled && lastXpUpdateTs <= 0 && profileHpScaled
      ? "XP is estimated until your next on-chain interaction (claim, buy, renew)."
      : null;
  const levelProgressLabel = `Progress: ${levelProgressPct.toFixed(2)}%`;

  const activePositions = useMemo(() => {
    const now = nowTs ?? Math.floor(Date.now() / 1000);
    return positions.filter((p) => !p.data.deactivated && now < p.data.endTs);
  }, [positions, nowTs]);

  const baseUserHpHundredths = useMemo(() => {
    if (activePositions.length > 0) {
      return activePositions.reduce((acc, p) => acc + p.data.hp, 0n);
    }
    if (userProfile) {
      return userProfile.hpScaled ? userProfile.activeHp : userProfile.activeHp * HP_SCALE;
    }
    return 0n;
  }, [activePositions, userProfile]);

  const buffedUserHpHundredths = useMemo(() => {
    if (activePositions.length === 0) return baseUserHpHundredths;
    const secondsPerDay = config ? Number(config.secondsPerDay) : 0;
    return activePositions.reduce((acc, p) => {
      const rigType = p.data.hpScaled
        ? p.data.rigType
        : rigTypeFromDuration(p.data.startTs, p.data.endTs, secondsPerDay);
      const buffBpsBase = rigBuffBps(rigType, p.data.buffLevel);
      const buffApplied =
        p.data.buffLevel > 0 &&
        (p.data.buffAppliedFromCycle === 0n ||
          nowTs == null ||
          BigInt(nowTs) >= p.data.buffAppliedFromCycle);
      const buffBps = buffApplied ? BigInt(buffBpsBase) : 0n;
      const buffedHp = (p.data.hp * (BPS_DENOMINATOR + buffBps)) / BPS_DENOMINATOR;
      return acc + buffedHp;
    }, 0n);
  }, [activePositions, baseUserHpHundredths, config, nowTs]);

  const effectiveUserHpHundredths = useMemo(() => {
    if (buffedUserHpHundredths === 0n) return 0n;
    return (
      buffedUserHpHundredths *
      (BPS_DENOMINATOR + levelBonusBpsBig) /
      BPS_DENOMINATOR
    );
  }, [buffedUserHpHundredths, levelBonusBpsBig]);
  const networkHp = config?.networkHpActive ?? 0n;
  const networkHpHundredths = useMemo(() => networkHp, [networkHp]);
  const hasNetworkBreakdown = networkBreakdown != null;
  const networkBaseHpHundredths = networkBreakdown?.baseHp ?? 0n;
  const networkRigBuffBonusHundredths = networkBreakdown?.rigBuffHp ?? 0n;
  const networkBuffedHpHundredths = networkBaseHpHundredths + networkRigBuffBonusHundredths;
  const networkAccountBonusHundredths =
    networkHpHundredths > networkBuffedHpHundredths
      ? networkHpHundredths - networkBuffedHpHundredths
      : 0n;
  const networkAccountBonusPct =
    networkBuffedHpHundredths > 0n
      ? Number((networkAccountBonusHundredths * 10_000n) / networkBuffedHpHundredths) / 100
      : 0;
  const networkBaseHpLabel = formatFixed2(networkBaseHpHundredths);
  const networkAccountBonusLabel = formatFixed2(networkAccountBonusHundredths);
  const miningStatusText =
    networkHp > 0n
      ? "Status: Mining active • • •"
      : "Status: Emission paused — no active hashpower";
  const statusAccentClass = networkHp > 0n ? "text-emerald-300" : "text-amber-300";
  const secondsPerDayUi = config && Number(config.secondsPerDay) > 0 ? Number(config.secondsPerDay) : 86_400;
  const renewWindowSeconds = secondsPerDayUi * RENEW_REMINDER_DAYS;
  const baseHpTotal = Number(baseUserHpHundredths) / 100;
  const hpWithRigBuffsTotal = Number(buffedUserHpHundredths) / 100;
  const hpFinal = Number(effectiveUserHpHundredths) / 100;
  const rigBuffRatio =
    baseUserHpHundredths > 0n
      ? Number((buffedUserHpHundredths - baseUserHpHundredths) * 10_000n / baseUserHpHundredths) /
        10_000
      : 0;
  const networkHpUi = networkHpHundredths > 0n ? Number(networkHpHundredths) / 100 : 0;
  const sharePctRaw = networkHpUi > 0 ? (hpFinal / networkHpUi) * 100 : 0;
  const sharePct = Number.isFinite(sharePctRaw) ? sharePctRaw : 0;
  const sharePctFull = sharePct;
  const shareTooltip =
    "You receive rewards continuously based on your current share. Your share may change when others join or expire.";
  const rigBuffBonusHp = Math.max(0, hpWithRigBuffsTotal - baseHpTotal);
  const accountBonusHp = Math.max(0, hpFinal - hpWithRigBuffsTotal);
  const rigBuffPct = rigBuffRatio * 100;
  const accountBonusPct = levelBonusBps / 100;
  const rigBuffCapRatio = Number(RIG_BUFF_CAP_BPS) / 10_000;
  const rigBuffCapPct = Number(RIG_BUFF_CAP_BPS) / 100;
  const rigBuffCapProgress =
    rigBuffCapRatio > 0
      ? Math.min(100, Math.max(0, (rigBuffRatio / rigBuffCapRatio) * 100))
      : 0;
  const rigBuffCapReached = rigBuffRatio >= rigBuffCapRatio;
  const hpFinalLabel = formatFixed2Number(hpFinal);
  const baseHpLabel = formatFixed2Number(baseHpTotal);
  const rigBuffBonusLabel = formatFixed2Number(rigBuffBonusHp);
  const accountBonusLabel = formatFixed2Number(accountBonusHp);
  const graceSeconds = secondsPerDayUi * GRACE_DAYS;
  const expiryTooltip =
    "When the contract expires, the rig stops mining and enters a 2-day grace period for renewal.";
  const soonestContractExpiresIn = useMemo(() => {
    if (nowTs == null) return null;
    const activeRemains = positions
      .filter((p) => !p.data.deactivated && nowTs < p.data.endTs)
      .map((p) => p.data.endTs - nowTs);
    if (activeRemains.length === 0) return null;
    return Math.min(...activeRemains);
  }, [positions, nowTs]);

  const accrualPerSecond = useMemo(() => {
    if (!config || config.networkHpActive === 0n) return 0n;
    return (config.emissionPerSec * ACC_SCALE) / config.networkHpActive;
  }, [config]);

  const elapsedSinceRefresh =
    nowTs != null && lastRefreshNowTs != null ? Math.max(0, nowTs - lastRefreshNowTs) : 0;
  const elapsedSinceRefreshBig = BigInt(elapsedSinceRefresh);
  const extraAccSinceRefresh = accrualPerSecond * elapsedSinceRefreshBig;

  const pendingPositions = useMemo(() => {
    const secondsPerDay = config ? Number(config.secondsPerDay) : 0;
    const levelAccSnapshots = userProfile?.levelAccSnapshots;
    const hasSnapshots = Array.isArray(levelAccSnapshots);
    const accPerSec =
      config && config.networkHpActive > 0n
        ? (config.emissionPerSec * ACC_SCALE) / config.networkHpActive
        : 0n;
    const lastUpdateTs = config ? BigInt(config.lastUpdateTs) : 0n;
    const applyBps = (value: bigint, bps: number | bigint) =>
      (value * (BPS_DENOMINATOR + BigInt(bps))) / BPS_DENOMINATOR;
    return positions.map((p) => {
      if (!config) {
        return { position: p, pending: 0n, livePending: 0n };
      }
      const rigType = p.data.hpScaled
        ? p.data.rigType
        : rigTypeFromDuration(p.data.startTs, p.data.endTs, secondsPerDay);
      const baseHp = p.data.hp;
      const buffBpsBase = rigBuffBps(rigType, p.data.buffLevel);
      const buffApplied =
        p.data.buffLevel > 0 &&
        (p.data.buffAppliedFromCycle === 0n ||
          nowTs == null ||
          BigInt(nowTs) >= p.data.buffAppliedFromCycle);
      const buffBps = buffApplied ? BigInt(buffBpsBase) : 0n;
      const levelForCalc = p.data.expired
        ? Math.max(p.data.lastLevelApplied ?? userLevel, 1)
        : userLevel;
      const bonusMultiplier =
        BPS_DENOMINATOR + BigInt(levelBonusFor(levelForCalc));
      const hpWithBuff = p.data.deactivated
        ? baseHp
        : (baseHp * (BPS_DENOMINATOR + buffBps)) / BPS_DENOMINATOR;
      const hpEffective = p.data.deactivated
        ? baseHp
        : (hpWithBuff * bonusMultiplier) / BPS_DENOMINATOR;
      const acc =
        p.data.deactivated || p.data.expired ? p.data.finalAccMindPerHp : config.accMindPerHp;
      let rewardDebt = p.data.rewardDebt;
      if (!p.data.deactivated && !p.data.expired && hasSnapshots) {
        const appliedLevel = Math.max(p.data.lastLevelApplied ?? 1, 1);
        if (userLevel > appliedLevel) {
          let prevLevel = appliedLevel;
          while (prevLevel < userLevel) {
            const nextLevel = prevLevel + 1;
            const bonusPrev = BigInt(levelBonusFor(prevLevel));
            const bonusNext = BigInt(levelBonusFor(nextLevel));
            const hpPrev = (hpWithBuff * (BPS_DENOMINATOR + bonusPrev)) / BPS_DENOMINATOR;
            const hpNext = (hpWithBuff * (BPS_DENOMINATOR + bonusNext)) / BPS_DENOMINATOR;
            const deltaHp = hpNext > hpPrev ? hpNext - hpPrev : 0n;
            const snapAcc = levelAccSnapshots?.[nextLevel] ?? 0n;
            rewardDebt += (deltaHp * snapAcc) / ACC_SCALE;
            prevLevel = nextLevel;
          }
        }
      }
      if (
        !p.data.deactivated &&
        !p.data.expired &&
        p.data.buffAppliedFromCycle > 0n &&
        nowTs != null &&
        BigInt(nowTs) >= p.data.buffAppliedFromCycle &&
        p.data.buffLevel > 0
      ) {
        const prevLevel = Math.max(0, p.data.buffLevel - 1);
        const prevBps = rigBuffBps(rigType, prevLevel);
        const newBps = rigBuffBps(rigType, p.data.buffLevel);
        if (prevBps !== newBps) {
          let accAtApply = config.accMindPerHp;
          if (accPerSec > 0n && p.data.buffAppliedFromCycle > lastUpdateTs) {
            const delta = p.data.buffAppliedFromCycle - lastUpdateTs;
            accAtApply = config.accMindPerHp + accPerSec * delta;
          }
          const levelBps = levelBonusFor(userLevel);
          const hpPrev = applyBps(applyBps(baseHp, prevBps), levelBps);
          const hpNew = applyBps(applyBps(baseHp, newBps), levelBps);
          const earnedOld = (hpPrev * accAtApply) / ACC_SCALE;
          const pendingBefore = earnedOld > rewardDebt ? earnedOld - rewardDebt : 0n;
          const earnedNew = (hpNew * accAtApply) / ACC_SCALE;
          rewardDebt = earnedNew > pendingBefore ? earnedNew - pendingBefore : 0n;
        }
      }
      const earned = (hpEffective * acc) / ACC_SCALE;
      const pending = earned > rewardDebt ? earned - rewardDebt : 0n;
      const livePending =
        p.data.deactivated || p.data.expired
          ? pending
          : pending + (hpEffective * extraAccSinceRefresh) / ACC_SCALE;
      return { position: p, pending, livePending };
    });
  }, [positions, config, extraAccSinceRefresh, nowTs, userLevel, userProfile, levelBonusFor]);

  const visiblePositions = useMemo(() => {
    if (nowTs == null) return pendingPositions;
    return pendingPositions.filter((entry) => nowTs <= entry.position.data.endTs + graceSeconds);
  }, [graceSeconds, nowTs, pendingPositions]);

  const totalPendingMind = pendingPositions.reduce((acc, entry) => acc + entry.pending, 0n);
  const livePendingMind =
    totalPendingMind + (effectiveUserHpHundredths * extraAccSinceRefresh) / ACC_SCALE;

  const stakingAccNow = useMemo(() => {
    if (!config || nowTs == null) return config?.stakingAccXntPerMind ?? 0n;
    if (config.stakingRewardRateXntPerSec === 0n || config.stakingTotalStakedMind === 0n) {
      return config.stakingAccXntPerMind;
    }
    const currentTs = BigInt(nowTs);
    const epochEnd = BigInt(config.stakingEpochEndTs);
    const lastUpdate = BigInt(config.stakingLastUpdateTs);
    const effectiveEnd = currentTs < epochEnd ? currentTs : epochEnd;
    if (effectiveEnd <= lastUpdate) {
      return config.stakingAccXntPerMind;
    }
    const dt = effectiveEnd - lastUpdate;
    const mintable = dt * config.stakingRewardRateXntPerSec;
    const delta =
      mintable * ACC_SCALE / config.stakingTotalStakedMind;
    return config.stakingAccXntPerMind + delta;
  }, [config, nowTs]);

  const basePendingXnt = useMemo(() => {
    if (!config || !userStake) return 0n;
    const earned = (userStake.stakedMind * stakingAccNow) / ACC_SCALE;
    const pending = earned > userStake.rewardDebt ? earned - userStake.rewardDebt : 0n;
    return pending + userStake.rewardOwed;
  }, [config, userStake, stakingAccNow]);

  const badgeBonusBps = userProfile?.badgeBonusBps ?? 0;
  const effectiveBonusBps = Math.min(badgeBonusBps, Number(BADGE_BONUS_CAP_BPS));
  const finalPendingXnt =
    basePendingXnt > 0n
      ? (basePendingXnt * (BPS_DENOMINATOR + BigInt(effectiveBonusBps))) / BPS_DENOMINATOR
      : 0n;
  const claimRipperPctClamped = Math.max(0, Math.min(100, claimRipperPct));
  const claimRipperAmount = (finalPendingXnt * BigInt(claimRipperPctClamped)) / 100n;
  const claimRipperFee = (claimRipperAmount * RIPPER_FEE_BPS) / BPS_DENOMINATOR;
  const claimRipperNet = claimRipperAmount > claimRipperFee ? claimRipperAmount - claimRipperFee : 0n;
  const claimWalletAmount = finalPendingXnt - claimRipperAmount;
  const claimRipperEstimate =
    ripperPool && claimRipperNet > 0n ? calcPoolTokensForDeposit(ripperPool, claimRipperNet) : 0n;

  const emissionPerDay = config ? config.emissionPerSec * 86_400n : 0n;
  const estUserPerDay =
    config && networkHpHundredths > 0n
      ? (emissionPerDay * effectiveUserHpHundredths) / networkHpHundredths
      : 0n;

  const epochCountdown = useMemo(() => {
    if (!config || nowTs == null) return null;
    const remaining = Math.max(0, config.stakingEpochEndTs - nowTs);
    return remaining;
  }, [config, nowTs]);

  const stakingSharePct = useMemo(() => {
    if (!config || !userStake || config.stakingTotalStakedMind === 0n) return null;
    return Number((userStake.stakedMind * 10_000n) / config.stakingTotalStakedMind) / 100;
  }, [config, userStake]);
  const stakingAprPct = useMemo(() => {
    if (!config || !mintDecimals) return null;
    if (config.stakingRewardRateXntPerSec === 0n || config.stakingTotalStakedMind === 0n) return 0;
    const rewardPerSec = Number(config.stakingRewardRateXntPerSec) / 10 ** mintDecimals.xnt;
    const totalStaked = Number(config.stakingTotalStakedMind) / 10 ** mintDecimals.mind;
    if (!Number.isFinite(rewardPerSec) || !Number.isFinite(totalStaked) || totalStaked <= 0) return null;
    const apr = (rewardPerSec * STAKING_SECONDS_PER_YEAR) / totalStaked;
    return apr * 100;
  }, [config, mintDecimals]);
  // APY removed from UI; APR is shown directly in stats.
  const totalClaimedMind = mindBalance + (userStake?.stakedMind ?? 0n);
  const secondsPerDayNumber = config ? Number(config.secondsPerDay) : 86_400;
  const secondsIntoDay =
    config && lastRefreshNowTs != null && secondsPerDayNumber > 0
      ? lastRefreshNowTs % secondsPerDayNumber
      : 0;
  const baseMintedToday =
    config && secondsIntoDay > 0
      ? config.emissionPerSec * BigInt(secondsIntoDay)
      : 0n;
  const liveMintedToday =
    baseMintedToday + (config ? config.emissionPerSec * elapsedSinceRefreshBig : 0n);
  const dailyMintTarget =
    config && secondsPerDayNumber > 0
      ? config.emissionPerSec * BigInt(secondsPerDayNumber)
      : 0n;

  const estimatedStakingPerDay = config ? config.stakingRewardRateXntPerSec * 86_400n : 0n;
  const userStakingPerDayBase =
    config && userStake && config.stakingTotalStakedMind > 0n
      ? (estimatedStakingPerDay * userStake.stakedMind) / config.stakingTotalStakedMind
      : 0n;
  const currentPaceBase =
    userStakingPerDayBase > 0n
      ? (userStakingPerDayBase * (BPS_DENOMINATOR + BigInt(effectiveBonusBps))) / BPS_DENOMINATOR
      : userStakingPerDayBase;

  const accruedXntBase = finalPendingXnt;
  const earnedValue =
    mintDecimals != null ? `${formatRoundedToken(accruedXntBase, mintDecimals.xnt, 2)} XNT` : "-";
  const currentPaceValue =
    mintDecimals != null
      ? `${formatRoundedToken(currentPaceBase, mintDecimals.xnt, 2)} XNT/day`
      : "-";
  const stakeAmountBase = useMemo(() => {
    if (!mintDecimals) return 0n;
    try {
      return parseUiAmountToBase(stakeAmountUi, mintDecimals.mind);
    } catch {
      return 0n;
    }
  }, [mintDecimals, stakeAmountUi]);
  const stakeAmountEffectiveBase =
    mindBalance > 0n && stakeAmountBase > mindBalance ? mindBalance : stakeAmountBase;
  const predictedStakeXntBase =
    config && config.stakingTotalStakedMind > 0n && stakeAmountEffectiveBase > 0n
      ? (estimatedStakingPerDay * stakeAmountEffectiveBase) / config.stakingTotalStakedMind
      : 0n;
  const predictedStakeXntBonus =
    predictedStakeXntBase > 0n
      ? (predictedStakeXntBase * (BPS_DENOMINATOR + BigInt(effectiveBonusBps))) /
        BPS_DENOMINATOR
      : predictedStakeXntBase;
  const stakeAmountExceedsBalance = mindBalance > 0n ? stakeAmountBase > mindBalance : stakeAmountBase > 0n;
  const predictedStakeLabel =
    mintDecimals != null
      ? `${formatRoundedToken(predictedStakeXntBonus, mintDecimals.xnt, 2)} XNT/day`
      : "-";
  const claimWalletLabel =
    mintDecimals != null ? formatRoundedToken(claimWalletAmount, mintDecimals.xnt, 4) : "-";
  const claimRipperNetLabel =
    mintDecimals != null ? formatRoundedToken(claimRipperNet, mintDecimals.xnt, 4) : "-";
  const claimRipperFeeLabel =
    mintDecimals != null ? formatRoundedToken(claimRipperFee, mintDecimals.xnt, 4) : "-";
  const claimRipperEstimateLabel =
    ripperMintDecimals != null ? formatRoundedToken(claimRipperEstimate, ripperMintDecimals, 4) : "-";

  const milestoneTargets = [1n, 5n, 10n];
  const xntDecimals = mintDecimals?.xnt ?? null;
  const milestoneTargetBase = (() => {
    if (xntDecimals == null) return null;
    const base = 10n ** BigInt(xntDecimals);
    if (currentPaceBase <= 0n) {
      return milestoneTargets[0] * base;
    }
    for (const target of milestoneTargets) {
      const targetBase = target * base;
      if (targetBase > accruedXntBase) {
        return targetBase;
      }
    }
    return milestoneTargets[milestoneTargets.length - 1] * base;
  })();

  const milestoneValue =
    milestoneTargetBase != null && xntDecimals != null
      ? `${formatRoundedToken(milestoneTargetBase, xntDecimals, 2)} XNT`
      : "-";
  const milestoneRemainingBase =
    milestoneTargetBase != null && accruedXntBase < milestoneTargetBase
      ? milestoneTargetBase - accruedXntBase
      : 0n;
  const milestoneEtaDisplay = (() => {
    if (milestoneTargetBase == null || currentPaceBase <= 0n) return null;
    if (accruedXntBase >= milestoneTargetBase) return "soon";
    const remaining = Number(milestoneRemainingBase);
    const pace = Number(currentPaceBase);
    if (!Number.isFinite(remaining) || !Number.isFinite(pace) || pace <= 0) return null;
    const eta = Math.round(remaining / pace);
    if (eta <= 0) return "soon";
    return String(Math.min(99, eta));
  })();

  const progressLabel =
    currentPaceBase > 0n && milestoneTargetBase != null && milestoneTargetBase > 0n
      ? `Progress: ${
          Math.min(
            100,
            Math.max(
              0,
              Number((accruedXntBase * 10_000n) / milestoneTargetBase) / 100
            )
          )
            .toFixed(2)
        }%`
      : "Waiting for rewards to start accumulating";
  const milestoneProgress =
    currentPaceBase > 0n && milestoneTargetBase != null && milestoneTargetBase > 0n
      ? Math.min(
          100,
          Math.max(0, Number((accruedXntBase * 10_000n) / milestoneTargetBase) / 100)
        )
      : 0;

  const userStakeRounded =
    mintDecimals && userStake
      ? formatRoundedToken(userStake.stakedMind, mintDecimals.mind, 2)
      : "-";
  const stakeShareRounded = stakingSharePct != null ? `${stakingSharePct.toFixed(2)}%` : "-";
  const stakeSummary = userStakeRounded === "-" ? "-" : `${userStakeRounded} MIND`;
  const epochTooltip =
    epochCountdown != null ? `Next epoch resets in ${formatDurationSeconds(epochCountdown)}` : undefined;

  const claimableRounded =
    mintDecimals != null ? formatRoundedToken(totalPendingMind, mintDecimals.mind, 6) : "-";
  const claimableFull =
    mintDecimals != null ? formatFullPrecisionToken(totalPendingMind, mintDecimals.mind) : "-";
  const claimableTinyThreshold =
    mintDecimals != null ? 10n ** BigInt(Math.max(0, mintDecimals.mind - 6)) : null;
  const claimableIsTiny =
    claimableTinyThreshold != null ? totalPendingMind < claimableTinyThreshold : false;
  const claimableHint = claimableIsTiny
    ? "Building up — rewards accrue continuously."
    : "Collect rewards via the Claim rewards button in Your rigs.";
  const accrualPerSecBase =
    estUserPerDay > 0n ? estUserPerDay / 86_400n : 0n;
  const accrualPerSecValue =
    mintDecimals != null
      ? `${formatTokenAmount(accrualPerSecBase, mintDecimals.mind, 6)} MIND / sec`
      : "-";
  const accrualPerHourValue =
    mintDecimals != null
      ? `${formatRoundedToken(estUserPerDay / 24n, mintDecimals.mind, 2)} MIND/hour`
      : "-";
  const accrualPerMinuteValue =
    mintDecimals != null
      ? `${formatRoundedToken(estUserPerDay / 1_440n, mintDecimals.mind, 2)} MIND/min`
      : "-";
  const walletRounded =
    mintDecimals != null ? formatRoundedToken(mindBalance, mintDecimals.mind) : "-";
  const walletFull =
    mintDecimals != null ? formatFullPrecisionToken(mindBalance, mintDecimals.mind) : "-";
  const emissionRounded =
    mintDecimals != null ? formatRoundedToken(liveMintedToday, mintDecimals.mind) : "-";
  const emissionFull =
    mintDecimals != null ? formatFullPrecisionToken(liveMintedToday, mintDecimals.mind) : "-";
  const emissionTargetRounded =
    mintDecimals != null && dailyMintTarget > 0n
      ? formatRoundedToken(dailyMintTarget, mintDecimals.mind, 0)
      : "-";
  const rewardPoolBadge = "3900.14";
  const totalStakedBadge =
    mintDecimals != null && config ? formatRoundedToken(config.stakingTotalStakedMind, mintDecimals.mind) : "-";
  const stakingShareLabel =
    stakingShareOfCirculating != null
      ? ` (${stakingShareOfCirculating.toFixed(2)}%)`
      : "";
  const totalStakedBase = config?.stakingTotalStakedMind ?? 0n;
  const leaderboardRowElements = leaderboardRows.map((row, idx) => {
    const medal = LEADER_MEDALS[idx];
    const sharePct =
      totalStakedBase > 0n
        ? Number((row.stakedMind * 10_000n) / totalStakedBase) / 100
        : 0;
    const shareLabel = totalStakedBase > 0n ? ` (${sharePct.toFixed(1)}%)` : "";
    const stakedLabel =
      mintDecimals != null
        ? `${formatRoundedToken(row.stakedMind, mintDecimals.mind, 2)}${shareLabel}`
        : "-";
    const levelBonusBpsRow = levelBonusFor(row.level);
    const baseForBonus = row.buffedHp ?? row.hp;
    const levelBonusHp =
      levelBonusBpsRow > 0 ? (baseForBonus * BigInt(levelBonusBpsRow)) / BPS_DENOMINATOR : 0n;
    const levelBonusLabel = levelBonusHp > 0n ? `(+${formatFixed2(levelBonusHp)})` : null;
    const stakedClass = stakedLabel === "-" ? "text-zinc-500" : "text-zinc-300";
    const levelLabel =
      row.level === 2
        ? "BRONZE Miner - LVL 2"
        : row.level === 3
          ? "SILVER Miner - LVL 3"
          : row.level === 4
            ? "GOLD Miner - LVL 4"
            : row.level === 5
              ? "PLATINUM Miner - LVL 5"
              : row.level === 6
                ? "DIAMOND Miner - LVL 6"
                : `LVL ${row.level}`;
    const levelClassName =
      row.level === 2
        ? "text-transparent bg-clip-text bg-gradient-to-r from-[#8c4b1f] via-[#c57f3a] to-[#ffcc8f] drop-shadow-[0_0_8px_rgba(197,127,58,0.75)]"
        : row.level === 3
          ? "text-transparent bg-clip-text bg-gradient-to-r from-[#c0c0c0] via-[#f7f7f7] to-[#9ea3ad] drop-shadow-[0_0_7px_rgba(192,192,192,0.7)]"
          : row.level === 4
            ? "text-transparent bg-clip-text bg-gradient-to-r from-[#b88900] via-[#ffd966] to-[#f4c430] drop-shadow-[0_0_10px_rgba(244,196,48,0.8)]"
            : row.level === 5
              ? "text-transparent bg-clip-text bg-gradient-to-r from-[#9fb6c3] via-[#e4ecf1] to-[#6f8898] drop-shadow-[0_0_10px_rgba(159,182,195,0.75)]"
              : row.level === 6
                ? "text-transparent bg-clip-text bg-gradient-to-r from-[#dff3ff] via-[#9dd5ff] to-[#5ab4ff] drop-shadow-[0_0_12px_rgba(90,180,255,0.9)]"
                : "text-emerald-200";
    return (
      <div
        key={row.owner}
        className="grid grid-cols-[32px_32px_1fr_140px_110px_140px] items-center text-xs text-zinc-200"
      >
        <div className="text-zinc-500">{idx + 1}</div>
        <div className="text-center font-mono text-sm">{medal ?? ""}</div>
        <div className="font-mono" title={row.owner}>
          <span>{shortPk(row.owner, 4)}</span>
          {row.level > 1 ? (
            <span className={`ml-2 text-[12px] font-semibold tracking-wide ${levelClassName}`}>
              {levelLabel}
            </span>
          ) : null}
        </div>
        <div className="text-right text-white tabular-nums">{formatFixed2(row.hp)}</div>
        <div
          className={`text-right tabular-nums ${levelBonusLabel ? "text-emerald-200" : "text-zinc-500"}`}
        >
          {levelBonusLabel ?? "—"}
        </div>
        <div className={`text-right ${stakedClass}`}>{stakedLabel}</div>
      </div>
  );
});
  const stakingAprDisplay = formatPercent(stakingAprPct);
  const lastClaimRounded =
    mintDecimals && lastClaimAmount != null
      ? formatRoundedToken(lastClaimAmount, mintDecimals.mind, 6)
      : null;
  const lastClaimAgo =
    lastClaimTs != null
      ? formatDurationSeconds(
          Math.max(0, (nowTs ?? Math.floor(Date.now() / 1000)) - lastClaimTs)
        )
      : null;
  const showLastClaim = lastClaimAmount != null && lastClaimAmount > 0n;
  const showClaimableAmount = mintDecimals != null && !claimableIsTiny && totalPendingMind > 0n;
  const hasMindBalance = mindBalance > 0n;
  const hasStakedMind = userStake?.stakedMind ? userStake.stakedMind > 0n : false;
  const quickAmountButtonClass =
    "h-7 px-2 text-[10px] border border-black/70 bg-black/30 text-zinc-200 hover:bg-black/50";

  const ensureAta = async (owner: PublicKey, mint: PublicKey) => {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const info = await connection.getAccountInfo(ata, "confirmed");
    if (info) return { ata, ix: null };
    return {
      ata,
      ix: createAssociatedTokenAccountIdempotentInstruction(
        owner,
        ata,
        owner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      ),
    };
  };

  const mapTxAction = (label: string) => {
    switch (label) {
      case "Buy contract":
        return "buy_contract";
      case "Claim all rigs":
        return "claim_mind";
      case "Stake MIND":
        return "stake_mind";
      case "Unstake MIND":
        return "unstake_mind";
      case "Claim XNT":
        return "claim_xnt";
      case "Claim + stake rXNT":
        return "claim_xnt_rxnt";
      case "Level up":
        return "level_up";
      case "Renew with buff":
        return "renew_rig_with_buff";
      case "Renew":
        return "renew_rig";
      default:
        return "other";
    }
  };

  const withTx = useCallback(
    async (label: string, fn: () => Promise<string>) => {
      const start = typeof performance !== "undefined" ? performance.now() : Date.now();
      let ok = false;
      let errorMsg: string | undefined;
      setBusy(label);
      setError(null);
      try {
        const sig = await fn();
        setLastSig(sig);
        pushToast({ title: label, description: shortPk(sig, 6) });
        ok = true;
      } catch (e: unknown) {
        console.error(e);
        errorMsg = formatError(e);
        if (
          (label === "Renew with buff" || label === "Renew") &&
          errorMsg.includes("Rig buff cap exceeded")
        ) {
          errorMsg =
            "Max rig buff reached (+15% HP). You can still renew this rig, but further buffs won't apply.";
        }
        setError(errorMsg);
      } finally {
        setBusy(null);
        const durationMs =
          (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
        void sendTelemetry({
          kind: "tx",
          action: mapTxAction(label),
          ok,
          durationMs,
        });
        if (!ok && errorMsg) {
          void sendTelemetry({ kind: "app_error", message: errorMsg });
        }
        await refresh();
      }
    },
    [pushToast, refresh]
  );

  const onBuy = async () => {
    if (!anchorWallet || !publicKey || !config) return;
    const program = getProgram(connection, anchorWallet);
    const nextIndex = userProfile?.nextPositionIndex ?? BigInt(positions.length);
    const positionIndex = new BN(nextIndex.toString());
    await withTx("Buy contract", async () => {
      const sig = await program.methods
        .buyContract(contract.key, positionIndex)
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          userProfile: deriveUserProfilePda(publicKey),
          position: derivePositionPda(publicKey, nextIndex),
          stakingRewardVault: config.stakingRewardVault,
          treasuryVault: config.treasuryVault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      return sig;
    });
  };

  const onClaimAll = useCallback(async () => {
    if (busy != null) return { executed: false, failedPositions: [] as string[] };
    if (!anchorWallet || !publicKey || !config) {
      return { executed: false, failedPositions: [] as string[] };
    }
    const claimTargets = pendingPositions.filter((entry) => entry.pending > 0n);
    if (claimTargets.length === 0) {
      return { executed: false, failedPositions: [] as string[] };
    }
    const failedPositions: string[] = [];
    let hadSuccess = false;
    await withTx("Claim all rigs", async () => {
      const { ata, ix } = await ensureAta(publicKey, config.mindMint);
      const program = getProgram(connection, anchorWallet);
      const MAX_INSTRUCTIONS = 6;
      const claimChunks: Array<{ tx: Transaction; positions: string[] }> = [];
      for (let i = 0; i < claimTargets.length; i += MAX_INSTRUCTIONS) {
        const chunk = claimTargets.slice(i, i + MAX_INSTRUCTIONS);
        const tx = new Transaction();
        if (ix && i === 0) tx.add(ix);
        for (const entry of chunk) {
          const instruction = await program.methods
            .claimMind()
            .accounts({
              owner: publicKey,
              config: deriveConfigPda(),
              userProfile: deriveUserProfilePda(publicKey),
              position: new PublicKey(entry.position.pubkey),
              vaultAuthority: deriveVaultPda(),
              mindMint: config.mindMint,
              userMindAta: ata,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .instruction();
          tx.add(instruction);
        }
        claimChunks.push({ tx, positions: chunk.map((entry) => entry.position.pubkey) });
      }
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      for (const chunk of claimChunks) {
        chunk.tx.recentBlockhash = blockhash;
        chunk.tx.feePayer = publicKey;
      }
      let sentSig = "";
      if (signAllTransactions) {
        const signed = await signAllTransactions(claimChunks.map((entry) => entry.tx));
        for (let i = 0; i < signed.length; i++) {
          try {
            const sig = await connection.sendRawTransaction(signed[i].serialize(), {
              skipPreflight: false,
            });
            await connection.confirmTransaction({
              signature: sig,
              blockhash,
              lastValidBlockHeight,
            });
            hadSuccess = true;
            sentSig = sig;
          } catch (err) {
            const failed = claimChunks[i]?.positions ?? [];
            failedPositions.push(...failed);
            console.warn("Claim failed for rigs", failed, err);
          }
        }
      } else {
        for (const chunk of claimChunks) {
          try {
            sentSig = await program.provider.sendAndConfirm(chunk.tx, []);
            hadSuccess = true;
          } catch (err) {
            failedPositions.push(...chunk.positions);
            console.warn("Claim failed for rigs", chunk.positions, err);
          }
        }
      }
      if (!hadSuccess) {
        throw new Error("Claim failed for all rigs.");
      }
      return sentSig;
    });
    return { executed: hadSuccess, failedPositions };
  }, [anchorWallet, busy, connection, config, pendingPositions, publicKey, signAllTransactions, withTx]);

  const handleClaimToggle = useCallback(async () => {
    if (!config || !publicKey) return;
    const ata = getAssociatedTokenAddressSync(config.mindMint, publicKey);
    const before = await connection
      .getTokenAccountBalance(ata, "confirmed")
      .then((b) => BigInt(b.value.amount || "0"))
      .catch(() => 0n);
    const { executed, failedPositions } = await onClaimAll();
    if (failedPositions.length > 0) {
      setLastClaimFailures(failedPositions);
      if (executed) {
        pushToast({
          title: "Claimed with warnings",
          description: `${failedPositions.length} rig(s) failed to claim.`,
        });
      }
    } else if (executed) {
      setLastClaimFailures([]);
    }
    if (executed) {
      const after = await connection
        .getTokenAccountBalance(ata, "confirmed")
        .then((b) => BigInt(b.value.amount || "0"))
        .catch(() => 0n);
      const delta = after > before ? after - before : 0n;
      if (delta > 0n) {
        setLastClaimAmount(delta);
        const claimTs = nowTs ?? Math.floor(Date.now() / 1000);
        setLastClaimTs(claimTs);
        if (typeof window !== "undefined") {
          const key = `mining_v2_last_claim_${publicKey.toBase58()}`;
          window.localStorage.setItem(
            key,
            JSON.stringify({ amount: delta.toString(), ts: claimTs })
          );
        }
      }
      await refresh();
    }
  }, [config, connection, nowTs, onClaimAll, publicKey, pushToast, refresh]);
  const onRenewWithBuff = async (posPubkey: string) => {
    if (busy != null) return;
    if (!anchorWallet || !config || !publicKey || !rigBuffConfig) return;
    if (nowTs == null) {
      setError("Missing clock data. Refresh and try again.");
      return;
    }
    const program = getProgram(connection, anchorWallet);
    await withTx("Renew with buff", async () => {
      const { ata, ix } = await ensureAta(publicKey, config.mindMint);
      const tx = new Transaction();
      if (ix) tx.add(ix);
      const instruction = await program.methods
        .renewRigWithBuff()
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          rigBuffConfig: deriveRigBuffConfigPda(),
          userProfile: deriveUserProfilePda(publicKey),
          position: new PublicKey(posPubkey),
          stakingRewardVault: config.stakingRewardVault,
          treasuryVault: config.treasuryVault,
          mindMint: config.mindMint,
          ownerMindAta: ata,
          burnMindVault: rigBuffConfig.mindBurnVault,
          treasuryMindVault: rigBuffConfig.mindTreasuryVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      tx.add(instruction);
      return await program.provider.sendAndConfirm(tx, []);
    });
  };

  const onRenewStandard = async (posPubkey: string) => {
    if (busy != null) return;
    if (!anchorWallet || !config || !publicKey) return;
    if (nowTs == null) {
      setError("Missing clock data. Refresh and try again.");
      return;
    }
    const program = getProgram(connection, anchorWallet);
    await withTx("Renew", async () => {
      const sig = await program.methods
        .renewRig()
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          userProfile: deriveUserProfilePda(publicKey),
          position: new PublicKey(posPubkey),
          stakingRewardVault: config.stakingRewardVault,
          treasuryVault: config.treasuryVault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      return sig;
    });
  };

  const onStake = async () => {
    if (!anchorWallet || !publicKey || !config || !mintDecimals) return;
    let amountBase: bigint;
    try {
      amountBase = parseUiAmountToBase(stakeAmountUi, mintDecimals.mind);
    } catch (e: unknown) {
      setError(formatError(e));
      return;
    }
    if (amountBase <= 0n) return;
    if (amountBase > mindBalance) {
      setError("Insufficient MIND in wallet to stake that amount.");
      return;
    }
    const program = getProgram(connection, anchorWallet);
    await withTx("Stake MIND", async () => {
      const { ata, ix } = await ensureAta(publicKey, config.mindMint);
      const tx = new Transaction();
      if (ix) tx.add(ix);
      const sig = await program.methods
        .stakeMind(new BN(amountBase.toString()))
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          userProfile: deriveUserProfilePda(publicKey),
          userStake: deriveUserStakePda(publicKey),
          vaultAuthority: deriveVaultPda(),
          stakingMindVault: config.stakingMindVault,
          ownerMindAta: ata,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions(tx.instructions)
        .rpc();
      return sig;
    });
  };
  const onUnstake = async () => {
    if (!anchorWallet || !publicKey || !config || !mintDecimals) return;
    let amountBase: bigint;
    try {
      amountBase = parseUiAmountToBase(unstakeAmountUi, mintDecimals.mind);
    } catch (e: unknown) {
      setError(formatError(e));
      return;
    }
    if (amountBase <= 0n) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Unstake MIND", async () => {
      const { ata, ix } = await ensureAta(publicKey, config.mindMint);
      const tx = new Transaction();
      if (ix) tx.add(ix);
      const sig = await program.methods
        .unstakeMind(new BN(amountBase.toString()))
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          userStake: deriveUserStakePda(publicKey),
          vaultAuthority: deriveVaultPda(),
          stakingMindVault: config.stakingMindVault,
          mindMint: config.mindMint,
          ownerMindAta: ata,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions(tx.instructions)
        .rpc();
      return sig;
    });
  };

  const onClaimXnt = async () => {
    if (!anchorWallet || !publicKey || !config) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Claim XNT", async () => {
      const sig = await program.methods
        .claimXnt()
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          userProfile: deriveUserProfilePda(publicKey),
          userStake: deriveUserStakePda(publicKey),
          stakingRewardVault: config.stakingRewardVault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      return sig;
    });
  };

  const onClaimRipperSplit = async () => {
    if (busy != null) return;
    if (!anchorWallet || !publicKey || !config) return;
    if (finalPendingXnt === 0n) return;
    if (claimRipperAmount === 0n) {
      await onClaimXnt();
      return;
    }
    if (!ripperPool) {
      setError("Ripper pool is unavailable right now.");
      return;
    }
    const stakeLamports = claimRipperNet;
    if (stakeLamports === 0n) {
      await onClaimXnt();
      return;
    }
    const toLamportsNumber = (value: bigint) => {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Amount too large for transfer.");
      }
      return Number(value);
    };
    const feeLamports = claimRipperFee;
    const program = getProgram(connection, anchorWallet);
    await withTx("Claim + stake rXNT", async () => {
      const tx = new Transaction();
      const claimIx = await program.methods
        .claimXnt()
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          userProfile: deriveUserProfilePda(publicKey),
          userStake: deriveUserStakePda(publicKey),
          stakingRewardVault: config.stakingRewardVault,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      tx.add(claimIx);
      if (feeLamports > 0n) {
        tx.add(
          SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: config.stakingRewardVault,
            lamports: toLamportsNumber(feeLamports),
          })
        );
      }
      const { ata: rXntAta, ix: createRxtAtaIx } = await ensureAta(
        publicKey,
        ripperPool.poolMint
      );
      if (createRxtAtaIx) {
        tx.add(createRxtAtaIx);
      }
      const ripperFunding = Keypair.generate();
      tx.add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: ripperFunding.publicKey,
          lamports: toLamportsNumber(stakeLamports),
        })
      );
      const depositIx = createRipperDepositSolInstruction({
        stakePool: RIPPER_POOL_ADDRESS,
        withdrawAuthority: findRipperWithdrawAuthority(),
        reserveStake: ripperPool.reserveStake,
        fundingAccount: ripperFunding.publicKey,
        destinationPoolAccount: rXntAta,
        managerFeeAccount: ripperPool.managerFeeAccount,
        referralPoolAccount: rXntAta,
        poolMint: ripperPool.poolMint,
        lamports: stakeLamports,
        depositAuthority: ripperPool.solDepositAuthority,
      });
      tx.add(depositIx);
      tx.feePayer = publicKey;
      const sig = await program.provider.sendAndConfirm(tx, [ripperFunding]);
      return sig;
    });
  };

  const onLevelUp = async () => {
    if (!levelingEnabled) {
      setError(LEVELING_DISABLED_MESSAGE);
      return;
    }
    if (busy != null) return;
    if (!anchorWallet || !publicKey || !config || !userProfile) return;
    if (!canLevelUp) {
      setError("Not enough XP or MIND to level up yet.");
      return;
    }
    let levelCfg: Awaited<ReturnType<typeof fetchLevelConfig>>;
    try {
      levelCfg = await fetchLevelConfig(connection);
    } catch {
      setError("Leveling is not available yet. Ask an admin to initialize level config.");
      return;
    }
    await withTx("Level up", async () => {
      const program = getProgram(connection, anchorWallet);
      const { ata, ix } = await ensureAta(publicKey, config.mindMint);
      const levelUpIx = await program.methods
        .levelUp()
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          levelConfig: deriveLevelConfigPda(),
          mindMint: config.mindMint,
          userProfile: deriveUserProfilePda(publicKey),
          ownerMindAta: ata,
          burnMindVault: levelCfg.mindBurnVault,
          treasuryMindVault: levelCfg.mindTreasuryVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const tx = new Transaction();
      if (ix) tx.add(ix);
      tx.add(levelUpIx);
      return await program.provider.sendAndConfirm(tx, []);
    });
  };

  const buyDisabled = !canTransact || !config || Boolean(busy);
  const stakeDisabled =
    !canTransact || !config || !mintDecimals || Boolean(busy) || stakeAmountUi.trim() === "";
  const unstakeDisabled =
    !canTransact || !config || !mintDecimals || Boolean(busy) || unstakeAmountUi.trim() === "";
  const claimDisabled = !canTransact || !config || Boolean(busy);
  const claimSplitDisabled =
    !canTransact ||
    !config ||
    Boolean(busy) ||
    finalPendingXnt === 0n ||
    (claimRipperNet > 0n && !ripperPool);
  const claimSplitHint =
    claimRipperNet > 0n && !ripperPool
      ? "rXNT pool is unavailable right now."
      : "Claim rewards and optionally auto-stake to rXNT.";

  const progressionLabel = levelingEnabled ? `LVL ${userLevel}` : "Levels paused";

  return (
    <div className="min-h-screen bg-ink text-white">
      <TopBar progressionLabel={progressionLabel} />

      <main className="mx-auto max-w-6xl px-4 pb-24 pt-10">
        <div className="space-y-4">
          <Card className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">
              What is happening right now?
            </div>
            <div className={`mt-2 text-sm font-semibold ${statusAccentClass}`}>{miningStatusText}</div>
          </Card>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-4">
              <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-400">Your HP</div>
              <div className="mt-2 text-3xl font-semibold text-white" data-testid="your-hp">
                {hpFinalLabel} HP
              </div>
              <div className="mt-3 space-y-1 text-[11px] text-zinc-400">
                <div className="flex items-center justify-between">
                  <span>Base HP</span>
                  <span className="text-zinc-200" data-testid="your-base-hp">
                    {baseHpLabel}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
                    Rig buffs
                  </span>
                  <span className="text-emerald-200" data-testid="your-rig-buffs">
                    +{rigBuffBonusLabel} HP (+{rigBuffPct.toFixed(1)}%)
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
                    Account bonus
                  </span>
                  <span className="text-emerald-200" data-testid="your-account-bonus">
                    +{accountBonusLabel} HP (+{accountBonusPct.toFixed(1)}%)
                  </span>
                </div>
              </div>
              <div
                className="mt-3 rounded-xl border border-white/10 bg-black/30 p-2"
                title="Rig buffs can increase your total HP by up to +15%. Your account level bonus is applied on top of that separate cap."
              >
                <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                  <span>Rig buff cap</span>
                  <span>
                    {rigBuffPct.toFixed(1)}% / {rigBuffCapPct.toFixed(1)}%
                  </span>
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-white/10">
                  <div
                    className="h-1.5 rounded-full bg-emerald-300/70 shadow-[0_0_10px_rgba(16,185,129,0.6)]"
                    style={{ width: `${rigBuffCapProgress}%` }}
                  />
                </div>
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-400">Network HP</div>
              <div className="mt-2 text-3xl font-semibold text-white" data-testid="network-hp">
                {formatFixed2(networkHpHundredths)} HP
              </div>
              <div className="mt-3 space-y-1 text-[11px] text-zinc-400">
                <div className="flex items-center justify-between">
                  <span>Base HP</span>
                  <span className="text-zinc-200" data-testid="network-base-hp">
                    {hasNetworkBreakdown ? networkBaseHpLabel : "-"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
                    Account bonus
                  </span>
                  <span className="text-emerald-200" data-testid="network-account-bonus">
                    {hasNetworkBreakdown
                      ? `+${networkAccountBonusLabel} HP (+${networkAccountBonusPct.toFixed(1)}%)`
                      : "-"}
                  </span>
                </div>
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Your share</div>
              <div className="mt-3 flex items-baseline gap-1">
                <button
                  type="button"
                  onClick={() => setShowShareFull((prev) => !prev)}
                  title={`${shareTooltip} Click to toggle precision.`}
                  className="text-3xl font-semibold text-white transition hover:text-cyan-200 focus:outline-none"
                  data-testid="your-share"
                >
                  {showShareFull ? sharePctFull.toFixed(4) : sharePct.toFixed(2)}
                </button>
                <span className="text-sm uppercase tracking-[0.2em] text-zinc-500">%</span>
              </div>
              <div className="mt-2 text-xs text-zinc-500">{shareTooltip}</div>
            </Card>
            <Card className="p-4">
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Est. MIND/day</div>
              <div className="mt-3 text-3xl font-semibold text-white">
                {config && mintDecimals ? formatRoundedToken(estUserPerDay, mintDecimals.mind) : "-"}
              </div>
              <div className="text-xs text-zinc-500">Pro-rata based on share</div>
              {estUserPerDay > 0n && mintDecimals ? (
                <div className="mt-2 space-y-1 text-[11px] text-zinc-500">
                  <div>≈ {accrualPerHourValue}</div>
                  <div>≈ {accrualPerMinuteValue}</div>
                </div>
              ) : null}
            </Card>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="lg:col-span-2 border border-emerald-500/30 bg-emerald-500/5 p-4">
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Claimable MIND</div>
              {showLastClaim ? (
                <div className="mt-3">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-emerald-200">
                    Last claimed
                  </div>
                <div className="mt-2 text-4xl font-semibold text-emerald-200">
                  {lastClaimRounded} MIND
                </div>
                {lastClaimAgo ? (
                  <div className="mt-1 text-[11px] text-zinc-500">Claimed {lastClaimAgo} ago</div>
                ) : null}
              </div>
            ) : null}
              {showClaimableAmount ? (
                <div className="mt-3 flex items-baseline gap-1">
                  <button
                    type="button"
                    onClick={() => setShowClaimableFull((prev) => !prev)}
                    title={
                      mintDecimals
                        ? `Click for full precision (${claimableFull} MIND)`
                        : "Connect wallet to see amount"
                    }
                    className="text-3xl font-semibold text-emerald-300 transition hover:text-emerald-100 focus:outline-none"
                  >
                    {mintDecimals ? (showClaimableFull ? claimableFull : claimableRounded) : "-"}
                  </button>
                  <span className="text-lg text-emerald-200">MIND</span>
                </div>
              ) : null}
              <div className="mt-2 text-xs text-zinc-400">{claimableHint}</div>
              {networkHp === 0n ? (
                <div className="mt-2 text-[11px] text-amber-200">
                  Accrual paused — no active miners
                </div>
              ) : estUserPerDay > 0n && mintDecimals ? (
                <div className="mt-2 text-[11px] text-zinc-500">
                  Accruing now: {accrualPerSecValue}
                </div>
              ) : null}
            </Card>
            <Card className="p-4">
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">In wallet</div>
              <div className="mt-3 flex items-baseline gap-1">
                <span
                  className="text-3xl font-semibold text-white"
                  title={mintDecimals ? `Full precision: ${walletFull} MIND` : undefined}
                >
                  {mintDecimals ? walletRounded : "-"}
                </span>
                <span className="text-lg text-zinc-400">MIND</span>
              </div>
              <div className="mt-2 text-xs text-zinc-500">
                {mintDecimals ? "Hover or tap to copy full precision" : "Connect wallet to see balances"}
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Today's emission</div>
              <div className="mt-3 flex items-baseline gap-2">
                <button
                  type="button"
                  onClick={() => setShowEmissionFull((prev) => !prev)}
                  title={
                    mintDecimals
                      ? `Toggle precision (${emissionFull} MIND so far)`
                      : "Connect wallet to see live emission"
                  }
                  className="text-3xl font-semibold text-white transition hover:text-cyan-200 focus:outline-none"
                >
                  {mintDecimals ? (showEmissionFull ? emissionFull : emissionRounded) : "-"}
                </button>
                <span className="text-sm text-zinc-500">/ {emissionTargetRounded} MIND</span>
              </div>
              <div className="mt-2 text-xs text-zinc-500" title="Resets every 24h">
                Resets every 24h
              </div>
            </Card>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-zinc-400">
            <Badge variant="muted">Max HP: {config?.maxEffectiveHp.toString() ?? "-"}</Badge>
            <Badge variant="muted">
              Emission/day:{" "}
              {config && mintDecimals
                ? formatRoundedToken(emissionPerDay, mintDecimals.mind)
                : "-"}
            </Badge>
            <Badge variant="muted">
              Active miners: Unique addresses: {activeMinerTotal} | Active rigs: {activeRigTotal}
            </Badge>
            <Badge variant="muted">Reward pool: {rewardPoolBadge} XNT</Badge>
            <Badge variant="muted">
              Total staked: {totalStakedBadge} MIND{stakingShareLabel}
            </Badge>
          </div>
        </div>

        <section className="mt-10 grid gap-6 lg:grid-cols-[2fr_1fr]">
          <Card className="border-cyan-400/20 bg-ink/90 p-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Buy hashpower</div>
                <div className="mt-2 text-2xl font-semibold">Choose a rig</div>
              </div>
              <Badge
                variant="muted"
                title="Fairness limit — prevents a single wallet from dominating the network."
              >
                HP limit: {config?.maxEffectiveHp.toString() ?? "-"}
              </Badge>
            </div>

            <div ref={rigCardsRef} className="mt-5 grid gap-3 md:grid-cols-3">
              {RIG_PLANS.map((plan, idx) => {
                const maxBuffPctLabel = (plan.maxBuffPercent * 100).toFixed(1);
                const maxBuffHpLabel = getMaxBuffHp(plan).toFixed(2);
                const isExpanded = openRigDetails === plan.type;
                return (
                  <div
                    key={plan.type}
                    data-rig-card
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setSelectedContract(idx);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedContract(idx);
                      }
                    }}
                    className={[
                      "rounded-2xl border px-4 py-3 text-left text-xs transition",
                      selectedContract === idx
                        ? "border-cyan-300/50 bg-cyan-300/10 text-white"
                        : "border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10",
                    ].join(" ")}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-white">
                        {plan.label}{" "}
                        <span className="text-[11px] text-zinc-400">· {plan.durationDays} days</span>
                      </div>
                      <button
                        type="button"
                        data-rig-details-toggle
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedContract(idx);
                          setOpenRigDetails((prev) => (prev === plan.type ? null : plan.type));
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded-full border border-white/10 text-[11px] text-zinc-400 hover:border-cyan-300/40 hover:text-white"
                        aria-label={`Details for ${plan.label}`}
                        aria-expanded={isExpanded}
                      >
                        i
                      </button>
                    </div>
                    <div className="mt-2 text-sm font-semibold text-white">
                      {plan.baseHp} HP <span className="text-zinc-500">•</span> {plan.costXnt} XNT
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500">
                      {RIG_STYLE_SUMMARY[plan.type]}
                    </div>
                    {isExpanded ? (
                      <div className="mt-3 border-t border-white/10 pt-3 text-[11px] text-zinc-400">
                        <div>
                          <span className="text-zinc-500">Best for:</span> {RIG_BEST_FOR[plan.type]}
                        </div>
                        <div className="mt-2">
                          <span className="text-zinc-500">Long-term potential:</span> Up to +
                          {maxBuffPctLabel}% permanent HP boost.
                        </div>
                        <div className="mt-1 text-zinc-500">
                          At max buffs: ~{maxBuffHpLabel} HP.
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
              <span>Choose the plan that fits your strategy. You can start multiple rigs.</span>
              <button
                type="button"
                onClick={() => setShowRigInfoModal(true)}
                className="text-xs text-cyan-200 hover:text-cyan-100"
              >
                Learn how rigs &amp; buffs work
              </button>
            </div>

            <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Selected</div>
              <div className="mt-3 space-y-2 text-sm font-medium text-white">
                <div>Hashpower: {selectedPlan.baseHp} HP</div>
                <div>Duration: {selectedPlan.durationDays} days</div>
                <div>Cost: {selectedPlan.costXnt} XNT</div>
              </div>
              <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3">
                <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                  Long-term projection
                </div>
                <div className="mt-1 text-sm text-white">
                  With max buffs: ~{selectedMaxBuffHpLabel} HP
                </div>
                <div
                  className="mt-1 text-[11px] text-zinc-500"
                  title="This is a simple projection using the maximum buff for this rig type. Actual growth depends on how often you renew with buffs."
                >
                  Estimate with max buffs.
                </div>
              </div>
              <div className="mt-3 text-xs text-zinc-500" title={hashpowerTooltip}>
                Hashpower gives you a share of daily emission. Your share changes if the network hashpower changes.
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button size="lg" className="h-12" onClick={() => void onBuy()} disabled={buyDisabled}>
                  {busy === "Buy contract" ? "Submitting..." : "Start mining"}
                </Button>
                <Button
                  size="lg"
                  variant="secondary"
                  className="h-12"
                  onClick={() => {
                    window.open(
                      "https://app.xdex.xyz/swap?fromTokenAddress=111111111111111111111111111111111111111111&toTokenAddress=DohWBfvXER6qs8zFGtdZRDpgbHmm97ZZwgCUTCdtHQNT",
                      "_blank",
                      "noopener,noreferrer"
                    );
                  }}
                >
                  Buy MIND
                </Button>
              </div>
            </div>

            {showRigInfoModal ? (
              <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
                <button
                  type="button"
                  className="absolute inset-0 bg-black/70 backdrop-blur-sm"
                  onClick={() => setShowRigInfoModal(false)}
                  aria-label="Close rig info"
                />
                <div className="relative w-full max-w-3xl overflow-hidden rounded-3xl border border-cyan-300/20 bg-ink/95 shadow-[0_0_40px_rgba(34,242,255,0.15)] backdrop-blur-xl">
                  <button
                    type="button"
                    onClick={() => setShowRigInfoModal(false)}
                    className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full border border-white/10 text-xs text-zinc-300 hover:border-cyan-300/40 hover:text-white"
                    aria-label="Close"
                  >
                    X
                  </button>
                  <div className="max-h-[80vh] overflow-y-auto p-5">
                    <div className="text-sm font-semibold text-white">Rigs &amp; buffs</div>
                    <div className="mt-1 text-xs text-zinc-400">
                      Compare plans, see how buffs stack, and pick the best playstyle for you.
                    </div>

                    <div className="mt-4 space-y-4">
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <div className="text-sm font-semibold text-white">Compare plans</div>
                        <div className="mt-1 text-xs text-zinc-500">{RISK_HELPER_TEXT}</div>

                        <div className="mt-4 hidden md:block">
                          <div className="grid grid-cols-6 gap-3 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                            <div>Rig</div>
                            <div>Base HP</div>
                            <div>Max buff</div>
                            <div>Cycle length</div>
                            <div title={RISK_HELPER_TEXT}>Risk</div>
                            <div>Style</div>
                          </div>
                          <div className="mt-2 space-y-2">
                            {RIG_COMPARE_ROWS.map((row) => (
                              <div
                                key={row.plan.type}
                                className="grid grid-cols-6 gap-3 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-300"
                              >
                                <div className="font-semibold text-white">{row.plan.label}</div>
                                <div>{row.plan.baseHp} HP</div>
                                <div>+{(row.plan.maxBuffPercent * 100).toFixed(1)}%</div>
                                <div>{row.plan.durationDays} days</div>
                                <div className="flex items-center gap-2">
                                  <div className="flex items-center gap-1">
                                    {Array.from({ length: 5 }, (_, idx) => (
                                      <span
                                        key={idx}
                                        className={`h-1.5 w-1.5 rounded-full ${
                                          idx < row.riskDots ? "bg-cyan-300" : "bg-white/10"
                                        }`}
                                      />
                                    ))}
                                  </div>
                                  <span className="text-[11px] text-zinc-500">{row.riskLabel}</span>
                                </div>
                                <div className="text-zinc-400">{row.style}</div>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="mt-4 grid gap-3 md:hidden">
                          {RIG_COMPARE_ROWS.map((row) => (
                            <div
                              key={row.plan.type}
                              className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-zinc-300"
                            >
                              <div className="text-sm font-semibold text-white">{row.plan.label}</div>
                              <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-zinc-400">
                                <div>Base HP</div>
                                <div className="text-zinc-200">{row.plan.baseHp} HP</div>
                                <div>Max buff</div>
                                <div className="text-zinc-200">
                                  +{(row.plan.maxBuffPercent * 100).toFixed(1)}%
                                </div>
                                <div>Cycle length</div>
                                <div className="text-zinc-200">{row.plan.durationDays} days</div>
                                <div>Style</div>
                                <div className="text-zinc-200">{row.style}</div>
                              </div>
                              <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-400">
                                <span title={RISK_HELPER_TEXT}>Risk</span>
                                <div className="flex items-center gap-2">
                                  <div className="flex items-center gap-1">
                                    {Array.from({ length: 5 }, (_, idx) => (
                                      <span
                                        key={idx}
                                        className={`h-1.5 w-1.5 rounded-full ${
                                          idx < row.riskDots ? "bg-cyan-300" : "bg-white/10"
                                        }`}
                                      />
                                    ))}
                                  </div>
                                  <span className="text-zinc-500">{row.riskLabel}</span>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <div className="text-sm font-semibold text-white">How rigs grow over time</div>
                        <div className="mt-1 text-xs text-zinc-500">
                          When you renew your rig, you can optionally add a buff. Buffs slightly increase
                          that rig&apos;s HP and stack over time, up to its maximum boost.
                        </div>
                        <ul className="mt-3 space-y-2 text-xs text-zinc-300">
                          {growthExamples.map((example) => (
                            <li key={example.key}>
                              {example.label}: {example.baseLabel} → ~{example.maxLabel} HP at max buffs.
                            </li>
                          ))}
                        </ul>
                        <div className="mt-3 text-[11px] text-zinc-500">
                          Buffs always apply from the next cycle to keep rewards fair.
                        </div>
                      </div>

                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <div className="text-sm font-semibold text-white">Pick based on your playstyle</div>
                        <div className="mt-3 grid gap-3 md:grid-cols-3">
                          {PLAYSTYLE_HINTS.map((hint) => (
                            <div
                              key={hint.title}
                              className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-zinc-300"
                            >
                              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                                {hint.title}
                              </div>
                              <div className="mt-2 text-sm font-semibold text-white">
                                Recommend: {hint.recommend}
                              </div>
                              <ul className="mt-2 space-y-1 text-[11px] text-zinc-400">
                                {hint.bullets.map((bullet) => (
                                  <li key={bullet}>• {bullet}</li>
                                ))}
                              </ul>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </Card>

          <Card className="border-cyan-400/20 bg-ink/90 p-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Your rigs</div>
                <div className="mt-1 text-[11px] text-zinc-500">
                  Soonest contract expires in{" "}
                  {soonestContractExpiresIn != null ? formatDurationSeconds(soonestContractExpiresIn) : "-"}
                </div>
              </div>
              <div className="mt-4">
                <Button
                  size="sm"
                  onClick={() => void handleClaimToggle()}
                  disabled={claimDisabled}
                  className="text-[11px]"
                  title="Collect all unclaimed MIND from your active rigs."
                >
                  {busy === "Claim all rigs" ? "Claiming..." : "Start Claim"}
                </Button>
              </div>
            </div>
            {lastClaimFailures.length > 0 ? (
              <div
                className="mt-2 text-[11px] text-amber-200"
                title={lastClaimFailures.join(", ")}
              >
                Failed to claim: {lastClaimFailures.map((pk) => shortPk(pk, 4)).join(", ")}
              </div>
            ) : null}
            <div className="mt-4 grid max-h-[260px] gap-3 overflow-y-auto pr-2 sm:max-h-[440px]">
              {visiblePositions.length === 0 ? (
                <div className="text-xs text-zinc-500">No positions yet.</div>
              ) : (
                visiblePositions.map((entry) => {
                  const p = entry.position;
                  const now = nowTs ?? null;
                  const remaining = now != null ? Math.max(0, p.data.endTs - now) : null;
                  const expired = now != null && now >= p.data.endTs;
                  const graceEnds = p.data.endTs + graceSeconds;
                  const inGrace = !p.data.deactivated && expired && now != null && now <= graceEnds;
                  const afterGrace = !p.data.deactivated && expired && now != null && now > graceEnds;
                  if (afterGrace) return null;
                  const bonusMultiplier = BPS_DENOMINATOR + levelBonusBpsBig;
                  const rigType = p.data.hpScaled
                    ? p.data.rigType
                    : rigTypeFromDuration(
                        p.data.startTs,
                        p.data.endTs,
                        secondsPerDayUi
                      );
                  const rigKind = rigTypeKey(rigType);
                  const rigPosition: RigPosition = {
                    type: rigKind,
                    buffLevel: p.data.buffLevel,
                    buffAppliedFromCycle: Number(p.data.buffAppliedFromCycle),
                    expiresAtTs: p.data.endTs,
                    baseHpHundredths: p.data.hp,
                  };
                  const buffBpsBase = rigBuffBps(rigType, p.data.buffLevel);
                  const buffPctLabel =
                    buffBpsBase > 0
                      ? `+${(buffBpsBase / 100).toLocaleString("en-US", {
                          minimumFractionDigits: 1,
                          maximumFractionDigits: 1,
                        })}%`
                      : null;
                  const buffEligible = !p.data.deactivated && !expired;
                  const buffActive =
                    buffEligible &&
                    p.data.buffLevel > 0 &&
                    (p.data.buffAppliedFromCycle === 0n ||
                      (now != null && BigInt(now) >= p.data.buffAppliedFromCycle));
                  const buffScheduled =
                    buffEligible &&
                    p.data.buffLevel > 0 &&
                    p.data.buffAppliedFromCycle > 0n &&
                    (now == null || BigInt(now) < p.data.buffAppliedFromCycle);
                  const buffStatusLabel = buffActive && buffPctLabel
                    ? `ACTIVE • L${p.data.buffLevel} (${buffPctLabel})`
                    : buffScheduled && buffPctLabel
                    ? `NEXT CYCLE • L${p.data.buffLevel} (${buffPctLabel})`
                    : "NO BUFF";
                  const buffStatusClass = buffActive
                    ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
                    : buffScheduled
                    ? "border-amber-400/30 bg-amber-500/10 text-amber-200"
                    : "border-white/10 bg-white/5 text-zinc-400";
                  const buffDotClass = buffActive
                    ? "bg-emerald-400"
                    : buffScheduled
                    ? "bg-amber-300"
                    : "bg-zinc-500";
                  const buffBps = buffActive ? BigInt(buffBpsBase) : 0n;
                  const baseHp = p.data.hp;
                  const hpWithBuff = (baseHp * (BPS_DENOMINATOR + buffBps)) / BPS_DENOMINATOR;
                  const positionHpEffective = (hpWithBuff * bonusMultiplier) / BPS_DENOMINATOR;
                  const positionRateHp =
                    p.data.deactivated || expired ? 0n : positionHpEffective;
                  const timeLine = expired
                    ? "Expired"
                    : `Ends in: ${remaining == null ? "-" : formatDurationSeconds(remaining)}`;
                  const timeClass = expired
                    ? inGrace
                      ? "text-amber-300"
                      : "text-zinc-500"
                    : "text-zinc-400";
                  const graceLeftLabel =
                    inGrace && now != null
                      ? formatDurationSeconds(Math.max(0, graceEnds - now))
                      : null;
                  const buffPendingIn =
                    buffScheduled && now != null
                      ? formatDurationSeconds(
                          Number(p.data.buffAppliedFromCycle - BigInt(now))
                        )
                      : null;
                  const canRenewStandard = inGrace;
                  const canRenewWithBuff =
                    inGrace || (remaining != null && remaining <= renewWindowSeconds);
                  const showRenew = canRenewStandard || canRenewWithBuff;
                  const contractMeta = CONTRACTS[rigType] ?? CONTRACTS[0];
                  const maxBuffLevel = rigMaxBuffLevel(rigType);
                  const nextBuffLevel =
                    p.data.buffLevel < maxBuffLevel ? p.data.buffLevel + 1 : p.data.buffLevel;
                  const hasNextBuffLevel = nextBuffLevel > p.data.buffLevel;
                  const buffBpsCurrent = rigBuffBps(rigType, p.data.buffLevel);
                  const buffBpsNext = rigBuffBps(rigType, nextBuffLevel);
                  const buffIncreaseBps = Math.max(0, buffBpsNext - buffBpsCurrent);
                  const buffIncreaseLabel = hasNextBuffLevel
                    ? `+${(buffIncreaseBps / 100).toFixed(1)}%`
                    : null;
                  const hpNow =
                    now != null && buffEligible ? getRigEffectiveHpNow(rigPosition, now) : 0;
                  const hpNext = buffEligible ? getRigEffectiveHpNextCycle(rigPosition) : 0;
                  const hpNowLabel = hpNow != null ? formatFixed2Number(hpNow) : "-";
                  const hpNextLabel = formatFixed2Number(hpNext);
                  const hpNextWithoutLabel = formatFixed2Number(hpNext);
                  const hpNextWithUpgrade =
                    (BASE_HP_BY_TYPE[rigKind] ?? 0) * (10_000 + buffBpsNext) / 10_000;
                  const hpNextWithLabel = formatFixed2Number(hpNextWithUpgrade);
                  const mindPerHpPerDayUi =
                    rigBuffConfig && mintDecimals
                      ? Number(
                          formatTokenAmount(
                            rigBuffConfig.mindPerHpPerDay,
                            mintDecimals.mind,
                            Math.min(mintDecimals.mind, 8)
                          )
                        )
                      : null;
                  const extraHpUi = hasNextBuffLevel
                    ? ((BASE_HP_BY_TYPE[rigKind] ?? 0) * (buffBpsNext - buffBpsCurrent)) / 10_000
                    : 0;
                  const extraYieldUi =
                    mindPerHpPerDayUi != null
                      ? extraHpUi * mindPerHpPerDayUi * contractMeta.durationDays
                      : null;
                  const extraYieldLabel =
                    extraYieldUi != null
                      ? formatTokenDynamicUi(extraYieldUi)
                      : "-";
                  const buffLevelProgress =
                    maxBuffLevel > 0
                      ? Math.min(100, (p.data.buffLevel / maxBuffLevel) * 100)
                      : 0;
                  const buffLevelBreakdown =
                    maxBuffLevel > 0
                      ? Array.from({ length: maxBuffLevel }, (_, idx) => {
                          const level = idx + 1;
                          const bps = rigBuffBps(rigType, level);
                          const pct = (bps / 100).toFixed(1);
                          return `L${level} +${pct}%`;
                        }).join(" • ")
                      : null;
                  const buffCountdownLabel =
                    graceLeftLabel != null ? `${graceLeftLabel} left` : null;
                  const buffButtonLabel = rigBuffCapReached
                    ? "Buff cap reached"
                    : hasNextBuffLevel
                    ? `Renew + Buff${
                        buffIncreaseLabel ? ` (${buffIncreaseLabel})` : ""
                      }${buffCountdownLabel ? ` • ${buffCountdownLabel}` : ""}`
                    : "Max buff reached";
                  const buffDisabled =
                    busy != null ||
                    !canRenewWithBuff ||
                    rigBuffCapReached ||
                    !rigBuffConfig ||
                    !mintDecimals ||
                    !hasNextBuffLevel;
                  const standardDisabled = busy != null || !canRenewStandard;
                  const ratePerHour =
                    networkHpHundredths > 0n
                      ? ((config?.emissionPerSec ?? 0n) * 3_600n * positionRateHp) /
                        networkHpHundredths
                      : null;
                  const ratePerDay =
                    networkHpHundredths > 0n
                      ? ((config?.emissionPerSec ?? 0n) *
                          BigInt(secondsPerDayUi) *
                          positionRateHp) /
                        networkHpHundredths
                      : null;
                  const ratePerCycle =
                    networkHpHundredths > 0n
                      ? ((config?.emissionPerSec ?? 0n) *
                          BigInt(secondsPerDayUi) *
                          BigInt(contractMeta.durationDays) *
                          positionRateHp) /
                        networkHpHundredths
                      : null;
                  return (
                    <div key={p.pubkey} className="rounded-2xl border border-white/10 bg-white/5 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm font-semibold text-white">
                          {contractMeta.label}{" "}
                          <span className="text-xs text-zinc-500">• #{shortPk(p.pubkey, 4)}</span>
                        </div>
                        <span
                          className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.2em] ${buffStatusClass}`}
                        >
                          <span className={`h-2 w-2 rounded-full ${buffDotClass}`} />
                          {buffStatusLabel}
                        </span>
                      </div>
                      <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3">
                        <div className="flex items-center justify-between text-[11px] text-zinc-400">
                          <span>HP this cycle</span>
                          <span className="text-sm font-semibold text-white">
                            {hpNowLabel} HP
                          </span>
                        </div>
                        <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-400">
                          <span>HP next cycle</span>
                          <span
                            className={`text-sm font-semibold ${
                              buffScheduled ? "text-emerald-200" : "text-zinc-200"
                            }`}
                          >
                            {hpNextLabel} HP
                          </span>
                        </div>
                        {maxBuffLevel > 0 ? (
                          <div className="mt-2">
                            <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                              <span>Buff level</span>
                              <span>
                                L{p.data.buffLevel} / L{maxBuffLevel}
                              </span>
                            </div>
                          <div className="mt-1 h-1 rounded-full bg-white/10">
                            <div
                              className="h-1 rounded-full bg-cyan-300/70"
                              style={{ width: `${buffLevelProgress}%` }}
                            />
                          </div>
                          {buffLevelBreakdown ? (
                            <div className="mt-2 text-[10px] uppercase tracking-[0.2em] text-zinc-600">
                              {buffLevelBreakdown}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      </div>
                      <div className={`mt-2 text-xs ${timeClass}`} title={expiryTooltip}>
                        {timeLine}
                      </div>
                      {inGrace && graceLeftLabel ? (
                        <div className="mt-1 text-[11px] text-amber-300">
                          In grace: {graceLeftLabel} left to renew
                        </div>
                      ) : null}
                      {buffScheduled ? (
                        <div className="mt-1 text-[11px] text-amber-200">
                          Locked for next cycle{buffPendingIn ? ` • ${buffPendingIn}` : ""}
                        </div>
                      ) : null}
                      {mintDecimals ? (
                        <div
                          className="mt-2 text-[11px] text-zinc-500"
                          title="Includes rig bonus and account XP bonus."
                        >
                          {networkHpHundredths > 0n && ratePerHour != null && ratePerDay != null && ratePerCycle != null ? (
                            <>
                              <div>
                                Current rate: {formatRoundedToken(ratePerHour, mintDecimals.mind)} MIND / h
                              </div>
                              <div>≈ {formatRoundedToken(ratePerDay, mintDecimals.mind)} MIND / 24h</div>
                              <div>
                                ≈ {formatRoundedToken(ratePerCycle, mintDecimals.mind)} MIND / cycle
                              </div>
                            </>
                          ) : (
                            <div>Rate unavailable</div>
                          )}
                        </div>
                      ) : null}
                      {showRenew ? (
                        <div className="mt-3 rounded-xl border border-white/10 bg-white/5 p-3">
                          <div className="text-[11px] text-zinc-300">
                            Boost your rig for the next cycle.
                          </div>
                          {graceLeftLabel ? (
                            <div className="mt-1 text-[11px] text-zinc-500">
                              Grace left to renew: {graceLeftLabel}
                            </div>
                          ) : null}
                          <div className="mt-3 grid gap-2">
                            <Button
                              size="sm"
                              className="w-full"
                              variant="secondary"
                              onClick={() => void onRenewStandard(p.pubkey)}
                              disabled={standardDisabled}
                              title={
                                canRenewStandard
                                  ? "Available during grace. Applies the next rig buff level if available."
                                  : "Available during grace only."
                              }
                            >
                              {busy === "Renew" ? "Submitting..." : "Renew (grace)"}
                            </Button>
                            <Button
                              size="sm"
                              className="w-full"
                              onClick={() => void onRenewWithBuff(p.pubkey)}
                              disabled={buffDisabled}
                              title={
                                rigBuffCapReached
                                  ? "Your global rig buff cap is reached."
                                  : !hasNextBuffLevel
                                  ? "This rig is already at max buff level."
                                  : !rigBuffConfig || !mintDecimals
                                  ? "Rig buff config is not initialized yet."
                                  : canRenewWithBuff
                                  ? "Applies from the next cycle."
                                  : "Available in the last 3 days or during grace."
                              }
                            >
                              {busy === "Renew with buff" ? "Submitting..." : buffButtonLabel}
                            </Button>
                          </div>
                          {hasNextBuffLevel ? (
                            <div className="mt-3 space-y-1 text-[11px] text-zinc-500">
                              <div>
                                HP next cycle: {hpNextWithoutLabel} → {hpNextWithLabel}
                              </div>
                              <div>Extra yield (est.): +{extraYieldLabel} MIND / cycle</div>
                            </div>
                          ) : (
                            <div className="mt-3 text-[11px] text-zinc-500">
                              Max buff level reached for this rig.
                            </div>
                          )}
                          {rigBuffCapReached ? (
                            <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                              Max rig buff reached (+{rigBuffCapPct.toFixed(1)}% HP). You can
                              still renew this rig, but further buffs won&apos;t apply.
                            </div>
                          ) : null}
                          <div className="mt-2 text-[11px] text-zinc-400">
                            Buffs always start from the next cycle to keep rewards fair.
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          </Card>
        </section>

        <section className="mt-10">
          <Card className="border-cyan-400/20 bg-ink/90 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Stats</div>
                <div className="text-xl font-semibold text-white">Protocol pulse</div>
                <div className="text-[11px] text-zinc-500">
                  Live on-chain reads; refresh cadence every 10 minutes.
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setStatsTab("payouts")}
                >
                  Payouts
                </Button>
              </div>
            </div>

            {statsTab === "payouts" ? (
              <div className="mt-6 grid gap-4 md:grid-cols-3 xl:grid-cols-4">
                <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                    Total paid out
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-white">
                    {claimStats
                      ? `${Number(claimStats.totalXnt).toFixed(2)} XNT`
                      : claimStatsError
                      ? "—"
                      : "…"}
                  </div>
                  {claimStats?.updatedAt ? (
                    <div className="mt-1 text-[11px] text-zinc-500">
                      Updated {new Date(claimStats.updatedAt).toLocaleTimeString()}
                    </div>
                  ) : null}
                    {claimStatsError ? (
                      <div className="mt-1 text-[11px] text-amber-300">{claimStatsError}</div>
                    ) : null}
                  </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                    Active stakers
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-white">
                    {activeStakersSummary.unique ?? ACTIVE_STAKERS_SUMMARY.unique}
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">
                    Unique wallets with staked MIND.
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                    TVL (staked)
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-white">
                    {config && mintDecimals
                      ? `${formatTokenAmount(config.stakingTotalStakedMind, mintDecimals.mind, 1)} MIND`
                      : "—"}
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">
                    Current total MIND locked in staking.
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                    TVL (USD)
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-white">
                    {claimStats?.tvlUsd != null
                      ? `$${claimStats.tvlUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                      : "—"}
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                    Current staking APR
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-white">
                    {stakingAprPct != null ? `${stakingAprPct.toFixed(2)}%` : "—"}
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">
                    Based on on-chain reward rate vs total staked MIND.
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                    7d realized APR
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-white">
                    {claimStats?.apr7dPct != null ? `${claimStats.apr7dPct.toFixed(2)}%` : "—"}
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">
                    From last 7d XNT claims vs current staked base.
                  </div>
                </div>
              </div>
            ) : null}
          </Card>
        </section>

        <section className="mt-10 grid gap-6 lg:grid-cols-[1fr_1fr]">
          <Card className="border-emerald-400/20 bg-ink/90 p-6">
            <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Staking</div>
            <div className="mt-2 text-2xl font-semibold">Stake MIND → Earn XNT</div>
            <div className="mt-1 text-xs text-zinc-400">Rewards are funded from mining purchases.</div>
            <div className="mt-3 text-xs text-zinc-400">
              Claimable: {mintDecimals ? formatTokenAmount(finalPendingXnt, mintDecimals.xnt, 4) : "-"} XNT
            </div>
            <div className="mt-2 text-xs text-emerald-200">
              Total paid out:{" "}
              {claimStats ? `${claimStats.totalXnt} XNT` : claimStatsError ? "—" : "…"}
            </div>
            {claimStatsError ? (
              <div className="mt-1 text-[11px] text-amber-300">{claimStatsError}</div>
            ) : null}
            {!loading && mintDecimals && userStake?.stakedMind ? (
              userStake.stakedMind > 0n ? (
                <div className="mt-2 text-[11px] text-zinc-500">
                  Your staked: {formatRoundedToken(userStake.stakedMind, mintDecimals.mind, 2)} MIND
                </div>
              ) : null
            ) : null}
            <div className="text-[11px] text-zinc-500">
              Rewards accrue continuously. Your rewards depend on your share of the staking pool.
            </div>
            <div className="mt-4">
              <Input
                value={stakeAmountUi}
                onChange={setStakeAmountUi}
                placeholder="Amount to stake (MIND)"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setMindAmountFromPercent(mindBalance, setStakeAmountUi, 25)}
                  disabled={!hasMindBalance}
                  className={quickAmountButtonClass}
                >
                  25%
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setMindAmountFromPercent(mindBalance, setStakeAmountUi, 50)}
                  disabled={!hasMindBalance}
                  className={quickAmountButtonClass}
                >
                  50%
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setMindAmountFromPercent(mindBalance, setStakeAmountUi, 75)}
                  disabled={!hasMindBalance}
                  className={quickAmountButtonClass}
                >
                  75%
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setMindAmountFromPercent(mindBalance, setStakeAmountUi, 100)}
                  disabled={!hasMindBalance}
                  className={quickAmountButtonClass}
                  >
                    MAX
                  </Button>
                </div>
                {stakeAmountUi.trim() !== "" && mintDecimals ? (
                  <div className="mt-2 space-y-1 text-xs">
                    <div className="text-zinc-400">Estimated for this stake: {predictedStakeLabel}</div>
                    {stakeAmountExceedsBalance ? (
                      <div className="text-amber-300">
                        Amount exceeds your wallet balance ({formatRoundedToken(mindBalance, mintDecimals.mind)} MIND).
                      </div>
                    ) : null}
                  </div>
                ) : null}
              <Button
                className="mt-3"
                onClick={() => void onStake()}
                disabled={stakeDisabled}
              >
                {busy === "Stake MIND" ? "Submitting..." : "Stake"}
              </Button>
              <div className="mt-2 text-[11px] text-zinc-500">
                Staked MIND can be unstaked at any time.
              </div>
            </div>
            <div className="mt-6">
              <Input
                value={unstakeAmountUi}
                onChange={setUnstakeAmountUi}
                placeholder="Unstake amount (MIND)"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setMindAmountFromPercent(userStake?.stakedMind ?? 0n, setUnstakeAmountUi, 25)
                  }
                  disabled={!hasStakedMind}
                  className={quickAmountButtonClass}
                >
                  25%
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setMindAmountFromPercent(userStake?.stakedMind ?? 0n, setUnstakeAmountUi, 50)
                  }
                  disabled={!hasStakedMind}
                  className={quickAmountButtonClass}
                >
                  50%
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setMindAmountFromPercent(userStake?.stakedMind ?? 0n, setUnstakeAmountUi, 75)
                  }
                  disabled={!hasStakedMind}
                  className={quickAmountButtonClass}
                >
                  75%
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setMindAmountFromPercent(userStake?.stakedMind ?? 0n, setUnstakeAmountUi, 100)
                  }
                  disabled={!hasStakedMind}
                  className={quickAmountButtonClass}
                >
                  MAX
                </Button>
              </div>
              <Button className="mt-3" onClick={() => void onUnstake()} disabled={unstakeDisabled}>
                {busy === "Unstake MIND" ? "Submitting..." : "Unstake"}
              </Button>
              <div className="mt-2 text-[11px] text-zinc-500">
                6% of unstaked MIND will be burned.
              </div>
              <div className="text-[11px] text-zinc-500">
                This helps stabilize rewards and discourage rapid in-out cycles.
              </div>
            </div>
            <div className="mt-6">
              <Button
                onClick={() => void onClaimXnt()}
                disabled={busy != null || finalPendingXnt === 0n}
                title="Collect rewards. Your MIND stays staked."
              >
                {busy === "Claim XNT" ? "Claiming..." : "Claim XNT"}
              </Button>
              <div className="mt-2 text-[11px] text-zinc-500">
                Claiming does not remove or unstake your MIND.
              </div>
            </div>
          </Card>

          <Card className="border-emerald-400/20 bg-ink/90 p-6">
            <div className="text-2xl font-semibold" title={epochTooltip}>
              Rewards (live)
            </div>
            <div className="mt-1 text-xs text-zinc-400">Rewards grow continuously — claim anytime.</div>
            <div className="mt-5 space-y-5">
              <div>
                <div className="text-xs text-zinc-400">Accrued (unclaimed):</div>
                <div className="mt-1 text-lg font-semibold text-white">{earnedValue}</div>
                <div className="text-[11px] text-zinc-500">Claim via the Claim XNT button.</div>
              </div>
              <div>
                <div className="text-xs text-zinc-400">Current pace:</div>
                <div className="mt-1 text-lg font-semibold text-white">{currentPaceValue}</div>
                <div className="text-[11px] text-zinc-500">based on your current share</div>
              </div>
              <div title="Estimate only. Depends on your share and can change at any time.">
                <div className="text-xs text-zinc-400">Next milestone:</div>
                <div className="mt-1 text-lg font-semibold text-white">
                  {milestoneValue}
                  {milestoneEtaDisplay != null
                    ? milestoneEtaDisplay === "soon"
                      ? " (≈ soon)"
                      : ` (≈ ${milestoneEtaDisplay} days)`
                    : ""}
                </div>
                <div className="mt-2">
                  <div className="relative h-4 w-full overflow-hidden rounded-full bg-white/5">
                    <div
                      className="h-full rounded-full bg-emerald-400/70"
                      style={{ width: `${milestoneProgress}%` }}
                    />
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">{progressLabel}</div>
                </div>
              </div>
            </div>
            <div className="mt-5 text-xs text-zinc-500">
              Your stake: {stakeSummary} · Your share: {stakeShareRounded}
            </div>
            <div className="mt-6 border-t border-white/10 pt-4">
              <div className="text-sm font-semibold">Active stakers</div>
              <div className="mt-1 text-[11px] text-zinc-400">
                Unique addresses: {activeStakersSummary.unique ?? ACTIVE_STAKERS_SUMMARY.unique} | Total staked:{" "}
                {activeStakersSummary.totalStaked ?? ACTIVE_STAKERS_SUMMARY.totalStaked} MIND | Updated{" "}
                {activeStakersSummary.updated ?? ACTIVE_STAKERS_SUMMARY.updated}
              </div>
              <div className="mt-3 max-h-48 overflow-y-auto">
                <table className="min-w-full text-left text-[11px] text-zinc-300">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-[0.25em] text-zinc-500">
                      <th className="pb-2 pr-4 font-normal">Address</th>
                      <th className="pb-2 pr-4 font-normal">Staked</th>
                      <th className="pb-2 pr-4 font-normal">Share</th>
                      <th className="pb-2 font-normal">Reward/day</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(activeStakers.length > 0 ? activeStakers : ACTIVE_STAKERS).map((staker) => (
                      <tr key={staker.owner} className="border-b border-white/5">
                        <td className="py-2 align-top font-mono text-[11px] text-white">{staker.owner}</td>
                        <td className="py-2">{staker.staked}</td>
                        <td className="py-2">{staker.share}</td>
                        <td className="py-2">{staker.reward}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>
        </section>

        <section className="mt-6">
          {levelingEnabled ? (
            <AccountProgressionPanel
              level={userLevel}
              xpLine={xpLine}
              rateLine={xpRateLine}
              bonusLine={bonusLine}
              yieldLine={personalYieldLine}
              yieldLinkHref="/progression#level-overview"
              description={xpEstimateNote ? `${progressionDescription} ${xpEstimateNote}` : progressionDescription}
              progressLabel={levelProgressLabel}
              progressPct={levelProgressPct}
              maxLevel={maxLevel}
              buttonLabel={levelUpButtonLabel}
              buttonDisabled={levelUpDisabled}
              requirements={levelUpRequirements}
              onLevelUp={onLevelUp}
            />
          ) : (
            <Card className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
              <div className="text-sm font-semibold">Account progression is paused</div>
              <div className="mt-2 text-xs text-zinc-300">{LEVELING_DISABLED_MESSAGE}</div>
            </Card>
          )}
        </section>

        <section className="mt-10">
          <Card className="border-white/10 bg-white/5 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Leaderboard</div>
                <div className="mt-1 text-xs text-zinc-500">Sorted by HP, then staked MIND.</div>
              </div>
              <Badge variant="muted">Top {leaderboardRows.length}</Badge>
            </div>
            <div className="mt-4 max-h-[360px] overflow-y-auto overflow-x-auto pr-2">
              <div className="min-w-[720px]">
                <div className="grid grid-cols-[32px_32px_1fr_140px_110px_140px] text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                  <div>#</div>
                  <div></div>
                  <div>Wallet</div>
                  <div className="text-right">HP</div>
                  <div className="text-right">HP (bonus)</div>
                  <div className="text-right">Staked MIND</div>
                </div>
                {leaderboardRows.length === 0 ? (
                  <div className="mt-3 text-xs text-zinc-500">Leaderboard unavailable.</div>
                ) : (
                  <div className="mt-3 space-y-2">{leaderboardRowElements}</div>
                )}
              </div>
            </div>
          </Card>
        </section>

        {error ? <div className="mt-6 text-sm text-amber-200">{error}</div> : null}
        {lastSig ? (
          <div className="mt-4 text-xs text-zinc-400">
            Last tx: <span className="font-mono">{shortPk(lastSig, 8)}</span>
          </div>
        ) : null}
        {loading ? <div className="mt-4 text-xs text-zinc-500">Refreshing...</div> : null}
      </main>
    </div>
  );
}
