"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TopBar } from "@/components/shared/TopBar";
import { Tabs } from "@/components/ui/tabs";
import { SummaryCards } from "@/components/dashboard/SummaryCards";
import { MiningControlPanel } from "@/components/dashboard/MiningControlPanel";
import { MiningActivityPanel } from "@/components/dashboard/MiningActivityPanel";
import { MiningXpHero } from "@/components/dashboard/MiningXpHero";
import { MineSection } from "@/components/dashboard/MineSection";
import { StakeSection } from "@/components/dashboard/StakeSection";
import { XPSection } from "@/components/dashboard/XPSection";
import { TransactionStatus } from "@/components/dashboard/TransactionStatus";
import { DashboardProvider, BusyAction, MiningPlanOption } from "@/components/dashboard/DashboardContext";
import { useToast } from "@/components/shared/ToastProvider";
import { getProgram } from "@/lib/anchor";
import type { DecodedConfig } from "@/lib/solana";
import {
  deriveConfigPda,
  deriveStakingPositionPda,
  deriveUserProfilePda,
  derivePositionPdaV2,
  deriveVaultPda,
  fetchClockUnixTs,
  fetchConfig,
  fetchTokenBalanceUi,
  getCurrentEpochFrom,
  getProgramId,
} from "@/lib/solana";
import {
  decodeStakingPositionAccount,
  decodeUserPositionAccount,
  decodeUserProfileAccount,
} from "@/lib/decoders";
import { formatDurationSeconds, formatTokenAmount, parseUiAmountToBase, shortPk } from "@/lib/format";
import { formatError } from "@/lib/formatError";

function safeBigintToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount is too large");
  return Number(value);
}

function planFeeBase(durationDays: 7 | 14 | 30, decimals: number): bigint {
  const base = 10n ** BigInt(decimals);
  if (durationDays === 7) return base / 10n; // 0.1
  if (durationDays === 14) return base; // 1
  return base * 5n; // 5
}

function formatBps(bps: number) {
  const percent = bps / 100;
  return `${percent % 1 === 0 ? percent.toFixed(0) : percent.toFixed(2)}%`;
}

function rewardForDurationBase(
  durationDays: 7 | 14 | 28 | 30,
  cfg: Pick<DecodedConfig, "mindReward7d" | "mindReward14d" | "mindReward28d">
) {
  if (durationDays === 7) return BigInt(cfg.mindReward7d.toString());
  if (durationDays === 14) return BigInt(cfg.mindReward14d.toString());
  return BigInt(cfg.mindReward28d.toString());
}

function rewardPerEpochBase(
  durationDays: 7 | 14 | 28 | 30,
  cfg: Pick<DecodedConfig, "mindReward7d" | "mindReward14d" | "mindReward28d">
) {
  return rewardForDurationBase(durationDays, cfg) / BigInt(durationDays);
}

const XP_TIER_LABELS = ["Bronze", "Silver", "Gold", "Diamond"] as const;

