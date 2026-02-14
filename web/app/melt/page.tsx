"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { useAnchorWallet, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Connection, SystemProgram } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { TopBar } from "@/components/shared/TopBar";
import { useToast } from "@/components/shared/ToastProvider";
import {
  deriveMeltConfigPda,
  deriveMeltRoundPda,
  deriveMeltUserRoundPda,
  getMindMint,
  getMeltProgram,
  getMeltRpcUrl,
} from "@/lib/melt";
import { useMeltState } from "@/lib/useMeltState";

const DECIMALS = 9n;
const REFRESH_TOAST_COOLDOWN_MS = 20_000;

const parseAmount = (value: string): bigint => {
  const trimmed = value.trim();
  if (!trimmed) return 0n;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return 0n;
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(Number(DECIMALS))).slice(0, Number(DECIMALS));
  return BigInt(whole) * 10n ** DECIMALS + BigInt(fracPadded);
};

const formatAmount = (value: bigint, decimals = 9n, fixed = 4) => {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** decimals;
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(Number(decimals), "0").slice(0, fixed);
  return `${negative ? "-" : ""}${whole.toString()}.${fracStr}`;
};

const percent = (num: bigint, den: bigint) => {
  if (den === 0n) return "0.00";
  const val = Number((num * 10_000n) / den) / 100;
  return val.toFixed(2);
};

type MeltPhase = "IDLE" | "LIVE" | "ENDED" | "FINALIZED";

type ActionState = {
  primaryLabel: string;
  primaryDisabled: boolean;
  primaryHandler: (() => void) | null;
  secondaryLabel: string;
  secondaryDisabled: boolean;
  secondaryHandler: (() => void) | null;
  hint: string;
};

