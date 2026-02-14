"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { useAnchorWallet, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
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
  getMeltProgramId,
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
type LeaderboardRow = {
  wallet: string;
  burned: bigint;
  payout: bigint;
};
type WinnerRow = {
  wallet: string;
  burned: bigint;
  payout: bigint;
};

type ActionState = {
  primaryLabel: string;
  primaryDisabled: boolean;
  primaryHandler: (() => void) | null;
  hint: string;
};

const shortWallet = (value: string) => `${value.slice(0, 4)}...${value.slice(-4)}`;

export default function MeltPlayerPage() {
  const { publicKey } = useWallet();
  const wallet = useAnchorWallet() ?? null;
  const toast = useToast();

  const [nowTs, setNowTs] = useState<number>(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState<"BURN" | "FINALIZE" | "CLAIM" | null>(null);
  const [burnInput, setBurnInput] = useState("10");
  const refreshToastAtRef = useRef(0);
  const [leaderboardRows, setLeaderboardRows] = useState<LeaderboardRow[]>([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const leaderboardRoundRef = useRef<string>("");
  const [lastWinners, setLastWinners] = useState<WinnerRow[]>([]);

  const connection = useMemo(() => new Connection(getMeltRpcUrl(), "confirmed"), []);
  const mindMint = useMemo(() => getMindMint(), []);
  const meltProgramId = useMemo(() => getMeltProgramId(), []);

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

  const finalizeRound = async () => {
    if (!wallet || !publicKey || !melt.config || !melt.roundPda) return;

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

  const actionState: ActionState = useMemo(() => {
    if (phase === "LIVE") {
      return {
        primaryLabel: "Claim after event ends",
        primaryDisabled: true,
        primaryHandler: null,
        hint: "Event is live. Burn to increase your share.",
      };
    }

    if (phase === "ENDED") {
      return {
        primaryLabel: busy === "FINALIZE" ? "Finalizing..." : "FINALIZE EVENT",
        primaryDisabled: !hasWallet || busy !== null || userClaimed,
        primaryHandler: () => void finalizeRound(),
        hint: "The event ended. First signer finalizes it.",
      };
    }

    if (phase === "FINALIZED") {
      if (userClaimed) {
        return {
          primaryLabel: "Already claimed",
          primaryDisabled: true,
          primaryHandler: null,
          hint: "Your rewards are already claimed.",
        };
      }

      return {
        primaryLabel: busy === "CLAIM" ? "Claiming..." : "CLAIM XNT",
        primaryDisabled: !hasWallet || busy !== null,
        primaryHandler: () => void claim(),
        hint: "Round finished. Rewards are ready to claim.",
      };
    }

    return {
      primaryLabel: "Charging...",
      primaryDisabled: true,
      primaryHandler: null,
      hint: "Waiting for next event.",
    };
  }, [busy, hasWallet, phase, userClaimed]);

  const renderActionButtons = () => (
    <div className="grid gap-2">
      <button
        className="rounded-lg border border-emerald-300/60 bg-emerald-500/30 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/40 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={actionState.primaryDisabled}
        onClick={actionState.primaryHandler ?? undefined}
      >
        {actionState.primaryLabel}
      </button>
    </div>
  );

  const missingToStart = capLamports > vialLamports ? capLamports - vialLamports : 0n;
  const nextProgressPct = capLamports > 0n ? Number((vialLamports * 100n) / capLamports) : 0;
  const showingNextCycle = phase === "IDLE" || phase === "FINALIZED";
  const roundSeq = melt.round ? BigInt(melt.round.seq.toString()) : null;

  const statusBadge = phase === "LIVE"
    ? "LIVE"
    : phase === "ENDED"
      ? "ENDED"
      : phase === "FINALIZED"
        ? "FINALIZED"
        : "IDLE";
  const eventTitle = phase === "FINALIZED"
    ? "EVENT ENDED"
    : phase === "ENDED"
      ? "EVENT ENDED - NEEDS FINALIZATION"
      : phase === "LIVE"
        ? "EVENT LIVE"
        : "EVENT";
  const eventSubtitle = phase === "FINALIZED"
    ? "Round finished. Rewards are ready to claim."
    : phase === "ENDED"
      ? "Waiting for finalization. First signer closes the round."
      : phase === "LIVE"
        ? `EVENT LIVE - ${countdown}`
        : "Charging...";
  const payoutTitle = phase === "FINALIZED" || phase === "ENDED"
    ? "In the last round we distributed"
    : "Round payout";
  const refreshLeaderboard = async () => {
    if (!melt.roundPda || !roundSeq) {
      setLeaderboardRows([]);
      leaderboardRoundRef.current = "";
      return;
    }

    const currentRoundKey = phase === "LIVE" ? melt.roundPda.toBase58() : "all-time";
    if (leaderboardRoundRef.current !== currentRoundKey) {
      setLeaderboardRows([]);
      leaderboardRoundRef.current = currentRoundKey;
    }

    try {
      setLeaderboardLoading(true);
      setLeaderboardError(null);
      const roundFilterOffset = 8 + 32;
      const filters = phase === "LIVE"
        ? [
            { dataSize: 82 },
            { memcmp: { offset: roundFilterOffset, bytes: melt.roundPda.toBase58() } },
          ]
        : [{ dataSize: 82 }];
      const userRounds = await connection.getProgramAccounts(meltProgramId, {
        commitment: "confirmed",
        filters,
      });

      const roundBurns = new Map<string, Map<string, bigint>>();
      for (const entry of userRounds) {
        const data = entry.account.data;
        if (data.length < 82) continue;
        const user = new PublicKey(data.subarray(8, 40)).toBase58();
        const round = new PublicKey(data.subarray(40, 72)).toBase58();
        const burned = data.readBigUInt64LE(72);
        if (burned <= 0n) continue;
        if (!roundBurns.has(round)) roundBurns.set(round, new Map<string, bigint>());
        const byUser = roundBurns.get(round)!;
        byUser.set(user, (byUser.get(user) ?? 0n) + burned);
      }

      const totals = new Map<string, { burned: bigint; payout: bigint }>();
      if (phase === "LIVE") {
        const byUser = roundBurns.get(melt.roundPda.toBase58()) ?? new Map<string, bigint>();
        for (const [walletAddr, burned] of byUser.entries()) {
          const payout = totalBurn > 0n ? (vPay * burned) / totalBurn : 0n;
          totals.set(walletAddr, { burned, payout });
        }
      } else {
        const roundKeys = Array.from(roundBurns.keys()).map((k) => new PublicKey(k));
        for (let i = 0; i < roundKeys.length; i += 100) {
          const chunk = roundKeys.slice(i, i + 100);
          const infos = await connection.getMultipleAccountsInfo(chunk, "confirmed");
          infos.forEach((info, idx) => {
            if (!info || info.data.length < 58) return;
            const status = info.data.readUInt8(56);
            if (status !== 2) return;
            const roundKey = chunk[idx].toBase58();
            const vPayRound = info.data.readBigUInt64LE(40);
            const totalBurnRound = info.data.readBigUInt64LE(48);
            const byUser = roundBurns.get(roundKey);
            if (!byUser) return;
            for (const [walletAddr, burned] of byUser.entries()) {
              const payout = totalBurnRound > 0n ? (vPayRound * burned) / totalBurnRound : 0n;
              const prev = totals.get(walletAddr) ?? { burned: 0n, payout: 0n };
              totals.set(walletAddr, {
                burned: prev.burned + burned,
                payout: prev.payout + payout,
              });
            }
          });
        }
      }

      const nextRows: LeaderboardRow[] = Array.from(totals.entries()).map(([walletAddr, v]) => ({
        wallet: walletAddr,
        burned: v.burned,
        payout: v.payout,
      }));
      nextRows.sort((a, b) => (a.burned === b.burned ? 0 : a.burned > b.burned ? -1 : 1));
      setLeaderboardRows(nextRows);
      if (nextRows.length === 0) {
        setLeaderboardError(phase === "LIVE" ? "No burns recorded for this round yet." : "No finalized rounds data yet.");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLeaderboardError(`Leaderboard unavailable: ${msg}`);
    } finally {
      setLeaderboardLoading(false);
    }
  };

  useEffect(() => {
    if (!melt.roundPda || !roundSeq) return;
    void refreshLeaderboard();
  }, [melt.roundPda, roundSeq, phase]);

  useEffect(() => {
    if (phase !== "LIVE" || !melt.roundPda || !roundSeq) return;
    const id = window.setInterval(() => {
      void refreshLeaderboard();
    }, 12_000);
    return () => window.clearInterval(id);
  }, [phase, melt.roundPda, roundSeq]);

  useEffect(() => {
    const refreshLastWinners = async () => {
      if (!melt.roundPda) {
        setLastWinners([]);
        return;
      }
      try {
        const roundFilterOffset = 8 + 32;
        const userRounds = await connection.getProgramAccounts(meltProgramId, {
          commitment: "confirmed",
          filters: [
            { dataSize: 82 },
            { memcmp: { offset: roundFilterOffset, bytes: melt.roundPda.toBase58() } },
          ],
        });

        const totals = new Map<string, bigint>();
        for (const entry of userRounds) {
          const data = entry.account.data;
          if (data.length < 82) continue;
          const user = new PublicKey(data.subarray(8, 40)).toBase58();
          const burned = data.readBigUInt64LE(72);
          if (burned <= 0n) continue;
          totals.set(user, (totals.get(user) ?? 0n) + burned);
        }

        const rows: WinnerRow[] = Array.from(totals.entries()).map(([walletAddr, burned]) => ({
          wallet: walletAddr,
          burned,
          payout: totalBurn > 0n ? (vPay * burned) / totalBurn : 0n,
        }));
        rows.sort((a, b) => (a.burned === b.burned ? 0 : a.burned > b.burned ? -1 : 1));
        setLastWinners(rows.slice(0, 3));
      } catch {
        setLastWinners([]);
      }
    };

    void refreshLastWinners();
  }, [connection, melt.roundPda, meltProgramId, totalBurn, vPay]);

  const topRows = leaderboardRows.slice(0, 10);
  const yourRowIndex = publicKey
    ? leaderboardRows.findIndex((r) => r.wallet === publicKey.toBase58())
    : -1;
  const yourOutsideTop = yourRowIndex >= 10 ? leaderboardRows[yourRowIndex] : null;
  const rowAbove = yourRowIndex > 0 ? leaderboardRows[yourRowIndex - 1] : null;
  const climbDelta =
    yourRowIndex > 0 && rowAbove
      ? rowAbove.burned > yourBurn
        ? rowAbove.burned - yourBurn + 1n
        : 1n
      : 0n;

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-950 via-slate-950 to-black pb-28 text-white">
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
                style={{ height: `${Math.max(4, Math.min(100, showingNextCycle ? nextProgressPct : 100))}%` }}
              />
            </div>

            <div className="text-center">
              <div className="text-2xl font-semibold">
                {showingNextCycle ? "Next Event" : "Event Vial"}: {formatAmount(showingNextCycle ? vialLamports : capLamports)} / {formatAmount(capLamports)} XNT
              </div>
              <div className="mt-1 text-sm text-white/70">
                {phase === "LIVE"
                  ? countdown
                  : phase === "ENDED"
                    ? "Event ended. Finalize event to unlock claim."
                    : phase === "FINALIZED"
                      ? `Previous event finalized. Claims open. Next cycle charging (${formatAmount(missingToStart)} XNT to start).`
                      : `Charging... Missing ${formatAmount(missingToStart)} XNT to start.`}
              </div>
            </div>
          </div>
        </section>

        <section className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">{eventTitle}</div>
            <div className="rounded-full border border-cyan-300/30 bg-cyan-500/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-100">
              {statusBadge}
            </div>
          </div>
          <div className="mt-3 text-3xl font-semibold">{payoutTitle}: {formatAmount(vPay)} XNT</div>
          <div className="mt-2 text-sm text-cyan-100">{eventSubtitle}</div>
          <div className="mt-2 text-lg text-white/80">Total burned: {formatAmount(totalBurn)} MIND</div>
          {(phase === "FINALIZED" || phase === "ENDED") ? (
            <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-3">
              <div className="text-xs uppercase tracking-[0.18em] text-cyan-300">Last winners</div>
              <div className="mt-2 grid gap-2">
                {lastWinners.length === 0 ? (
                  <div className="text-sm text-white/60">No winners data yet.</div>
                ) : (
                  lastWinners.map((row, idx) => {
                    const tone = idx === 0
                      ? "border-yellow-300/40 bg-yellow-500/10 text-yellow-200"
                      : idx === 1
                        ? "border-slate-300/40 bg-slate-300/10 text-slate-100"
                        : "border-amber-700/50 bg-amber-700/10 text-amber-200";
                    const label = idx === 0 ? "TOP 1" : idx === 1 ? "TOP 2" : "TOP 3";
                    return (
                      <div key={row.wallet} className={`flex items-center justify-between rounded-lg border px-3 py-2 ${tone}`}>
                        <div className="text-sm font-semibold">{label} · {shortWallet(row.wallet)}</div>
                        <div className="text-sm">{formatAmount(row.payout)} XNT</div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ) : null}
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
                  {yourRowIndex > 0 && climbDelta > 0n ? (
                    <div className="mt-2 text-xs text-cyan-200">
                      To reach #{yourRowIndex}, you need +{formatAmount(climbDelta)} MIND.
                    </div>
                  ) : yourRowIndex === 0 ? (
                    <div className="mt-2 text-xs text-cyan-200">You are on top of the leaderboard.</div>
                  ) : null}
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
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Leaderboard</div>
            <div className="flex items-center gap-2">
              <div className="rounded-full border border-cyan-300/30 bg-cyan-500/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-100">
                {phase === "LIVE" ? "LIVE" : "FINAL RESULTS"}
              </div>
              <button
                className="rounded-lg border border-white/20 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10 disabled:opacity-50"
                onClick={() => void refreshLeaderboard()}
                disabled={leaderboardLoading}
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="text-left text-xs uppercase tracking-[0.16em] text-white/60">
                <tr>
                  <th className="pb-2">Rank</th>
                  <th className="pb-2">Wallet</th>
                  <th className="pb-2">Burned (MIND)</th>
                  <th className="pb-2">Payout (XNT)</th>
                </tr>
              </thead>
              <tbody className="text-white/85">
                {topRows.map((row, idx) => {
                  const mine = publicKey?.toBase58() === row.wallet;
                  return (
                    <tr key={row.wallet} className={mine ? "bg-cyan-500/10" : ""}>
                      <td className="py-1.5 pr-3">#{idx + 1}</td>
                      <td className="py-1.5 pr-3">
                        <div className="flex items-center gap-2">
                          <span>{shortWallet(row.wallet)}</span>
                          <button
                            type="button"
                            className="rounded border border-white/20 px-1.5 py-0.5 text-[10px] text-white/70 hover:bg-white/10"
                            onClick={() => navigator.clipboard.writeText(row.wallet)}
                          >
                            Copy
                          </button>
                        </div>
                      </td>
                      <td className="py-1.5 pr-3">{formatAmount(row.burned)}</td>
                      <td className="py-1.5 pr-3">{formatAmount(row.payout)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {yourOutsideTop ? (
            <div className="mt-3 rounded-lg border border-cyan-400/20 bg-cyan-500/10 p-3 text-sm text-cyan-100">
              You: #{yourRowIndex + 1} · {shortWallet(yourOutsideTop.wallet)} · Burned {formatAmount(yourOutsideTop.burned)} MIND
            </div>
          ) : null}

          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-white/60">
            <div>
              {leaderboardLoading ? "Loading leaderboard..." : leaderboardError ?? (phase === "LIVE" ? "Live event ranking" : "All finalized rounds")}
            </div>
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
      {phase === "ENDED" ? (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-black/85 backdrop-blur">
          <div className="mx-auto max-w-4xl px-4 py-3 sm:px-6">
            <div className="mb-2 text-xs text-white/70">The event ended. First signer finalizes it.</div>
            <button
              className="w-full rounded-lg border border-emerald-300/60 bg-emerald-500/30 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/40 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={actionState.primaryDisabled}
              onClick={actionState.primaryHandler ?? undefined}
            >
              {actionState.primaryLabel}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
