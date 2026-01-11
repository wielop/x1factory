"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TopBar } from "@/components/shared/TopBar";
import { cn } from "@/components/ui/cn";
import { explorerTxUrl, formatTokenAmount, parseUiAmountToBase } from "@/lib/format";
import { fetchClockUnixTs } from "@/lib/solana";
import {
  deriveX1MindCommitPda,
  deriveX1MindConfigPda,
  deriveX1MindMindVaultAuthority,
  deriveX1MindRoundPda,
} from "@/lib/x1mind";
import { getX1MindProgram } from "@/lib/x1mindAnchor";

const XNT_DECIMALS = 9;
const GRID_FALLBACK = 36;

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

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const hexToBytes = (hex: string) => {
  const clean = hex.trim().replace(/^0x/, "");
  if (!clean || clean.length % 2 !== 0) throw new Error("Invalid seed hex");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return bytes;
};

const buildCommitHash = async (
  seed: Uint8Array,
  owner: PublicKey,
  roundId: bigint,
  cell: number
) => {
  if (!globalThis.crypto?.subtle) throw new Error("Missing crypto.subtle");
  const roundBuf = new ArrayBuffer(8);
  new DataView(roundBuf).setBigUint64(0, roundId, true);
  const data = new Uint8Array(32 + 32 + 8 + 1);
  data.set(seed, 0);
  data.set(owner.toBytes(), 32);
  data.set(new Uint8Array(roundBuf), 64);
  data.set([cell], 72);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
};

