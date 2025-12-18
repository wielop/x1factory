"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import { SystemProgram, Transaction } from "@solana/web3.js";
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
  PROGRAM_ID,
  deriveConfigPda,
  deriveEpochPda,
  derivePositionPda,
  deriveUserEpochPda,
  deriveVaultPda,
  fetchClockUnixTs,
  fetchConfig,
  fetchTokenBalanceUi,
  getCurrentEpochFrom,
} from "@/lib/solana";
import { decodeEpochStateAccount, decodeUserEpochAccount, decodeUserPositionAccount } from "@/lib/decoders";
import { explorerTxUrl, formatDurationSeconds, formatTokenAmount, formatUnixTs, parseUiAmountToBase, shortPk } from "@/lib/format";
import { formatError } from "@/lib/formatError";

function safeBigintToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount is too large");
  return Number(value);
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

export function PublicDashboard() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { push: pushToast } = useToast();

  const [config, setConfig] = useState<Awaited<ReturnType<typeof fetchConfig>> | null>(null);
  const [nowTs, setNowTs] = useState<number | null>(null);
  const [positionInfo, setPositionInfo] = useState<ReturnType<typeof decodeUserPositionAccount> | null>(null);
  const [xntBalanceUi, setXntBalanceUi] = useState<string | null>(null);
  const [mindBalanceUi, setMindBalanceUi] = useState<string | null>(null);

  const [epochState, setEpochState] = useState<ReturnType<typeof decodeEpochStateAccount> | null>(null);
  const [userEpoch, setUserEpoch] = useState<ReturnType<typeof decodeUserEpochAccount> | null>(null);

  const [durationDays, setDurationDays] = useState<7 | 14 | 30>(14);
  const [depositAmountUi, setDepositAmountUi] = useState("2");
  const [busy, setBusy] = useState<null | "deposit" | "heartbeat" | "claim" | "create">(null);
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

  const positionPda = useMemo(() => (publicKey ? derivePositionPda(publicKey) : null), [publicKey]);
  const positionExists = !!positionPda && positionInfo !== null;
  const positionHasAmount = !!positionInfo && positionInfo.lockedAmount > 0n;
  const positionActive =
    !!positionInfo && positionInfo.lockedAmount > 0n && nowTs != null && nowTs < positionInfo.lockEndTs;
  const positionEnded =
    !!positionInfo && positionInfo.lockedAmount > 0n && nowTs != null && nowTs >= positionInfo.lockEndTs;

  const heartbeatDone = useMemo(() => {
    if (!userEpoch || currentEpoch == null) return false;
    return userEpoch.epochIndex === BigInt(currentEpoch);
  }, [userEpoch, currentEpoch]);

  const claimed = !!userEpoch?.claimed;

  const refresh = useCallback(async () => {
    setError(null);
    const cfg = await fetchConfig(connection);
    setConfig(cfg);
    const ts = await fetchClockUnixTs(connection);
    setNowTs(ts);

    if (!publicKey) {
      setPositionInfo(null);
      setXntBalanceUi(null);
      setMindBalanceUi(null);
      setEpochState(null);
      setUserEpoch(null);
      return;
    }

    const pos = derivePositionPda(publicKey);
    const posAcc = await connection.getAccountInfo(pos, "confirmed");
    setPositionInfo(posAcc?.data ? decodeUserPositionAccount(Buffer.from(posAcc.data)) : null);

    const xntMint = cfg.xntMint;
    if (xntMint.equals(NATIVE_MINT)) {
      const lamports = await connection.getBalance(publicKey, "confirmed");
      setXntBalanceUi(formatTokenAmount(BigInt(lamports), 9, 6));
    } else {
      const ownerXntAta = getAssociatedTokenAddressSync(xntMint, publicKey);
      setXntBalanceUi(await fetchTokenBalanceUi(connection, ownerXntAta));
    }

    const userMindAta = getAssociatedTokenAddressSync(cfg.mindMint, publicKey);
    setMindBalanceUi(await fetchTokenBalanceUi(connection, userMindAta));

    const epoch = currentEpoch ?? getCurrentEpochFrom(cfg, ts);
    const epochStatePda = deriveEpochPda(epoch);
    const userEpochPda = deriveUserEpochPda(publicKey, epoch);
    const [epochAcc, userAcc] = await Promise.all([
      connection.getAccountInfo(epochStatePda, "confirmed"),
      connection.getAccountInfo(userEpochPda, "confirmed"),
    ]);
    setEpochState(epochAcc?.data ? decodeEpochStateAccount(Buffer.from(epochAcc.data)) : null);
    setUserEpoch(userAcc?.data ? decodeUserEpochAccount(Buffer.from(userAcc.data)) : null);
  }, [connection, publicKey, currentEpoch]);

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

    const xntMint = config.xntMint;
    const amountBase = parseUiAmountToBase(depositAmountUi, config.xntDecimals);
    if (amountBase <= 0n) throw new Error("Amount must be > 0");

    if (positionActive) throw new Error("Position already active");

    setBusy("deposit");
    try {
      await withTx(positionExists ? (positionEnded ? "Renew mining cycle" : "Deposit") : "Create position + Deposit", async () => {
        const program = getProgram(connection, anchorWallet);
        const tx = new Transaction();

        const position = derivePositionPda(publicKey);
        const posAcc = await connection.getAccountInfo(position, "confirmed");
        if (!posAcc) {
          const createIx = await program.methods
            .createPosition(durationDays)
            .accounts({
              owner: publicKey,
              config: deriveConfigPda(),
              position,
              systemProgram: SystemProgram.programId,
            })
            .instruction();
          tx.add(createIx);
        } else {
          const decoded = decodeUserPositionAccount(Buffer.from(posAcc.data));
          if (decoded.lockedAmount > 0n) {
            if (nowTs == null) throw new Error("Clock not loaded");
            if (nowTs < decoded.lockEndTs) throw new Error("PositionActive");
          }
        }

        const ownerXntAta = getAssociatedTokenAddressSync(xntMint, publicKey);
        const vaultAuthority = deriveVaultPda();
        const vaultXntAta = getAssociatedTokenAddressSync(xntMint, vaultAuthority, true);

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
              lamports: safeBigintToNumber(amountBase),
            }),
            createSyncNativeInstruction(ownerXntAta)
          );
        }

        const depositIx = await program.methods
          .deposit(new BN(amountBase.toString()))
          .accounts({
            owner: publicKey,
            config: deriveConfigPda(),
            position,
            vaultAuthority,
            xntMint,
            vaultXntAta,
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
    if (!positionActive) throw new Error("Deposit first");
    const epoch = currentEpoch;
    if (epoch == null) throw new Error("Epoch not available");
    if (heartbeatDone) throw new Error("Heartbeat already recorded for this epoch");

    setBusy("heartbeat");
    try {
      await withTx("Heartbeat", async () => {
        const program = getProgram(connection, anchorWallet);
        const position = derivePositionPda(publicKey);
        const epochStatePda = deriveEpochPda(epoch);
        const userEpochPda = deriveUserEpochPda(publicKey, epoch);
        const ix = await program.methods
          .heartbeat(new BN(epoch))
          .accounts({
            owner: publicKey,
            config: deriveConfigPda(),
            position,
            epochState: epochStatePda,
            userEpoch: userEpochPda,
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

  const onClaim = async () => {
    if (!publicKey) throw new Error("Connect a wallet first");
    if (!anchorWallet) throw new Error("Wallet is not ready for Anchor");
    if (!config) throw new Error("Config not loaded");
    if (busy) return;
    if (!positionActive) throw new Error("Deposit first");
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
            position: derivePositionPda(publicKey),
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

  const maxDeposit = async () => {
    if (!publicKey || !config) return;
    try {
      if (config.xntMint.equals(NATIVE_MINT)) {
        const lamports = await connection.getBalance(publicKey, "confirmed");
        const reserve = 10_000_000n; // 0.01 SOL reserve
        const max = BigInt(lamports) > reserve ? BigInt(lamports) - reserve : 0n;
        setDepositAmountUi(formatTokenAmount(max, 9, 6));
      } else {
        const ownerXntAta = getAssociatedTokenAddressSync(config.xntMint, publicKey);
        const bal = await connection.getTokenAccountBalance(ownerXntAta, "confirmed").catch(() => null);
        const amount = bal?.value.amount ? BigInt(bal.value.amount) : 0n;
        setDepositAmountUi(formatTokenAmount(amount, config.xntDecimals, 6));
      }
    } catch {
      // ignore
    }
  };

  const estimatedLockEndTs = useMemo(() => {
    if (!config || nowTs == null) return null;
    const daySeconds = config.allowEpochSecondsEdit ? config.epochSeconds.toNumber() : 86_400;
    return nowTs + durationDays * daySeconds;
  }, [config, nowTs, durationDays]);

  const countdownSeconds = useMemo(() => {
    if (!positionInfo || nowTs == null || positionInfo.lockedAmount === 0n) return null;
    return Math.max(0, positionInfo.lockEndTs - nowTs);
  }, [positionInfo, nowTs]);

  const lockProgress = useMemo(() => {
    if (!positionInfo || nowTs == null || positionInfo.lockedAmount === 0n) return null;
    const total = positionInfo.lockEndTs - positionInfo.lockStartTs;
    if (total <= 0) return 0;
    const done = nowTs - positionInfo.lockStartTs;
    return Math.min(1, Math.max(0, done / total));
  }, [positionInfo, nowTs]);

  const lockProgressPct = useMemo(() => {
    if (lockProgress == null) return 0;
    return Math.round(lockProgress * 100);
  }, [lockProgress]);

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

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-white/5 bg-zinc-950/40 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-cyan-400/30 to-fuchsia-500/20 ring-1 ring-white/10" />
            <div>
              <div className="text-sm font-semibold leading-tight">PoCM Vault Mining</div>
              <div className="text-[11px] text-zinc-400">Deposit → Heartbeat → Claim → Withdraw</div>
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
              Mining Dashboard <span className="text-zinc-400">/</span>{" "}
              <span className="bg-gradient-to-r from-cyan-200 to-fuchsia-200 bg-clip-text text-transparent">
                Testnet
              </span>
            </h1>
            <div className="mt-2 text-sm text-zinc-400">
              Everything is derived on-chain. No backend. Confirm transactions in-wallet.
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
                title="Status Overview"
                description="Live on-chain state (auto-refresh every ~15s)."
                right={<Button variant="secondary" onClick={() => void refresh()} disabled={busy !== null}>Refresh</Button>}
              />
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-zinc-400">Current epoch</div>
                  <div className="mt-1 font-mono text-lg">
                    {currentEpoch == null ? <Skeleton className="h-6 w-24" /> : currentEpoch}
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-zinc-400">On-chain time (Clock)</div>
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
                  <div className="text-xs text-zinc-400">Your position</div>
                  <div className="mt-1 text-sm text-zinc-200">
                    {!publicKey ? (
                      <Badge variant="muted">not connected</Badge>
                    ) : !positionExists ? (
                      <Badge variant="warning">no position</Badge>
                    ) : positionActive ? (
                      <Badge variant="success">active lock</Badge>
                    ) : (
                      <Badge variant="muted">inactive</Badge>
                    )}
                  </div>
                  {publicKey && positionPda ? (
                    <div className="mt-2 text-xs text-zinc-500">
                      PDA: <span className="font-mono">{shortPk(positionPda.toBase58(), 8)}</span>
                    </div>
                  ) : null}
                </div>
              </div>
              {emissionNotStarted && config ? (
                <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-950/20 p-3 text-sm text-amber-100">
                  Mining not started yet. Emission start:{" "}
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
                  positionActive
                    ? "Your lock is active. Heartbeat each epoch and claim rewards."
                    : "Create a position (one-time duration) and deposit XNT to start."
                }
                right={
                  config ? (
                    <Badge variant="muted">{config.xntMint.equals(NATIVE_MINT) ? "XNT = wSOL" : "XNT = SPL"}</Badge>
                  ) : null
                }
              />

              {!publicKey ? (
                <div className="mt-4 text-sm text-zinc-400">Connect your wallet to view position controls.</div>
              ) : (
                <div className="mt-4 grid gap-4">
                  {!positionExists ? (
                    <div className="grid gap-3">
                      <div className="text-xs text-zinc-400">Duration (one-time per wallet)</div>
                      <div className="grid grid-cols-3 gap-2">
                        {([
                          { d: 7, mult: "1.0x" },
                          { d: 14, mult: "1.25x" },
                          { d: 30, mult: "1.5x" },
                        ] as const).map((opt) => (
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
                            <div className="mt-1 text-xs text-zinc-400">{opt.mult} multiplier</div>
                          </button>
                        ))}
                      </div>
                      <div className="rounded-xl border border-amber-500/20 bg-amber-950/20 p-3 text-xs text-amber-100">
                        Deposit is non-refundable (treasury fee). Estimated cycle end:{" "}
                        <span className="font-mono">{estimatedLockEndTs ? formatUnixTs(estimatedLockEndTs) : "-"}</span>
                      </div>
                    </div>
                  ) : null}

                  {positionHasAmount && positionInfo && config ? (
                    <div className="grid gap-3">
                      <div className="grid gap-2 rounded-2xl border border-white/10 bg-white/5 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-xs text-zinc-400">Locked amount</div>
                            <div className="mt-1 font-mono text-lg">
                              {formatTokenAmount(positionInfo.lockedAmount, config.xntDecimals, 6)} XNT
                            </div>
                          </div>
                          <Badge variant={positionActive ? "success" : "muted"}>
                            {positionActive ? "active" : "ended"}
                          </Badge>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-zinc-400">
                          <div>
                            Start: <span className="font-mono text-zinc-200">{formatUnixTs(positionInfo.lockStartTs)}</span>
                          </div>
                          <div>
                            End: <span className="font-mono text-zinc-200">{formatUnixTs(positionInfo.lockEndTs)}</span>
                          </div>
                        </div>
                        <div className="mt-2">
                          <div className="h-2 w-full overflow-hidden rounded-full bg-white/5">
                            <div
                              className="h-full bg-gradient-to-r from-cyan-400/70 to-fuchsia-500/60"
                              style={{ width: `${lockProgressPct}%` }}
                            />
                          </div>
                          <div className="mt-2 flex items-center justify-between text-xs text-zinc-400">
                            <span>Progress</span>
                            <span className="font-mono">
                              {countdownSeconds == null ? "-" : positionEnded ? "ended" : formatDurationSeconds(countdownSeconds)}
                            </span>
                          </div>
                        </div>
                        <div className="mt-2 rounded-xl border border-amber-500/20 bg-amber-950/20 p-3 text-xs text-amber-100">
                          XNT stays in the treasury. When the cycle ends, deposit again to start a new cycle.
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="grid gap-3">
                      <div className="flex items-center justify-between">
                        <div className="text-xs text-zinc-400">XNT balance</div>
                        <div className="font-mono text-xs text-zinc-300">{xntBalanceUi ?? "(loading)"}</div>
                      </div>
                      <div className="rounded-xl border border-amber-500/20 bg-amber-950/20 p-3 text-xs text-amber-100">
                        Deposit is non-refundable (treasury fee).
                      </div>
                      <Input
                        value={depositAmountUi}
                        onChange={setDepositAmountUi}
                        placeholder="0.0"
                        right={
                          <Button variant="ghost" size="sm" onClick={() => void maxDeposit()} disabled={!config}>
                            Max
                          </Button>
                        }
                      />
                      <Button
                        size="lg"
                        onClick={() => void onDeposit().catch(() => null)}
                        disabled={!config || busy !== null || emissionNotStarted || positionActive}
                        title={positionActive ? "Position already active" : undefined}
                      >
                        {busy === "deposit"
                          ? "Submitting…"
                          : positionExists
                            ? positionEnded
                              ? "Renew mining (deposit again)"
                              : "Deposit"
                            : "Create position + Deposit"}
                      </Button>
                      {positionActive ? (
                        <div className="text-xs text-zinc-400">
                          Deposit is blocked because your mining cycle is still active.
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              )}
            </Card>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-12">
          <div className="md:col-span-7">
            <Card>
              <CardHeader title="Epoch Actions" description="These actions are only relevant while your lock is active." />
              {!publicKey ? (
                <div className="mt-4 text-sm text-zinc-400">Connect wallet to see epoch actions.</div>
              ) : !positionActive ? (
                <div className="mt-4 text-sm text-zinc-400">
                  {positionEnded ? "Cycle ended. Renew to keep mining." : "Deposit to activate your mining cycle."}
                </div>
              ) : (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold">Heartbeat</div>
                        <div className="mt-1 text-xs text-zinc-400">Record your mining power for the current epoch.</div>
                      </div>
                      <Badge variant={heartbeatDone ? "success" : "warning"}>{heartbeatDone ? "done" : "required"}</Badge>
                    </div>
                    <div className="mt-4">
                      <Button
                        onClick={() => void onHeartbeat().catch(() => null)}
                        disabled={busy !== null || heartbeatDone || currentEpoch == null}
                        title={heartbeatDone ? "Already recorded" : undefined}
                      >
                        {busy === "heartbeat" ? "Submitting…" : "Heartbeat current epoch"}
                      </Button>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold">Claim</div>
                        <div className="mt-1 text-xs text-zinc-400">Mint MIND rewards for the current epoch.</div>
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
              <CardHeader
                title="Treasury"
                description="Your XNT deposit stays in the protocol treasury (custodial model)."
              />
              {!publicKey ? (
                <div className="mt-4 text-sm text-zinc-400">Connect wallet to see your cycle status.</div>
              ) : !positionHasAmount ? (
                <div className="mt-4 text-sm text-zinc-400">No deposit yet.</div>
              ) : (
                <div className="mt-4 grid gap-3">
                  <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-zinc-400">
                    {positionEnded
                      ? "Cycle ended. Renew by depositing again."
                      : countdownSeconds == null
                        ? "Loading time remaining…"
                        : `Cycle ends in ${formatDurationSeconds(countdownSeconds)}.`}
                  </div>
                  <div className="text-xs text-zinc-500">
                    Funds are held by the program treasury and are not withdrawable by users.
                  </div>
                </div>
              )}
            </Card>
          </div>
        </div>

        {lastSig ? (
          <Card>
            <CardHeader title="Transaction" description="Last confirmed signature." right={<CopyButton text={lastSig} label="Copy sig" />} />
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
                <Badge variant="muted">Program: {shortPk(PROGRAM_ID.toBase58(), 6)}</Badge>
              </div>
            </div>
          </Card>
        ) : null}

        {error ? (
          <Card className="border-rose-500/20">
            <CardHeader title="Error" description="Actionable details from simulation / RPC." right={<Badge variant="danger">failed</Badge>} />
            <pre className="mt-3 whitespace-pre-wrap rounded-xl border border-white/10 bg-zinc-950/40 p-3 text-xs text-rose-100">
              {error}
            </pre>
          </Card>
        ) : null}

        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-white/5 bg-zinc-950/40 backdrop-blur-xl md:hidden">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
            <div className="text-xs text-zinc-400">
              {publicKey
                ? positionActive
                  ? "Mining active"
                  : positionEnded
                    ? "Cycle ended"
                    : "Ready to deposit"
                : "Connect wallet"}
            </div>
            <Button
              size="lg"
              disabled={
                busy !== null ||
                !publicKey ||
                emissionNotStarted ||
                (positionActive && heartbeatDone && claimed)
              }
              onClick={() => {
                if (!publicKey) return;
                if (!positionActive) void onDeposit();
                else if (!heartbeatDone) void onHeartbeat();
                else if (!claimed) void onClaim();
              }}
              title={!publicKey ? "Connect wallet" : undefined}
            >
              {busy ? "Working…" : !positionActive ? (positionEnded ? "Renew" : "Deposit") : !heartbeatDone ? "Heartbeat" : !claimed ? "Claim" : "Up to date"}
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
