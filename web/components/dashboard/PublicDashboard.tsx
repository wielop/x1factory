"use client";

import "@/lib/polyfillBufferClient";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
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
import { useToast } from "@/components/shared/ToastProvider";
import { getProgram } from "@/lib/anchor";
import type { DecodedConfig } from "@/lib/solana";
import {
  deriveConfigPda,
  derivePositionPda,
  deriveUserProfilePda,
  deriveUserStakePda,
  deriveVaultPda,
  fetchClockUnixTs,
  fetchConfig,
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

const ACC_SCALE = 1_000_000_000_000_000_000n;
const AUTO_CLAIM_INTERVAL_MS = 15_000;
const BPS_DENOMINATOR = 10_000n;
const BADGE_BONUS_CAP_BPS = 2_000n;
const CONTRACTS = [
  { key: 0, label: "Starter Rig", durationDays: 7, costXnt: 1, hp: 1 },
  { key: 1, label: "Pro Rig", durationDays: 14, costXnt: 10, hp: 5 },
  { key: 2, label: "Industrial Rig", durationDays: 28, costXnt: 20, hp: 7 },
] as const;

function formatIntegerBig(value: bigint) {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
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

  const [selectedContract, setSelectedContract] = useState<number>(1);
  const [stakeAmountUi, setStakeAmountUi] = useState<string>("");
  const [unstakeAmountUi, setUnstakeAmountUi] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastClaimAmount, setLastClaimAmount] = useState<bigint | null>(null);
  const hashpowerTooltip =
    "Hashpower gives you a share of daily emission. Your share changes if the network hashpower changes.";
  const [showShareFull, setShowShareFull] = useState(false);
  const [showEmissionFull, setShowEmissionFull] = useState(false);
  const [showClaimableFull, setShowClaimableFull] = useState(false);

  const contract = CONTRACTS.find((c) => c.key === selectedContract) ?? CONTRACTS[0];

  const refresh = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const cfg = await fetchConfig(connection);
      setConfig(cfg);
      const ts = await fetchClockUnixTs(connection);
      setNowTs(ts);
      setLastRefreshNowTs(ts);

      const [xntMintInfo, mindMintInfo] = await Promise.all([
        getMint(connection, cfg.xntMint, "confirmed"),
        getMint(connection, cfg.mindMint, "confirmed"),
      ]);
      setMintDecimals({ xnt: xntMintInfo.decimals, mind: mindMintInfo.decimals });

      const [rewardBal, mindBal] = await Promise.all([
        connection.getTokenAccountBalance(cfg.stakingRewardVault, "confirmed"),
        connection.getTokenAccountBalance(cfg.stakingMindVault, "confirmed"),
      ]);
      setStakingRewardBalance(BigInt(rewardBal.value.amount || "0"));
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
      const [posGpa, profileAcc, stakeAcc] = await Promise.all([
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [
            { dataSize: MINER_POSITION_LEN },
            { memcmp: { offset: 8, bytes: publicKey.toBase58() } },
          ],
        }),
        connection.getAccountInfo(deriveUserProfilePda(publicKey), "confirmed"),
        connection.getAccountInfo(deriveUserStakePda(publicKey), "confirmed"),
      ]);

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

      const xntAta = getAssociatedTokenAddressSync(cfg.xntMint, publicKey);
      const mindAta = getAssociatedTokenAddressSync(cfg.mindMint, publicKey);
      const [xntBal, mindBalUser] = await Promise.all([
        connection
          .getTokenAccountBalance(xntAta, "confirmed")
          .then((b) => BigInt(b.value.amount || "0"))
          .catch(() => 0n),
        connection
          .getTokenAccountBalance(mindAta, "confirmed")
          .then((b) => BigInt(b.value.amount || "0"))
          .catch(() => 0n),
      ]);
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
      setLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  const userHp = useMemo(() => {
    if (userProfile) return userProfile.activeHp;
    if (!nowTs) return 0n;
    return positions
      .filter((p) => !p.data.deactivated && nowTs < p.data.endTs)
      .reduce((acc, p) => acc + p.data.hp, 0n);
  }, [positions, userProfile, nowTs]);

  const effectiveUserHp = useMemo(() => {
    if (!config) return userHp;
    return userHp > config.maxEffectiveHp ? config.maxEffectiveHp : userHp;
  }, [config, userHp]);

  const networkHp = config?.networkHpActive ?? 0n;
  const sharePct = networkHp > 0n ? Number((effectiveUserHp * 10_000n) / networkHp) / 100 : 0;
  const sharePctFull =
    networkHp > 0n ? Number((effectiveUserHp * 1_000_000n) / networkHp) / 10_000 : 0;
  const shareTooltip =
    "You receive ~33% of daily emission while this share holds. Share changes when others join/expire.";
  const miningStatusText =
    networkHp > 0n
      ? "Status: Mining active — rewards accrue continuously"
      : "Status: Emission paused — no active hashpower";
  const statusAccentClass = networkHp > 0n ? "text-emerald-300" : "text-amber-300";
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
    return positions.map((p) => {
      if (!config) {
        return { position: p, pending: 0n, livePending: 0n };
      }
      const acc = p.data.deactivated ? p.data.finalAccMindPerHp : config.accMindPerHp;
      const earned = (p.data.hp * acc) / ACC_SCALE;
      const pending = earned > p.data.rewardDebt ? earned - p.data.rewardDebt : 0n;
      const livePending = pending + (p.data.hp * extraAccSinceRefresh) / ACC_SCALE;
      return { position: p, pending, livePending };
    });
  }, [positions, config, extraAccSinceRefresh]);

  const totalPendingMind = pendingPositions.reduce((acc, entry) => acc + entry.pending, 0n);
  const livePendingMind =
    totalPendingMind + (userHp * extraAccSinceRefresh) / ACC_SCALE;

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
    config && networkHp > 0n
      ? (emissionPerDay * effectiveUserHp) / networkHp
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
  const sevenDayAverageXnt = config ? (config.stakingRewardRateXntPerSec * 604_800n) / 7n : 0n;
  const userStakeRounded =
    mintDecimals && userStake
      ? formatRoundedToken(userStake.stakedMind, mintDecimals.mind)
      : "-";

  const claimableRounded =
    mintDecimals != null ? formatRoundedToken(totalPendingMind, mintDecimals.mind) : "-";
  const claimableFull =
    mintDecimals != null ? formatFullPrecisionToken(totalPendingMind, mintDecimals.mind) : "-";
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
  const lastClaimRounded =
    mintDecimals && lastClaimAmount != null
      ? formatRoundedToken(lastClaimAmount, mintDecimals.mind)
      : null;

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

  const withTx = useCallback(
    async (label: string, fn: () => Promise<string>) => {
      setBusy(label);
      setError(null);
      try {
        const sig = await fn();
        setLastSig(sig);
        pushToast({ title: label, description: shortPk(sig, 6) });
      } catch (e: unknown) {
        console.error(e);
        setError(formatError(e));
      } finally {
        setBusy(null);
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
      const { ata, ix } = await ensureAta(publicKey, config.xntMint);
      const tx = new Transaction();
      if (ix) tx.add(ix);
      const sig = await program.methods
        .buyContract(contract.key, positionIndex)
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          userProfile: deriveUserProfilePda(publicKey),
          position: derivePositionPda(publicKey, nextIndex),
          vaultAuthority: deriveVaultPda(),
          xntMint: config.xntMint,
          stakingRewardVault: config.stakingRewardVault,
          treasuryVault: config.treasuryVault,
          ownerXntAta: ata,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions(tx.instructions)
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
          })
          .instruction();
        tx.add(instruction);
      }
      return await program.provider.sendAndConfirm(tx, []);
    });
    return true;
  }, [anchorWallet, busy, connection, config, pendingPositions, publicKey, withTx]);

  const handleClaimToggle = useCallback(async () => {
    const claimSnapshot = totalPendingMind;
    const executed = await onClaimAll();
    if (executed) {
      setLastClaimAmount(claimSnapshot);
    }
  }, [onClaimAll, totalPendingMind]);
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
      const { ata, ix } = await ensureAta(publicKey, config.xntMint);
      const tx = new Transaction();
      if (ix) tx.add(ix);
      const sig = await program.methods
        .claimXnt()
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          userProfile: deriveUserProfilePda(publicKey),
          userStake: deriveUserStakePda(publicKey),
          vaultAuthority: deriveVaultPda(),
          stakingRewardVault: config.stakingRewardVault,
          ownerXntAta: ata,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions(tx.instructions)
        .rpc();
      return sig;
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
      <TopBar title="Mining V2" subtitle="Pro-rata emission + staking rewards" link={{ href: "/admin", label: "Admin" }} />

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
              <div className="text-3xl font-semibold text-white">{formatIntegerBig(effectiveUserHp)}</div>
              <div className="mt-2 text-[10px] uppercase tracking-[0.2em] text-zinc-400">Your HP</div>
            </Card>
            <Card className="p-4">
              <div className="text-3xl font-semibold text-white">{formatIntegerBig(networkHp)}</div>
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
            </Card>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="lg:col-span-2 border border-emerald-500/30 bg-emerald-500/5 p-4">
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Claimable MIND</div>
              <div className="mt-3 flex items-baseline gap-1">
                <button
                  type="button"
                  onClick={() => setShowClaimableFull((prev) => !prev)}
                  title={
                    mintDecimals
                      ? `Click for full precision (${claimableFull} MIND)`
                      : "Connect wallet to see amount"
                  }
                  className="text-4xl font-semibold text-emerald-300 transition hover:text-emerald-100 focus:outline-none"
                >
                  {mintDecimals ? (showClaimableFull ? claimableFull : claimableRounded) : "-"}
                </button>
                <span className="text-lg text-emerald-200">MIND</span>
              </div>
            <div className="mt-2 text-xs text-zinc-400">
              Collect rewards via the Claim rewards button in Your rigs.
            </div>
            {lastClaimRounded ? (
              <div className="mt-1 text-[11px] text-emerald-200">
                Last claimed: {lastClaimRounded} MIND
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
              Network 24h:{" "}
              {networkTrend
                ? `${networkTrend.delta.toString()} (${networkTrend.pct.toFixed(2)}%)`
                : "0 (warming up)"}
            </Badge>
            <Badge variant="muted">Badge bonus: +{effectiveBonusBps / 100}%</Badge>
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

              <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Selected</div>
                <div className="mt-3 space-y-2 text-sm font-medium text-white">
                  <div>Hashpower: {contract.hp} HP</div>
                  <div>Duration: {contract.durationDays} days</div>
                  <div>Cost: {contract.costXnt} XNT</div>
                </div>
                <div
                  className="mt-3 text-xs text-zinc-500"
                  title={hashpowerTooltip}
                >
                  Hashpower gives you a share of daily emission. Your share changes if the network hashpower changes.
                </div>
                <div className="mt-4">
                  <Button size="lg" className="h-12" onClick={() => void onBuy()} disabled={buyDisabled}>
                    {busy === "Buy contract" ? "Submitting..." : "Activate rig"}
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
            <div className="mt-4 grid gap-3">
              {positions.length === 0 ? (
                <div className="text-xs text-zinc-500">No positions yet.</div>
              ) : (
                pendingPositions.map((entry) => {
                  const p = entry.position;
                  const remaining = nowTs ? Math.max(0, p.data.endTs - nowTs) : null;
                  const expired = nowTs != null && nowTs >= p.data.endTs;
                  return (
                    <div key={p.pubkey} className="rounded-2xl border border-white/10 bg-white/5 p-3">
                      <div className="flex items-center justify-between">
                        <div className="text-sm text-zinc-200">HP {p.data.hp.toString()}</div>
                        <Badge variant={expired ? "danger" : "success"}>
                          {expired ? "expired" : "active"}
                        </Badge>
                      </div>
                      <div className="mt-2 text-xs text-zinc-400">
                        Ends in {remaining == null ? "-" : formatDurationSeconds(remaining)}
                      </div>
                      {mintDecimals ? (
                        <div className="mt-2 text-[11px] text-zinc-500">
                          {networkHp > 0n
                            ? `Current rate: ${formatRoundedToken(
                                ((config?.emissionPerSec ?? 0n) * 3_600n * p.data.hp) / networkHp,
                                mintDecimals.mind
                              )} MIND / h`
                            : "Rate unavailable"}
                        </div>
                      ) : null}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={() => void onDeactivate(p.pubkey, p.data.owner)}
                          disabled={busy != null || !expired}
                          title="Stops contributing hashpower. You do not lose rewards already accrued."
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
            <div className="mt-3 text-xs text-zinc-400">
              Claimable: {mintDecimals ? formatTokenAmount(finalPendingXnt, mintDecimals.xnt, 4) : "-"} XNT
            </div>
            <div className="text-[11px] text-zinc-500">
              Rewards accrue continuously. Your rewards depend on your share of the staking pool.
            </div>
            <div className="mt-4">
              <Input
                value={stakeAmountUi}
                onChange={setStakeAmountUi}
                placeholder="Amount to stake (MIND)"
              />
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
              <Button className="mt-3" onClick={() => void onUnstake()} disabled={unstakeDisabled}>
                {busy === "Unstake MIND" ? "Submitting..." : "Unstake"}
              </Button>
            </div>
            <div className="mt-6">
              <Button
                onClick={() => void onClaimXnt()}
                disabled={busy != null || finalPendingXnt === 0n}
                title="Collect rewards. Your MIND stays staked."
              >
                {busy === "Claim XNT" ? "Claiming..." : "Claim XNT"}
              </Button>
            </div>
          </Card>

          <Card className="border-emerald-400/20 bg-ink/90 p-6">
            <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Pool stats</div>
            <div className="mt-2 text-2xl font-semibold">Rewards</div>
            <div className="mt-4 space-y-2 text-xs text-zinc-400">
              <div>
                Estimated per day:{" "}
                {mintDecimals
                  ? `${formatRoundedToken(estimatedStakingPerDay, mintDecimals.xnt)} XNT/day`
                  : "-"}
              </div>
              <div>
                7-day average:{" "}
                {mintDecimals
                  ? `${formatRoundedToken(sevenDayAverageXnt, mintDecimals.xnt)} XNT/day`
                  : "-"}
              </div>
              <div>
                Next epoch resets in: {epochCountdown != null ? formatDurationSeconds(epochCountdown) : "-"}
              </div>
              <div>
                Your stake: {mintDecimals ? `${userStakeRounded} MIND` : "-"}
              </div>
              <div>
                Your share: {stakingSharePct != null ? `${stakingSharePct.toFixed(2)}%` : "-"}
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