const getSeedKey = (roundId: bigint, cell: number) => `x1mind_seed_${roundId}_${cell}`;
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
  const [selectedCell, setSelectedCell] = useState<number>(0);
  const [selectedCells, setSelectedCells] = useState<number[]>([]);
  const [amountUi, setAmountUi] = useState("0.01");
  const [referrerUi, setReferrerUi] = useState("");
  const [seedHex, setSeedHex] = useState("");
  const [seedMap, setSeedMap] = useState<Record<number, string>>({});
  const [userCommit, setUserCommit] = useState<any | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [commitRefreshKey, setCommitRefreshKey] = useState(0);

  const readOnlyWallet = useMemo(() => {
    const keypair = Keypair.generate();
    return {
      publicKey: keypair.publicKey,
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

  useEffect(() => {
    if (roundId == null) return;
    if (typeof window === "undefined") return;
    const map: Record<number, string> = {};
    for (let cell = 0; cell < gridSize; cell += 1) {
      const stored = window.localStorage.getItem(getSeedKey(roundId, cell));
      if (stored) {
        map[cell] = stored;
      }
    }
    setSeedMap(map);
  }, [roundId, gridSize]);

  useEffect(() => {
    if (roundId == null || typeof window === "undefined") return;
    const stored = window.localStorage.getItem(getSeedKey(roundId, selectedCell));
    setSeedHex(stored ?? "");
  }, [roundId, selectedCell, commitRefreshKey]);

  useEffect(() => {
    const loadCommit = async () => {
      if (!program || !publicKey || roundId == null) {
        setUserCommit(null);
        return;
      }
      try {
        const commit = await program.account.userCommit.fetch(
          deriveX1MindCommitPda(roundId, publicKey, selectedCell)
        );
        setUserCommit(commit);
      } catch {
        setUserCommit(null);
      }
    };
    void loadCommit();
  }, [program, publicKey, roundId, selectedCell, commitRefreshKey]);

  const now = nowTs ?? 0;
  const commitEnd = round ? toNumber(round.commitEndTs) : null;
  const revealEnd = round ? toNumber(round.revealEndTs) : null;
  const isCommitPhase = commitEnd != null && now <= commitEnd;
  const isRevealPhase = commitEnd != null && revealEnd != null && now > commitEnd && now <= revealEnd;
  const isFinalizePhase = revealEnd != null && now > revealEnd;

  const totalPerCell: bigint[] = Array.from({ length: gridSize }, (_, idx) => {
    const list = round?.totalPerCell ?? [];
    const value = list[idx] ?? 0;
    return toBigInt(value);
  });

  const handleCommit = useCallback(async () => {
    if (!program || !anchorWallet || !publicKey || roundId == null || !round) {
      setError("Najpierw polacz portfel i poczekaj na runde.");
      return;
    }
    try {
      setBusy("commit");
      setError(null);
      const amountBase = parseUiAmountToBase(amountUi, XNT_DECIMALS);
      const cellsToCommit =
        selectedCells.length > 0 ? Array.from(new Set(selectedCells)).sort((a, b) => a - b) : [selectedCell];
      if (!globalThis.crypto?.getRandomValues) {
        throw new Error("Missing crypto.getRandomValues");
      }
      const referrerKey = referrerUi ? new PublicKey(referrerUi) : publicKey;

      const sigs: string[] = [];
      for (const cell of cellsToCommit) {
        const seed = new Uint8Array(32);
        globalThis.crypto.getRandomValues(seed);
        const hash = await buildCommitHash(seed, publicKey, roundId, cell);

        const sig = await program.methods
          .commitDeposit(
            new BN(roundId.toString()),
            cell,
            Array.from(hash),
            new BN(amountBase.toString()),
            referrerKey
          )
          .accounts({
            owner: publicKey,
            config: deriveX1MindConfigPda(),
            round: deriveX1MindRoundPda(roundId),
            userCommit: deriveX1MindCommitPda(roundId, publicKey, cell),
            referrer: referrerKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        sigs.push(sig);

        if (typeof window !== "undefined") {
          const nextSeedHex = bytesToHex(seed);
          window.localStorage.setItem(getSeedKey(roundId, cell), nextSeedHex);
          if (cell === selectedCell) {
            setSeedHex(nextSeedHex);
          }
          setSeedMap((prev) => ({ ...prev, [cell]: nextSeedHex }));
        }
      }
      setLastSig(sigs[sigs.length - 1] ?? null);
      setCommitRefreshKey((value) => value + 1);
      void refresh();
    } catch (err) {
      console.error("commit failed", err);
      setError("Commit nieudany. Sprawdz saldo i sprobuj ponownie.");
    } finally {
      setBusy(null);
    }
  }, [
    amountUi,
    anchorWallet,
    program,
    publicKey,
    referrerUi,
    refresh,
    round,
    roundId,
    selectedCell,
    selectedCells,
  ]);

  const handleReveal = useCallback(async () => {
    if (!program || !anchorWallet || !publicKey || roundId == null) {
      setError("Najpierw polacz portfel.");
      return;
    }
    try {
      setBusy("reveal");
      setError(null);
      const seedBytes = hexToBytes(seedHex);
      const sig = await program.methods
        .reveal(new BN(roundId.toString()), selectedCell, Array.from(seedBytes))
        .accounts({
          owner: publicKey,
          config: deriveX1MindConfigPda(),
          round: deriveX1MindRoundPda(roundId),
          userCommit: deriveX1MindCommitPda(roundId, publicKey, selectedCell),
        })
        .rpc();
      setLastSig(sig);
      setCommitRefreshKey((value) => value + 1);
      void refresh();
    } catch (err) {
      console.error("reveal failed", err);
      setError("Reveal nieudany. Sprawdz okno reveal.");
    } finally {
      setBusy(null);
    }
  }, [anchorWallet, program, publicKey, refresh, roundId, seedHex, selectedCell]);

  const handleClaim = useCallback(async () => {
    if (!program || !anchorWallet || !publicKey || roundId == null || !config) {
      setError("Najpierw polacz portfel.");
      return;
    }
    try {
      setBusy("claim");
      setError(null);
      const mindMint = config.mindMint as PublicKey;
      const mindVault = config.mindVault as PublicKey;
      const userMindAta = getAssociatedTokenAddressSync(mindMint, publicKey, false);
      const ataInfo = await connection.getAccountInfo(userMindAta, "confirmed");
      const preIxs = ataInfo
        ? []
        : [
            createAssociatedTokenAccountInstruction(
              publicKey,
              userMindAta,
              publicKey,
              mindMint
            ),
          ];

      const sig = await program.methods
        .claim(new BN(roundId.toString()), selectedCell)
        .accounts({
          owner: publicKey,
          config: deriveX1MindConfigPda(),
          round: deriveX1MindRoundPda(roundId),
          userCommit: deriveX1MindCommitPda(roundId, publicKey, selectedCell),
          mindVault,
          mindVaultAuthority: deriveX1MindMindVaultAuthority(),
          userMindAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions(preIxs)
        .rpc();

      setLastSig(sig);
      setCommitRefreshKey((value) => value + 1);
      void refresh();
    } catch (err) {
      console.error("claim failed", err);
      setError("Claim nieudany. Upewnij sie, ze wygrales.");
    } finally {
      setBusy(null);
    }
  }, [anchorWallet, config, connection, program, publicKey, refresh, roundId, selectedCell]);

  const handleStartRound = useCallback(async () => {
    if (!program || !anchorWallet || !publicKey || !config) return;
    try {
      setBusy("start");
      setError(null);
      const nextRoundId = toBigInt(config.currentRoundId) + 1n;
      const sig = await program.methods
        .startRound(new BN(nextRoundId.toString()))
        .accounts({
          config: deriveX1MindConfigPda(),
          admin: publicKey,
          round: deriveX1MindRoundPda(nextRoundId),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      setLastSig(sig);
      void refresh();
    } catch (err) {
      console.error("start round failed", err);
      setError("Nie udalo sie wystartowac rundy.");
    } finally {
      setBusy(null);
    }
  }, [anchorWallet, config, program, publicKey, refresh]);

  const handleFinalize = useCallback(async () => {
    if (!program || !anchorWallet || !publicKey || !config || roundId == null) return;
    try {
      setBusy("finalize");
      setError(null);
      const sig = await program.methods
        .finalizeRound(new BN(roundId.toString()))
        .accounts({
          config: deriveX1MindConfigPda(),
          admin: publicKey,
          round: deriveX1MindRoundPda(roundId),
          buybackWallet: config.buybackWallet,
          adminWallet: config.adminWallet,
          motherlodeVault: config.motherlodeVault,
          mindVault: config.mindVault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      setLastSig(sig);
      void refresh();
    } catch (err) {
      console.error("finalize failed", err);
      setError("Finalizacja nieudana.");
    } finally {
      setBusy(null);
    }
  }, [anchorWallet, config, program, publicKey, refresh, roundId]);

  const adminActive = Boolean(publicKey && config?.admin && (config.admin as PublicKey).equals(publicKey));

  const phaseLabel = isCommitPhase
    ? "Commit"
    : isRevealPhase
    ? "Reveal"
    : isFinalizePhase
    ? "Finalize"
    : "-";

  const timeLeft = isCommitPhase
    ? commitEnd! - now
    : isRevealPhase
    ? revealEnd! - now
    : 0;

  const winningCell = round?.winningCell != null ? Number(round.winningCell) : null;
  const selectedCellsForUi = selectedCells.length > 0 ? selectedCells : [selectedCell];

  return (
    <div className="min-h-screen">
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 pb-16 pt-10">
        <div className="mb-10 rounded-3xl border border-cyan-400/20 bg-ink/70 p-8 shadow-[0_0_40px_rgba(34,242,255,0.12)]">
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div>
              <div className="text-xs uppercase tracking-[0.4em] text-cyan-200/70">X1 Mind Miner</div>
              <h1 className="mt-3 text-3xl font-semibold text-white">6x6 grid, 60 sekund, jedna wygrana komorka.</h1>
              <p className="mt-3 max-w-xl text-sm text-zinc-400">
                Commituj XNT na wybrany blok, ujawnij seed w oknie reveal i zgarnij pule XNT +
                MIND. Cala emisja MIND pochodzi z vaulta protokolu.
              </p>
            </div>
            <div className="rounded-2xl border border-cyan-400/20 bg-ink/80 px-5 py-4 text-xs text-zinc-300">
              <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Faza</div>
              <div className="mt-1 text-lg font-semibold text-cyan-200">{phaseLabel}</div>
              <div className="mt-2 text-[11px] text-zinc-500">
                Pozostalo: {formatCountdown(timeLeft)}
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
          <section className="space-y-6">
            <div className="rounded-3xl border border-cyan-400/20 bg-ink/70 p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Runda</div>
                  <div className="mt-2 text-2xl font-semibold text-white">
                    #{roundId != null ? roundId.toString() : "-"}
                  </div>
                </div>
                <div className="text-right text-xs text-zinc-400">
                  <div>Commit do: {commitEnd ? new Date(commitEnd * 1000).toLocaleTimeString() : "-"}</div>
                  <div>Reveal do: {revealEnd ? new Date(revealEnd * 1000).toLocaleTimeString() : "-"}</div>
                </div>
              </div>

              <div className="mt-6 grid gap-4 rounded-2xl border border-cyan-400/10 bg-ink/80 p-4">
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="rounded-xl border border-cyan-400/10 bg-ink/70 p-3">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Pula XNT</div>
                    <div className="mt-1 text-lg font-semibold text-white">
                      {round?.poolXnt != null
                        ? formatTokenAmount(toBigInt(round.poolXnt), XNT_DECIMALS, 4)
                        : "-"}
                    </div>
                  </div>
                  <div className="rounded-xl border border-cyan-400/10 bg-ink/70 p-3">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Nagroda MIND</div>
                    <div className="mt-1 text-lg font-semibold text-white">
                      {round?.mindReward != null
                        ? formatTokenAmount(toBigInt(round.mindReward), 9, 4)
                        : "-"}
                    </div>
                  </div>
                  <div className="rounded-xl border border-cyan-400/10 bg-ink/70 p-3">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Motherlode</div>
                    <div className="mt-1 text-lg font-semibold text-white">
                      {round?.motherlodeHit ? "TRAFIONO" : "Aktywne"}
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-6 grid grid-cols-6 gap-2">
                {Array.from({ length: gridSize }).map((_, idx) => {
                  const total = totalPerCell[idx] ?? 0n;
                  const hasSeed = Boolean(seedMap[idx]);
                  const isSelected =
                    selectedCells.length > 0 ? selectedCells.includes(idx) : selectedCell === idx;
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        setSelectedCell(idx);
                        setSelectedCells((prev) =>
                          prev.includes(idx) ? prev.filter((cell) => cell !== idx) : [...prev, idx].sort((a, b) => a - b)
                        );
                      }}
                      className={cn(
                        "relative flex aspect-square flex-col items-center justify-center rounded-xl border text-xs transition",
                        isSelected
                          ? "border-cyan-300/80 bg-cyan-400/10 text-white"
                          : "border-cyan-400/10 bg-ink/70 text-zinc-400 hover:border-cyan-300/40 hover:text-white"
                      )}
                    >
                      <span className="text-[10px] uppercase tracking-[0.2em]">{idx + 1}</span>
                      <span className="mt-1 text-[11px] text-zinc-300">
                        {total > 0n ? formatTokenAmount(total, XNT_DECIMALS, 3) : "-"}
                      </span>
                      {hasSeed ? (
                        <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(34,242,255,0.7)]" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <aside className="space-y-6">
            <div className="rounded-3xl border border-cyan-400/20 bg-ink/70 p-6">
              <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Akcja</div>
              <div className="mt-2 text-2xl font-semibold text-white">
                {selectedCells.length > 1 ? `Komorki (${selectedCells.length})` : `Komorka #${selectedCell + 1}`}
              </div>
              <div className="mt-2 text-xs text-zinc-500">
                Wybrane: {selectedCellsForUi.map((cell) => cell + 1).join(", ")}
              </div>

              <div className="mt-5 grid gap-3">
                <label className="text-xs text-zinc-400">Kwota XNT (za komorke)</label>
                <input
                  value={amountUi}
                  onChange={(event) => setAmountUi(event.target.value)}
                  className="h-11 rounded-xl border border-cyan-400/20 bg-ink/80 px-4 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-cyan-400/40"
                  placeholder="0.01"
                />
                <label className="text-xs text-zinc-400">Referrer (opcjonalnie)</label>
                <input
                  value={referrerUi}
                  onChange={(event) => setReferrerUi(event.target.value)}
                  className="h-11 rounded-xl border border-cyan-400/20 bg-ink/80 px-4 text-xs text-zinc-100 focus:outline-none focus:ring-2 focus:ring-cyan-400/40"
                  placeholder="Adres portfela"
                />
              </div>

              <div className="mt-4 rounded-2xl border border-cyan-400/10 bg-ink/80 p-4 text-xs text-zinc-400">
                <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Seed</div>
                <div className="mt-2 break-all text-[11px] text-zinc-300">
                  {seedHex || "Brak seeda dla tej komorki"}
                </div>
              </div>

              <div className="mt-5 grid gap-3">
                <button
                  type="button"
                  onClick={handleCommit}
                  disabled={!isCommitPhase || busy != null}
                  className={cn(
                    "h-12 rounded-full border text-xs font-semibold uppercase tracking-[0.3em] transition",
                    !isCommitPhase || busy
                      ? "border-cyan-400/10 bg-ink/60 text-zinc-500"
                      : "border-cyan-400/40 bg-cyan-500/10 text-cyan-200 hover:border-cyan-300/70"
                  )}
                >
                  {busy === "commit" ? "Commit..." : "Commit"}
                </button>
                <button
                  type="button"
                  onClick={handleReveal}
                  disabled={!isRevealPhase || !seedHex || busy != null}
                  className={cn(
                    "h-12 rounded-full border text-xs font-semibold uppercase tracking-[0.3em] transition",
                    !isRevealPhase || !seedHex || busy
                      ? "border-cyan-400/10 bg-ink/60 text-zinc-500"
                      : "border-cyan-400/40 bg-cyan-500/10 text-cyan-200 hover:border-cyan-300/70"
                  )}
                >
                  {busy === "reveal" ? "Reveal..." : "Reveal"}
                </button>
                <button
                  type="button"
                  onClick={handleClaim}
                  disabled={!round?.finalized || busy != null}
                  className={cn(
                    "h-12 rounded-full border text-xs font-semibold uppercase tracking-[0.3em] transition",
                    !round?.finalized || busy
                      ? "border-cyan-400/10 bg-ink/60 text-zinc-500"
                      : "border-cyan-400/40 bg-cyan-500/10 text-cyan-200 hover:border-cyan-300/70"
                  )}
                >
                  {busy === "claim" ? "Claim..." : "Claim"}
                </button>
              </div>

              <div className="mt-4 text-xs text-zinc-400">
                {userCommit ? (
                  <div>
                    Status: deposit {formatTokenAmount(toBigInt(userCommit.deposit), XNT_DECIMALS, 4)},
                    revealed {String(userCommit.revealed)}, claimed {String(userCommit.claimed)}
                  </div>
                ) : (
                  <div>Brak commitu dla tej komorki.</div>
                )}
              </div>
            </div>

            <div className="rounded-3xl border border-cyan-400/20 bg-ink/70 p-6 text-xs text-zinc-400">
              <div className="text-[10px] uppercase tracking-[0.3em] text-zinc-500">Admin</div>
              <div className="mt-3 grid gap-3">
                <button
                  type="button"
                  onClick={handleStartRound}
                  disabled={!adminActive || busy != null}
                  className={cn(
                    "h-11 rounded-full border text-[11px] font-semibold uppercase tracking-[0.3em] transition",
                    !adminActive || busy
                      ? "border-cyan-400/10 bg-ink/60 text-zinc-500"
                      : "border-cyan-400/40 bg-cyan-500/10 text-cyan-200 hover:border-cyan-300/70"
                  )}
                >
                  {busy === "start" ? "Start..." : "Start nastepnej rundy"}
                </button>
                <button
                  type="button"
                  onClick={handleFinalize}
                  disabled={!adminActive || !isFinalizePhase || busy != null}
                  className={cn(
                    "h-11 rounded-full border text-[11px] font-semibold uppercase tracking-[0.3em] transition",
                    !adminActive || !isFinalizePhase || busy
                      ? "border-cyan-400/10 bg-ink/60 text-zinc-500"
                      : "border-cyan-400/40 bg-cyan-500/10 text-cyan-200 hover:border-cyan-300/70"
                  )}
                >
                  {busy === "finalize" ? "Finalize..." : "Finalize"}
                </button>
              </div>
            </div>

            <div className="rounded-3xl border border-cyan-400/20 bg-ink/70 p-6 text-xs text-zinc-400">
              <div className="text-[10px] uppercase tracking-[0.3em] text-zinc-500">Status</div>
              <div className="mt-3 space-y-2">
                <div>Wygrana komorka: {winningCell != null ? winningCell + 1 : "-"}</div>
                {lastSig ? (
                  <a className="text-cyan-200" href={explorerTxUrl(lastSig)} target="_blank" rel="noreferrer">
                    Ostatnia transakcja
                  </a>
                ) : null}
                {error ? <div className="text-rose-400">{error}</div> : null}
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
