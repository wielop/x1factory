"use client";

import Link from "next/link";
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

export default function MeltPlayerPage() {
  const { publicKey } = useWallet();
  const wallet = useAnchorWallet() ?? null;
  const toast = useToast();
  const [nowTs, setNowTs] = useState<number>(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState<"BURN" | "CLAIM" | null>(null);
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

  const capLamports = melt.config ? BigInt(melt.config.vaultCapLamports.toString()) : 0n;
  const vialLamports = melt.config ? BigInt(melt.config.vialLamports.toString()) : 0n;
  const roundStatus = melt.roundStatus;

  const isLiveWindow = useMemo(() => {
    if (!melt.round || roundStatus !== "active") return false;
    const start = Number(melt.round.startTs.toString());
    const end = Number(melt.round.endTs.toString());
    return nowTs >= start && nowTs <= end;
  }, [melt.round, nowTs, roundStatus]);

  const isClaimPhase = roundStatus === "finalized";
  const showEventSection = roundStatus === "active" || roundStatus === "finalized";

  const countdown = useMemo(() => {
    if (!showEventSection || !melt.round) return "";
    if (isClaimPhase) return "Event ended - claim available";
    const end = Number(melt.round.endTs.toString());
    const left = Math.max(0, end - nowTs);
    return `Ends in ${left}s`;
  }, [isClaimPhase, melt.round, nowTs, showEventSection]);

  const totalBurn = melt.round ? BigInt(melt.round.totalBurn.toString()) : 0n;
  const vPay = melt.round ? BigInt(melt.round.vPay.toString()) : 0n;
  const yourBurn = melt.userRound ? BigInt(melt.userRound.burned.toString()) : 0n;
  const yourShare = percent(yourBurn, totalBurn);
  const estimatedPayout = totalBurn > 0n && (roundStatus === "active" || roundStatus === "finalized")
    ? (vPay * yourBurn) / totalBurn
    : 0n;

  const burnMinMind = melt.config ? BigInt(melt.config.burnMin.toString()) : 0n;
  const burnSliderMin = Number((burnMinMind / 10n ** DECIMALS) || 1n);

  const burnError = (message: string) => {
    if (message.includes("BelowBurnMin")) {
      return `Minimum burn is ${formatAmount(burnMinMind)} MIND`;
    }
    if (message.includes("RoundNotActive") || message.includes("BadRoundStatus")) {
      return "Event not live yet";
    }
    return "Burn failed. Please try again.";
  };

  const claimError = (message: string) => {
    if (message.includes("AlreadyClaimed")) return "Already claimed";
    if (message.includes("RoundNotEnded") || message.includes("BadRoundStatus")) {
      return "Claim available after event ends";
    }
    return "Claim failed. Please try again.";
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

  const claim = async () => {
    if (!wallet || !publicKey || !melt.roundPda || !melt.config) return;
    setBusy("CLAIM");
    try {
      const program = getMeltProgram(connection, wallet);
      const userRoundPda = deriveMeltUserRoundPda(publicKey, melt.roundPda);
      const sig = await program.methods
        .claim()
        .accounts({
          user: publicKey,
          config: deriveMeltConfigPda(),
          vault: melt.config.vault,
          round: melt.roundPda,
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

  const nextProgressPct = capLamports > 0n ? Number((vialLamports * 100n) / capLamports) : 0;

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-950 via-slate-950 to-black text-white">
      <TopBar />
      <div className="mx-auto max-w-4xl px-6 pb-24 pt-10">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-[0.28em] text-cyan-300">Testnet Event</div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">MELT</h1>
          </div>
          <div className="flex items-center gap-3">
            <WalletMultiButton />
            <Link href="/melt/admin" className="rounded-lg border border-white/20 px-3 py-2 text-xs text-white/80 hover:bg-white/10">
              Admin
            </Link>
          </div>
        </div>

        <section className="rounded-2xl border border-cyan-500/30 bg-cyan-950/20 p-5">
          <div className="text-xs uppercase tracking-[0.22em] text-cyan-300">Next Event</div>
          <div className="mt-3 flex items-center gap-5">
            <div className="relative h-28 w-10 overflow-hidden rounded-full border border-cyan-400/40 bg-black/40">
              <div
                className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-cyan-500 to-cyan-200"
                style={{ height: `${Math.max(4, Math.min(100, nextProgressPct))}%` }}
              />
            </div>
            <div className="flex-1">
              <div className="text-xl font-semibold">
                Next Event: {formatAmount(vialLamports)} / {formatAmount(capLamports)} XNT
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10">
                <div className="h-full bg-gradient-to-r from-cyan-400 to-cyan-200" style={{ width: `${Math.max(0, Math.min(100, nextProgressPct))}%` }} />
              </div>
              <div className="mt-2 text-sm text-white/70">Event starts automatically when the vial is full.</div>
              {roundStatus === "active" ? (
                <div className="mt-2 inline-flex rounded-full border border-cyan-300/40 bg-cyan-500/15 px-3 py-1 text-xs text-cyan-100">
                  Filling NEXT vial during the event
                </div>
              ) : null}
            </div>
          </div>
        </section>

        {showEventSection ? (
          <section className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Event</div>
              <div className="rounded-full border border-cyan-300/30 bg-cyan-500/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-100">
                {isClaimPhase ? "CLAIM" : "LIVE"}
              </div>
            </div>
            <div className="mt-3 text-2xl font-semibold">Payout this event (locked): {formatAmount(vPay)} XNT</div>
            <div className="mt-2 text-sm text-white/70">Total burned: {formatAmount(totalBurn)} MIND</div>
            <div className="mt-3 text-sm text-cyan-100">{countdown}</div>
          </section>
        ) : null}

        <section className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-5">
          <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Your Position</div>
          {!publicKey ? (
            <div className="mt-3 text-sm text-white/70">Connect your wallet to see your position and actions.</div>
          ) : (
            <>
              <div className="mt-3 grid gap-2 text-sm text-white/80 sm:grid-cols-2">
                <div>Burned: {formatAmount(yourBurn)} MIND</div>
                <div>Claimed: {melt.userRound?.claimed ? "Yes" : "No"}</div>
                <div>Your share: {yourShare}%</div>
                <div>Estimated payout: {formatAmount(estimatedPayout)} XNT</div>
              </div>

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
                    disabled={!isLiveWindow || busy !== null}
                    onClick={burnMind}
                  >
                    {busy === "BURN" ? "Burning..." : "BURN"}
                  </button>
                  <div className="text-xs text-white/60">{isLiveWindow ? "Live now" : "Event not live yet"}</div>
                </div>
              </div>

              <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-white/60">Claim</div>
                <div className="mt-2 flex items-center gap-3">
                  <button
                    className="rounded-lg border border-emerald-400/40 bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-40"
                    disabled={!isClaimPhase || !!melt.userRound?.claimed || busy !== null}
                    onClick={claim}
                  >
                    {busy === "CLAIM" ? "Claiming..." : "CLAIM"}
                  </button>
                  <div className="text-xs text-white/60">
                    {isClaimPhase ? "Claim available" : "Claim available after event ends"}
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        <section className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-5">
          <details>
            <summary className="cursor-pointer text-sm font-semibold text-white">How it works</summary>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-white/75">
              <li>XNT fills the vial from miner purchases.</li>
              <li>When the vial is full, a 10-minute event starts automatically.</li>
              <li>Burn MIND during the event to earn a share of the locked payout.</li>
              <li>Claim XNT after it ends.</li>
            </ol>
          </details>
        </section>

        {melt.initState === "NOT_INITIALIZED" ? (
          <div className="mt-5 rounded-xl border border-amber-400/40 bg-amber-500/10 p-4 text-sm text-amber-100">
            MELT is not initialized on this testnet. Admin can initialize it on /melt/admin.
          </div>
        ) : null}
      </div>
    </div>
  );
}
