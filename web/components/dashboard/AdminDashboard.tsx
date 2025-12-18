"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import { SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { NetworkBadge } from "@/components/shared/NetworkBadge";
import { CopyButton } from "@/components/shared/CopyButton";
import { useToast } from "@/components/shared/ToastProvider";
import { getProgram } from "@/lib/anchor";
import { deriveConfigPda, deriveVaultPda, fetchClockUnixTs, fetchConfig, getCurrentEpochFrom } from "@/lib/solana";
import { explorerTxUrl, formatTokenAmount, formatUnixTs, parseUiAmountToBase, shortPk } from "@/lib/format";
import { formatError } from "@/lib/formatError";

export function AdminDashboard() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { push: pushToast } = useToast();

  const [config, setConfig] = useState<Awaited<ReturnType<typeof fetchConfig>> | null>(null);
  const [nowTs, setNowTs] = useState<number | null>(null);

  const [th1, setTh1] = useState<string>("");
  const [th2, setTh2] = useState<string>("");
  const [mpCapBps, setMpCapBps] = useState<string>("");
  const [updateEpochSeconds, setUpdateEpochSeconds] = useState(false);
  const [epochSeconds, setEpochSeconds] = useState<string>("");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [treasuryBusy, setTreasuryBusy] = useState(false);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [treasuryBalanceUi, setTreasuryBalanceUi] = useState<string | null>(null);
  const [treasuryWithdrawUi, setTreasuryWithdrawUi] = useState<string>("0.1");

  const refresh = useCallback(async () => {
    setError(null);
    const cfg = await fetchConfig(connection);
    setConfig(cfg);
    const ts = await fetchClockUnixTs(connection);
    setNowTs(ts);

    setTh1(cfg.th1.toString());
    setTh2(cfg.th2.toString());
    setMpCapBps(String(cfg.mpCapBpsPerWallet));
    setEpochSeconds(cfg.epochSeconds.toString());

    try {
      const bal = await connection.getTokenAccountBalance(cfg.vaultXntAta, "confirmed");
      const amountBase = bal.value.amount ? BigInt(bal.value.amount) : 0n;
      setTreasuryBalanceUi(formatTokenAmount(amountBase, cfg.xntDecimals, 6));
    } catch {
      setTreasuryBalanceUi(null);
    }
  }, [connection]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const id = window.setInterval(() => void refresh().catch(() => null), 20_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const currentEpoch = useMemo(() => {
    if (!config || nowTs == null) return null;
    return getCurrentEpochFrom(config, nowTs);
  }, [config, nowTs]);

  const isAdmin = useMemo(() => {
    if (!publicKey || !config) return false;
    return publicKey.toBase58() === config.admin.toBase58();
  }, [publicKey, config]);

  const diff = useMemo(() => {
    if (!config) return null;
    return [
      { k: "th1", before: config.th1.toString(), after: th1 },
      { k: "th2", before: config.th2.toString(), after: th2 },
      { k: "mp_cap_bps_per_wallet", before: String(config.mpCapBpsPerWallet), after: mpCapBps },
      {
        k: "epoch_seconds",
        before: config.epochSeconds.toString(),
        after: updateEpochSeconds ? epochSeconds : "(unchanged)",
      },
    ];
  }, [config, th1, th2, mpCapBps, updateEpochSeconds, epochSeconds]);

  const signAndSend = useCallback(
    async (tx: Transaction) => {
      if (!publicKey) throw new Error("Connect a wallet first");
      if (!signTransaction) throw new Error("Wallet does not support signTransaction");
      tx.feePayer = publicKey;
      const latest = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = latest.blockhash;
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await connection.confirmTransaction(
        { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
        "confirmed"
      );
      return sig;
    },
    [connection, publicKey, signTransaction]
  );

  const submit = async () => {
    if (!publicKey) throw new Error("Connect wallet");
    if (!anchorWallet) throw new Error("Wallet is not ready for Anchor");
    if (!config) throw new Error("Config not loaded");
    if (!isAdmin) throw new Error("Connected wallet is not the admin");

    setBusy(true);
    setLastSig(null);
    setError(null);
    pushToast({ title: "Admin update", description: "Confirm in your wallet…", variant: "info" });
    try {
      const program = getProgram(connection, anchorWallet);
      const ix = await program.methods
        .adminUpdateConfig({
          th1: new BN(th1),
          th2: new BN(th2),
          mpCapBpsPerWallet: Number(mpCapBps),
          updateEpochSeconds,
          epochSeconds: new BN(epochSeconds),
        })
        .accounts({
          admin: publicKey,
          config: deriveConfigPda(),
        })
        .instruction();

      const tx = new Transaction().add(ix);
      const sig = await signAndSend(tx);
      setLastSig(sig);
      pushToast({ title: "Transaction confirmed", description: shortPk(sig, 6), variant: "success" });
      await refresh();
    } catch (e: any) {
      const msg = formatError(e);
      setError(msg);
      pushToast({
        title: msg.includes("Plugin Closed") ? "Wallet action required" : "Admin update failed",
        description: msg.includes("Plugin Closed") ? "Open/unlock the wallet and retry." : "See details on the page.",
        variant: "error",
      });
      throw e;
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  const withdrawTreasury = async () => {
    if (!publicKey) throw new Error("Connect wallet");
    if (!anchorWallet) throw new Error("Wallet is not ready for Anchor");
    if (!config) throw new Error("Config not loaded");
    if (!isAdmin) throw new Error("Connected wallet is not the admin");
    if (treasuryBusy || busy) return;

    const amountBase = parseUiAmountToBase(treasuryWithdrawUi, config.xntDecimals);
    if (amountBase <= 0n) throw new Error("Amount must be > 0");

    setTreasuryBusy(true);
    setLastSig(null);
    setError(null);
    pushToast({ title: "Treasury withdraw", description: "Confirm in your wallet…", variant: "info" });
    try {
      const program = getProgram(connection, anchorWallet);
      const vaultAuthority = deriveVaultPda();
      const adminXntAta = getAssociatedTokenAddressSync(config.xntMint, publicKey);

      const ix = await program.methods
        .adminWithdrawTreasuryXnt(new BN(amountBase.toString()))
        .accounts({
          admin: publicKey,
          config: deriveConfigPda(),
          vaultAuthority,
          xntMint: config.xntMint,
          vaultXntAta: config.vaultXntAta,
          adminXntAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      const tx = new Transaction().add(ix);
      const sig = await signAndSend(tx);
      setLastSig(sig);
      pushToast({ title: "Treasury withdrawn", description: shortPk(sig, 6), variant: "success" });
      await refresh();
    } catch (e: any) {
      const msg = formatError(e);
      setError(msg);
      pushToast({
        title: msg.includes("Plugin Closed") ? "Wallet action required" : "Treasury withdraw failed",
        description: msg.includes("Plugin Closed") ? "Open/unlock the wallet and retry." : "See details on the page.",
        variant: "error",
      });
      throw e;
    } finally {
      setTreasuryBusy(false);
    }
  };

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-white/5 bg-zinc-950/40 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-cyan-400/30 to-fuchsia-500/20 ring-1 ring-white/10" />
            <div>
              <div className="text-sm font-semibold leading-tight">Admin Console</div>
              <div className="text-[11px] text-zinc-400">Update config thresholds + limits</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link className="text-xs text-zinc-300 hover:text-white" href="/">
              Public
            </Link>
            <WalletMultiButton />
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-4 px-4 pb-10 pt-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Protocol Config</h1>
            <div className="mt-2 text-sm text-zinc-400">Admin-only. All changes are on-chain and irreversible.</div>
            <div className="mt-3">
              <NetworkBadge />
            </div>
          </div>
          {publicKey ? (
            <div className="flex items-center gap-2">
              <Badge variant={isAdmin ? "success" : "warning"}>{isAdmin ? "admin connected" : "not admin"}</Badge>
              <Badge variant="muted">Wallet: {shortPk(publicKey.toBase58(), 6)}</Badge>
              <CopyButton text={publicKey.toBase58()} />
            </div>
          ) : (
            <Badge variant="warning">Connect admin wallet</Badge>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-12">
          <div className="md:col-span-5">
            <Card>
              <CardHeader title="Read-only summary" description="Current on-chain values." right={<Button variant="secondary" onClick={() => void refresh()} disabled={busy}>Refresh</Button>} />
              {!config ? (
                <div className="mt-4 grid gap-3">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : (
                <div className="mt-4 grid gap-3 text-sm">
                  <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                    <div className="text-xs text-zinc-400">Admin</div>
                    <div className="mt-1 font-mono text-xs">{config.admin.toBase58()}</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                    <div className="text-xs text-zinc-400">Epoch</div>
                    <div className="mt-1 font-mono text-sm">
                      {currentEpoch == null ? "-" : currentEpoch}{" "}
                      <span className="text-xs text-zinc-400">(epoch_seconds={config.epochSeconds.toString()})</span>
                    </div>
                    <div className="mt-1 text-xs text-zinc-400">clock: {formatUnixTs(nowTs)}</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                    <div className="text-xs text-zinc-400">Emission</div>
                    <div className="mt-1 font-mono text-sm">
                      {formatTokenAmount(BigInt(config.minedTotal.toString()), config.mindDecimals, 2)} /{" "}
                      {formatTokenAmount(BigInt(config.minedCap.toString()), config.mindDecimals, 2)} MIND
                    </div>
                    <div className="mt-1 text-xs text-zinc-400">start: {formatUnixTs(config.emissionStartTs.toNumber())}</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                    <div className="text-xs text-zinc-400">Treasury (vault XNT)</div>
                    <div className="mt-1 font-mono text-sm">
                      {treasuryBalanceUi != null ? `${treasuryBalanceUi} XNT` : "(unavailable)"}
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">
                      vault ATA: <span className="font-mono">{shortPk(config.vaultXntAta.toBase58(), 8)}</span>
                    </div>
                  </div>
                </div>
              )}
            </Card>
          </div>

          <div className="md:col-span-7">
            <Card>
              <CardHeader title="Edit + submit" description="Changes require the admin wallet signature." />
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <div className="text-xs text-zinc-400">TH1 (base units)</div>
                  <Input value={th1} onChange={setTh1} placeholder="u64" mono />
                </div>
                <div className="grid gap-2">
                  <div className="text-xs text-zinc-400">TH2 (base units)</div>
                  <Input value={th2} onChange={setTh2} placeholder="u64" mono />
                </div>
                <div className="grid gap-2">
                  <div className="text-xs text-zinc-400">mp_cap_bps_per_wallet</div>
                  <Input value={mpCapBps} onChange={setMpCapBps} placeholder="0-10000" mono />
                </div>
                <div className="grid gap-2">
                  <div className="text-xs text-zinc-400">epoch_seconds</div>
                  <Input
                    value={epochSeconds}
                    onChange={setEpochSeconds}
                    placeholder={updateEpochSeconds ? "u64" : "(unchanged)"}
                    mono
                    disabled={!updateEpochSeconds}
                  />
                  <label className="flex items-center gap-2 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={updateEpochSeconds}
                      onChange={(e) => setUpdateEpochSeconds(e.target.checked)}
                      disabled={!config?.allowEpochSecondsEdit}
                    />
                    update epoch_seconds (requires allow flag)
                  </label>
                  {!config?.allowEpochSecondsEdit ? (
                    <div className="text-xs text-zinc-500">Epoch edits disabled by protocol config.</div>
                  ) : null}
                </div>
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-2">
                <Button
                  size="lg"
                  disabled={!publicKey || !isAdmin || busy || !config}
                  onClick={() => setConfirmOpen(true)}
                  title={!isAdmin ? "Connect admin wallet" : undefined}
                >
                  Review & submit
                </Button>
                <Badge variant="muted">Config PDA: {shortPk(deriveConfigPda().toBase58(), 8)}</Badge>
              </div>
            </Card>

            <Card className="mt-4">
              <CardHeader
                title="Treasury withdraw"
                description="Custodial: move XNT from vault to the admin wallet."
                right={
                  config ? (
                    <Badge variant="muted">{config.xntMint.equals(NATIVE_MINT) ? "XNT = wSOL" : "XNT = SPL"}</Badge>
                  ) : null
                }
              />
              <div className="mt-4 grid gap-3">
                <Input value={treasuryWithdrawUi} onChange={setTreasuryWithdrawUi} placeholder="0.0" />
                <Button
                  size="lg"
                  variant="danger"
                  disabled={!publicKey || !isAdmin || !config || busy || treasuryBusy}
                  onClick={() => void withdrawTreasury().catch(() => null)}
                >
                  {treasuryBusy ? "Submitting…" : "Withdraw from treasury"}
                </Button>
                <div className="text-xs text-zinc-500">
                  This transfers from the program vault to your admin ATA. Users cannot withdraw their deposits.
                </div>
              </div>
            </Card>
          </div>
        </div>

        {lastSig ? (
          <Card>
            <CardHeader title="Transaction" description="Last confirmed signature." right={<CopyButton text={lastSig} label="Copy sig" />} />
            <div className="mt-3 flex flex-col gap-2">
              <div className="rounded-xl border border-white/10 bg-white/5 p-3 font-mono text-xs">{lastSig}</div>
              <a className="text-xs text-cyan-200 underline-offset-4 hover:underline" href={explorerTxUrl(lastSig)} target="_blank" rel="noreferrer">
                View in explorer
              </a>
            </div>
          </Card>
        ) : null}

        {error ? (
          <Card className="border-rose-500/20">
            <CardHeader title="Error" description="Actionable details from RPC/simulation." right={<Badge variant="danger">failed</Badge>} />
            <pre className="mt-3 whitespace-pre-wrap rounded-xl border border-white/10 bg-zinc-950/40 p-3 text-xs text-rose-100">
              {error}
            </pre>
          </Card>
        ) : null}
      </main>

      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Confirm on-chain update"
        description="Review the diff. This writes to the config account."
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={busy}>
              {busy ? "Submitting…" : "Confirm & send"}
            </Button>
          </div>
        }
      >
        <div className="grid gap-3">
          {diff ? (
            diff.map((d) => (
              <div key={d.k} className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-zinc-400">{d.k}</div>
                <div className="mt-1 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg border border-white/10 bg-black/20 p-2">
                    <div className="text-[10px] text-zinc-500">before</div>
                    <div className="mt-1 font-mono text-zinc-200">{d.before}</div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/20 p-2">
                    <div className="text-[10px] text-zinc-500">after</div>
                    <div className="mt-1 font-mono text-zinc-200">{d.after}</div>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="text-sm text-zinc-400">Config not loaded.</div>
          )}
        </div>
      </Dialog>
    </div>
  );
}
