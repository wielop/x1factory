"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TopBar } from "@/components/shared/TopBar";
import { cn } from "@/components/ui/cn";
import { explorerTxUrl, formatTokenAmount, parseUiAmountToBase } from "@/lib/format";
import { fetchClockUnixTs } from "@/lib/solana";
import {
  deriveX1MindConfigPda,
  deriveX1MindEntryPda,
  deriveX1MindRoundPda,
  getX1MindMindMint,
} from "@/lib/x1mind";
import { getX1MindProgram } from "@/lib/x1mindAnchor";

const XNT_DECIMALS = 9;
const GRID_FALLBACK = 25;

const toBigInt = (value: unknown): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) {
    return BigInt((value as { toString: () => string }).toString());
  }
  return 0n;
};

const toNumber = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "toString" in value) {
    return Number((value as { toString: () => string }).toString());
  }
  return 0;
};

const formatCountdown = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
};

export function X1MindMiner() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();

  const [config, setConfig] = useState<any | null>(null);
  const [round, setRound] = useState<any | null>(null);
  const [roundId, setRoundId] = useState<bigint | null>(null);
  const [nowTs, setNowTs] = useState<number | null>(null);
  const [selectedCells, setSelectedCells] = useState<number[]>([]);
  const [amountUi, setAmountUi] = useState("0.01");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);

  const readOnlyWallet = useMemo(() => {
    const dummy = PublicKey.default;
    return {
      publicKey: dummy,
      signTransaction: async (tx: any) => tx,
      signAllTransactions: async (txs: any[]) => txs,
    };
  }, []);

  const program = useMemo(() => {
    if (!connection) return null;
    const wallet = anchorWallet ?? readOnlyWallet;
    return getX1MindProgram(connection, wallet as any);
  }, [connection, anchorWallet, readOnlyWallet]);

  const gridSize = Number(config?.gridSize ?? GRID_FALLBACK);
  const gridCols = 5; // stałe 5x5 zgodnie z nowym programem

  const refresh = useCallback(async () => {
    if (!connection || !program) return;
    try {
      const cfg = await program.account.config.fetch(deriveX1MindConfigPda());
      const currentRoundId = toBigInt(cfg.currentRoundId);
      let roundAccount: any = null;
      try {
        roundAccount = await program.account.round.fetch(deriveX1MindRoundPda(currentRoundId));
      } catch {
        roundAccount = null;
      }
      const ts = await fetchClockUnixTs(connection);
      setConfig(cfg);
      setRoundId(currentRoundId);
      setRound(roundAccount);
      setNowTs(ts);
      setError(null);
    } catch (err) {
      console.error("x1mind refresh failed", err);
      setError("Nie udalo sie odswiezyc stanu. Sprobuj ponownie.");
    }
  }, [connection, program]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      void refresh();
    }, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (nowTs == null) return;
    const id = setInterval(() => {
      setNowTs((prev) => (prev == null ? prev : prev + 1));
    }, 1000);
    return () => clearInterval(id);
  }, [nowTs != null]);

  const now = nowTs ?? 0;
  const endTs = round ? toNumber(round.endTs) : null;
  const timeLeft = endTs != null ? endTs - now : null;
  const isActive = Boolean(round && !round.finalized && (timeLeft ?? 0) > 0);
  const totalPerCell: bigint[] = Array.from({ length: gridSize }, (_, idx) => {
    const list = round?.totalPerCell ?? [];
    const value = list[idx] ?? 0;
    return toBigInt(value);
  });

  const toggleCell = (cell: number) => {
    setSelectedCells((prev) =>
      prev.includes(cell) ? prev.filter((c) => c !== cell) : [...prev, cell].slice(0, gridSize)
    );
  };

  const handleEnter = useCallback(async () => {
    if (!program || !anchorWallet || !publicKey || roundId == null || !round) {
      setError("Najpierw polacz portfel i poczekaj na runde.");
      return;
    }
    try {
      setBusy("enter");
      setError(null);
      const cells =
        selectedCells.length > 0 ? Array.from(new Set(selectedCells)).sort((a, b) => a - b) : [];
      if (cells.length === 0) {
        throw new Error("Wybierz przynajmniej jedno pole.");
      }
      const amountBase = parseUiAmountToBase(amountUi, XNT_DECIMALS);
      if (amountBase <= 0n) {
        throw new Error("Kwota musi byc wieksza od zera.");
      }

      const sig = await program.methods
        .enterRound(new BN(roundId.toString()), cells, new BN(amountBase.toString()))
        .accounts({
          owner: anchorWallet.publicKey,
          config: deriveX1MindConfigPda(),
          round: deriveX1MindRoundPda(roundId),
          userEntry: deriveX1MindEntryPda(roundId, anchorWallet.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      setLastSig(sig);
      setSelectedCells([]);
      void refresh();
    } catch (err) {
      console.error("enter_round failed", err);
      const message = err instanceof Error ? err.message : String(err);
      setError(message || "Transakcja nie powiodla sie.");
    } finally {
      setBusy(null);
    }
  }, [program, anchorWallet, publicKey, roundId, round, selectedCells, amountUi, refresh]);

  const winningCell =
    round && round.finalized ? Number(toBigInt(round.winningCell ?? 0).valueOf()) : null;

  const canEnter = Boolean(isActive && anchorWallet && round);
  const disabledReason = !round
    ? "Brak aktywnej rundy"
    : round.finalized
      ? "Runda zakonczona"
      : !anchorWallet
        ? "Podlacz portfel"
        : !isActive
          ? "Czekam na koniec poprzedniej fazy"
          : null;

  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-50">
      <TopBar />
      <main className="mx-auto flex max-w-4xl flex-col gap-8 px-4 py-10">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold text-white">X1Mind Miner (5×5)</h1>
          <p className="text-sm text-zinc-400">
            Jedno klikniecie: obstaw pola, poczekaj na koniec rundy. Po finalize nagrody XNT + MIND
            sa wysylane automatycznie — bez claim.
          </p>
        </div>

        <div className="grid gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex flex-wrap items-center gap-4 text-sm text-zinc-300">
            <span>
              Runda:{" "}
              <strong className="text-white">{roundId != null ? roundId.toString() : "…"}</strong>
            </span>
            <span>
              Status:{" "}
              <strong className="text-white">
                {round
                  ? round.finalized
                    ? "Zakonczona"
                    : isActive
                      ? "W toku"
                      : "Czekam na finalize"
                  : "Brak rundy"}
              </strong>
            </span>
            <span>
              Koniec rundy:{" "}
              <strong className="text-white">
                {timeLeft != null ? formatCountdown(timeLeft) : "…"}
              </strong>
            </span>
            <span>
              MIND mint: <code className="text-xs text-amber-200">{getX1MindMindMint().toBase58()}</code>
            </span>
          </div>

          {winningCell != null && (
            <div className="rounded-lg border border-emerald-700/50 bg-emerald-900/30 p-3 text-sm text-emerald-100">
              Zwycieskie pole: <strong>#{winningCell}</strong>. Wyplaty sa wykonywane automatycznie
              przez cron.
            </div>
          )}

          <div className="grid gap-3">
            <label className="text-sm font-medium text-zinc-200">Wybierz pola (multi-select)</label>
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)` }}>
              {Array.from({ length: gridSize }).map((_, idx) => {
                const isSelected = selectedCells.includes(idx);
                const total = totalPerCell[idx] ?? 0n;
                return (
                  <button
                    key={idx}
                    onClick={() => toggleCell(idx)}
                    className={cn(
                      "flex h-16 flex-col justify-center rounded-lg border text-sm transition focus:outline-none focus:ring-2 focus:ring-amber-500/60",
                      "border-zinc-800 bg-zinc-900/60 hover:border-amber-400/60 active:scale-[0.98]",
                      isSelected && "border-amber-500/80 bg-amber-500/15 text-amber-100"
                    )}
                    aria-pressed={isSelected}
                  >
                    <span className="font-semibold">#{idx}</span>
                    <span className="text-xs text-zinc-400">
                      {formatTokenAmount(total, XNT_DECIMALS)} XNT
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-zinc-200">Kwota na pole (XNT)</label>
              <input
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-amber-500"
                value={amountUi}
                onChange={(e) => setAmountUi(e.target.value)}
                placeholder="0.01"
              />
              <p className="text-xs text-zinc-500">
                Kazde zaznaczone pole otrzyma taka sama stawke. Srodki trafiaja do rundy od razu.
              </p>
            </div>

            <div className="flex items-end">
              <button
                className={cn(
                  "w-full rounded-lg px-4 py-3 text-sm font-semibold transition",
                  canEnter
                    ? "bg-amber-500 text-black hover:bg-amber-400"
                    : "cursor-not-allowed bg-zinc-800 text-zinc-500"
                )}
                disabled={!canEnter || busy === "enter"}
                onClick={() => void handleEnter()}
              >
                {busy === "enter" ? "Wysylam transakcje…" : "Obstaw teraz"}
              </button>
            </div>
          </div>

          {!canEnter && (
            <div className="text-xs text-zinc-500">
              {disabledReason ?? "Czekam na runde…"} — odświeżenie co 10s.
            </div>
          )}

          {error && <div className="text-sm text-red-400">{error}</div>}
          {lastSig && (
            <div className="text-sm text-emerald-300">
              Transakcja:{" "}
              <a
                className="underline"
                href={explorerTxUrl(lastSig)}
                target="_blank"
                rel="noreferrer"
              >
                {lastSig}
              </a>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