export function PublicDashboard() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { push: pushToast } = useToast();

  const [config, setConfig] = useState<Awaited<ReturnType<typeof fetchConfig>> | null>(null);
  const [nowTs, setNowTs] = useState<number | null>(null);
  const [positions, setPositions] = useState<
    Array<{ pubkey: string; data: ReturnType<typeof decodeUserPositionAccount> }>
  >([]);
  const [stakingPositions, setStakingPositions] = useState<
    Array<{ pubkey: string; data: ReturnType<typeof decodeStakingPositionAccount> }>
  >([]);
  const [xntBalanceUi, setXntBalanceUi] = useState<string | null>(null);
  const [mindBalanceUi, setMindBalanceUi] = useState<string | null>(null);
  const [mindBalanceBase, setMindBalanceBase] = useState<bigint>(0n);
  const [stakingVaultXntBalanceUi, setStakingVaultXntBalanceUi] = useState<string | null>(null);
  const [stakingVaultXntBalanceBase, setStakingVaultXntBalanceBase] = useState<bigint | null>(null);
  const [stakingVaultMindBalanceUi, setStakingVaultMindBalanceUi] = useState<string | null>(null);
  const [rewardPoolHistory, setRewardPoolHistory] = useState<Array<{ ts: number; amount: bigint }>>([]);
  const [userProfile, setUserProfile] = useState<ReturnType<typeof decodeUserProfileAccount> | null>(null);

  const [durationDays, setDurationDays] = useState<7 | 14 | 30>(14);
  const [stakeDurationDays, setStakeDurationDays] = useState<7 | 14 | 30 | 60>(30);
  const [stakeAmountUi, setStakeAmountUi] = useState("");
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentEpoch = useMemo(() => {
    if (!config || nowTs == null) return null;
    return getCurrentEpochFrom(config, nowTs);
  }, [config, nowTs]);

  const emissionNotStarted = useMemo(() => {
    if (!config || nowTs == null) return false;
    return nowTs < config.emissionStartTs.toNumber();
  }, [config, nowTs]);

  const nextEpochCountdown = useMemo(() => {
    if (!config || nowTs == null) return null;
    if (nowTs < config.emissionStartTs.toNumber()) {
      return { label: "starts in", seconds: Math.max(0, config.emissionStartTs.toNumber() - nowTs) };
    }
    const epoch = getCurrentEpochFrom(config, nowTs);
    const epochStart = config.emissionStartTs.toNumber() + epoch * config.epochSeconds.toNumber();
    const nextStart = epochStart + config.epochSeconds.toNumber();
    return { label: "next epoch in", seconds: Math.max(0, nextStart - nowTs) };
  }, [config, nowTs]);

  const activePositions = useMemo(() => {
    if (nowTs == null) return [];
    return positions.filter((p) => p.data.lockedAmount > 0n && nowTs < p.data.lockEndTs);
  }, [positions, nowTs]);

  const anyActive = activePositions.length > 0;

  const refresh = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const cfg = await fetchConfig(connection);
      setConfig(cfg);
      const ts = await fetchClockUnixTs(connection);
      setNowTs(ts);

      try {
        const vaultBalance = await connection.getTokenAccountBalance(cfg.stakingVaultXntAta, "confirmed");
        const base = BigInt(vaultBalance.value.amount || "0");
        setStakingVaultXntBalanceBase(base);
        setStakingVaultXntBalanceUi(formatTokenAmount(base, cfg.xntDecimals, 6));
      } catch {
        setStakingVaultXntBalanceBase(null);
        setStakingVaultXntBalanceUi(null);
      }

      try {
        const vaultMind = await connection.getTokenAccountBalance(cfg.stakingVaultMindAta, "confirmed");
        setStakingVaultMindBalanceUi(
          formatTokenAmount(BigInt(vaultMind.value.amount || "0"), cfg.mindDecimals, 6)
        );
      } catch {
        setStakingVaultMindBalanceUi(null);
      }

      if (!publicKey) {
        setPositions([]);
        setStakingPositions([]);
        setXntBalanceUi(null);
        setMindBalanceUi(null);
        setMindBalanceBase(0n);
        setStakingVaultXntBalanceBase(null);
        setUserProfile(null);
        return;
      }

      const programId = getProgramId();
      const [positionsGpa, stakingGpa, profileAcc] = await Promise.all([
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [
            { dataSize: 93 },
            { memcmp: { offset: 8, bytes: publicKey.toBase58() } },
          ],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ memcmp: { offset: 8, bytes: publicKey.toBase58() } }],
        }),
        connection.getAccountInfo(deriveUserProfilePda(publicKey), "confirmed"),
      ]);

      const decoded = positionsGpa
        .map((a) => ({
          pubkey: a.pubkey.toBase58(),
          data: decodeUserPositionAccount(Buffer.from(a.account.data)),
        }))
        .sort((a, b) => b.data.lockStartTs - a.data.lockStartTs);
      setPositions(decoded);

      const decodedStakes = stakingGpa
        .map((a) => ({
          pubkey: a.pubkey.toBase58(),
          data: decodeStakingPositionAccount(Buffer.from(a.account.data)),
        }))
        .sort((a, b) => b.data.startTs - a.data.startTs);
      setStakingPositions(decodedStakes);

      setUserProfile(profileAcc?.data ? decodeUserProfileAccount(Buffer.from(profileAcc.data)) : null);

      const xntMint = cfg.xntMint;
      if (xntMint.equals(NATIVE_MINT)) {
        const lamports = await connection.getBalance(publicKey, "confirmed");
        setXntBalanceUi(formatTokenAmount(BigInt(lamports), 9, 6));
      } else {
        const ownerXntAta = getAssociatedTokenAddressSync(xntMint, publicKey);
        setXntBalanceUi(await fetchTokenBalanceUi(connection, ownerXntAta));
      }

      const userMindAta = getAssociatedTokenAddressSync(cfg.mindMint, publicKey);
      try {
        const mindBalance = await connection.getTokenAccountBalance(userMindAta, "confirmed");
        const amountBase = BigInt(mindBalance.value.amount || "0");
        setMindBalanceBase(amountBase);
        setMindBalanceUi(mindBalance.value.uiAmountString ?? "0");
      } catch {
        setMindBalanceBase(0n);
        setMindBalanceUi("0");
      }

    } catch (e: unknown) {
      console.error(e);
      setError(formatError(e));
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("pocm_reward_pool_history");
      if (!raw) return;
      const parsed = JSON.parse(raw) as Array<{ ts: number; amount: string }>;
      if (!Array.isArray(parsed)) return;
      setRewardPoolHistory(
        parsed
          .filter((p) => typeof p.ts === "number" && typeof p.amount === "string")
          .map((p) => ({ ts: p.ts, amount: BigInt(p.amount) }))
      );
    } catch {
      // ignore corrupted cache
    }
  }, []);

  useEffect(() => {
    if (stakingVaultXntBalanceBase == null || nowTs == null) return;
    setRewardPoolHistory((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (!last || nowTs - last.ts >= 60) {
        next.push({ ts: nowTs, amount: stakingVaultXntBalanceBase });
      } else {
        next[next.length - 1] = { ts: nowTs, amount: stakingVaultXntBalanceBase };
      }
      const cutoff = nowTs - 24 * 60 * 60;
      const trimmed = next.filter((p) => p.ts >= cutoff).slice(-64);
      try {
        localStorage.setItem(
          "pocm_reward_pool_history",
          JSON.stringify(trimmed.map((p) => ({ ts: p.ts, amount: p.amount.toString() })))
        );
      } catch {
        // ignore storage quota
      }
      return trimmed;
    });
  }, [nowTs, stakingVaultXntBalanceBase]);

  const rewardPoolSeries = useMemo(() => {
    if (rewardPoolHistory.length < 2) return null;
    const amounts = rewardPoolHistory.map((p) => p.amount);
    let min = amounts[0];
    let max = amounts[0];
    for (const v of amounts) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const span = max > min ? max - min : 1n;
    const points = rewardPoolHistory.map((p, idx) => {
      const x = (idx / Math.max(1, rewardPoolHistory.length - 1)) * 100;
      const y = 100 - Number(((p.amount - min) * 100n) / span);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    return { points: points.join(" "), min, max };
  }, [rewardPoolHistory]);

  const estimateStakeRewardParts = useCallback(
    (
      amountBase: bigint,
      boostBps: number,
      durationDays: number,
      totalWeighted: bigint,
      vaultBase: bigint
    ) => {
      if (amountBase <= 0n || totalWeighted <= 0n || vaultBase <= 0n) return null;
      const durationMult =
        durationDays === 7 ? 10_000n : durationDays === 14 ? 11_000n : durationDays === 30 ? 12_500n : 15_000n;
      const baseWeight = (amountBase * durationMult) / 10_000n;
      const boostedWeight = (baseWeight * BigInt(10_000 + boostBps)) / 10_000n;
      const base = (vaultBase * baseWeight) / totalWeighted;
      const boosted = (vaultBase * boostedWeight) / totalWeighted;
      return { base, boosted };
    },
    []
  );

  const stakeEstimate = useMemo(() => {
    if (!config || !userProfile || stakingVaultXntBalanceBase == null) return null;
    try {
      const amountBase = parseUiAmountToBase(stakeAmountUi, config.mindDecimals);
      if (amountBase <= 0n) return null;
      const totalWeighted = BigInt(config.totalStakedMind.toString());
      return estimateStakeRewardParts(
        amountBase,
        userProfile.xpBoostBps,
        stakeDurationDays,
        totalWeighted,
        stakingVaultXntBalanceBase
      );
    } catch {
      return null;
    }
  }, [
    config,
    estimateStakeRewardParts,
    stakeAmountUi,
    stakeDurationDays,
    stakingVaultXntBalanceBase,
    userProfile,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const id = window.setInterval(() => void refresh().catch(() => null), 15_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const signAndSend = useCallback(
    async (tx: Transaction) => {
      if (!publicKey) throw new Error("Connect a wallet first");
      if (!signTransaction) throw new Error("Wallet does not support signTransaction");
      tx.feePayer = publicKey;
      const latest = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = latest.blockhash;
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await connection.confirmTransaction(
        {
          signature: sig,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        "confirmed"
      );
      return sig;
    },
    [connection, publicKey, signTransaction]
  );

  const withTx = useCallback(
    async (label: string, fn: () => Promise<string>) => {
      setError(null);
      setLastSig(null);
      pushToast({ title: label, description: "Confirm in your wallet…", variant: "info" });
      try {
        const sig = await fn();
        setLastSig(sig);
        pushToast({ title: "Transaction confirmed", description: shortPk(sig, 6), variant: "success" });
        await refresh();
        return sig;
      } catch (e: unknown) {
        const msg = formatError(e);
        setError(msg);
        pushToast({
          title: msg.includes("Plugin Closed") ? "Wallet action required" : "Transaction failed",
          description: msg.includes("Plugin Closed") ? "Open/unlock the wallet and retry." : "See error details on the page.",
          variant: "error",
        });
        throw e;
      }
    },
    [pushToast, refresh]
  );

  const onDeposit = async () => {
    if (!publicKey) throw new Error("Connect a wallet first");
    if (!anchorWallet) throw new Error("Wallet is not ready for Anchor");
    if (!config) throw new Error("Config not loaded");
    if (busy) return;
    if (emissionNotStarted) throw new Error(`Mining not started yet (start=${config.emissionStartTs.toNumber()})`);

    const feeBase = planFeeBase(durationDays, config.xntDecimals);
    const xntMint = config.xntMint;

    setBusy("buy");
    try {
      await withTx("Buy mining position", async () => {
        const program = getProgram(connection, anchorWallet);
        const tx = new Transaction();

        // Determine next position index from UserProfile PDA (or 0 if missing).
        const profilePda = deriveUserProfilePda(publicKey);
        const profileAcc = await connection.getAccountInfo(profilePda, "confirmed");
        const nextIndex = profileAcc?.data
          ? decodeUserProfileAccount(Buffer.from(profileAcc.data)).nextPositionIndex
          : 0n;

        const positionPda = derivePositionPdaV2(publicKey, nextIndex);

        const ownerXntAta = getAssociatedTokenAddressSync(xntMint, publicKey);
        const vaultAuthority = deriveVaultPda();
        const vaultXntAta = getAssociatedTokenAddressSync(xntMint, vaultAuthority, true);
        const stakingVaultXntAta = config.stakingVaultXntAta;

        tx.add(
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey,
            ownerXntAta,
            publicKey,
            xntMint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );

        if (xntMint.equals(NATIVE_MINT)) {
          tx.add(
            SystemProgram.transfer({
              fromPubkey: publicKey,
              toPubkey: ownerXntAta,
              lamports: safeBigintToNumber(feeBase),
            }),
            createSyncNativeInstruction(ownerXntAta)
          );
        }

        const createIx = await program.methods
          .createPosition(durationDays, new BN(nextIndex.toString()))
          .accounts({
            owner: publicKey,
            config: deriveConfigPda(),
            userProfile: profilePda,
            position: positionPda,
            systemProgram: SystemProgram.programId,
          })
          .instruction();
        tx.add(createIx);

        const depositIx = await program.methods
          .deposit(new BN(feeBase.toString()))
          .accounts({
            owner: publicKey,
            config: deriveConfigPda(),
            userProfile: profilePda,
            position: positionPda,
            vaultAuthority,
            xntMint,
            vaultXntAta,
            stakingVaultXntAta,
            ownerXntAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();
        tx.add(depositIx);

        return await signAndSend(tx);
      });
    } finally {
      setBusy(null);
    }
  };

  const onClaim = async (amountBase: bigint) => {
    if (!publicKey) throw new Error("Connect a wallet first");
    if (!anchorWallet) throw new Error("Wallet is not ready for Anchor");
    if (!config) throw new Error("Config not loaded");
    if (busy) return;
    if (!positions.some((p) => p.data.lockedAmount > 0n)) throw new Error("No miners found");
    if (amountBase <= 0n) throw new Error("Amount must be greater than 0");

    setBusy("claim");
    try {
      await withTx("Claim", async () => {
        const program = getProgram(connection, anchorWallet);
        const vaultAuthority = deriveVaultPda();
        const userMindAta = getAssociatedTokenAddressSync(config.mindMint, publicKey);
        const ix = await program.methods
          .claim(new BN(amountBase.toString()))
          .accounts({
            owner: publicKey,
            config: deriveConfigPda(),
            vaultAuthority,
            mindMint: config.mindMint,
            userMindAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(
            positions
              .filter((p) => p.data.lockedAmount > 0n)
              .map((p) => ({
                pubkey: new PublicKey(p.pubkey),
                isSigner: false,
                isWritable: true,
              }))
          )
          .instruction();
        const tx = new Transaction().add(ix);
        return await signAndSend(tx);
      });
    } finally {
      setBusy(null);
    }
  };

const onStake = async () => {
  if (!publicKey) throw new Error("Connect a wallet first");
  if (!anchorWallet) throw new Error("Wallet is not ready for Anchor");
  if (!config) throw new Error("Config not loaded");
  if (!userProfile) throw new Error("Your profile is not ready yet");
  if (busy) return;

  const amountBase = parseUiAmountToBase(stakeAmountUi, config.mindDecimals);
  if (amountBase <= 0n) throw new Error("Amount must be greater than 0");
  if (amountBase > mindBalanceBase) throw new Error("Insufficient MIND balance");

  setBusy("stake");
  try {
    await withTx("Stake MIND", async () => {
      const program = getProgram(connection, anchorWallet);
      const ownerMindAta = getAssociatedTokenAddressSync(config.mindMint, publicKey);
      const stakingPositionPda = deriveStakingPositionPda(publicKey, userProfile.nextStakeIndex);
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey,
          ownerMindAta,
          publicKey,
          config.mindMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
      const ix = await program.methods
        .createStake(
          stakeDurationDays,
          new BN(userProfile.nextStakeIndex.toString()),
          new BN(amountBase.toString())
        )
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          userProfile: deriveUserProfilePda(publicKey),
          stakingPosition: stakingPositionPda,
          vaultAuthority: deriveVaultPda(),
          stakingVaultMindAta: config.stakingVaultMindAta,
          ownerMindAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction();
      tx.add(ix);
      return await signAndSend(tx);
    });
    setStakeAmountUi("");
  } finally {
    setBusy(null);
  }
};

const onClaimStake = async (
  stake: { pubkey: string; data: ReturnType<typeof decodeStakingPositionAccount> },
  amountBase: bigint
) => {
  if (!publicKey) throw new Error("Connect a wallet first");
  if (!anchorWallet) throw new Error("Wallet is not ready for Anchor");
  if (!config) throw new Error("Config not loaded");
  if (busy) return;
  if (amountBase <= 0n) throw new Error("Amount must be greater than 0");

  const stakeIndex = stake.data.stakeIndex;
  const busyLabel = `claim-stake-${stake.pubkey}` as BusyAction;
  setBusy(busyLabel);
  try {
    await withTx("Claim staking reward", async () => {
      const program = getProgram(connection, anchorWallet);
      const ownerXntAta = getAssociatedTokenAddressSync(config.xntMint, publicKey);
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey,
          ownerXntAta,
          publicKey,
          config.xntMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
      const ix = await program.methods
        .claimStakeReward(new BN(stakeIndex.toString()), new BN(amountBase.toString()))
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          stakingPosition: new PublicKey(stake.pubkey),
          vaultAuthority: deriveVaultPda(),
          stakingVaultXntAta: config.stakingVaultXntAta,
          ownerXntAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      tx.add(ix);
      return await signAndSend(tx);
    });
  } finally {
    setBusy(null);
  }
};

const onWithdrawStake = async (stake: { pubkey: string; data: ReturnType<typeof decodeStakingPositionAccount> }) => {
  if (!publicKey) throw new Error("Connect a wallet first");
  if (!anchorWallet) throw new Error("Wallet is not ready for Anchor");
  if (!config) throw new Error("Config not loaded");
  if (busy) return;

  const busyLabel = `withdraw-stake-${stake.pubkey}` as BusyAction;
  setBusy(busyLabel);
  try {
    await withTx("Withdraw stake", async () => {
      const program = getProgram(connection, anchorWallet);
      const ownerMindAta = getAssociatedTokenAddressSync(config.mindMint, publicKey);
      const ix = await program.methods
        .withdrawStake(new BN(stake.data.stakeIndex.toString()))
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          stakingPosition: new PublicKey(stake.pubkey),
          vaultAuthority: deriveVaultPda(),
          stakingVaultMindAta: config.stakingVaultMindAta,
          ownerMindAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      return await signAndSend(new Transaction().add(ix));
    });
  } finally {
    setBusy(null);
  }
};

  const onClosePosition = async (positionPubkey: string) => {
    if (!publicKey) throw new Error("Connect a wallet first");
    if (!anchorWallet) throw new Error("Wallet is not ready for Anchor");
    if (busy) return;

    setBusy("close");
    try {
      await withTx("Close position", async () => {
        const program = getProgram(connection, anchorWallet);
        const ix = await program.methods
          .withdraw()
          .accounts({
            owner: publicKey,
            position: new PublicKey(positionPubkey),
            systemProgram: SystemProgram.programId,
          })
          .instruction();
        return await signAndSend(new Transaction().add(ix));
      });
    } finally {
      setBusy(null);
    }
  };

  const estimatedRewardBase = useMemo(() => {
    if (!config) return null;
    const total = activePositions.reduce((acc, position) => {
      if (
        position.data.durationDays !== 7 &&
        position.data.durationDays !== 14 &&
        position.data.durationDays !== 28 &&
        position.data.durationDays !== 30
      ) {
        return acc;
      }
      return acc + rewardPerEpochBase(position.data.durationDays, config);
    }, 0n);
    return total > 0n ? total : null;
  }, [activePositions, config]);

  const xpStats = useMemo(() => {
    if (!config || !userProfile) return null;
    const xpValue = BigInt(userProfile.miningXp.toString());
    const thresholds = [
      0n,
      BigInt(config.xpTierSilver.toString()),
      BigInt(config.xpTierGold.toString()),
      BigInt(config.xpTierDiamond.toString()),
    ];
    const tier = Math.min(Number(userProfile.xpTier), XP_TIER_LABELS.length - 1);
    const floor = thresholds[tier];
    const nextThreshold = tier < thresholds.length - 1 ? thresholds[tier + 1] : null;
    const baseDiff = nextThreshold && nextThreshold > floor ? nextThreshold - floor : 1n;
    const relative = xpValue > floor ? xpValue - floor : 0n;
    const progress = nextThreshold
      ? Math.min(
          100,
          Number(((relative * 100n) / baseDiff).toString())
        )
      : 100;
    const remaining = nextThreshold && xpValue < nextThreshold ? nextThreshold - xpValue : 0n;
    return {
      tier,
      tierName: XP_TIER_LABELS[tier],
      boostBps: userProfile.xpBoostBps,
      progress,
      remaining,
      nextTierName: nextThreshold ? XP_TIER_LABELS[tier + 1] : null,
    };
  }, [config, userProfile]);

  const planOptions: MiningPlanOption[] = config
    ? [
        { d: 7, mult: "1.0x", price: "0.1", xp: config.xpPer7d.toString() },
        { d: 14, mult: "1.25x", price: "1", xp: config.xpPer14d.toString() },
        { d: 30, mult: "1.5x", price: "5", xp: config.xpPer30d.toString() },
      ]
    : [
        { d: 7, mult: "1.0x", price: "0.1", xp: "—" },
        { d: 14, mult: "1.25x", price: "1", xp: "—" },
        { d: 30, mult: "1.5x", price: "5", xp: "—" },
      ];

  const handleStakeMax = () => {
    if (!config) return;
    setStakeAmountUi(formatTokenAmount(mindBalanceBase, config.mindDecimals, config.mindDecimals));
  };

  const [activeTab, setActiveTab] = useState<"mine" | "stake" | "xp">("mine");

  const dashboardValue = useMemo(
    () => ({
      publicKey,
      config,
      nowTs,
      currentEpoch,
      nextEpochCountdown,
      positions,
      activePositions,
      anyActive,
      stakingPositions,
      durationDays,
      setDurationDays,
      planOptions,
      emissionNotStarted,
      onDeposit,
      onClaim,
      onClosePosition,
      onStake,
      onClaimStake,
      onWithdrawStake,
      busy,
      loading,
      error,
      lastSig,
      refresh,
      xntBalanceUi,
      mindBalanceUi,
      mindBalanceBase,
      stakingVaultXntBalanceUi,
      stakingVaultXntBalanceBase,
      stakingVaultMindBalanceUi,
      stakeAmountUi,
      setStakeAmountUi,
      stakeDurationDays,
      setStakeDurationDays,
      stakeEstimate,
      handleStakeMax,
      estimatedRewardBase,
      userProfile,
      xpStats,
      rewardPoolSeries,
    }),
    [
      activePositions,
      anyActive,
      busy,
      config,
      currentEpoch,
      durationDays,
      emissionNotStarted,
      estimatedRewardBase,
      error,
      handleStakeMax,
      lastSig,
      loading,
      mindBalanceBase,
      mindBalanceUi,
      nextEpochCountdown,
      nowTs,
      onClaim,
      onClaimStake,
      onClosePosition,
      onDeposit,
      onStake,
      onWithdrawStake,
      planOptions,
      positions,
      publicKey,
      refresh,
      rewardPoolSeries,
      stakeAmountUi,
      stakeDurationDays,
      stakeEstimate,
      stakingPositions,
      stakingVaultMindBalanceUi,
      stakingVaultXntBalanceBase,
      stakingVaultXntBalanceUi,
      userProfile,
      xpStats,
      xntBalanceUi,
      setDurationDays,
      setStakeAmountUi,
      setStakeDurationDays,
    ]
  );

  return (
    <DashboardProvider value={dashboardValue}>
      <div className="min-h-dvh">
        <TopBar
          title="X1 Mining Vault"
          subtitle="Mine XNT • Earn XP • Boost staking"
          link={{ href: "/admin", label: "Admin" }}
          tier={xpStats?.tierName ?? "Bronze"}
          xpProgress={xpStats?.progress ?? null}
          xpNextLabel={xpStats?.nextTierName ? `Next: ${xpStats.nextTierName}` : null}
        />

        <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pb-24 pt-8">
          <MiningControlPanel />
          <MiningActivityPanel />
          <MiningXpHero />

          <SummaryCards />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Tabs
              value={activeTab}
              onValueChange={setActiveTab}
              options={[
                { value: "mine", label: "Mine" },
                { value: "stake", label: "Stake" },
                { value: "xp", label: "XP" },
              ]}
            />
            <Button variant="secondary" onClick={() => void refresh()} disabled={busy !== null || loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          </div>

          {activeTab === "mine" ? <MineSection /> : null}
          {activeTab === "stake" ? <StakeSection /> : null}
          {activeTab === "xp" ? <XPSection /> : null}

          <TransactionStatus />

          {error ? (
            <Card className="border-rose-500/30">
              <CardHeader
                title="Error"
                description="RPC or simulation details."
                right={
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" onClick={() => void refresh()} disabled={loading}>
                      {loading ? "Retrying…" : "Retry"}
                    </Button>
                    <Badge variant="danger">failed</Badge>
                  </div>
                }
              />
              <pre className="mt-3 whitespace-pre-wrap rounded-2xl border border-white/10 bg-ink/80 p-3 text-xs text-rose-100">
                {error}
              </pre>
            </Card>
          ) : null}
        </main>
      </div>
    </DashboardProvider>
  );
}
