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
import Link from "next/link";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { NetworkBadge } from "@/components/shared/NetworkBadge";
import { CopyButton } from "@/components/shared/CopyButton";
import { useToast } from "@/components/shared/ToastProvider";
import { getProgram } from "@/lib/anchor";
import {
  deriveConfigPda,
  deriveEpochPda,
  deriveStakingPositionPda,
  deriveUserEpochPda,
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
  decodeEpochStateAccount,
  decodeStakingPositionAccount,
  decodeUserEpochAccount,
  decodeUserPositionAccount,
  decodeUserProfileAccount,
} from "@/lib/decoders";
import { explorerTxUrl, formatDurationSeconds, formatTokenAmount, formatUnixTs, parseUiAmountToBase, shortPk } from "@/lib/format";
import { formatError } from "@/lib/formatError";

function safeBigintToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount is too large");
  return Number(value);
}

function formatEpochCountdown(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";
  return formatDurationSeconds(seconds);
}

function planFeeBase(durationDays: 7 | 14 | 28, decimals: number): bigint {
  const base = 10n ** BigInt(decimals);
  if (durationDays === 7) return base / 10n; // 0.1
  if (durationDays === 14) return base; // 1
  return base * 5n; // 5
}

function formatBps(bps: number) {
  const percent = bps / 100;
  return `${percent % 1 === 0 ? percent.toFixed(0) : percent.toFixed(2)}%`;
}

function computeEstimatedReward(args: {
  dailyEmission: bigint;
  totalEffectiveMp: bigint;
  userMp: bigint;
  mpCapBpsPerWallet: number;
  minedCap: bigint;
  minedTotal: bigint;
}) {
  const { dailyEmission, totalEffectiveMp, userMp, mpCapBpsPerWallet, minedCap, minedTotal } = args;
  if (totalEffectiveMp <= 0n) return 0n;
  const capPortion = (totalEffectiveMp * BigInt(mpCapBpsPerWallet)) / 10_000n;
  const cappedUserMp = userMp < capPortion ? userMp : capPortion;
  if (cappedUserMp <= 0n) return 0n;
  const reward = (dailyEmission * cappedUserMp) / totalEffectiveMp;
  const remaining = minedCap > minedTotal ? minedCap - minedTotal : 0n;
  return reward < remaining ? reward : remaining;
}

type BusyAction =
  | "buy"
  | "heartbeat"
  | "claim"
  | "close"
  | "stake"
  | `claim-stake-${string}`
  | `withdraw-stake-${string}`;

const STAKING_COOLDOWN_SECONDS = 7 * 86_400;
const STAKE_DURATIONS: Array<7 | 14 | 30 | 60> = [7, 14, 30, 60];
const XP_TIER_LABELS = ["Bronze", "Silver", "Gold", "Diamond"] as const;
const XP_BADGE_VARIANTS: Array<"muted" | "warning" | "success"> = ["muted", "warning", "success", "success"];

