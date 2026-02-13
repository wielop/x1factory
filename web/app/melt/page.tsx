"use client";

import Link from "next/link";
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
  deriveMeltUserRoundPda,
  getMindMint,
  getMeltProgram,
  getMeltProgramId,
  getMeltRpcUrl,
} from "@/lib/melt";
import { useMeltState } from "@/lib/useMeltState";

const DECIMALS = 9n;
const REFRESH_TOAST_COOLDOWN_MS = 20_000;
const LEADERBOARD_PAGE_SIZE = 40;

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

type LeaderboardRow = {
  wallet: string;
  burned: bigint;
};

const shortWallet = (value: string) => `${value.slice(0, 4)}...${value.slice(-4)}`;

export default function MeltPlayerPage() {
  const { publicKey } = useWallet();
  const wallet = useAnchorWallet() ?? null;
  const toast = useToast();
  const [nowTs, setNowTs] = useState<number>(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState<"BURN" | "CLAIM" | null>(null);
  const [burnInput, setBurnInput] = useState("10");
  const refreshToastAtRef = useRef(0);
  const [leaderboardRows, setLeaderboardRows] = useState<LeaderboardRow[]>([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const [leaderboardCursor, setLeaderboardCursor] = useState<string | null>(null);
  const leaderboardSeenRef = useRef<Set<string>>(new Set());
  const leaderboardRoundRef = useRef<string>("");

  const connection = useMemo(() => new Connection(getMeltRpcUrl(), "confirmed"), []);
  const mindMint = useMemo(() => getMindMint(), []);
  const meltProgramId = useMemo(() => getMeltProgramId(), []);
  const readOnlyWallet = useMemo(
    () => ({
      publicKey: PublicKey.default,
      signTransaction: async (tx: unknown) => tx as never,
      signAllTransactions: async (txs: unknown) => txs as never,
    }),
    []
  );
  const parserProgram = useMemo(
    () => getMeltProgram(connection, wallet ?? (readOnlyWallet as any)),
    [connection, readOnlyWallet, wallet]
  );

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
  const isLiveStatus = roundStatus === "active";
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
  const vialVisualPct = isLiveStatus ? 100 : nextProgressPct;
  const roundSeq = melt.round ? BigInt(melt.round.seq.toString()) : null;

  const refreshLeaderboard = async (loadMore = false) => {
    if (!melt.roundPda || !roundSeq) {
      setLeaderboardRows([]);
      setLeaderboardCursor(null);
      leaderboardSeenRef.current.clear();
      leaderboardRoundRef.current = "";
      return;
    }
    const currentRoundKey = melt.roundPda.toBase58();
    if (leaderboardRoundRef.current !== currentRoundKey) {
      leaderboardSeenRef.current.clear();
      setLeaderboardRows([]);
      setLeaderboardCursor(null);
      leaderboardRoundRef.current = currentRoundKey;
    }
    try {
      setLeaderboardLoading(true);
      setLeaderboardError(null);
      const signatures = await connection.getSignaturesForAddress(meltProgramId, {
        limit: LEADERBOARD_PAGE_SIZE,
        ...(loadMore && leaderboardCursor ? { before: leaderboardCursor } : {}),
      });
      if (signatures.length === 0) {
        setLeaderboardLoading(false);
        return;
      }

      const seen = leaderboardSeenRef.current;
      const burnedMap = new Map<string, bigint>();
      for (const row of leaderboardRows) burnedMap.set(row.wallet, row.burned);

      for (const sig of signatures) {
        if (!loadMore && seen.has(sig.signature)) continue;
        const tx = await connection.getTransaction(sig.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        seen.add(sig.signature);
        const logs = tx?.meta?.logMessages ?? [];
        for (const logLine of logs) {
          const prefix = "Program data: ";
          const idx = logLine.indexOf(prefix);
          if (idx < 0) continue;
          const payload = logLine.slice(idx + prefix.length).trim();
          let evt: any = null;
          try {
            evt = (parserProgram.coder.events as any).decode(payload);
          } catch {
            evt = null;
          }
          if (!evt || evt.name !== "Burned") continue;
          const eventRound = new PublicKey(evt.data.round);
          if (!eventRound.equals(melt.roundPda)) continue;
          const user = new PublicKey(evt.data.user).toBase58();
          const amount = BigInt(evt.data.amount.toString());
          burnedMap.set(user, (burnedMap.get(user) ?? 0n) + amount);
        }
      }

      const nextRows: LeaderboardRow[] = Array.from(burnedMap.entries()).map(([walletAddr, burned]) => ({
        wallet: walletAddr,
        burned,
      }));
      nextRows.sort((a, b) => (a.burned === b.burned ? 0 : a.burned > b.burned ? -1 : 1));
      setLeaderboardRows(nextRows);
      setLeaderboardCursor(signatures[signatures.length - 1]?.signature ?? null);
    } catch {
      setLeaderboardError("Leaderboard unavailable (RPC limits)");
    } finally {
      setLeaderboardLoading(false);
    }
  };

  useEffect(() => {
    if (!showEventSection || !melt.roundPda || !roundSeq) return;
    void refreshLeaderboard(false);
  }, [showEventSection, melt.roundPda, roundSeq]);

  useEffect(() => {
    if (!isLiveStatus || !melt.roundPda || !roundSeq) return;
    const id = window.setInterval(() => {
      void refreshLeaderboard(false);
    }, 12_000);
    return () => window.clearInterval(id);
  }, [isLiveStatus, melt.roundPda, roundSeq]);

  const topRows = leaderboardRows.slice(0, 10);
  const yourRowIndex = publicKey
    ? leaderboardRows.findIndex((r) => r.wallet === publicKey.toBase58())
    : -1;
  const yourOutsideTop = yourRowIndex >= 10 ? leaderboardRows[yourRowIndex] : null;

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
          <div className="text-xs uppercase tracking-[0.22em] text-cyan-300">Event Vial</div>
          <div className="mt-4 flex flex-col items-center gap-4">
            <div
              className={`relative h-36 w-14 overflow-hidden rounded-full border bg-black/40 ${
                isLiveStatus
                  ? "border-cyan-200/70 shadow-[0_0_40px_rgba(34,211,238,0.55)] animate-pulse"
                  : "border-cyan-400/40"
              }`}
            >
              <div
                className={`absolute bottom-0 left-0 right-0 ${
                  isLiveStatus
                    ? "bg-gradient-to-t from-cyan-300 via-cyan-200 to-white"
                    : "bg-gradient-to-t from-cyan-500 to-cyan-200"
                }`}
                style={{ height: `${Math.max(4, Math.min(100, vialVisualPct))}%` }}
              />
              {isLiveStatus ? (
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/40 via-transparent to-transparent opacity-70" />
              ) : null}
            </div>

            <div className="text-center">
              <div className="text-xl font-semibold">
                Next Event: {formatAmount(vialLamports)} / {formatAmount(capLamports)} XNT
              </div>
              <div className="mt-1 text-sm text-white/70">
                {isLiveStatus ? `EVENT LIVE${countdown ? ` • ${countdown}` : ""}` : "Event starts automatically when the vial is full."}
              </div>
              {isLiveStatus ? (
                <div className="mt-2 inline-flex rounded-full border border-cyan-300/40 bg-cyan-500/15 px-3 py-1 text-xs text-cyan-100">
                  Filling NEXT vial during the event
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-5 rounded-xl border border-cyan-400/20 bg-black/25 p-3">
            <div className="flex items-center gap-2 text-sm text-cyan-100">
              <span>Next vial charging: {formatAmount(vialLamports)} / {formatAmount(capLamports)} XNT</span>
              <span
                className="inline-flex cursor-help rounded-full border border-cyan-300/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-cyan-200"
                title="If a purchase overfills the vial, only the amount needed to reach CAP starts the event. The remainder rolls into the next vial. Example: 8/10 + 5 → event starts, and 3 XNT goes to the next vial."
              >
                i
              </span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full bg-gradient-to-r from-cyan-400/80 to-cyan-200/90"
                style={{ width: `${Math.max(0, Math.min(100, nextProgressPct))}%` }}
              />
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
            <div className="mt-2 text-xs text-cyan-100/90">
              New inflows fill the next vial while payout stays locked.
            </div>
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

        {showEventSection ? (
          <section className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Leaderboard</div>
              <div className="flex items-center gap-2">
                <div className="rounded-full border border-cyan-300/30 bg-cyan-500/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-100">
                  {isLiveStatus ? "LIVE" : "FINAL"}
                </div>
                <button
                  className="rounded-lg border border-white/20 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10 disabled:opacity-50"
                  onClick={() => void refreshLeaderboard(false)}
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
                    <th className="pb-2">Est. payout (XNT)</th>
                  </tr>
                </thead>
                <tbody className="text-white/85">
                  {topRows.map((row, idx) => {
                    const mine = publicKey?.toBase58() === row.wallet;
                    const est = totalBurn > 0n ? (vPay * row.burned) / totalBurn : 0n;
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
                        <td className="py-1.5 pr-3">{formatAmount(est)}</td>
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
                {leaderboardLoading ? "Loading leaderboard..." : leaderboardError ?? `Round #${roundSeq?.toString() ?? "-"}`}
              </div>
              <button
                className="rounded-lg border border-white/20 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10 disabled:opacity-50"
                onClick={() => void refreshLeaderboard(true)}
                disabled={leaderboardLoading || !leaderboardCursor}
              >
                Load more
              </button>
            </div>
          </section>
        ) : null}

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
