"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { Card, Field, Button, Input } from "@/components/Ui";
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
import { getProgram } from "@/lib/anchor";
import { formatError } from "@/lib/formatError";

export function PublicPanel() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, sendTransaction } = useWallet();
  const anchorWallet = useAnchorWallet();

  const [config, setConfig] = useState<Awaited<ReturnType<typeof fetchConfig>> | null>(null);
  const [nowTs, setNowTs] = useState<number | null>(null);
  const [positionExists, setPositionExists] = useState<boolean | null>(null);
  const [mintBalance, setMintBalance] = useState<string | null>(null);
  const [depositAmount, setDepositAmount] = useState("2");
  const [durationDays, setDurationDays] = useState("14");
  const [busy, setBusy] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    const cfg = await fetchConfig(connection);
    setConfig(cfg);
    const ts = await fetchClockUnixTs(connection);
    setNowTs(ts);

    if (publicKey) {
      const pos = derivePositionPda(publicKey);
      const info = await connection.getAccountInfo(pos, "confirmed");
      setPositionExists(!!info);
      const userMindAta = getAssociatedTokenAddressSync(cfg.mindMint, publicKey);
      setMintBalance(await fetchTokenBalanceUi(connection, userMindAta));
    } else {
      setPositionExists(null);
      setMintBalance(null);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const currentEpoch = useMemo(() => {
    if (!config || nowTs == null) return null;
    return getCurrentEpochFrom(config, nowTs);
  }, [config, nowTs]);

  const ensureWallet = () => {
    if (!publicKey) throw new Error("Connect a wallet first");
    if (!anchorWallet) throw new Error("Wallet is not ready for Anchor");
    if (!signTransaction) throw new Error("Wallet does not support signTransaction");
  };

  const createPosition = async () => {
    ensureWallet();
    if (!config) throw new Error("Config not loaded");
    setBusy("createPosition");
    setLastSig(null);
    setError(null);
    try {
      const program = getProgram(connection, anchorWallet!);
      const days = Number(durationDays);
      if (!Number.isFinite(days) || days <= 0) throw new Error("Invalid durationDays");
      const position = derivePositionPda(publicKey!);
      const sig = await program.methods
        .createPosition(days)
        .accounts({
          owner: publicKey!,
          config: deriveConfigPda(),
          position,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      setLastSig(sig);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const deposit = async () => {
    ensureWallet();
    if (!config) throw new Error("Config not loaded");
    setBusy("deposit");
    setLastSig(null);
    setError(null);
    try {
      const program = getProgram(connection, anchorWallet!);
      const xntMint = config.xntMint;
      const amountUi = Number(depositAmount);
      if (!Number.isFinite(amountUi) || amountUi <= 0) throw new Error("Invalid amount");
      const amountBase = BigInt(Math.floor(amountUi * 10 ** config.xntDecimals));

      const ownerXntAta = getAssociatedTokenAddressSync(xntMint, publicKey!);
      const vaultAuthority = deriveVaultPda();
      const vaultXntAta = getAssociatedTokenAddressSync(xntMint, vaultAuthority, true);

      const tx = new Transaction();

      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey!,
          ownerXntAta,
          publicKey!,
          xntMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );

      if (xntMint.equals(NATIVE_MINT)) {
        tx.add(
          SystemProgram.transfer({
            fromPubkey: publicKey!,
            toPubkey: ownerXntAta,
            lamports: amountBase,
          }),
          createSyncNativeInstruction(ownerXntAta)
        );
      }

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");

      const amountBn = new BN(amountBase.toString());
      const position = derivePositionPda(publicKey!);
      const sig2 = await program.methods
        .deposit(amountBn)
        .accounts({
          owner: publicKey!,
          config: deriveConfigPda(),
          position,
          vaultAuthority,
          xntMint,
          vaultXntAta,
          ownerXntAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      setLastSig(sig2);
      await refresh();
    } catch (e: any) {
      setError(formatError(e));
      throw e;
    } finally {
      setBusy(null);
    }
  };

  const heartbeat = async () => {
    ensureWallet();
    if (!config) throw new Error("Config not loaded");
    const epoch = currentEpoch;
    if (epoch == null) throw new Error("Epoch not available");
    setBusy("heartbeat");
    setLastSig(null);
    setError(null);
    try {
      const program = getProgram(connection, anchorWallet!);
      const epochState = deriveEpochPda(epoch);
      const userEpoch = deriveUserEpochPda(publicKey!, epoch);
      const sig = await program.methods
        .heartbeat(new BN(epoch))
        .accounts({
          owner: publicKey!,
          config: deriveConfigPda(),
          position: derivePositionPda(publicKey!),
          epochState,
          userEpoch,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      setLastSig(sig);
      await refresh();
    } catch (e: any) {
      setError(formatError(e));
      throw e;
    } finally {
      setBusy(null);
    }
  };

  const claim = async () => {
    ensureWallet();
    if (!config) throw new Error("Config not loaded");
    const epoch = currentEpoch;
    if (epoch == null) throw new Error("Epoch not available");
    setBusy("claim");
    setLastSig(null);
    setError(null);
    try {
      const program = getProgram(connection, anchorWallet!);
      const epochState = deriveEpochPda(epoch);
      const userEpoch = deriveUserEpochPda(publicKey!, epoch);
      const vaultAuthority = deriveVaultPda();
      const userMindAta = getAssociatedTokenAddressSync(config.mindMint, publicKey!);
      const sig = await program.methods
        .claim()
        .accounts({
          owner: publicKey!,
          config: deriveConfigPda(),
          vaultAuthority,
          position: derivePositionPda(publicKey!),
          epochState,
          userEpoch,
          mindMint: config.mindMint,
          userMindAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      setLastSig(sig);
      await refresh();
    } catch (e: any) {
      setError(formatError(e));
      throw e;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-4">
      <Card title="Config">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Program ID" value={PROGRAM_ID.toBase58()} />
          <Field label="Config PDA" value={deriveConfigPda().toBase58()} />
          <Field label="XNT mint" value={config?.xntMint.toBase58() ?? "(loading)"} />
          <Field label="MIND mint" value={config?.mindMint.toBase58() ?? "(loading)"} />
          <Field label="Epoch seconds" value={config ? config.epochSeconds.toString() : "(loading)"} />
          <Field label="Current epoch" value={currentEpoch ?? "(loading)"} />
        </div>
        <div className="mt-3">
          <Button onClick={() => void refresh()} disabled={busy !== null}>
            Refresh
          </Button>
        </div>
      </Card>

      <Card title="Your status">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Position"
            value={
              publicKey
                ? `${positionExists ? "exists" : "missing"} (${derivePositionPda(publicKey).toBase58()})`
                : "(connect wallet)"
            }
          />
          <Field label="MIND balance" value={mintBalance ?? "(connect wallet)"} />
        </div>
      </Card>

      <Card title="Actions">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-2">
            <div className="text-xs text-zinc-400">Create position</div>
            <Input value={durationDays} onChange={setDurationDays} placeholder="duration days (7/14/30)" />
            <Button
              disabled={!publicKey || busy !== null}
              onClick={() => void createPosition().catch((e) => setError(formatError(e)))}
            >
              {busy === "createPosition" ? "Working..." : "Create position"}
            </Button>
          </div>

          <div className="grid gap-2">
            <div className="text-xs text-zinc-400">
              Deposit XNT ({config?.xntMint.equals(NATIVE_MINT) ? "wSOL" : "SPL"})
            </div>
            <Input value={depositAmount} onChange={setDepositAmount} placeholder="amount (XNT)" />
            <Button
              disabled={!publicKey || busy !== null}
              onClick={() => void deposit().catch((e) => setError(formatError(e)))}
            >
              {busy === "deposit" ? "Working..." : "Deposit"}
            </Button>
          </div>

          <div className="grid gap-2">
            <div className="text-xs text-zinc-400">Heartbeat</div>
            <Button
              disabled={!publicKey || busy !== null}
              onClick={() => void heartbeat().catch((e) => setError(formatError(e)))}
            >
              {busy === "heartbeat" ? "Working..." : "Heartbeat current epoch"}
            </Button>
          </div>

          <div className="grid gap-2">
            <div className="text-xs text-zinc-400">Claim</div>
            <Button
              disabled={!publicKey || busy !== null}
              onClick={() => void claim().catch((e) => setError(formatError(e)))}
            >
              {busy === "claim" ? "Working..." : "Claim current epoch"}
            </Button>
          </div>
        </div>

        {lastSig ? (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs">
            last tx: {lastSig}
          </div>
        ) : null}
        {error ? (
          <div className="mt-4 rounded-lg border border-red-900/60 bg-red-950/40 p-3 text-sm text-red-200">
            {error}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