type MiningPlanOption = { d: 7 | 14 | 28; mult: string; price: string; xp: string };

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

  const [epochState, setEpochState] = useState<ReturnType<typeof decodeEpochStateAccount> | null>(null);
  const [userEpoch, setUserEpoch] = useState<ReturnType<typeof decodeUserEpochAccount> | null>(null);
  const [userProfile, setUserProfile] = useState<ReturnType<typeof decodeUserProfileAccount> | null>(null);

  const [durationDays, setDurationDays] = useState<7 | 14 | 28>(14);
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

  const heartbeatDone = useMemo(() => {
    if (!userEpoch || currentEpoch == null) return false;
    return userEpoch.epochIndex === BigInt(currentEpoch);
  }, [userEpoch, currentEpoch]);

  const claimed = !!userEpoch?.claimed;

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
        setEpochState(null);
        setUserEpoch(null);
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
          filters: [
            { dataSize: 85 },
            { memcmp: { offset: 8, bytes: publicKey.toBase58() } },
          ],
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

      const epoch = getCurrentEpochFrom(cfg, ts);
      const epochStatePda = deriveEpochPda(epoch);
      const userEpochPda = deriveUserEpochPda(publicKey, epoch);
      const [epochAcc, userAcc] = await Promise.all([
        connection.getAccountInfo(epochStatePda, "confirmed"),
        connection.getAccountInfo(userEpochPda, "confirmed"),
      ]);
      setEpochState(epochAcc?.data ? decodeEpochStateAccount(Buffer.from(epochAcc.data)) : null);
      setUserEpoch(userAcc?.data ? decodeUserEpochAccount(Buffer.from(userAcc.data)) : null);
    } catch (e: unknown) {
      console.error(e);
      setError(formatError(e));
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey]);

  const estimateStakeRewardBase = useCallback(
    (amountBase: bigint, boostBps: number, totalStakedBase: bigint, vaultBase: bigint) => {
      if (amountBase <= 0n || totalStakedBase <= 0n || vaultBase <= 0n) return null;
      const rewardBase = (vaultBase * amountBase) / totalStakedBase;
      const reward = (rewardBase * BigInt(10_000 + boostBps)) / 10_000n;
      return reward;
    },
    []
  );

  const stakeEstimateBase = useMemo(() => {
    if (!config || !userProfile || stakingVaultXntBalanceBase == null) return null;
    try {
      const amountBase = parseUiAmountToBase(stakeAmountUi, config.mindDecimals);
      if (amountBase <= 0n) return null;
      const totalStaked = BigInt(config.totalStakedMind.toString()) + amountBase;
      return estimateStakeRewardBase(
        amountBase,
        userProfile.xpBoostBps,
        totalStaked,
        stakingVaultXntBalanceBase
      );
    } catch {
      return null;
    }
  }, [config, estimateStakeRewardBase, stakeAmountUi, stakingVaultXntBalanceBase, userProfile]);

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
      if (heartbeatDone && nextEpochCountdown) {
        pushToast({
          title: "Heads up",
          description: `You already heartbeated this epoch. This miner starts earning ${nextEpochCountdown.label} ${formatEpochCountdown(
            nextEpochCountdown.seconds
          )}.`,
          variant: "info",
        });
      }
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

  const onHeartbeat = async () => {
    if (!publicKey) throw new Error("Connect a wallet first");
    if (!anchorWallet) throw new Error("Wallet is not ready for Anchor");
    if (!config) throw new Error("Config not loaded");
    if (busy) return;
    if (!anyActive) throw new Error("Deposit first");
    const epoch = currentEpoch;
    if (epoch == null) throw new Error("Epoch not available");
    if (heartbeatDone) throw new Error("Heartbeat already recorded for this epoch");

    setBusy("heartbeat");
    try {
      await withTx("Heartbeat", async () => {
        const program = getProgram(connection, anchorWallet);
        const epochStatePda = deriveEpochPda(epoch);
        const userEpochPda = deriveUserEpochPda(publicKey, epoch);
        const ix = await program.methods
          .heartbeat(new BN(epoch))
          .accounts({
            owner: publicKey,
            config: deriveConfigPda(),
            epochState: epochStatePda,
            userEpoch: userEpochPda,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(
            activePositions.map((p) => ({
              pubkey: new PublicKey(p.pubkey),
              isSigner: false,
              isWritable: false,
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

  const onClaim = async () => {
    if (!publicKey) throw new Error("Connect a wallet first");
    if (!anchorWallet) throw new Error("Wallet is not ready for Anchor");
    if (!config) throw new Error("Config not loaded");
    if (busy) return;
    if (!anyActive) throw new Error("Deposit first");
    if (!heartbeatDone) throw new Error("Heartbeat required");
    if (claimed) throw new Error("Already claimed for this epoch");
    const epoch = currentEpoch;
    if (epoch == null) throw new Error("Epoch not available");

    setBusy("claim");
    try {
      await withTx("Claim", async () => {
        const program = getProgram(connection, anchorWallet);
        const epochStatePda = deriveEpochPda(epoch);
        const userEpochPda = deriveUserEpochPda(publicKey, epoch);
        const vaultAuthority = deriveVaultPda();
        const userMindAta = getAssociatedTokenAddressSync(config.mindMint, publicKey);
        const ix = await program.methods
          .claim()
          .accounts({
            owner: publicKey,
            config: deriveConfigPda(),
            vaultAuthority,
            epochState: epochStatePda,
            userEpoch: userEpochPda,
            mindMint: config.mindMint,
            userMindAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
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

const onClaimStake = async (stake: { pubkey: string; data: ReturnType<typeof decodeStakingPositionAccount> }) => {
  if (!publicKey) throw new Error("Connect a wallet first");
  if (!anchorWallet) throw new Error("Wallet is not ready for Anchor");
  if (!config) throw new Error("Config not loaded");
  if (busy) return;

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
        .claimStakeReward(new BN(stakeIndex.toString()))
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
    if (!config || !epochState || !userEpoch) return null;
    return computeEstimatedReward({
      dailyEmission: epochState.dailyEmission,
      totalEffectiveMp: epochState.totalEffectiveMp,
      userMp: userEpoch.userMp,
      mpCapBpsPerWallet: config.mpCapBpsPerWallet,
      minedCap: BigInt(config.minedCap.toString()),
      minedTotal: BigInt(config.minedTotal.toString()),
    });
  }, [config, epochState, userEpoch]);

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
        { d: 14, mult: "1.2x", price: "1", xp: config.xpPer14d.toString() },
        { d: 28, mult: "1.4x", price: "5", xp: config.xpPer30d.toString() },
      ]
    : [
        { d: 7, mult: "1.0x", price: "0.1", xp: "—" },
        { d: 14, mult: "1.2x", price: "1", xp: "—" },
        { d: 28, mult: "1.4x", price: "5", xp: "—" },
      ];

  const handleStakeMax = () => {
    if (!config) return;
    setStakeAmountUi(formatTokenAmount(mindBalanceBase, config.mindDecimals, config.mindDecimals));
  };

  const xpTierVariant = xpStats
    ? XP_BADGE_VARIANTS[Math.min(xpStats.tier, XP_BADGE_VARIANTS.length - 1)]
    : "muted";

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-white/5 bg-zinc-950/40 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-cyan-400/30 to-fuchsia-500/20 ring-1 ring-white/10" />
            <div>
              <div className="text-sm font-semibold leading-tight">PoCM Vault Mining</div>
              <div className="text-[11px] text-zinc-400">XNT mining + XP-powered staking rewards</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link className="text-xs text-zinc-300 hover:text-white" href="/admin">
              Admin
            </Link>
            <WalletMultiButton />
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-4 px-4 pb-24 pt-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Mining & staking{" "}
              <span className="bg-gradient-to-r from-cyan-200 to-fuchsia-200 bg-clip-text text-transparent">
                Testnet
              </span>
            </h1>
            <div className="mt-2 text-sm text-zinc-400">
              Zero-backend dashboard. All state is pulled directly from-chain.
            </div>
            <div className="mt-3">
              <NetworkBadge />
            </div>
          </div>
          {publicKey ? (
            <div className="flex items-center gap-2">
              <Badge variant="muted">Wallet: {shortPk(publicKey.toBase58(), 6)}</Badge>
              <CopyButton text={publicKey.toBase58()} label="Copy" />
            </div>
          ) : (
            <Badge variant="warning">Connect wallet to start</Badge>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-12">
          <div className="md:col-span-7">
            <Card>
              <CardHeader
                title="Status overview"
                description="Live epoch, emission & miner metadata."
                right={
                  <Button variant="secondary" onClick={() => void refresh()} disabled={busy !== null || loading}>
                    {loading ? "Refreshing…" : "Refresh"}
                  </Button>
                }
              />
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-zinc-400">Current epoch</div>
                  <div className="mt-1 font-mono text-lg">
                    {currentEpoch == null ? <Skeleton className="h-6 w-24" /> : currentEpoch}
                  </div>
                  {nextEpochCountdown ? (
                    <div className="mt-2 text-xs text-zinc-400">
                      {nextEpochCountdown.label}{" "}
                      <span className="font-mono text-zinc-200">
                        {formatEpochCountdown(nextEpochCountdown.seconds)}
                      </span>
                    </div>
                  ) : null}
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-zinc-400">On-chain clock</div>
                  <div className="mt-1 font-mono text-sm">{nowTs == null ? "(loading)" : formatUnixTs(nowTs)}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-zinc-400">Emission</div>
                  {config ? (
                    <div className="mt-1 text-sm text-zinc-200">
                      <div className="font-mono">
                        {formatTokenAmount(BigInt(config.minedTotal.toString()), config.mindDecimals, 2)} /{" "}
                        {formatTokenAmount(BigInt(config.minedCap.toString()), config.mindDecimals, 2)} MIND
                      </div>
                      <div className="mt-1 text-xs text-zinc-400">
                        start: {formatUnixTs(config.emissionStartTs.toNumber())}
                      </div>
                    </div>
                  ) : (
                    <Skeleton className="h-10 w-full" />
                  )}
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-zinc-400">Position status</div>
                  <div className="mt-1 text-sm text-zinc-200">
                    {!publicKey ? (
                      <Badge variant="muted">not connected</Badge>
                    ) : positions.length === 0 ? (
                      <Badge variant="warning">no miners yet</Badge>
                    ) : anyActive ? (
                      <Badge variant="success">active miners</Badge>
                    ) : (
                      <Badge variant="muted">no active lock</Badge>
                    )}
                  </div>
                  <div className="mt-2 text-xs text-zinc-500">Miners: {positions.length}</div>
                </div>
              </div>
              {xpStats && (
                <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-semibold text-zinc-100">XP tier</div>
                    <Badge variant={xpTierVariant}>
                      {xpStats.tierName} • +{formatBps(xpStats.boostBps)} boost
                    </Badge>
                    <div className="text-xs text-zinc-400">Total XP: {userProfile?.miningXp.toString()}</div>
                  </div>
                  <div className="mt-3 h-1.5 w-full rounded-full bg-white/10">
                    <div
                      className="h-1.5 rounded-full bg-gradient-to-r from-cyan-400 to-fuchsia-500 transition-all"
                      style={{ width: `${xpStats.progress}%` }}
                    />
                  </div>
                  <div className="mt-2 text-xs text-zinc-400">
                    {xpStats.nextTierName
                      ? `${xpStats.remaining.toString()} XP to ${xpStats.nextTierName}`
                      : "Max tier unlocked"}
                  </div>
                </div>
              )}
              {emissionNotStarted && config ? (
                <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-950/20 p-3 text-sm text-amber-100">
                  Mining has not yet started. Emission start:{" "}
                  <span className="font-mono">{formatUnixTs(config.emissionStartTs.toNumber())}</span>
                </div>
              ) : null}
            </Card>
          </div>

          <div className="md:col-span-5">
            <Card>
              <CardHeader
                title="Position"
                description={
                  anyActive
                    ? "Active miners require epoch heartbeats + claims."
                    : "Buy miners and stack XP for staking boosts."
                }
                right={
                  config ? (
                    <Badge variant="muted">{config.xntMint.equals(NATIVE_MINT) ? "XNT = wSOL" : "XNT = SPL"}</Badge>
                  ) : null
                }
              />

              {!publicKey ? (
                <div className="mt-4 text-sm text-zinc-400">Connect wallet to buy miners.</div>
              ) : (
                <div className="mt-4 grid gap-4">
                  <div className="grid gap-3">
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-zinc-400">XNT balance</div>
                      <div className="font-mono text-xs text-zinc-300">
                        {xntBalanceUi ?? "(loading)"}
                      </div>
                    </div>
                    <div className="text-xs text-zinc-400">Choose a plan</div>
                    <div className="grid grid-cols-3 gap-2">
                      {planOptions.map((opt) => (
                        <button
                          key={opt.d}
                          type="button"
                          onClick={() => setDurationDays(opt.d)}
                          className={[
                            "rounded-2xl border px-3 py-3 text-left transition",
                            durationDays === opt.d
                              ? "border-cyan-400/40 bg-cyan-500/10"
                              : "border-white/10 bg-white/5 hover:bg-white/10",
                          ].join(" ")}
                        >
                          <div className="text-sm font-semibold">{opt.d}d</div>
                          <div className="mt-1 text-xs text-zinc-400">{opt.mult}</div>
                          <div className="mt-1 text-xs text-emerald-300">+{opt.xp} XP</div>
                          <div className="mt-2 text-xs text-zinc-200">{opt.price} XNT</div>
                        </button>
                      ))}
                    </div>
                    <div className="rounded-xl border border-amber-500/20 bg-amber-950/20 p-3 text-xs text-amber-100">
                      Deposit is non-refundable. You can open multiple miners.
                    </div>
                    {publicKey && heartbeatDone && nextEpochCountdown ? (
                      <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-zinc-300">
                        Already heartbeated for this epoch. A new miner begins earning{" "}
                        <span className="font-mono">
                          {nextEpochCountdown.label} {formatEpochCountdown(nextEpochCountdown.seconds)}
                        </span>
                        .
                      </div>
                    ) : null}
                    <Button
                      size="lg"
                      onClick={() => void onDeposit().catch(() => null)}
                      disabled={!config || busy !== null || emissionNotStarted}
                    >
                      {busy === "buy" ? "Submitting…" : "Buy miner"}
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-12">
          <div className="md:col-span-7">
            <Card>
              <CardHeader
                title="XP & boosts"
                description="Every miner adds XP. XP unlocks better staking multipliers."
              />
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="text-xs text-zinc-400">Progress</div>
                  <div className="mt-1 text-sm text-zinc-200">
                    {userProfile ? `${userProfile.miningXp.toString()} XP collected` : (
                      <Skeleton className="h-5 w-24" />
                    )}
                  </div>
                  <div className="mt-3 h-1.5 w-full rounded-full bg-white/10">
                    <div
                      className="h-1.5 rounded-full bg-gradient-to-r from-cyan-400 to-fuchsia-500"
                      style={{ width: `${xpStats?.progress ?? 0}%` }}
                    />
                  </div>
                  <div className="mt-2 text-xs text-zinc-400">
                    XP boosts staking by up to +{formatBps(xpStats?.boostBps ?? 0)}.
                  </div>
                  <div className="mt-3 text-xs text-zinc-500">
                    {xpStats?.nextTierName
                      ? `${xpStats.remaining.toString()} XP to ${xpStats.nextTierName}`
                      : "At max tier"}
                  </div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="text-xs text-zinc-400">Tier thresholds</div>
                  <div className="mt-2 grid gap-2">
                    <div className="flex items-center justify-between text-xs text-zinc-300">
                      <span>Silver</span>
                      <span>
                        {config?.xpTierSilver.toString() ?? "-"} XP • +{formatBps(config?.xpBoostSilverBps ?? 0)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-zinc-300">
                      <span>Gold</span>
                      <span>
                        {config?.xpTierGold.toString() ?? "-"} XP • +{formatBps(config?.xpBoostGoldBps ?? 0)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-zinc-300">
                      <span>Diamond</span>
                      <span>
                        {config?.xpTierDiamond.toString() ?? "-"} XP • +{formatBps(config?.xpBoostDiamondBps ?? 0)}
                      </span>
                    </div>
                  </div>
                  <div className="mt-3 text-xs text-zinc-500">
                    Total XP minted: {config ? config.totalXp.toString() : "-"}.
                  </div>
                </div>
              </div>
              <div className="mt-4 text-xs text-zinc-500">
                25% of every miner purchase is reserved for the staking vault. XP only affects staking boosts.
              </div>
            </Card>
          </div>

          <div className="md:col-span-5">
            <Card>
              <CardHeader
                title="Staking vault"
                description="Rewards pool for MIND stakes (25% of deposits + admin top-ups)."
              />
              <div className="mt-3 grid gap-3">
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-zinc-400">XNT liquidity</div>
                  <div className="mt-1 font-mono text-sm">{stakingVaultXntBalanceUi ?? "loading..."}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-zinc-400">Staked MIND</div>
                  <div className="mt-1 font-mono text-sm">
                    {config
                      ? formatTokenAmount(BigInt(config.totalStakedMind.toString()), config.mindDecimals, 4)
                      : "-"}
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-zinc-400">Vault MIND balance</div>
                  <div className="mt-1 font-mono text-sm">{stakingVaultMindBalanceUi ?? "loading..."}</div>
                </div>
              </div>
              <div className="mt-5 border-t border-white/5 pt-4">
                <div className="text-xs text-zinc-400">Stake MIND</div>
                <div className="mt-2 grid gap-2">
                  <Input
                    value={stakeAmountUi}
                    onChange={setStakeAmountUi}
                    placeholder="Amount (MIND)"
                    disabled={busy !== null}
                    right={
                      <button
                        type="button"
                        className="rounded-full border border-white/10 px-2 py-1 text-[11px] text-zinc-200 hover:border-cyan-400/40"
                        onClick={handleStakeMax}
                        disabled={!config || mindBalanceBase === 0n}
                      >
                        Max
                      </button>
                    }
                  />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {STAKE_DURATIONS.map((days) => (
                    <button
                      key={days}
                      type="button"
                      onClick={() => setStakeDurationDays(days)}
                      className={[
                        "rounded-2xl border px-3 py-2 text-sm transition",
                        stakeDurationDays === days
                          ? "border-cyan-400/40 bg-cyan-500/10"
                          : "border-white/10 bg-white/5 hover:bg-white/10",
                      ].join(" ")}
                    >
                      {days}d
                    </button>
                  ))}
                </div>
                <div className="mt-4">
                  <Button
                    size="lg"
                    onClick={() => void onStake().catch(() => null)}
                    disabled={!config || busy !== null || !stakeAmountUi}
                  >
                    {busy === "stake" ? "Submitting…" : "Stake MIND"}
                  </Button>
                </div>
                <div className="mt-2 text-xs text-zinc-400">
                  Est. weekly reward:{" "}
                  <span className="font-mono text-zinc-200">
                    {config && stakeEstimateBase != null
                      ? `${formatTokenAmount(stakeEstimateBase, config.xntDecimals, 6)} XNT`
                      : "-"}
                  </span>
                </div>
                <div className="mt-2 text-xs text-zinc-500">
                  Claim once every 7 days. Withdraw after the lock expires.
                </div>
                <div className="mt-1 text-[11px] text-zinc-500">
                  Estimate uses current vault XNT and total staked MIND. Actual reward depends on pool at claim time.
                </div>
              </div>
            </Card>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-12">
          <div className="md:col-span-7">
            <Card>
              <CardHeader title="Epoch actions" description="Needed when you have an active lock." />
              {nextEpochCountdown && (
                <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-zinc-300">
                  {nextEpochCountdown.label}{" "}
                  <span className="font-mono text-zinc-100">{formatEpochCountdown(nextEpochCountdown.seconds)}</span>
                </div>
              )}
              {!publicKey ? (
                <div className="mt-4 text-sm text-zinc-400">Connect wallet to heartbeat & claim.</div>
              ) : !anyActive ? (
                <div className="mt-4 text-sm text-zinc-400">
                  Buy a miner to participate in the current epoch.
                </div>
              ) : (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold">Heartbeat</div>
                        <div className="mt-1 text-xs text-zinc-400">Record mining power this epoch.</div>
                      </div>
                      <Badge variant={heartbeatDone ? "success" : "warning"}>
                        {heartbeatDone ? "done" : "required"}
                      </Badge>
                    </div>
                    <div className="mt-4">
                      <Button
                        onClick={() => void onHeartbeat().catch(() => null)}
                        disabled={busy !== null || heartbeatDone || currentEpoch == null}
                        title={
                          heartbeatDone
                            ? nextEpochCountdown
                              ? `Already recorded. ${formatEpochCountdown(nextEpochCountdown.seconds)} until next epoch.`
                              : "Already recorded"
                            : currentEpoch == null
                              ? "Epoch unavailable"
                              : undefined
                        }
                      >
                        {busy === "heartbeat" ? "Submitting…" : "Heartbeat current epoch"}
                      </Button>
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold">Claim</div>
                        <div className="mt-1 text-xs text-zinc-400">Mint MIND rewards.</div>
                      </div>
                      <Badge variant={claimed ? "muted" : heartbeatDone ? "success" : "warning"}>
                        {claimed ? "claimed" : heartbeatDone ? "claimable" : "needs heartbeat"}
                      </Badge>
                    </div>
                    <div className="mt-3 text-xs text-zinc-400">
                      Est. reward:{" "}
                      <span className="font-mono text-zinc-200">
                        {config && estimatedRewardBase != null
                          ? `${formatTokenAmount(estimatedRewardBase, config.mindDecimals, 4)} MIND`
                          : "-"}
                      </span>
                    </div>
                    <div className="mt-4">
                      <Button
                        onClick={() => void onClaim().catch(() => null)}
                        disabled={busy !== null || !heartbeatDone || claimed}
                        title={!heartbeatDone ? "Heartbeat required" : claimed ? "Already claimed" : undefined}
                      >
                        {busy === "claim" ? "Submitting…" : "Claim current epoch"}
                      </Button>
                    </div>
                    <div className="mt-3 text-xs text-zinc-400">
                      MIND balance: <span className="font-mono text-zinc-200">{mindBalanceUi ?? "(loading)"}</span>
                    </div>
                  </div>
                </div>
              )}
            </Card>
          </div>
          <div className="md:col-span-5">
            <Card>
              <CardHeader title="Your miners" description="Each purchase is a standalone position." />
              {!publicKey ? (
                <div className="mt-4 text-sm text-zinc-400">Connect wallet to explore miners.</div>
              ) : positions.length === 0 ? (
                <div className="mt-4 text-sm text-zinc-400">No miners yet.</div>
              ) : (
                <div className="mt-4 grid gap-2">
                  {positions.slice(0, 5).map((p) => {
                    const active = nowTs != null && p.data.lockedAmount > 0n && nowTs < p.data.lockEndTs;
                    const remaining = nowTs != null ? Math.max(0, p.data.lockEndTs - nowTs) : null;
                    const ended = nowTs != null && p.data.lockedAmount > 0n && nowTs >= p.data.lockEndTs;
                    const inactive = p.data.lockedAmount === 0n;
                    return (
                      <div key={p.pubkey} className="rounded-2xl border border-white/10 bg-white/5 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="text-xs text-zinc-400">Position</div>
                            <div className="mt-1 font-mono text-xs text-zinc-200">{shortPk(p.pubkey, 8)}</div>
                          </div>
                          <Badge variant={active ? "success" : inactive ? "warning" : "muted"}>
                            {active ? "active" : inactive ? "inactive" : ended ? "completed" : "inactive"}
                          </Badge>
                        </div>
                        <div className="mt-2 text-xs text-zinc-400">
                          paid:{" "}
                          <span className="font-mono text-zinc-200">
                            {config ? `${formatTokenAmount(p.data.lockedAmount, config.xntDecimals, 6)} XNT` : "-"}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-zinc-400">
                          duration: <span className="font-mono text-zinc-200">{p.data.durationDays}d</span>
                        </div>
                        <div className="mt-1 text-xs text-zinc-400">
                          ends: <span className="font-mono text-zinc-200">{formatUnixTs(p.data.lockEndTs)}</span>
                        </div>
                        {active ? (
                          <div className="mt-2 text-xs text-zinc-400">
                            remaining:{" "}
                            <span className="font-mono text-zinc-200">
                              {remaining == null ? "-" : formatDurationSeconds(remaining)}
                            </span>
                          </div>
                        ) : ended ? (
                          <div className="mt-3 flex items-center justify-between gap-3">
                            <div className="text-xs text-zinc-500">
                              Lock ended. Close to reclaim rent.
                            </div>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy !== null}
                              onClick={() => void onClosePosition(p.pubkey).catch(() => null)}
                            >
                              Close
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  {positions.length > 5 ? (
                    <div className="text-xs text-zinc-500">Showing the 5 most recent miners.</div>
                  ) : null}
                </div>
              )}
            </Card>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-12">
          <div className="md:col-span-12">
            <Card>
              <CardHeader title="Your stakes" description="Weekly claims. Multiple stakes allowed." />
              {!publicKey ? (
                <div className="mt-4 text-sm text-zinc-400">Connect wallet to view stakes.</div>
              ) : stakingPositions.length === 0 ? (
                <div className="mt-4 text-sm text-zinc-400">No MIND stakes yet.</div>
              ) : (
                <div className="mt-4 grid gap-3">
                  {stakingPositions.map((stake) => {
                    const lockEndTs = stake.data.lockEndTs;
                    const startTs = stake.data.startTs;
                    const amount = stake.data.amount;
                    const totalStakedBase = config ? BigInt(config.totalStakedMind.toString()) : 0n;
                    const rewardEstimateBase =
                      config && stakingVaultXntBalanceBase != null
                        ? estimateStakeRewardBase(
                            amount,
                            stake.data.xpBoostBps,
                            totalStakedBase,
                            stakingVaultXntBalanceBase
                          )
                        : null;
                    const lockTotal = Math.max(1, lockEndTs - startTs);
                    const elapsed = nowTs != null ? Math.max(0, Math.min(nowTs - startTs, lockTotal)) : 0;
                    const progress = Math.min(100, Math.floor((elapsed / lockTotal) * 100));
                    const claimReady =
                      nowTs != null &&
                      nowTs >= stake.data.lastClaimTs + STAKING_COOLDOWN_SECONDS;
                    const nextClaimIn =
                      nowTs != null
                        ? Math.max(0, stake.data.lastClaimTs + STAKING_COOLDOWN_SECONDS - nowTs)
                        : null;
                    const unlocked = nowTs != null && nowTs >= lockEndTs;
                    const claimLabel = `claim-stake-${stake.pubkey}` as BusyAction;
                    const withdrawLabel = `withdraw-stake-${stake.pubkey}` as BusyAction;
                    return (
                      <div key={stake.pubkey} className="rounded-2xl border border-white/10 bg-white/5 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="text-xs text-zinc-400">Stake</div>
                            <div className="mt-1 font-mono text-xs text-zinc-200">{shortPk(stake.pubkey, 8)}</div>
                          </div>
                          <Badge variant={unlocked ? "success" : "warning"}>
                            {unlocked ? "unlocked" : "locked"}
                          </Badge>
                        </div>
                        <div className="mt-2 text-xs text-zinc-400">
                          amount:{" "}
                          <span className="font-mono text-zinc-200">
                            {config
                              ? `${formatTokenAmount(amount, config.mindDecimals, 6)} MIND`
                              : "-"}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-zinc-400">
                          duration: <span className="font-mono text-zinc-200">{stake.data.durationDays}d</span>
                        </div>
                        <div className="mt-1 text-xs text-zinc-400">
                          ends: <span className="font-mono text-zinc-200">{formatUnixTs(lockEndTs)}</span>
                        </div>
                        <div className="mt-2 text-xs text-zinc-400">
                          XP boost: <span className="font-mono text-zinc-200">+{formatBps(stake.data.xpBoostBps)}</span>
                        </div>
                        <div className="mt-2 text-xs text-zinc-400">
                          Est. weekly reward:{" "}
                          <span className="font-mono text-zinc-200">
                            {config && rewardEstimateBase != null
                              ? `${formatTokenAmount(rewardEstimateBase, config.xntDecimals, 6)} XNT`
                              : "-"}
                          </span>
                        </div>
                        <div className="mt-3 h-1.5 w-full rounded-full bg-white/10">
                          <div
                            className="h-1.5 rounded-full bg-gradient-to-r from-cyan-400 to-fuchsia-500"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            onClick={() => void onClaimStake(stake).catch(() => null)}
                            disabled={busy !== null || !claimReady}
                            title={claimReady ? undefined : "Claim available once per 7 days"}
                          >
                            {busy === claimLabel ? "Submitting…" : "Claim reward"}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void onWithdrawStake(stake).catch(() => null)}
                            disabled={busy !== null || !unlocked}
                            title={!unlocked ? "Lock needs to end first" : undefined}
                          >
                            {busy === withdrawLabel ? "Submitting…" : "Withdraw stake"}
                          </Button>
                        </div>
                        <div className="mt-2 text-xs text-zinc-500">
                          {claimReady ? (
                            <span className="text-emerald-300">Claim ready</span>
                          ) : nextClaimIn != null ? (
                            <>
                              Next claim in{" "}
                              <span className="font-mono text-zinc-200">
                                {formatDurationSeconds(nextClaimIn)}
                              </span>
                            </>
                          ) : (
                            "Claim info pending"
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>
        </div>

        {lastSig && (
          <Card>
            <CardHeader
              title="Transaction"
              description="Most recent confirmed signature."
              right={<CopyButton text={lastSig} label="Copy sig" />}
            />
            <div className="mt-3 flex flex-col gap-2">
              <div className="rounded-xl border border-white/10 bg-white/5 p-3 font-mono text-xs">{lastSig}</div>
              <div className="flex items-center gap-2">
                <a
                  className="text-xs text-cyan-200 underline-offset-4 hover:underline"
                  href={explorerTxUrl(lastSig)}
                  target="_blank"
                  rel="noreferrer"
                >
                  View in explorer
                </a>
                <Badge variant="muted">Program: {shortPk(getProgramId().toBase58(), 6)}</Badge>
              </div>
            </div>
          </Card>
        )}

        {error && (
          <Card className="border-rose-500/20">
            <CardHeader
              title="Error"
              description="Simulation/RPC details."
              right={
                <div className="flex items-center gap-2">
                  <Button variant="secondary" onClick={() => void refresh()} disabled={loading}>
                    {loading ? "Retrying…" : "Retry"}
                  </Button>
                  <Badge variant="danger">failed</Badge>
                </div>
              }
            />
            <pre className="mt-3 whitespace-pre-wrap rounded-xl border border-white/10 bg-zinc-950/40 p-3 text-xs text-rose-100">
              {error}
            </pre>
          </Card>
        )}

        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-white/5 bg-zinc-950/40 backdrop-blur-xl md:hidden">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
            <div className="text-xs text-zinc-400">
              {publicKey ? (anyActive ? "Mining active" : "Ready to buy") : "Connect wallet"}
            </div>
            <Button
              size="lg"
              disabled={
                busy !== null ||
                !publicKey ||
                emissionNotStarted ||
                (anyActive && heartbeatDone && claimed)
              }
              onClick={() => {
                if (!publicKey) return;
                if (!anyActive) void onDeposit();
                else if (!heartbeatDone) void onHeartbeat();
                else if (!claimed) void onClaim();
              }}
              title={!publicKey ? "Connect wallet" : undefined}
            >
              {busy ? "Working…" : !anyActive ? "Buy" : !heartbeatDone ? "Heartbeat" : !claimed ? "Claim" : "Up to date"}
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
