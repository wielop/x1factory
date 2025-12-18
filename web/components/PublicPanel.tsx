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
  createCloseAccountInstruction,
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

type DecodedPosition = {
  lockedAmount: bigint;
  lockStartTs: number;
  lockEndTs: number;
  durationDays: number;
};

function decodeUserPositionAccount(data: Buffer): DecodedPosition {
  // Anchor account layout: 8-byte discriminator + fields in struct order.
  // See `programs/pocm_vault_mining/src/lib.rs` `UserPosition`.
  if (data.length < 93) throw new Error(`Position account too small: ${data.length} bytes`);
  let offset = 8; // discriminator
  offset += 32; // owner pubkey
  const lockedAmount = data.readBigUInt64LE(offset);
  offset += 8;
  const lockStartTs = Number(data.readBigInt64LE(offset));
  offset += 8;
  const lockEndTs = Number(data.readBigInt64LE(offset));
  offset += 8;
  const durationDays = data.readUInt16LE(offset);
  return { lockedAmount, lockStartTs, lockEndTs, durationDays };
}

function parseAmountToBaseUnits(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!trimmed) throw new Error("Amount is required");
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("Invalid amount format");
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const base = BigInt(10) ** BigInt(decimals);
  return BigInt(whole) * base + BigInt(fracPadded || "0");
}

function safeBigintToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount is too large");
  return Number(value);
}

