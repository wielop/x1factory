"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { useAnchorWallet, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { useToast } from "@/components/shared/ToastProvider";
import { TopBar } from "@/components/shared/TopBar";
import {
  deriveMeltConfigPda,
  deriveMeltVaultPda,
  deriveMeltRoundPda,
  deriveMeltUserRoundPda,
  fetchMiningMeltConfig,
  getMindMint,
  getMeltProgram,
  getMeltProgramId,
  getMeltRpcUrl,
} from "@/lib/melt";

type MeltConfig = {
  admin: PublicKey;
  mindMint: PublicKey;
  vault: PublicKey;
  vaultCapLamports: BN;
  rolloverBps: number;
  burnMin: BN;
  roundWindowSec: BN;
  testMode: boolean;
  roundSeq: BN;
  vialLamports: BN;
  bonusPoolLamports: BN;
  activeRoundSeq: BN;
  activeRoundActive: boolean;
  pendingWindowSec: BN;
};

type MeltRound = {
  seq: BN;
  startTs: BN;
  endTs: BN;
  vRound: BN;
  vPay: BN;
  totalBurn: BN;
  status: Record<string, unknown>;
};

type MeltUserRound = {
  burned: BN;
  claimed: boolean;
};

type MiningMeltConfig = {
  meltEnabled: boolean;
  meltProgramId: PublicKey;
  meltFundingBps: number;
};

const DECIMALS = 9n;
const CONFIG_NOT_INITIALIZED = "NOT_INITIALIZED";
const HISTORY_LIMIT = 5;

const parseAmount = (value: string): bigint => {
  const trimmed = value.trim();
  if (!trimmed) return 0n;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return 0n;
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(Number(DECIMALS))).slice(0, Number(DECIMALS));
  return BigInt(whole) * 10n ** DECIMALS + BigInt(fracPadded);
};

const formatAmount = (value: bigint, decimals = 9n) => {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** decimals;
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(Number(decimals), "0").slice(0, 4);
  return `${negative ? "-" : ""}${whole.toString()}.${fracStr}`;
};

const formatPct = (num: bigint, den: bigint) => {
  if (den === 0n) return "0.00%";
  const pct = Number((num * 10_000n) / den) / 100;
  return `${pct.toFixed(2)}%`;
};

const statusLabel = (status: Record<string, unknown> | null) => {
  if (!status) return "-";
  const key = Object.keys(status)[0];
  return key ? key.toLowerCase() : "-";
};

const formatStatus = (label: string) => {
  if (!label || label === "-") return "-";
  return label.charAt(0).toUpperCase() + label.slice(1);
};

const humanError = (message: string) => {
  if (message.includes("BelowBurnMin")) return "Below minimum burn. Try 10+ MIND.";
  if (message.includes("RoundNotActive")) return "Round is not active.";
  if (message.includes("BadRoundStatus")) return "Round not in the right phase.";
  if (message.includes("AlreadyClaimed")) return "Already claimed this round.";
  if (message.includes("NothingToClaim")) return "Nothing to claim yet.";
  if (message.includes("RoundNotEnded")) return "Round hasn’t ended yet.";
  if (message.includes("RoundNotStarted")) return "Round hasn’t started yet.";
  if (message.includes("RoundAlreadyActive")) return "Round already active.";
  if (message.includes("VialNotFull")) return "Vial is not full yet.";
  return message;
};