export default function MeltPlayerPage() {
  const { publicKey } = useWallet();
  const wallet = useAnchorWallet() ?? null;
  const toast = useToast();

  const [nowTs, setNowTs] = useState<number>(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState<"BURN" | "FINALIZE" | "CLAIM" | null>(null);
  const [burnInput, setBurnInput] = useState("10");
  const refreshToastAtRef = useRef(0);

  const connection = useMemo(() => new Connection(getMeltRpcUrl(), "confirmed"), []);
  const mindMint = useMemo(() => getMindMint(), []);

  const melt = useMeltState({
    connection,
    anchorWallet: wallet,
    publicKey,
    pollMs: 4000,
  });

  useEffect(() => {
    const id = window.setInterval(() => {
      setNowTs(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!melt.error) return;
    const now = Date.now();
    if (now - refreshToastAtRef.current < REFRESH_TOAST_COOLDOWN_MS) return;
    refreshToastAtRef.current = now;
    toast.push({
      title: "Refresh issue",
      description: "Could not refresh event data. Retrying...",
      variant: "error",
    });
  }, [melt.error, toast]);

  const nowSec = nowTs;
  const normalizedStatus = melt.roundStatus.toUpperCase();
  const hasRound = !!melt.round;
  const roundEndTs = melt.round ? Number(melt.round.endTs.toString()) : 0;
  const ended = hasRound && nowSec >= roundEndTs;
  const isActive = hasRound && normalizedStatus === "ACTIVE";
  const isFinalized = hasRound && normalizedStatus === "FINALIZED";
  const userClaimed = !!melt.userRound?.claimed;
  const hasWallet = !!(wallet && publicKey);

  const phase: MeltPhase = !hasRound
    ? "IDLE"
    : isFinalized
      ? "FINALIZED"
      : isActive && !ended
        ? "LIVE"
        : isActive && ended
          ? "ENDED"
          : "IDLE";

  const capLamports = melt.config ? BigInt(melt.config.vaultCapLamports.toString()) : 0n;
  const vialLamports = melt.config ? BigInt(melt.config.vialLamports.toString()) : 0n;
  const totalBurn = melt.round ? BigInt(melt.round.totalBurn.toString()) : 0n;
  const vPay = melt.round ? BigInt(melt.round.vPay.toString()) : 0n;
  const yourBurn = melt.userRound ? BigInt(melt.userRound.burned.toString()) : 0n;
  const yourShare = percent(yourBurn, totalBurn);
  const estimatedPayout = totalBurn > 0n && phase !== "IDLE" ? (vPay * yourBurn) / totalBurn : 0n;

  const burnMinMind = melt.config ? BigInt(melt.config.burnMin.toString()) : 0n;
  const burnSliderMin = Number((burnMinMind / 10n ** DECIMALS) || 1n);
  const canClaim = phase === "FINALIZED" && !userClaimed;

  const countdown = useMemo(() => {
    if (!melt.round) return "";
    const end = Number(melt.round.endTs.toString());
    const left = end - nowSec;
    if (left <= 0) return "Ended";
    return `Ends in ${left}s`;
  }, [melt.round, nowSec]);

  const burnError = (message: string) => {
    if (message.includes("BelowBurnMin")) {
      return `Minimum burn is ${formatAmount(burnMinMind)} MIND`;
    }
    if (message.includes("RoundNotActive") || message.includes("BadRoundStatus")) {
      return "Burn unavailable for this event state";
    }
    return "Burn failed. Please try again.";
  };

  const claimError = (message: string) => {
    if (message.includes("AlreadyClaimed")) return "Already claimed";
    if (message.includes("NothingToClaim") || message.includes("AccountNotInitialized")) {
      return "Nothing to claim for this event";
    }
    if (message.includes("InsufficientVaultBalance")) {
      return "Vault underfunded. Admin must top up MELT vault.";
    }
    if (message.includes("RoundNotEnded") || message.includes("BadRoundStatus")) {
      return "Claim available after event is finalized";
    }
    return `Claim failed: ${message.slice(0, 120)}`;
  };

  const finalizeError = (message: string) => {
    if (message.includes("RoundNotEnded")) return "Finalize available only after event end";
    if (message.includes("BadRoundStatus")) return "Event is already finalized";
    return `Finalize failed: ${message.slice(0, 120)}`;
  };

  const burnMind = async () => {
    if (!wallet || !publicKey || !melt.roundPda) return;
    const amount = parseAmount(burnInput);
    if (amount <= 0n) {
      toast.push({ title: "Enter burn amount", variant: "error" });
      return;
    }

    setBusy("BURN");
    try {
      const program = getMeltProgram(connection, wallet);
      const ata = getAssociatedTokenAddressSync(mindMint, publicKey, false);
      const info = await connection.getAccountInfo(ata, "confirmed");
      const userRoundPda = deriveMeltUserRoundPda(publicKey, melt.roundPda);

      const method = program.methods
        .burnMind(new BN(amount.toString()))
        .accounts({
          user: publicKey,
          config: deriveMeltConfigPda(),
          round: melt.roundPda,
          mindMint,
          userMindAta: ata,
          userRound: userRoundPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        });

      if (!info) {
        method.preInstructions([
          createAssociatedTokenAccountInstruction(publicKey, ata, publicKey, mindMint),
        ]);
      }

      const sig = await method.rpc();
      toast.push({ title: "Burn submitted", description: sig, variant: "success" });
      await melt.refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.push({ title: burnError(msg), variant: "error" });
    } finally {
      setBusy(null);
    }
  };

  const finalizeRound = async () => {
    if (!wallet || !publicKey || !melt.roundPda || !melt.config) return;

    setBusy("FINALIZE");
    try {
      const program = getMeltProgram(connection, wallet);
      const configPda = deriveMeltConfigPda();
      const cfgNow = await (program.account as any).meltConfig.fetch(configPda);
      const nextRoundPda = deriveMeltRoundPda(BigInt(cfgNow.roundSeq.toString()));
      const sig = await program.methods
        .finalizeRound()
        .accounts({
          admin: publicKey,
          config: configPda,
          round: melt.roundPda,
          vault: cfgNow.vault,
          nextRound: nextRoundPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      toast.push({ title: "Event finalized", description: sig, variant: "success" });
      await melt.refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.push({ title: finalizeError(msg), variant: "error" });
    } finally {
      setBusy(null);
    }
  };

  const claim = async () => {
    if (!wallet || !publicKey || !melt.config || !melt.roundPda) return;

    setBusy("CLAIM");
    try {
      const program = getMeltProgram(connection, wallet);
      const configPda = deriveMeltConfigPda();
      const cfgNow = await (program.account as any).meltConfig.fetch(configPda);
      const nextRoundPda = deriveMeltRoundPda(BigInt(cfgNow.roundSeq.toString()));
      const userRoundPda = deriveMeltUserRoundPda(publicKey, melt.roundPda);

      const sig = await program.methods
        .claim()
        .accounts({
          user: publicKey,
          config: configPda,
          vault: cfgNow.vault,
          round: melt.roundPda,
          nextRound: nextRoundPda,
          userRound: userRoundPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      toast.push({ title: "Claim submitted", description: sig, variant: "success" });
      await melt.refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.push({ title: claimError(msg), variant: "error" });
    } finally {
      setBusy(null);
    }
  };

  const actionState: ActionState = useMemo(() => {
    if (phase === "LIVE") {
      return {
        primaryLabel: busy === "BURN" ? "Burning..." : "BURN MIND",
        primaryDisabled: !hasWallet || busy !== null,
        primaryHandler: () => void burnMind(),
        secondaryLabel: "Claim after event ends",
        secondaryDisabled: true,
        secondaryHandler: null,
        hint: "Event is live. Burn to increase your share.",
      };
    }

    if (phase === "ENDED") {
      return {
        primaryLabel: busy === "FINALIZE" ? "Finalizing..." : "FINALIZE EVENT",
        primaryDisabled: !hasWallet || busy !== null,
        primaryHandler: () => void finalizeRound(),
        secondaryLabel: "Finalize first",
        secondaryDisabled: true,
        secondaryHandler: null,
        hint: "Event has ended. Any wallet can finalize.",
      };
    }

    if (phase === "FINALIZED") {
      if (userClaimed) {
        return {
          primaryLabel: "Already claimed",
          primaryDisabled: true,
          primaryHandler: null,
          secondaryLabel: "Event finalized",
          secondaryDisabled: true,
          secondaryHandler: null,
          hint: "Your rewards are already claimed.",
        };
      }

      return {
        primaryLabel: busy === "CLAIM" ? "Claiming..." : "CLAIM XNT",
        primaryDisabled: !hasWallet || busy !== null || !canClaim,
        primaryHandler: () => void claim(),
        secondaryLabel: "Ready to claim",
        secondaryDisabled: true,
        secondaryHandler: null,
        hint: "Event finalized. Claim is now available.",
      };
    }

    return {
      primaryLabel: "Charging...",
      primaryDisabled: true,
      primaryHandler: null,
      secondaryLabel: "Claim unavailable",
      secondaryDisabled: true,
      secondaryHandler: null,
      hint: "Waiting for next event.",
    };
  }, [busy, canClaim, hasWallet, phase, userClaimed]);

  const renderActionButtons = (sticky = false) => (
    <div className={sticky ? "grid gap-2 sm:grid-cols-2" : "grid gap-2"}>
      <button
        className="rounded-lg border border-emerald-300/60 bg-emerald-500/30 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/40 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={actionState.primaryDisabled}
        onClick={actionState.primaryHandler ?? undefined}
      >
        {actionState.primaryLabel}
      </button>
      <button
        className="rounded-lg border border-white/20 bg-white/5 px-4 py-2 text-sm font-semibold text-white/70 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={actionState.secondaryDisabled}
        onClick={actionState.secondaryHandler ?? undefined}
      >
        {actionState.secondaryLabel}
      </button>
    </div>
  );

  const missingToStart = capLamports > vialLamports ? capLamports - vialLamports : 0n;
  const nextProgressPct = capLamports > 0n ? Number((vialLamports * 100n) / capLamports) : 0;

  const statusBadge = phase === "LIVE"
    ? "LIVE"
    : phase === "ENDED"
      ? "ENDED"
      : phase === "FINALIZED"
        ? "FINALIZED"
        : "IDLE";

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-950 via-slate-950 to-black pb-32 text-white">
      <TopBar />
      <div className="mx-auto max-w-4xl px-6 pt-10">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-[0.28em] text-cyan-300">Testnet Event</div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">MELT</h1>
          </div>
          <WalletMultiButton />
        </div>

        <section className="rounded-2xl border border-cyan-500/30 bg-cyan-950/20 p-5">
          <div className="text-xs uppercase tracking-[0.22em] text-cyan-300">Event Vial</div>
          <div className="mt-4 flex flex-col items-center gap-4">
            <div
              className={`relative h-36 w-14 overflow-hidden rounded-full border bg-black/40 ${
                phase === "LIVE"
                  ? "border-cyan-200/70 shadow-[0_0_40px_rgba(34,211,238,0.55)]"
                  : "border-cyan-400/40"
              }`}
            >
              <div
                className={`absolute bottom-0 left-0 right-0 ${
                  phase === "LIVE"
                    ? "bg-gradient-to-t from-cyan-300 via-cyan-200 to-white"
                    : "bg-gradient-to-t from-cyan-500 to-cyan-200"
                }`}
                style={{ height: `${Math.max(4, Math.min(100, phase === "IDLE" ? nextProgressPct : 100))}%` }}
              />
            </div>

            <div className="text-center">
              <div className="text-2xl font-semibold">
                {phase === "IDLE" ? "Next Event" : "Event Vial"}: {formatAmount(phase === "IDLE" ? vialLamports : capLamports)} / {formatAmount(capLamports)} XNT
              </div>
              <div className="mt-1 text-sm text-white/70">
                {phase === "LIVE"
                  ? countdown
                  : phase === "ENDED"
                    ? "Event ended. Finalize event to unlock claim."
                    : phase === "FINALIZED"
                      ? "Event finalized. Claim is open."
                      : `Charging... Missing ${formatAmount(missingToStart)} XNT to start.`}
              </div>
            </div>
          </div>
        </section>

        <section className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Event</div>
            <div className="rounded-full border border-cyan-300/30 bg-cyan-500/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-100">
              {statusBadge}
            </div>
          </div>
          <div className="mt-3 text-3xl font-semibold">Payout locked: {formatAmount(vPay)} XNT</div>
          <div className="mt-2 text-lg text-white/80">Total burned: {formatAmount(totalBurn)} MIND</div>
          <div className="mt-2 text-sm text-white/65">
            {phase === "LIVE" ? countdown : phase === "ENDED" ? "Waiting for finalize" : phase === "FINALIZED" ? "Ready to claim" : "Charging"}
          </div>
        </section>

        <section className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-5">
          <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Your Position</div>
          {!publicKey ? (
            <div className="mt-3 text-sm text-white/70">Connect your wallet to see your position and actions.</div>
          ) : (
            <>
              <div className="mt-3 grid gap-2 text-sm text-white/80 sm:grid-cols-2">
                <div>Burned: {formatAmount(yourBurn)} MIND</div>
                <div>Claimed: {userClaimed ? "Yes" : "No"}</div>
                <div>Your share: {yourShare}%</div>
                <div>Estimate: {formatAmount(estimatedPayout)} XNT</div>
              </div>

              {phase === "LIVE" ? (
                <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs uppercase tracking-[0.2em] text-white/60">Burn MIND</div>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <input
                      className="w-28 rounded-lg border border-white/10 bg-black/40 px-2 py-2 text-sm"
                      value={burnInput}
                      onChange={(e) => setBurnInput(e.target.value)}
                      placeholder="10"
                    />
                    <input
                      type="range"
                      min={burnSliderMin}
                      max={200}
                      step={1}
                      value={Math.max(burnSliderMin, Number(burnInput) || burnSliderMin)}
                      onChange={(e) => setBurnInput(e.target.value)}
                      className="w-44 accent-cyan-400"
                    />
                    <button
                      className="rounded-lg border border-cyan-400/40 bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-40"
                      disabled={!hasWallet || busy !== null}
                      onClick={burnMind}
                    >
                      {busy === "BURN" ? "Burning..." : "BURN NOW"}
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          )}

          <div className="mt-4 rounded-xl border border-emerald-400/30 bg-black/30 p-4">
            <div className="text-xs uppercase tracking-[0.2em] text-emerald-200">ACTIONS</div>
            <div className="mt-3">{renderActionButtons()}</div>
            <div className="mt-2 text-xs text-white/70">{actionState.hint}</div>
            {!hasWallet ? (
              <div className="mt-2 text-xs text-white/50">Connect wallet to execute actions.</div>
            ) : null}
          </div>
        </section>

        <section className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-5">
          <details>
            <summary className="cursor-pointer text-sm font-semibold text-white">How it works</summary>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-white/75">
              <li>XNT fills the vial from miner purchases.</li>
              <li>When the vial is full, an event starts automatically.</li>
              <li>Burn MIND while LIVE to earn a share of payout.</li>
              <li>After end time: finalize event, then claim XNT.</li>
            </ol>
          </details>
        </section>

        {melt.initState === "NOT_INITIALIZED" ? (
          <div className="mt-5 rounded-xl border border-amber-400/40 bg-amber-500/10 p-4 text-sm text-amber-100">
            MELT is not initialized on this testnet. Admin can initialize it on /melt/admin.
          </div>
        ) : null}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-black/85 backdrop-blur">
        <div className="mx-auto max-w-4xl px-4 py-3 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-cyan-300">Action Bar</div>
              <div className="text-sm text-white/75">{actionState.hint}</div>
            </div>
            <div className="rounded-full border border-cyan-300/30 bg-cyan-500/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-100">
              {statusBadge}
            </div>
          </div>
          <div className="mt-3">{renderActionButtons(true)}</div>
        </div>
      </div>
    </div>
  );
}
