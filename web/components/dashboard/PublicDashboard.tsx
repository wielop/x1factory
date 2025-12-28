"use client";

import "@/lib/polyfillBufferClient";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction, type AccountMeta } from "@solana/web3.js";
import {
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
import { Dialog } from "@/components/ui/dialog";
import { getProgram } from "@/lib/anchor";
import type { DecodedConfig } from "@/lib/solana";
import {
  deriveConfigPda,
  deriveLevelConfigPda,
  derivePositionPda,
  deriveUserProfilePda,
  deriveUserStakePda,
  deriveVaultPda,
  fetchClockUnixTs,
  fetchConfig,
  fetchLevelConfig,
  getProgramId,
} from "@/lib/solana";
import type { DecodedUserStake } from "@/lib/decoders";
import {
  decodeMinerPositionAccount,
  decodeUserMiningProfileAccount,
  MINER_POSITION_LEN,
  tryDecodeUserStakeAccount,
} from "@/lib/decoders";
import { formatDurationSeconds, formatTokenAmount, parseUiAmountToBase, shortPk } from "@/lib/format";
import { formatError } from "@/lib/formatError";
import { sendTelemetry } from "@/lib/telemetryClient";

const ACC_SCALE = 1_000_000_000_000_000_000n;
const AUTO_CLAIM_INTERVAL_MS = 15_000;
const BPS_DENOMINATOR = 10_000n;
const BADGE_BONUS_CAP_BPS = 2_000n;
const LEVEL_CAP = 6;
const LEVEL_THRESHOLDS = [0n, 1n, 2_000n, 5_000n, 10_000n, 16_000n] as const;
const LEVEL_BONUS_BPS = [0, 160, 340, 550, 780, 1000] as const;
const LEVEL_UP_COSTS = [150, 350, 900, 2_000, 4_000] as const;
const STAKING_SECONDS_PER_YEAR = 31_536_000;
const XNT_DECIMALS = 9;
const NATIVE_VAULT_SPACE = 9;
const HP_SCALE = 100n;
const CONTRACTS = [
  { key: 0, label: "Starter Rig", durationDays: 7, costXnt: 1, hp: 1 },
  { key: 1, label: "Pro Rig", durationDays: 14, costXnt: 10, hp: 5 },
  { key: 2, label: "Industrial Rig", durationDays: 28, costXnt: 20, hp: 7 },
] as const;

function formatIntegerBig(value: bigint) {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function formatFixed2(valueHundredths: bigint) {
  const whole = valueHundredths / 100n;
  const frac = valueHundredths % 100n;
  return `${formatIntegerBig(whole)}.${frac.toString().padStart(2, "0")}`;
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

export function PublicDashboard() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();
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
  const [xntBalance, setXntBalance] = useState<bigint>(0n);
  const [mindBalance, setMindBalance] = useState<bigint>(0n);
  const [stakingRewardBalance, setStakingRewardBalance] = useState<bigint>(0n);
  const [stakingMindBalance, setStakingMindBalance] = useState<bigint>(0n);
  const [networkTrend, setNetworkTrend] = useState<{ delta: bigint; pct: number } | null>(null);
  const [activeMinerTotal, setActiveMinerTotal] = useState(0);
  const [activeRigTotal, setActiveRigTotal] = useState(0);

  const [selectedContract, setSelectedContract] = useState<number>(1);
  const [stakeAmountUi, setStakeAmountUi] = useState<string>("");
  const [unstakeAmountUi, setUnstakeAmountUi] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastClaimAmount, setLastClaimAmount] = useState<bigint | null>(null);
  const [lastClaimTs, setLastClaimTs] = useState<number | null>(null);
  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  const [stopDialogTarget, setStopDialogTarget] = useState<{
    pubkey: string;
    owner: Uint8Array;
  } | null>(null);
  const refreshIdRef = useRef(0);
  const xpEstimateStartRef = useRef<number | null>(null);
  const xpEstimateKey =
    publicKey && typeof window !== "undefined"
      ? `mining_v2_xp_estimate_${publicKey.toBase58()}`
      : null;
  const hashpowerTooltip =
    "Hashpower gives you a share of daily emission. Your share changes if the network hashpower changes.";
  const [showShareFull, setShowShareFull] = useState(false);
  const [showEmissionFull, setShowEmissionFull] = useState(false);

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

  const contract = CONTRACTS.find((c) => c.key === selectedContract) ?? CONTRACTS[0];

  const refresh = useCallback(async () => {
    const refreshId = ++refreshIdRef.current;
    const isStale = () => refreshId !== refreshIdRef.current;
    setError(null);
    setLoading(true);
    try {
      const cfg = await fetchConfig(connection);
      if (isStale()) return;
      setConfig(cfg);
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
        return;
      }

      const programId = getProgramId();
      const [posGpa, profileAcc, stakeAcc, allPositions] = await Promise.all([
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [
            { dataSize: MINER_POSITION_LEN },
            { memcmp: { offset: 8, bytes: publicKey.toBase58() } },
          ],
        }),
        connection.getAccountInfo(deriveUserProfilePda(publicKey), "confirmed"),
        connection.getAccountInfo(deriveUserStakePda(publicKey), "confirmed"),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: MINER_POSITION_LEN }],
        }),
      ]);
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
        for (const entry of allPositions) {
          const decoded = decodeMinerPositionAccount(Buffer.from(entry.account.data));
          if (decoded.deactivated || decoded.endTs <= now) continue;
          const ownerKey = new PublicKey(decoded.owner).toBase58();
          unique.add(ownerKey);
          rigs += 1;
        }
        setActiveMinerTotal(unique.size);
        setActiveRigTotal(rigs);
      } catch (err) {
        console.warn("Failed to load active miners", err);
        setActiveMinerTotal(0);
        setActiveRigTotal(0);
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

  const userLevel = Math.max(userProfile?.level ?? 1, 1);
  const userXp = userProfile?.xp ?? 0n;
  const lastXpUpdateTs = userProfile?.lastXpUpdateTs ?? 0;

  useEffect(() => {
    if (!nowTs || !userProfile) return;
    if (lastXpUpdateTs > 0) {
      xpEstimateStartRef.current = null;
      if (xpEstimateKey) {
        window.localStorage.removeItem(xpEstimateKey);
      }
      return;
    }
    if (userProfile.activeHp <= 0n) {
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
          if (storedHp === userProfile.activeHp) {
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
          JSON.stringify({ ts: nowTs, hp: userProfile.activeHp.toString() })
        );
      }
    }
  }, [lastXpUpdateTs, nowTs, userProfile, xpEstimateKey]);
  const levelIdx = Math.min(Math.max(userLevel, 1), LEVEL_CAP) - 1;
  const levelBonusBps = LEVEL_BONUS_BPS[levelIdx] ?? LEVEL_BONUS_BPS[LEVEL_BONUS_BPS.length - 1];
  const nextLevelXp = userLevel < LEVEL_CAP ? LEVEL_THRESHOLDS[userLevel] : null;
  const levelBonusPct = (levelBonusBps / 100).toFixed(1);
  const levelBonusBpsBig = BigInt(levelBonusBps);
  const xpEstimate = useMemo(() => {
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
    const baseHp = userProfile.activeHp;
    const gainHundredths = (baseHp * BigInt(deltaSeconds) * 100n) / 36_000n;
    const hundredths = userXp * 100n + gainHundredths;
    return { whole: hundredths / 100n, hundredths };
  }, [nowTs, userProfile, userXp, lastXpUpdateTs]);
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
  const hpTooltip =
    levelBonusBps > 0
      ? `Your HP includes a ${levelBonusPct}% level bonus. Leveling only increases your share of rewards, not the global MIND emission.`
      : "Your HP is currently based only on your active rigs. Leveling will add a small bonus on top of this value.";
  const levelUpCostTokens = userLevel < LEVEL_CAP ? LEVEL_UP_COSTS[userLevel - 1] ?? null : null;
  const levelUpCostBase =
    levelUpCostTokens != null && mintDecimals != null
      ? BigInt(levelUpCostTokens) * 10n ** BigInt(mintDecimals.mind)
      : null;
  const hasMindForLevelUp =
    levelUpCostBase != null ? mindBalance >= levelUpCostBase : false;
  const canLevelUp =
    userProfile != null &&
    nextLevelXp != null &&
    xpDisplay >= nextLevelXp &&
    hasMindForLevelUp &&
    userLevel < LEVEL_CAP;
  const missingXpLabel = formatFixed2(xpRemainingHundredths);
  const requiredMindLabel = levelUpCostTokens != null ? `${levelUpCostTokens}` : "0";
  const maxLevel = userLevel >= LEVEL_CAP || nextLevelXp == null;
  const levelUpDisabled = !canLevelUp || busy != null || maxLevel;
  const levelUpButtonLabel = maxLevel
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
    userProfile?.activeHp != null ? userProfile.activeHp * 10n : 0n;
  const xpRateLine =
    userProfile?.activeHp != null && userProfile.activeHp > 0n
      ? `≈ ${formatFixed2(xpPerHourHundredths)} XP/hour`
      : null;
  const bonusLine = `HP bonus: +${levelBonusPct}%`;
  const progressionDescription =
    "Your account earns XP while your rigs are mining. Higher levels give a small HP bonus on top of your rigs.";
  const xpEstimateNote =
    lastXpUpdateTs <= 0 && userProfile?.activeHp
      ? "XP is estimated until your next on-chain interaction (claim, buy, renew)."
      : null;
  const levelProgressLabel = `Progress: ${levelProgressPct.toFixed(2)}%`;

  const baseUserHp = useMemo(() => {
    if (userProfile) return userProfile.activeHp;
    if (!nowTs) return 0n;
    return positions
      .filter((p) => !p.data.deactivated && nowTs < p.data.endTs)
      .reduce((acc, p) => acc + p.data.hp, 0n);
  }, [positions, userProfile, nowTs]);

  const cappedBaseUserHp = useMemo(() => {
    if (!config) return baseUserHp;
    return baseUserHp > config.maxEffectiveHp ? config.maxEffectiveHp : baseUserHp;
  }, [config, baseUserHp]);

  const effectiveUserHpHundredths = useMemo(() => {
    if (cappedBaseUserHp === 0n) return 0n;
    return (
      cappedBaseUserHp *
      (BPS_DENOMINATOR + levelBonusBpsBig) *
      HP_SCALE /
      BPS_DENOMINATOR
    );
  }, [cappedBaseUserHp, levelBonusBpsBig]);
  const bonusHpHundredths = useMemo(() => {
    if (effectiveUserHpHundredths === 0n) return 0n;
    const baseHundredths = cappedBaseUserHp * HP_SCALE;
    return effectiveUserHpHundredths > baseHundredths
      ? effectiveUserHpHundredths - baseHundredths
      : 0n;
  }, [effectiveUserHpHundredths, cappedBaseUserHp]);

  const networkHp = config?.networkHpActive ?? 0n;
  const networkHpHundredths = useMemo(() => networkHp, [networkHp]);
  const sharePct =
    networkHpHundredths > 0n
      ? Number((effectiveUserHpHundredths * 10_000n) / networkHpHundredths) / 100
      : 0;
  const sharePctFull =
    networkHpHundredths > 0n
      ? Number((effectiveUserHpHundredths * 1_000_000n) / networkHpHundredths) / 10_000
      : 0;
  const shareTooltip =
    "You receive rewards continuously based on your current share. Your share may change when others join or expire.";
  const miningStatusText =
    networkHp > 0n
      ? "Status: Mining active • • •"
      : "Status: Emission paused — no active hashpower";
  const statusAccentClass = networkHp > 0n ? "text-emerald-300" : "text-amber-300";
  const expiryTooltip =
    "When the contract expires, this rig stops mining automatically and no more rewards are generated.";
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
    const bonusMultiplier = BPS_DENOMINATOR + levelBonusBpsBig;
    return positions.map((p) => {
      if (!config) {
        return { position: p, pending: 0n, livePending: 0n };
      }
      const hpEffective = p.data.deactivated
        ? p.data.hp
        : (p.data.hp * bonusMultiplier * HP_SCALE) / BPS_DENOMINATOR;
      const acc = p.data.deactivated ? p.data.finalAccMindPerHp : config.accMindPerHp;
      const earned = (hpEffective * acc) / ACC_SCALE;
      const pending = earned > p.data.rewardDebt ? earned - p.data.rewardDebt : 0n;
      const livePending = pending + (hpEffective * extraAccSinceRefresh) / ACC_SCALE;
      return { position: p, pending, livePending };
    });
  }, [positions, config, extraAccSinceRefresh, levelBonusBpsBig]);

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
  const stakingApyPct = useMemo(() => {
    if (stakingAprPct == null) return null;
    const aprRate = stakingAprPct / 100;
    const apyRate = Math.pow(1 + aprRate / 365, 365) - 1;
    return apyRate * 100;
  }, [stakingAprPct]);
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
    mintDecimals != null ? formatRoundedToken(totalPendingMind, mintDecimals.mind) : "-";
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
  const rewardPoolBadge =
    mintDecimals != null ? formatRoundedToken(stakingRewardBalance, mintDecimals.xnt) : "-";
  const totalStakedBadge =
    mintDecimals != null && config ? formatRoundedToken(config.stakingTotalStakedMind, mintDecimals.mind) : "-";
  const stakingAprDisplay = formatPercent(stakingAprPct);
  const stakingApyDisplay = formatPercent(stakingApyPct);
  const lastClaimRounded =
    mintDecimals && lastClaimAmount != null
      ? formatRoundedToken(lastClaimAmount, mintDecimals.mind)
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
      case "Level up":
        return "level_up";
      case "Deactivate position":
        return "deactivate_position";
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
    if (busy != null) return false;
    if (!anchorWallet || !publicKey || !config) return false;
    const claimTargets = pendingPositions.filter((entry) => entry.livePending > 0n);
    if (claimTargets.length === 0) return false;
    await withTx("Claim all rigs", async () => {
      const { ata, ix } = await ensureAta(publicKey, config.mindMint);
      const tx = new Transaction();
      if (ix) tx.add(ix);
      const program = getProgram(connection, anchorWallet);
      for (const entry of claimTargets) {
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
      return await program.provider.sendAndConfirm(tx, []);
    });
    return true;
  }, [anchorWallet, busy, connection, config, pendingPositions, publicKey, withTx]);

  const handleClaimToggle = useCallback(async () => {
    if (!config || !publicKey) return;
    const ata = getAssociatedTokenAddressSync(config.mindMint, publicKey);
    const before = await connection
      .getTokenAccountBalance(ata, "confirmed")
      .then((b) => BigInt(b.value.amount || "0"))
      .catch(() => 0n);
    const executed = await onClaimAll();
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
    }
  }, [config, connection, nowTs, onClaimAll, publicKey]);
  const onDeactivate = async (posPubkey: string, ownerBytes: Uint8Array) => {
    if (!anchorWallet || !config) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Deactivate position", async () => {
      const sig = await program.methods
        .deactivatePosition()
        .accounts({
          config: deriveConfigPda(),
          position: new PublicKey(posPubkey),
          userProfile: deriveUserProfilePda(new PublicKey(ownerBytes)),
        })
        .rpc();
      return sig;
    });
  };
  const requestStopMining = (posPubkey: string, ownerBytes: Uint8Array | null | undefined) => {
    if (!ownerBytes || ownerBytes.length !== 32) {
      if (publicKey) {
        void onDeactivate(posPubkey, publicKey.toBytes());
      }
      return;
    }
    setStopDialogTarget({ pubkey: posPubkey, owner: ownerBytes });
    setStopDialogOpen(true);
  };
  const confirmStopMining = async () => {
    if (!stopDialogTarget) return;
    const target = stopDialogTarget;
    setStopDialogOpen(false);
    setStopDialogTarget(null);
    await onDeactivate(target.pubkey, target.owner);
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

  const onLevelUp = async () => {
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
    const activePositions = positions.filter((entry) => !entry.data.deactivated);
    if (activePositions.length === 0) {
      setError("No active rigs found for leveling up.");
      return;
    }
    const activeHp = activePositions.reduce((acc, entry) => acc + entry.data.hp, 0n);
    if (activeHp !== userProfile.activeHp) {
      setError("Active rig list out of sync. Refresh and try again.");
      return;
    }
    await withTx("Level up", async () => {
      const { ata, ix } = await ensureAta(publicKey, config.mindMint);
      const remainingAccounts: AccountMeta[] = activePositions.map((entry) => ({
        pubkey: new PublicKey(entry.pubkey),
        isSigner: false,
        isWritable: true,
      }));
      const program = getProgram(connection, anchorWallet);
      const tx = new Transaction();
      if (ix) tx.add(ix);
      const instruction = await program.methods
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
        .remainingAccounts(remainingAccounts)
        .instruction();
      tx.add(instruction);
      return await program.provider.sendAndConfirm(tx, []);
    });
  };

  const buyDisabled = !publicKey || !config || Boolean(busy);
  const stakeDisabled =
    !publicKey || !config || !mintDecimals || Boolean(busy) || stakeAmountUi.trim() === "";
  const unstakeDisabled =
    !publicKey || !config || !mintDecimals || Boolean(busy) || unstakeAmountUi.trim() === "";
  const claimDisabled = !publicKey || !config || Boolean(busy);

  return (
    <div className="min-h-screen bg-ink text-white">
      <TopBar progressionLabel={`LVL ${userLevel}`} />

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
              <div className="text-3xl font-semibold text-white">
                <span>{formatFixed2(effectiveUserHpHundredths)} HP</span>
                {bonusHpHundredths > 0n ? (
                  <span className="ml-2 text-base font-semibold text-emerald-300">
                    (+{formatFixed2(bonusHpHundredths)})
                  </span>
                ) : null}
              </div>
              <div className="mt-2 flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-zinc-400">
                <span>Your HP</span>
                <span
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-white/10 text-[9px] text-zinc-400"
                  title={hpTooltip}
                  aria-label="HP info"
                >
                  i
                </span>
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-3xl font-semibold text-white">
                {formatFixed2(networkHpHundredths)} HP
              </div>
              <div className="mt-2 text-[10px] uppercase tracking-[0.2em] text-zinc-400">Network HP</div>
            </Card>
            <Card className="p-4">
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Your share</div>
              <div className="mt-3 flex items-baseline gap-1">
                <button
                  type="button"
                  onClick={() => setShowShareFull((prev) => !prev)}
                  title={`${shareTooltip} Click to toggle precision.`}
                  className="text-3xl font-semibold text-white transition hover:text-cyan-200 focus:outline-none"
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
            <Badge variant="muted">Total staked: {totalStakedBadge} MIND</Badge>
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

            <div className="mt-5 grid gap-3 md:grid-cols-3">
              {CONTRACTS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setSelectedContract(c.key)}
                  className={[
                    "rounded-2xl border px-4 py-3 text-left text-xs transition",
                    selectedContract === c.key
                      ? "border-cyan-300/50 bg-cyan-300/10 text-white"
                      : "border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10",
                  ].join(" ")}
                >
                  <div className="text-sm font-semibold">{c.label}</div>
                  <div className="mt-1 text-[11px] text-zinc-400">{c.durationDays} days</div>
                  <div className="mt-1 text-[11px] text-cyan-200">HP {c.hp}</div>
                  <div className="mt-3 text-sm text-emerald-200">{c.costXnt} XNT</div>
                </button>
              ))}
            </div>
            <div className="mt-2 text-xs text-zinc-500">
              Choose the plan that fits your strategy. You can start multiple rigs.
            </div>
            <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Selected</div>
              <div className="mt-3 space-y-2 text-sm font-medium text-white">
                <div>Hashpower: {contract.hp} HP</div>
                <div>Duration: {contract.durationDays} days</div>
                <div>Cost: {contract.costXnt} XNT</div>
              </div>
              <div className="mt-3 text-xs text-zinc-500" title={hashpowerTooltip}>
                Hashpower gives you a share of daily emission. Your share changes if the network hashpower changes.
              </div>
              <div className="mt-4">
                <Button size="lg" className="h-12" onClick={() => void onBuy()} disabled={buyDisabled}>
                  {busy === "Buy contract" ? "Submitting..." : "Start mining"}
                </Button>
              </div>
            </div>
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
            <div className="mt-4 grid max-h-[320px] gap-3 overflow-y-auto pr-2 sm:max-h-[440px]">
              {positions.length === 0 ? (
                <div className="text-xs text-zinc-500">No positions yet.</div>
              ) : (
                pendingPositions.map((entry) => {
                  const p = entry.position;
                  const remaining = nowTs ? Math.max(0, p.data.endTs - nowTs) : null;
                  const expired = nowTs != null && nowTs >= p.data.endTs;
                  const bonusMultiplier = BPS_DENOMINATOR + levelBonusBpsBig;
                  const positionHpEffective = p.data.deactivated
                    ? p.data.hp
                    : (p.data.hp * bonusMultiplier * HP_SCALE) / BPS_DENOMINATOR;
                  const positionHpLabel = p.data.deactivated
                    ? formatFixed2(p.data.hp)
                    : p.data.hp.toString();
                  return (
                    <div key={p.pubkey} className="rounded-2xl border border-white/10 bg-white/5 p-3">
                      <div className="flex items-center justify-between">
                        <div className="text-sm text-zinc-200">HP {positionHpLabel}</div>
                        <Badge variant={expired ? "danger" : "success"}>
                          {expired ? "expired" : "active"}
                        </Badge>
                      </div>
                      <div className="mt-2 text-xs text-zinc-400" title={expiryTooltip}>
                        Ends in {remaining == null ? "-" : formatDurationSeconds(remaining)}
                      </div>
                      {mintDecimals ? (
                        <div className="mt-2 text-[11px] text-zinc-500">
                          {networkHpHundredths > 0n
                            ? `Current rate: ${formatRoundedToken(
                                ((config?.emissionPerSec ?? 0n) * 3_600n * positionHpEffective) /
                                  networkHpHundredths,
                                mintDecimals.mind
                              )} MIND / h`
                            : "Rate unavailable"}
                        </div>
                      ) : null}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={() => requestStopMining(p.pubkey, p.data.owner)}
                          disabled={busy != null || !expired}
                          title="Stops mining for this rig. This action cannot be undone."
                        >
                          Stop mining
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </Card>
        </section>

        <section className="mt-10 grid gap-6 lg:grid-cols-[1fr_1fr]">
          <Card className="border-emerald-400/20 bg-ink/90 p-6">
            <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Staking</div>
            <div className="mt-2 text-2xl font-semibold">Stake MIND → Earn XNT</div>
            <div className="mt-1 text-xs text-zinc-400">
              Rewards are funded from mining purchases (30% of revenue).
            </div>
            <div
              className="mt-3 text-xs text-zinc-400"
              title="Based on current XNT reward rate and total staked MIND."
            >
              APR: {stakingAprDisplay} | APY: {stakingApyDisplay}
            </div>
            <div className="mt-3 text-xs text-zinc-400">
              Claimable: {mintDecimals ? formatTokenAmount(finalPendingXnt, mintDecimals.xnt, 4) : "-"} XNT
            </div>
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
                3% of unstaked MIND will be burned.
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
          </Card>
        </section>

        <section className="mt-6">
          <AccountProgressionPanel
            level={userLevel}
            xpLine={xpLine}
            rateLine={xpRateLine}
            bonusLine={bonusLine}
            description={xpEstimateNote ? `${progressionDescription} ${xpEstimateNote}` : progressionDescription}
            progressLabel={levelProgressLabel}
            progressPct={levelProgressPct}
            maxLevel={maxLevel}
            buttonLabel={levelUpButtonLabel}
            buttonDisabled={levelUpDisabled}
            requirements={levelUpRequirements}
            onLevelUp={onLevelUp}
          />
        </section>

        {error ? <div className="mt-6 text-sm text-amber-200">{error}</div> : null}
        {lastSig ? (
          <div className="mt-4 text-xs text-zinc-400">
            Last tx: <span className="font-mono">{shortPk(lastSig, 8)}</span>
          </div>
        ) : null}
        {loading ? <div className="mt-4 text-xs text-zinc-500">Refreshing...</div> : null}
      </main>
      <Dialog
        open={stopDialogOpen}
        onOpenChange={(open) => {
          setStopDialogOpen(open);
          if (!open) setStopDialogTarget(null);
        }}
        title="Stop mining?"
        description="Stopping early will permanently disable this rig. You will no longer receive rewards from it."
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setStopDialogOpen(false);
                setStopDialogTarget(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void confirmStopMining()} disabled={busy != null}>
              Yes — stop mining
            </Button>
          </div>
        }
      >
        <div className="text-xs text-zinc-500">This action cannot be undone.</div>
      </Dialog>
    </div>
  );
}