export function PublicPanel() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const anchorWallet = useAnchorWallet();

  const [config, setConfig] = useState<Awaited<ReturnType<typeof fetchConfig>> | null>(null);
  const [nowTs, setNowTs] = useState<number | null>(null);
  const [positionExists, setPositionExists] = useState<boolean | null>(null);
  const [position, setPosition] = useState<DecodedPosition | null>(null);
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
      if (info?.data) {
        try {
          setPosition(decodeUserPositionAccount(Buffer.from(info.data)));
        } catch {
          setPosition(null);
        }
      } else {
        setPosition(null);
      }
      const userMindAta = getAssociatedTokenAddressSync(cfg.mindMint, publicKey);
      setMintBalance(await fetchTokenBalanceUi(connection, userMindAta));
    } else {
      setPositionExists(null);
      setPosition(null);
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

  const positionActive = !!position && position.lockedAmount > 0n;
  const positionUnlockable = !!position && position.lockedAmount > 0n && nowTs != null && nowTs >= position.lockEndTs;

  const ensureWallet = () => {
    if (!publicKey) throw new Error("Connect a wallet first");
    if (!anchorWallet) throw new Error("Wallet is not ready for Anchor");
    if (!signTransaction) throw new Error("Wallet does not support signTransaction");
  };

  const signAndSend = async (tx: Transaction) => {
    ensureWallet();
    tx.feePayer = publicKey!;
    const latest = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = latest.blockhash;
    const signed = await signTransaction!(tx);
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
      const tx = new Transaction();
      const ix = await program.methods
        .createPosition(days)
        .accounts({
          owner: publicKey!,
          config: deriveConfigPda(),
          position,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      tx.add(ix);

      const sig = await signAndSend(tx);
      setLastSig(sig);
      await refresh();
    } catch (e: unknown) {
      console.error("[PublicPanel] createPosition failed", e);
      const msg = formatError(e);
      setError(
        msg.includes("Plugin Closed")
          ? `${msg}\n\nTip: unlock the wallet + disable popup blockers, then try again.`
          : msg
      );
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
      const amountBase = parseAmountToBaseUnits(depositAmount, config.xntDecimals);

      const ownerXntAta = getAssociatedTokenAddressSync(xntMint, publicKey!);
      const vaultAuthority = deriveVaultPda();
      const vaultXntAta = getAssociatedTokenAddressSync(xntMint, vaultAuthority, true);

      const tx = new Transaction();

      const position = derivePositionPda(publicKey!);
      const posInfo = await connection.getAccountInfo(position, "confirmed");
      if (!posInfo) {
        const days = Number(durationDays);
        if (!Number.isFinite(days) || days <= 0) throw new Error("Invalid durationDays");
        const createPositionIx = await program.methods
          .createPosition(days)
          .accounts({
            owner: publicKey!,
            config: deriveConfigPda(),
            position,
            systemProgram: SystemProgram.programId,
          })
          .instruction();
        tx.add(createPositionIx);
      } else {
        // Program forbids depositing again if the position is already active.
        const decoded = decodeUserPositionAccount(Buffer.from(posInfo.data));
        if (decoded.lockedAmount > 0n) {
          throw new Error(
            `Position already active (locked=${decoded.lockedAmount}). Wait until unlock, then use Withdraw (not in UI yet), or use a fresh wallet.`
          );
        }
      }

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
            lamports: safeBigintToNumber(amountBase),
          }),
          createSyncNativeInstruction(ownerXntAta)
        );
      }

      const amountBn = new BN(amountBase.toString());
      const depositIx = await program.methods
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
        .instruction();
      tx.add(depositIx);

      const sig = await signAndSend(tx);
      setLastSig(sig);
      await refresh();
    } catch (e: any) {
      console.error("[PublicPanel] deposit failed", e);
      const msg = formatError(e);
      setError(
        msg.includes("Plugin Closed")
          ? `${msg}\n\nTip: unlock the wallet + disable popup blockers, then try again.`
          : msg
      );
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
      const tx = new Transaction();
      const ix = await program.methods
        .heartbeat(new BN(epoch))
        .accounts({
          owner: publicKey!,
          config: deriveConfigPda(),
          position: derivePositionPda(publicKey!),
          epochState,
          userEpoch,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      tx.add(ix);

      const sig = await signAndSend(tx);
      setLastSig(sig);
      await refresh();
    } catch (e: any) {
      console.error("[PublicPanel] heartbeat failed", e);
      const msg = formatError(e);
      setError(
        msg.includes("Plugin Closed")
          ? `${msg}\n\nTip: unlock the wallet + disable popup blockers, then try again.`
          : msg
      );
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
      const tx = new Transaction();
      const ix = await program.methods
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
        .instruction();
      tx.add(ix);

      const sig = await signAndSend(tx);
      setLastSig(sig);
      await refresh();
    } catch (e: any) {
      console.error("[PublicPanel] claim failed", e);
      const msg = formatError(e);
      setError(
        msg.includes("Plugin Closed")
          ? `${msg}\n\nTip: unlock the wallet + disable popup blockers, then try again.`
          : msg
      );
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async () => {
    ensureWallet();
    if (!config) throw new Error("Config not loaded");
    setBusy("withdraw");
    setLastSig(null);
    setError(null);
    try {
      const program = getProgram(connection, anchorWallet!);
      const xntMint = config.xntMint;
      const positionPda = derivePositionPda(publicKey!);

      const posInfo = await connection.getAccountInfo(positionPda, "confirmed");
      if (!posInfo) throw new Error("Position does not exist");
      const decoded = decodeUserPositionAccount(Buffer.from(posInfo.data));
      if (decoded.lockedAmount === 0n) throw new Error("Nothing to withdraw (position inactive)");
      if (nowTs == null) throw new Error("Clock not loaded");
      if (nowTs < decoded.lockEndTs) throw new Error(`Lock not finished yet (unlockTs=${decoded.lockEndTs})`);

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

      const ix = await program.methods
        .withdraw()
        .accounts({
          owner: publicKey!,
          config: deriveConfigPda(),
          position: positionPda,
          vaultAuthority,
          xntMint,
          vaultXntAta,
          ownerXntAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      tx.add(ix);

      // If XNT is actually SOL (wrapped), optionally unwrap back to SOL by closing the ATA.
      if (xntMint.equals(NATIVE_MINT)) {
        tx.add(createCloseAccountInstruction(ownerXntAta, publicKey!, publicKey!));
      }

      const sig = await signAndSend(tx);
      setLastSig(sig);
      await refresh();
    } catch (e: unknown) {
      console.error("[PublicPanel] withdraw failed", e);
      const msg = formatError(e);
      setError(
        msg.includes("Plugin Closed")
          ? `${msg}\n\nTip: unlock the wallet + disable popup blockers, then try again.`
          : msg
      );
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
          <Field
            label="Locked"
            value={
              publicKey
                ? position
                  ? position.lockedAmount > 0n
                    ? `active (locked=${position.lockedAmount})`
                    : "inactive"
                  : "(unknown)"
                : "(connect wallet)"
            }
          />
          <Field
            label="Unlock"
            value={
              publicKey
                ? position && position.lockedAmount > 0n
                  ? nowTs != null
                    ? nowTs >= position.lockEndTs
                      ? "ready"
                      : `in ${position.lockEndTs - nowTs}s`
                    : "(loading)"
                  : "-"
                : "(connect wallet)"
            }
          />
          <Field label="MIND balance" value={mintBalance ?? "(connect wallet)"} />
        </div>
      </Card>

      <Card title="Actions">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-2">
            <div className="text-xs text-zinc-400">
              Lock duration (days) {positionExists ? "(already set for this wallet)" : ""}
            </div>
            <Input value={durationDays} onChange={setDurationDays} placeholder="duration days (7/14/30)" />
            {!positionExists ? (
              <div className="text-xs text-zinc-500">
                This is a one-time choice per wallet (7/14/30). To change it, use a new wallet.
              </div>
            ) : null}
          </div>

          <div className="grid gap-2">
            <div className="text-xs text-zinc-400">
              Deposit XNT ({config?.xntMint.equals(NATIVE_MINT) ? "wSOL" : "SPL"})
            </div>
            <Input value={depositAmount} onChange={setDepositAmount} placeholder="amount (XNT)" />
            <Button
              disabled={!publicKey || busy !== null || positionActive}
              onClick={() => void deposit()}
            >
              {busy === "deposit"
                ? "Working..."
                : positionExists
                  ? "Deposit"
                  : "Create position + Deposit"}
            </Button>
            {positionActive ? (
              <div className="text-xs text-zinc-500">
                Deposit is blocked because your position already has a lock. Use Heartbeat/Claim, then Withdraw after unlock (not in UI yet).
              </div>
            ) : null}
          </div>

          <div className="grid gap-2">
            <div className="text-xs text-zinc-400">Heartbeat</div>
            <Button
              disabled={!publicKey || busy !== null}
              onClick={() => void heartbeat()}
            >
              {busy === "heartbeat" ? "Working..." : "Heartbeat current epoch"}
            </Button>
          </div>

          <div className="grid gap-2">
            <div className="text-xs text-zinc-400">Claim</div>
            <Button
              disabled={!publicKey || busy !== null}
              onClick={() => void claim()}
            >
              {busy === "claim" ? "Working..." : "Claim current epoch"}
            </Button>
          </div>

          <div className="grid gap-2">
            <div className="text-xs text-zinc-400">Withdraw</div>
            <Button disabled={!publicKey || busy !== null || !positionUnlockable} onClick={() => void withdraw()}>
              {busy === "withdraw" ? "Working..." : "Withdraw (after unlock)"}
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
