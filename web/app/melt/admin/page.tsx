"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { sha256 } from "@noble/hashes/sha256";
import { useAnchorWallet, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TopBar } from "@/components/shared/TopBar";
import { useToast } from "@/components/shared/ToastProvider";
import {
  deriveMeltConfigPda,
  deriveMeltRoundPda,
  deriveMeltVaultPda,
  fetchMiningMeltConfig,
  getMeltProgram,
  getMeltProgramId,
  getMeltRpcUrl,
  getMiningProgramId,
  getMindMint,
} from "@/lib/melt";
import { getRpcUrl } from "@/lib/solana";
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

const ixDisc = (name: string) => {
  return Buffer.from(sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8));
};

export default function MeltAdminPage() {
  const { publicKey } = useWallet();
  const wallet = useAnchorWallet() ?? null;
  const toast = useToast();
  const refreshToastAtRef = useRef(0);

  const connection = useMemo(() => new Connection(getMeltRpcUrl(), "confirmed"), []);
  const miningConnection = useMemo(() => new Connection(getRpcUrl(), "confirmed"), []);
  const meltProgramId = useMemo(() => getMeltProgramId(), []);
  const miningProgramId = useMemo(() => getMiningProgramId(), []);
  const mindMint = useMemo(() => getMindMint(), []);

  const melt = useMeltState({
    connection,
    anchorWallet: wallet,
    publicKey,
    pollMs: 4000,
  });

  useEffect(() => {
    if (!melt.error) return;
    const now = Date.now();
    if (now - refreshToastAtRef.current < REFRESH_TOAST_COOLDOWN_MS) return;
    refreshToastAtRef.current = now;
    toast.push({
      title: "Refresh issue",
      description: "Could not refresh admin data. Retrying...",
      variant: "error",
    });
  }, [melt.error, toast]);

  const [busy, setBusy] = useState<string | null>(null);
  const [topupInput, setTopupInput] = useState("1");
  const [recordInput, setRecordInput] = useState("1");
  const [capInput, setCapInput] = useState("10");
  const [windowInput, setWindowInput] = useState("600");
  const [rolloverInput, setRolloverInput] = useState("2000");
  const [burnMinInput, setBurnMinInput] = useState("10");
  const [fundingBpsInput, setFundingBpsInput] = useState("9500");
  const [fundingEnabled, setFundingEnabled] = useState(true);

  useEffect(() => {
    if (!melt.config) return;
    setCapInput(formatAmount(BigInt(melt.config.vaultCapLamports.toString())));
    setWindowInput(melt.config.roundWindowSec.toString());
    setRolloverInput(String(melt.config.rolloverBps));
    setBurnMinInput(formatAmount(BigInt(melt.config.burnMin.toString())));
  }, [melt.config]);

  useEffect(() => {
    if (!melt.miningMeltConfig) return;
    setFundingBpsInput(String(melt.miningMeltConfig.meltFundingBps));
    setFundingEnabled(melt.miningMeltConfig.meltEnabled);
  }, [melt.miningMeltConfig]);

  const isAdmin = useMemo(() => {
    if (!publicKey || !melt.config) return false;
    return publicKey.equals(melt.config.admin);
  }, [publicKey, melt.config]);

  const canInit = !!wallet && melt.initState === "NOT_INITIALIZED";
  const canManage = !!wallet && (melt.initState === "NOT_INITIALIZED" || isAdmin);

  const withBusy = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const initMelt = async () => {
    if (!wallet || !publicKey) return;
    await withBusy("INIT", async () => {
      const program = getMeltProgram(connection, wallet);
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
      await melt.refresh();
    });
  };

  const migrateConfig = async () => {
    if (!wallet || !melt.config) return;
    await withBusy("MIGRATE", async () => {
      const program = getMeltProgram(connection, wallet);
      const sig = await program.methods
        .adminMigrateConfig()
        .accounts({
          admin: wallet.publicKey,
          config: deriveMeltConfigPda(),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      toast.push({ title: "Migrated", description: sig, variant: "success" });
      await melt.refresh();
    });
  };

  const setParams = async () => {
    if (!wallet || !melt.config) return;
    const cfg = melt.config;

    const cap = parseAmount(capInput);
    const burnMin = parseAmount(burnMinInput);
    const windowSec = Number(windowInput);
    const rollover = Number(rolloverInput);
    const fundingBps = Number(fundingBpsInput);

    if (cap <= 0n || burnMin < 0n || !Number.isFinite(windowSec) || windowSec <= 0) {
      toast.push({ title: "Invalid MELT params", variant: "error" });
      return;
    }
    if (!Number.isFinite(rollover) || rollover < 0 || rollover > 10000) {
      toast.push({ title: "rollover_bps must be 0..10000", variant: "error" });
      return;
    }
    if (!Number.isInteger(fundingBps) || fundingBps < 0 || fundingBps > 10000) {
      toast.push({ title: "funding_bps must be 0..10000", variant: "error" });
      return;
    }
    if (!miningProgramId) {
      toast.push({ title: "Missing mining program id", description: "Set NEXT_PUBLIC_PROGRAM_ID", variant: "error" });
      return;
    }

    await withBusy("SAVE", async () => {
      const meltProgram = getMeltProgram(connection, wallet);
      const sig1 = await meltProgram.methods
        .adminSetParams({
          vaultCapXnt: new BN(cap.toString()),
          rolloverBps: rollover,
          burnMin: new BN(burnMin.toString()),
          roundWindowSec: new BN(windowSec),
        })
        .accounts({
          admin: wallet.publicKey,
          config: deriveMeltConfigPda(),
        })
        .rpc();

      const [miningConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        miningProgramId
      );
      const data = Buffer.concat([
        ixDisc("admin_set_melt_config"),
        Buffer.from([fundingEnabled ? 1 : 0]),
        meltProgramId.toBuffer(),
        Buffer.from([fundingBps & 0xff, (fundingBps >> 8) & 0xff]),
      ]);
      const ix = new TransactionInstruction({
        programId: miningProgramId,
        keys: [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: miningConfigPda, isSigner: false, isWritable: true },
        ],
        data,
      });
      const tx = new Transaction().add(ix);
      const miningProvider = new anchor.AnchorProvider(miningConnection, wallet, {
        commitment: "confirmed",
      });
      const sig2 = await miningProvider.sendAndConfirm(tx, []);

      const freshMiningCfg = await fetchMiningMeltConfig(miningConnection);
      if (!freshMiningCfg) {
        throw new Error("Saved, but could not re-read mining melt config.");
      }
      if (
        freshMiningCfg.meltEnabled !== fundingEnabled ||
        freshMiningCfg.meltFundingBps !== fundingBps ||
        !freshMiningCfg.meltProgramId.equals(meltProgramId)
      ) {
        throw new Error(
          `Saved tx=${sig2}, but on-chain value differs (enabled=${String(
            freshMiningCfg.meltEnabled
          )}, bps=${freshMiningCfg.meltFundingBps}).`
        );
      }

      toast.push({ title: "Params saved", description: `melt=${sig1} mining=${sig2}`, variant: "success" });
      await melt.refresh();
    });
  };

  const topupVial = async () => {
    if (!wallet || !melt.config) return;
    const cfg = melt.config;
    const amount = parseAmount(topupInput);
    if (amount <= 0n) {
      toast.push({ title: "Invalid topup amount", variant: "error" });
      return;
    }
    await withBusy("TOPUP", async () => {
      const program = getMeltProgram(connection, wallet);
      const roundPda = melt.nextRoundPda ?? deriveMeltRoundPda(BigInt(cfg.roundSeq.toString()));
      const sig = await program.methods
        .adminTopupVial(new BN(amount.toString()))
        .accounts({
          admin: wallet.publicKey,
          config: deriveMeltConfigPda(),
          vault: cfg.vault,
          round: roundPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      toast.push({ title: "Topup sent", description: sig, variant: "success" });
      await melt.refresh();
    });
  };

  const recordFunding = async () => {
    if (!wallet || !melt.config) return;
    const cfg = melt.config;
    const amount = parseAmount(recordInput);
    if (amount <= 0n) {
      toast.push({ title: "Invalid record amount", variant: "error" });
      return;
    }
    await withBusy("RECORD", async () => {
      const program = getMeltProgram(connection, wallet);
      const roundPda = melt.nextRoundPda ?? deriveMeltRoundPda(BigInt(cfg.roundSeq.toString()));
      const sig = await program.methods
        .recordFunding(new BN(amount.toString()))
        .accounts({
          payer: wallet.publicKey,
          config: deriveMeltConfigPda(),
          vault: cfg.vault,
          round: roundPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      toast.push({ title: "Funding recorded", description: sig, variant: "success" });
      await melt.refresh();
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-950 via-slate-950 to-black text-white">
      <TopBar />
      <div className="mx-auto max-w-4xl px-6 pb-24 pt-10">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-[0.28em] text-cyan-300">Testnet Admin</div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">MELT /admin</h1>
          </div>
          <WalletMultiButton />
        </div>

        {!publicKey ? (
          <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-4 text-sm text-amber-100">
            Connect wallet to access admin tools.
          </div>
        ) : null}

        {melt.initState === "READY" && !isAdmin ? (
          <div className="mt-4 rounded-xl border border-red-400/40 bg-red-500/10 p-4 text-sm text-red-100">
            This wallet is not MELT admin.
          </div>
        ) : null}

        {canManage ? (
          <div className="space-y-5">
            <section className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Initialize / Migrate</div>
              {melt.initState === "NOT_INITIALIZED" ? (
                <button
                  className="mt-3 rounded-lg border border-cyan-400/40 bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-40"
                  disabled={!canInit || busy !== null}
                  onClick={initMelt}
                >
                  {busy === "INIT" ? "Initializing..." : "Initialize MELT"}
                </button>
              ) : (
                <button
                  className="mt-3 rounded-lg border border-cyan-400/40 bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-40"
                  disabled={!isAdmin || busy !== null}
                  onClick={migrateConfig}
                >
                  {busy === "MIGRATE" ? "Migrating..." : "Migrate"}
                </button>
              )}
            </section>

            {melt.config ? (
              <>
                <section className="rounded-2xl border border-white/10 bg-white/5 p-5">
                  <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Set params</div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="text-sm text-white/75">
                      cap_xnt
                      <input className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2" value={capInput} onChange={(e) => setCapInput(e.target.value)} />
                    </label>
                    <label className="text-sm text-white/75">
                      window_sec
                      <input className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2" value={windowInput} onChange={(e) => setWindowInput(e.target.value)} />
                    </label>
                    <label className="text-sm text-white/75">
                      rollover_bps
                      <input className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2" value={rolloverInput} onChange={(e) => setRolloverInput(e.target.value)} />
                    </label>
                    <label className="text-sm text-white/75">
                      burn_min_mind
                      <input className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2" value={burnMinInput} onChange={(e) => setBurnMinInput(e.target.value)} />
                    </label>
                    <label className="text-sm text-white/75">
                      funding_bps
                      <input className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2" value={fundingBpsInput} onChange={(e) => setFundingBpsInput(e.target.value)} />
                    </label>
                    <label className="flex items-end gap-2 text-sm text-white/75">
                      <input type="checkbox" checked={fundingEnabled} onChange={(e) => setFundingEnabled(e.target.checked)} />
                      melt_enabled
                    </label>
                  </div>
                  <button
                    className="mt-4 rounded-lg border border-cyan-400/40 bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-40"
                    disabled={!isAdmin || busy !== null}
                    onClick={setParams}
                  >
                    {busy === "SAVE" ? "Saving..." : "Save params"}
                  </button>
                </section>

                <section className="rounded-2xl border border-white/10 bg-white/5 p-5">
                  <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Funding tools</div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                      <div className="text-xs uppercase tracking-[0.16em] text-white/60">Topup + record</div>
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <input
                          className="w-28 rounded-lg border border-white/10 bg-black/40 px-3 py-2"
                          value={topupInput}
                          onChange={(e) => setTopupInput(e.target.value)}
                        />
                        <button
                          className="rounded-lg border border-cyan-400/40 bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-40"
                          disabled={!isAdmin || busy !== null}
                          onClick={topupVial}
                        >
                          {busy === "TOPUP" ? "Topup..." : "Topup vial"}
                        </button>
                      </div>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                      <div className="text-xs uppercase tracking-[0.16em] text-white/60">Record only (no transfer)</div>
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <input
                          className="w-28 rounded-lg border border-white/10 bg-black/40 px-3 py-2"
                          value={recordInput}
                          onChange={(e) => setRecordInput(e.target.value)}
                        />
                        <button
                          className="rounded-lg border border-emerald-400/40 bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-40"
                          disabled={!isAdmin || busy !== null}
                          onClick={recordFunding}
                        >
                          {busy === "RECORD" ? "Recording..." : "Record funding"}
                        </button>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="rounded-2xl border border-white/10 bg-white/5 p-5 text-sm text-white/75">
                  <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">Debug (admin)</div>
                  <div className="mt-3 space-y-2 break-all">
                    {[
                      ["RPC", getMeltRpcUrl()],
                      ["ProgramId", meltProgramId.toBase58()],
                      ["ConfigPDA", deriveMeltConfigPda().toBase58()],
                      ["VaultPDA", deriveMeltVaultPda().toBase58()],
                      ["RoundPDA", melt.roundPda ? melt.roundPda.toBase58() : "-"],
                      ["MiningProgramId", miningProgramId ? miningProgramId.toBase58() : "-"],
                    ].map(([label, value]) => (
                      <div key={String(label)} className="flex items-center gap-2">
                        <div className="min-w-28 text-xs uppercase tracking-[0.2em] text-cyan-300">{label}</div>
                        <div className="flex-1 truncate">{value}</div>
                        <button
                          className="rounded border border-cyan-300/30 px-2 py-1 text-xs hover:bg-cyan-500/10"
                          onClick={() => navigator.clipboard.writeText(String(value))}
                          type="button"
                        >
                          Copy
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