export default function MeltPage() {
  const { publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();
  const toast = useToast();
  const connection = useMemo(() => new Connection(getMeltRpcUrl(), "confirmed"), []);
  const programId = useMemo(() => getMeltProgramId(), []);
  const mindMint = useMemo(() => getMindMint(), []);
  const readonlyWallet = useMemo(
    () => ({
      publicKey: PublicKey.default,
      signTransaction: async (tx: unknown) => tx as never,
      signAllTransactions: async (txs: unknown) => txs as never,
    }),
    []
  );

  const [config, setConfig] = useState<MeltConfig | null>(null);
  const [round, setRound] = useState<MeltRound | null>(null);
  const [roundPda, setRoundPda] = useState<PublicKey | null>(null);
  const [nextRoundPda, setNextRoundPda] = useState<PublicKey | null>(null);
  const [userRound, setUserRound] = useState<MeltUserRound | null>(null);
  const [miningMeltConfig, setMiningMeltConfig] = useState<MiningMeltConfig | null>(null);
  const [history, setHistory] = useState<MeltRound[]>([]);
  const [nowTs, setNowTs] = useState<number>(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState<string | null>(null);
  const [initState, setInitState] = useState<"READY" | "NOT_INITIALIZED">("READY");
  const initToastShownRef = useRef(false);

  const [burnInput, setBurnInput] = useState("10");
  const [topupInput, setTopupInput] = useState("5");
  const [withdrawInput, setWithdrawInput] = useState("1");
  const [capInput, setCapInput] = useState("");
  const [burnMinInput, setBurnMinInput] = useState("");
  const [rolloverInput, setRolloverInput] = useState("");
  const [windowInput, setWindowInput] = useState("");

  const isAdmin = useMemo(() => {
    if (!publicKey || !config) return false;
    return publicKey.equals(config.admin);
  }, [publicKey, config]);

  const isActive = useMemo(() => {
    if (!round) return false;
    const label = statusLabel(round.status);
    return label === "active";
  }, [round]);

  const isFinalized = useMemo(() => statusLabel(round?.status ?? null) === "finalized", [round]);

  const refresh = useCallback(async () => {
    try {
      const configPda = deriveMeltConfigPda();
      const configInfo = await connection.getAccountInfo(configPda, "confirmed");
      if (!configInfo) {
        setInitState("NOT_INITIALIZED");
        setConfig(null);
        setRound(null);
        setRoundPda(null);
        setUserRound(null);
        setMiningMeltConfig(null);
        if (!initToastShownRef.current) {
          initToastShownRef.current = true;
          toast.push({
            title: "MELT config not initialized",
            description: "Connect admin wallet and initialize.",
            variant: "info",
          });
        }
        return;
      }
      const program = getMeltProgram(connection, anchorWallet ?? (readonlyWallet as any));
      const cfg = (await program.account.meltConfig.fetch(configPda)) as MeltConfig;
      setInitState("READY");
      setConfig(cfg);
      const miningCfg = await fetchMiningMeltConfig(connection);
      setMiningMeltConfig(miningCfg as MiningMeltConfig | null);
      const nextSeq = BigInt(cfg.roundSeq.toString());
      const nextPda = deriveMeltRoundPda(nextSeq);
      setNextRoundPda(nextPda);

      let displayRound: MeltRound | null = null;
      let displayPda: PublicKey | null = null;
      if (nextSeq > 0n) {
        const currentSeq = nextSeq - 1n;
        const currentPda = deriveMeltRoundPda(currentSeq);
        const currentInfo = await connection.getAccountInfo(currentPda, "confirmed");
        if (currentInfo) {
          displayRound = (await program.account.meltRound.fetch(currentPda)) as MeltRound;
          displayPda = currentPda;
        }
      }
      if (!displayRound) {
        const nextInfo = await connection.getAccountInfo(nextPda, "confirmed");
        if (nextInfo) {
          displayRound = (await program.account.meltRound.fetch(nextPda)) as MeltRound;
          displayPda = nextPda;
        }
      }
      setRound(displayRound);
      setRoundPda(displayPda);

      if (publicKey && anchorWallet && displayPda) {
        const userProgram = getMeltProgram(connection, anchorWallet);
        const urPda = deriveMeltUserRoundPda(publicKey, displayPda);
        const ur = (await userProgram.account.meltUserRound.fetchNullable(urPda)) as
          | MeltUserRound
          | null;
        setUserRound(ur);
      } else {
        setUserRound(null);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isMissingConfig =
        message.includes("Account not found: meltConfig") ||
        message.includes("Account does not exist") ||
        message.includes("failed to get info about account") ||
        message.includes("Account not found") ||
        message.includes("Account data too small");
      if (isMissingConfig) {
        setInitState("NOT_INITIALIZED");
        setConfig(null);
        setRound(null);
        setRoundPda(null);
        setUserRound(null);
        setMiningMeltConfig(null);
        if (!initToastShownRef.current) {
          initToastShownRef.current = true;
          toast.push({
            title: "MELT config not initialized",
            description: "Connect admin wallet and initialize.",
            variant: "info",
          });
        }
        return;
      }
      console.error(e);
      toast.push({
        title: "Failed to refresh",
        description: humanError(message),
        variant: "error",
      });
    }
  }, [anchorWallet, connection, publicKey, toast]);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 4_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setNowTs(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!config) return;
    if (!capInput) setCapInput(formatAmount(BigInt(config.vaultCapLamports.toString())));
    if (!burnMinInput) setBurnMinInput(formatAmount(BigInt(config.burnMin.toString())));
    if (!rolloverInput) setRolloverInput(String(config.rolloverBps));
    if (!windowInput) setWindowInput(config.roundWindowSec.toString());
  }, [burnMinInput, capInput, config, rolloverInput, windowInput]);

  const ensureAtaIx = async (owner: PublicKey) => {
    const ata = getAssociatedTokenAddressSync(mindMint, owner, false);
    const info = await connection.getAccountInfo(ata, "confirmed");
    if (info) return { ata, ix: null as any };
    const ix = createAssociatedTokenAccountInstruction(owner, ata, owner, mindMint);
    return { ata, ix };
  };

  const withBusy = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const burnMind = async () => {
    if (!anchorWallet || !publicKey || !roundPda) return;
    const amount = parseAmount(burnInput);
    if (amount <= 0n) {
      toast.push({ title: "Enter a valid amount", variant: "error" });
      return;
    }
    await withBusy("Burn", async () => {
      const program = getMeltProgram(connection, anchorWallet);
      const { ata, ix } = await ensureAtaIx(publicKey);
      const userRoundPda = deriveMeltUserRoundPda(publicKey, roundPda);
      const method = program.methods
        .burnMind(new BN(amount.toString()))
        .accounts({
          user: publicKey,
          config: deriveMeltConfigPda(),
          round: roundPda,
          mindMint,
          userMindAta: ata,
          userRound: userRoundPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        });
      if (ix) method.preInstructions([ix]);
      const sig = await method.rpc();
      toast.push({ title: "Burn locked", description: sig, variant: "success" });
      await refresh();
    });
  };

  const claim = async () => {
    if (!anchorWallet || !publicKey || !roundPda) return;
    await withBusy("Claim", async () => {
      const program = getMeltProgram(connection, anchorWallet);
      const userRoundPda = deriveMeltUserRoundPda(publicKey, roundPda);
      const sig = await program.methods
        .claim()
        .accounts({
          user: publicKey,
          config: deriveMeltConfigPda(),
          vault: config?.vault ?? deriveMeltVaultPda(),
          round: roundPda,
          userRound: userRoundPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      toast.push({ title: "Claimed", description: sig, variant: "success" });
      await refresh();
    });
  };

  const adminTopup = async () => {
    if (!anchorWallet || !config) return;
    const amount = parseAmount(topupInput);
    if (amount <= 0n) {
      toast.push({ title: "Enter a valid amount", variant: "error" });
      return;
    }
    await withBusy("Topup", async () => {
      const program = getMeltProgram(connection, anchorWallet);
      const sig = await program.methods
        .adminTopupVial(new BN(amount.toString()))
        .accounts({
          admin: anchorWallet.publicKey,
          config: deriveMeltConfigPda(),
          vault: config.vault,
          round:
            nextRoundPda ??
            deriveMeltRoundPda(BigInt(config.roundSeq.toString())),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      toast.push({ title: "Vial topped up", description: sig, variant: "success" });
      await refresh();
    });
  };

  const adminWithdraw = async () => {
    if (!anchorWallet || !config) return;
    const amount = parseAmount(withdrawInput);
    if (amount <= 0n) {
      toast.push({ title: "Enter a valid amount", variant: "error" });
      return;
    }
    await withBusy("Withdraw", async () => {
      const program = getMeltProgram(connection, anchorWallet);
      const sig = await program.methods
        .adminWithdrawVault(new BN(amount.toString()))
        .accounts({
          admin: anchorWallet.publicKey,
          config: deriveMeltConfigPda(),
          vault: config.vault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      toast.push({ title: "Vault withdrawn", description: sig, variant: "success" });
      await refresh();
    });
  };

  const adminSetParams = async () => {
    if (!anchorWallet) return;
    const capLamports = capInput.trim() ? parseAmount(capInput) : null;
    const burnLamports = burnMinInput.trim() ? parseAmount(burnMinInput) : null;
    const rollover = rolloverInput.trim() ? Number(rolloverInput) : null;
    const windowSec = windowInput.trim() ? Number(windowInput) : null;
    if (capLamports !== null && capLamports <= 0n) {
      toast.push({ title: "Cap must be > 0", variant: "error" });
      return;
    }
    if (burnLamports !== null && burnLamports < 0n) {
      toast.push({ title: "Burn min must be >= 0", variant: "error" });
      return;
    }
    if (rollover !== null && (!Number.isFinite(rollover) || rollover < 0 || rollover > 10_000)) {
      toast.push({ title: "Rollover must be 0-10000", variant: "error" });
      return;
    }
    if (windowSec !== null && (!Number.isFinite(windowSec) || windowSec <= 0)) {
      toast.push({ title: "Window must be > 0", variant: "error" });
      return;
    }
    await withBusy("Set params", async () => {
      const program = getMeltProgram(connection, anchorWallet);
      const sig = await program.methods
        .adminSetParams({
          vaultCapXnt: capLamports === null ? null : new BN(capLamports.toString()),
          rolloverBps: rollover === null ? null : rollover,
          burnMin: burnLamports === null ? null : new BN(burnLamports.toString()),
          roundWindowSec: windowSec === null ? null : new BN(windowSec),
        })
        .accounts({
          admin: anchorWallet.publicKey,
          config: deriveMeltConfigPda(),
        })
        .rpc();
      toast.push({ title: "Params updated", description: sig, variant: "success" });
      await refresh();
    });
  };

  const adminFinalize = async () => {
    if (!anchorWallet || !roundPda || !config) return;
    await withBusy("Finalize", async () => {
      const program = getMeltProgram(connection, anchorWallet);
      const sig = await program.methods
        .finalizeRound()
        .accounts({
          admin: anchorWallet.publicKey,
          config: deriveMeltConfigPda(),
          round: roundPda,
          vault: config.vault,
        })
        .rpc();
      toast.push({ title: "Round finalized", description: sig, variant: "success" });
      await refresh();
    });
  };

  const burnAmount = userRound ? BigInt(userRound.burned.toString()) : 0n;
  const totalBurn = round ? BigInt(round.totalBurn.toString()) : 0n;
  const vPay = round ? BigInt(round.vPay.toString()) : 0n;
  const payoutBase = isFinalized || isActive ? vPay : 0n;
  const payoutEstimate =
    payoutBase > 0n && totalBurn > 0n ? (payoutBase * burnAmount) / totalBurn : 0n;
  const sharePct = formatPct(burnAmount, totalBurn);

  const startTs = round ? Number(round.startTs.toString()) : null;
  const endTs = round ? Number(round.endTs.toString()) : null;
  const isPlanned = !!(startTs && nowTs < startTs);
  const countdown = isPlanned
    ? `Starts in ${startTs - nowTs}s`
    : isActive && endTs && nowTs < endTs
      ? `Ends in ${endTs - nowTs}s`
      : isFinalized
        ? "Claim now"
        : "Waiting for vial to reach CAP";

  const initMelt = async () => {
    if (!anchorWallet || !publicKey) {
      toast.push({ title: "Connect wallet first", variant: "error" });
      return;
    }
    await withBusy(CONFIG_NOT_INITIALIZED, async () => {
      try {
        const program = getMeltProgram(connection, anchorWallet);
        const sig = await program.methods
          .initMelt({
            vaultCapXnt: new BN((10n * 1_000_000_000n).toString()),
            rolloverBps: 2000,
            burnMin: new BN((10n * 1_000_000_000n).toString()),
            roundWindowSec: new BN("600"),
            testMode: true,
          })
          .accounts({
            payer: publicKey,
            admin: publicKey,
            mindMint,
            config: deriveMeltConfigPda(),
            vault: deriveMeltVaultPda(),
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        toast.push({ title: "Initialized", description: sig, variant: "success" });
        initToastShownRef.current = false;
        await refresh();
      } catch (e) {
        toast.push({
          title: "Init failed",
          description: humanError(e instanceof Error ? e.message : String(e)),
          variant: "error",
        });
      }
    });
  };

  useEffect(() => {
    const loadHistory = async () => {
      if (!config) {
        setHistory([]);
        return;
      }
      const program = getMeltProgram(connection, anchorWallet ?? (readonlyWallet as any));
      const nextSeq = BigInt(config.roundSeq.toString());
      const rounds: MeltRound[] = [];
      for (let i = 1; i <= HISTORY_LIMIT; i += 1) {
        const seq = nextSeq >= BigInt(i) ? nextSeq - BigInt(i) : null;
        if (seq === null) continue;
        const pda = deriveMeltRoundPda(seq);
        const info = await connection.getAccountInfo(pda, "confirmed");
        if (!info) continue;
        const r = (await program.account.meltRound.fetch(pda)) as MeltRound;
        rounds.push(r);
      }
      setHistory(rounds);
    };
    loadHistory();
  }, [anchorWallet, connection, config, readonlyWallet]);

  const capLamports = config ? BigInt(config.vaultCapLamports.toString()) : 0n;
  const vialLamports = config ? BigInt(config.vialLamports.toString()) : 0n;
  const bonusLamports = config ? BigInt(config.bonusPoolLamports.toString()) : 0n;
  const vialFill = capLamports > 0n ? Number((vialLamports * 100n) / capLamports) : 0;
  const estBase =
    capLamports > 0n
      ? BigInt(Math.min(Number(vialLamports), Number(capLamports))) + bonusLamports
      : 0n;
  const jackpotEstimate =
    round && (statusLabel(round.status) === "active" || statusLabel(round.status) === "finalized")
      ? vPay
      : estBase > 0n
        ? (estBase * BigInt(10_000 - (config?.rolloverBps ?? 0))) / 10_000n
        : 0n;

  const ctaLabel =
    statusLabel(round?.status ?? null) === "finalized"
      ? "CLAIM XNT"
      : statusLabel(round?.status ?? null) === "active"
        ? "BURN MIND"
        : isAdmin
          ? "TOPUP VIAL"
          : "WAIT FOR CAP";

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-950 via-slate-950 to-black text-white">
      <TopBar />
      <div className="mx-auto max-w-5xl px-6 pb-24 pt-10">
        <div className="rounded-[28px] border border-cyan-500/30 bg-gradient-to-br from-cyan-950/70 via-slate-950/80 to-black p-7 shadow-[0_0_40px_rgba(34,242,255,0.2)]">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-[0.3em] text-cyan-300">Testnet / Experimental</div>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight">MELT EVENT</h1>
              <p className="mt-2 max-w-xl text-sm text-white/70">
                Pro-rata burn event. Feed the vial, raise the jackpot, and claim XNT.
              </p>
          <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-white/60">
            <div className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-3 py-1">
              Jackpot: {formatAmount(jackpotEstimate)} XNT
            </div>
            <div className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-3 py-1">
              {countdown}
            </div>
          </div>
            </div>
            <div className="flex flex-col items-end gap-3">
              <WalletMultiButton />
              <div className="rounded-full border border-cyan-400/40 bg-cyan-500/20 px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-cyan-100">
                {ctaLabel}
              </div>
            </div>
          </div>
          <div className="mt-6 flex items-center gap-6">
            <div className="relative h-32 w-10 overflow-hidden rounded-full border border-cyan-400/30 bg-black/60">
              <div
                className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-cyan-500 to-cyan-300"
                style={{ height: `${Math.min(100, Math.max(4, vialFill))}%` }}
              />
            </div>
            <div className="flex-1">
              <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Next vial</div>
              <div className="mt-2 text-sm text-white/70">
                {formatAmount(vialLamports)} / {formatAmount(capLamports)} XNT
              </div>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full bg-gradient-to-r from-cyan-400 to-cyan-200"
                  style={{ width: `${Math.min(100, Math.max(4, vialFill))}%` }}
                />
              </div>
              <div className="mt-2 text-xs text-white/50">
                {isActive ? "New inflows now fill the NEXT vial." : "Auto-start at CAP."}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-6">
            {initState === "NOT_INITIALIZED" ? (
              <div className="rounded-2xl border border-amber-400/40 bg-amber-500/10 p-5">
                <div className="text-xs uppercase tracking-[0.2em] text-amber-300">Not initialized</div>
                <div className="mt-2 text-lg font-semibold">
                  MELT config is not initialized on this network.
                </div>
                <div className="mt-2 text-sm text-white/70">
                  Connect admin wallet and initialize.
                </div>
                <div className="mt-4">
                  <button
                    className="rounded-xl border border-amber-300/40 bg-amber-500/20 px-4 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-500/30 disabled:opacity-40"
                    disabled={!anchorWallet || busy !== null}
                    onClick={initMelt}
                  >
                    {busy === CONFIG_NOT_INITIALIZED ? "Initializing..." : "Initialize MELT (admin)"}
                  </button>
                </div>
              </div>
            ) : (
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Next vial</div>
                  <div className="mt-2 text-2xl font-semibold">
                    {formatAmount(vialLamports)} XNT
                  </div>
                  <div className="mt-1 text-xs text-white/50">
                    Auto-start at CAP · new inflows fill the next vial
                  </div>
                </div>
                <div className="rounded-full border border-cyan-400/30 bg-cyan-950/40 px-3 py-1 text-xs text-cyan-100">
                  {countdown}
                </div>
              </div>
              <div className="mt-4 grid gap-3 text-sm text-white/70 sm:grid-cols-2">
                <div>Round seq: {round ? round.seq.toString() : "-"}</div>
                <div>Status: {formatStatus(statusLabel(round?.status ?? null))}</div>
                <div>Start: {startTs ?? "-"}</div>
                <div>End: {endTs ?? "-"}</div>
                <div>Active pot: {round ? formatAmount(BigInt(round.vRound.toString())) : "-"}</div>
                <div>v_pay: {round ? formatAmount(BigInt(round.vPay.toString())) : "-"}</div>
                <div>total_burn: {round ? formatAmount(BigInt(round.totalBurn.toString())) : "-"}</div>
                <div>rollover: {config ? `${config.rolloverBps} bps` : "-"}</div>
              </div>
              <div className="mt-3 text-xs text-amber-300">
                {bonusLamports > 0n
                  ? `+ Bonus pool included in payout: ${formatAmount(bonusLamports)} XNT`
                  : "Bonus pool hidden (0 XNT)"}
              </div>
            </div>
            )}

            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Player Panel</div>
                  <div className="mt-2 text-xl font-semibold">Burned: {formatAmount(burnAmount)} MIND</div>
                  <div className="mt-1 text-sm text-white/60">Claimed: {userRound?.claimed ? "Yes" : "No"}</div>
                </div>
                <div className="text-right text-sm text-white/60">
                  Your estimated payout
                  <div className="text-lg font-semibold text-white">
                    {formatAmount(payoutEstimate)} XNT
                  </div>
                  <div className="text-[11px] uppercase tracking-[0.2em] text-cyan-300">
                    v_pay * (yourBurn / totalBurn)
                  </div>
                  <div className="mt-2 text-xs text-white/60">Your share: {sharePct}</div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Burn MIND</div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <input
                  className="w-40 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white"
                  value={burnInput}
                  onChange={(e) => setBurnInput(e.target.value)}
                  placeholder="20"
                />
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={1}
                  value={Number(burnInput) || 10}
                  onChange={(e) => setBurnInput(e.target.value)}
                  className="w-40 accent-cyan-400"
                />
                <button
                  className="rounded-xl border border-cyan-400/40 bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={!anchorWallet || !isActive || busy !== null}
                  onClick={burnMind}
                >
                  {busy === "Burn" ? "Burning..." : "Burn"}
                </button>
                <span className="text-xs text-white/50">
                  {isActive ? "Round active — raise your share" : "Burn disabled (inactive round)"}
                </span>
              </div>
              <div className="mt-2 text-xs text-white/50">Min burn: 10 MIND.</div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Claim</div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  className="rounded-xl border border-emerald-400/40 bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={!anchorWallet || !isFinalized || userRound?.claimed || busy !== null}
                  onClick={claim}
                >
                  {busy === "Claim" ? "Claiming..." : "Claim"}
                </button>
                <span className="text-xs text-white/50">
                  {isFinalized ? "Finalized" : "Claim disabled (not finalized)"}
                </span>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Round Story</div>
              <div className="mt-3 grid gap-3 text-xs text-white/70">
                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-cyan-300">This round</div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div>Seq: {round ? round.seq.toString() : "-"}</div>
                    <div>Status: {formatStatus(statusLabel(round?.status ?? null))}</div>
                    <div>Start: {startTs ?? "-"}</div>
                    <div>End: {endTs ?? "-"}</div>
                    <div>Active pot: {round ? formatAmount(BigInt(round.vRound.toString())) : "-"}</div>
                    <div>v_pay: {round ? formatAmount(BigInt(round.vPay.toString())) : "-"}</div>
                    <div>total_burn: {round ? formatAmount(BigInt(round.totalBurn.toString())) : "-"}</div>
                  </div>
                </div>
                {history.length === 0 ? (
                  <div className="text-white/50">No previous rounds yet.</div>
                ) : (
                  history.map((r) => (
                    <div key={r.seq.toString()} className="rounded-xl border border-white/10 bg-black/30 p-3">
                      <div className="flex items-center justify-between">
                        <div className="text-[11px] uppercase tracking-[0.2em] text-cyan-300">
                          Round #{r.seq.toString()}
                        </div>
                        <div className="text-[10px] text-white/50">
                          {formatStatus(statusLabel(r.status))}
                        </div>
                      </div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <div>v_round: {formatAmount(BigInt(r.vRound.toString()))}</div>
                        <div>v_pay: {formatAmount(BigInt(r.vPay.toString()))}</div>
                        <div>burn: {formatAmount(BigInt(r.totalBurn.toString()))}</div>
                        <div>start: {Number(r.startTs.toString())}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Admin controls</div>
                  <div className="mt-2 text-sm text-white/60">
                    {isAdmin ? "Admin wallet connected" : "Connect admin wallet to unlock"}
                  </div>
                </div>
              </div>

              <div className="mt-5 space-y-4">
                <div className="flex items-center gap-3">
                  <input
                    className="w-28 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
                    value={topupInput}
                    onChange={(e) => setTopupInput(e.target.value)}
                  />
                  <button
                    className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/20 disabled:opacity-40"
                    disabled={!isAdmin || busy !== null}
                    onClick={adminTopup}
                  >
                    {busy === "Topup" ? "Topup..." : "Topup vial"}
                  </button>
                </div>

                <div className="flex items-center gap-3">
                  <input
                    className="w-28 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
                    value={withdrawInput}
                    onChange={(e) => setWithdrawInput(e.target.value)}
                  />
                  <button
                    className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/20 disabled:opacity-40"
                    disabled={!isAdmin || !config?.testMode || busy !== null}
                    onClick={adminWithdraw}
                  >
                    {busy === "Withdraw" ? "Withdraw..." : "Withdraw vault"}
                  </button>
                  <span className="text-xs text-white/50">
                    {config?.testMode ? "test_mode ON" : "test_mode OFF"}
                  </span>
                </div>

                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="text-xs text-white/60">Set params (testnet)</div>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      className="w-24 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs"
                      value={capInput}
                      onChange={(e) => setCapInput(e.target.value)}
                    />
                    <span className="text-xs text-white/50">cap XNT</span>
                    <input
                      className="w-20 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs"
                      value={burnMinInput}
                      onChange={(e) => setBurnMinInput(e.target.value)}
                    />
                    <span className="text-xs text-white/50">burn min</span>
                    <input
                      className="w-20 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs"
                      value={rolloverInput}
                      onChange={(e) => setRolloverInput(e.target.value)}
                    />
                    <span className="text-xs text-white/50">rollover bps</span>
                    <input
                      className="w-20 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs"
                      value={windowInput}
                      onChange={(e) => setWindowInput(e.target.value)}
                    />
                    <span className="text-xs text-white/50">window sec</span>
                    <button
                      className="ml-auto rounded-lg border border-white/10 bg-white/10 px-2 py-1 text-xs font-semibold hover:bg-white/20 disabled:opacity-40"
                      disabled={!isAdmin || busy !== null}
                      onClick={adminSetParams}
                    >
                      {busy === "Set params" ? "Saving..." : "Save"}
                    </button>
                </div>
              </div>

                <div className="flex gap-3">
                  <button
                    className="flex-1 rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/20 disabled:opacity-40"
                    disabled={!isAdmin || busy !== null}
                    onClick={adminFinalize}
                  >
                    {busy === "Finalize" ? "Finalizing..." : "Finalize"}
                  </button>
                </div>

                {isAdmin ? (
                  <div className="mt-4 rounded-xl border border-cyan-500/30 bg-cyan-950/30 p-3 text-xs text-cyan-100">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-cyan-300">
                      Debug (admin)
                    </div>
                    <div className="mt-2 space-y-2 break-all">
                      {[
                        ["RPC", getMeltRpcUrl()],
                        ["ProgramId", programId.toBase58()],
                        ["configPda", deriveMeltConfigPda().toBase58()],
                        ["vaultPda", deriveMeltVaultPda().toBase58()],
                        ["roundPda", roundPda ? roundPda.toBase58() : "-"],
                      ].map(([label, value]) => (
                        <div key={label} className="flex items-center gap-2">
                          <div className="min-w-20 text-[10px] uppercase tracking-[0.2em] text-cyan-300">
                            {label}
                          </div>
                          <div className="flex-1 truncate">{value}</div>
                          <button
                            className="rounded-md border border-cyan-400/30 px-2 py-1 text-[10px] text-cyan-100 hover:bg-cyan-500/10"
                            onClick={() => navigator.clipboard.writeText(String(value))}
                            type="button"
                          >
                            Copy
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-5 text-sm text-white/70">
              <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Config</div>
              <div className="mt-3 space-y-1">
                <div>Program: {programId.toBase58()}</div>
                <div>RPC: {getMeltRpcUrl()}</div>
                <div>MIND mint: {mindMint.toBase58()}</div>
                <div>Config PDA: {deriveMeltConfigPda().toBase58()}</div>
                <div>Vault PDA: {deriveMeltVaultPda().toBase58()}</div>
                <div>Vial: {formatAmount(vialLamports)} XNT</div>
                <div>Bonus pool: {formatAmount(bonusLamports)} XNT</div>
                <div>cap: {formatAmount(capLamports)} XNT</div>
                <div>window: {config ? config.roundWindowSec.toString() : "-"} sec</div>
                <div>rollover: {config ? `${config.rolloverBps} bps` : "-"}</div>
                <div>burn_min: {config ? formatAmount(BigInt(config.burnMin.toString())) : "-"} MIND</div>
                <div>
                  funding_bps:{" "}
                  {miningMeltConfig
                    ? `${miningMeltConfig.meltFundingBps} (${miningMeltConfig.meltEnabled ? "enabled" : "disabled"})`
                    : "-"}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
