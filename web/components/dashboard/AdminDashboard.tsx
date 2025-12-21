"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import { SystemProgram, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  NATIVE_MINT,
} from "@solana/spl-token";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyButton } from "@/components/shared/CopyButton";
import { TopBar } from "@/components/shared/TopBar";
import { useToast } from "@/components/shared/ToastProvider";
import { getProgram } from "@/lib/anchor";
import { deriveConfigPda, deriveVaultPda, fetchClockUnixTs, fetchConfig, getCurrentEpochFrom } from "@/lib/solana";
import { explorerTxUrl, formatTokenAmount, formatUnixTs, parseUiAmountToBase, shortPk } from "@/lib/format";
import { formatError } from "@/lib/formatError";

function formatBps(bps: number) {
  const percent = bps / 100;
  return `${percent % 1 === 0 ? percent.toFixed(0) : percent.toFixed(2)}%`;
}

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
  const [updateXpConfig, setUpdateXpConfig] = useState(false);
  const [xpPer7d, setXpPer7d] = useState<string>("");
  const [xpPer14d, setXpPer14d] = useState<string>("");
  const [xpPer30d, setXpPer30d] = useState<string>("");
  const [xpTierSilver, setXpTierSilver] = useState<string>("");
  const [xpTierGold, setXpTierGold] = useState<string>("");
  const [xpTierDiamond, setXpTierDiamond] = useState<string>("");
  const [xpBoostSilverBps, setXpBoostSilverBps] = useState<string>("");
  const [xpBoostGoldBps, setXpBoostGoldBps] = useState<string>("");
  const [xpBoostDiamondBps, setXpBoostDiamondBps] = useState<string>("");
  const [updateMindRewards, setUpdateMindRewards] = useState(false);
  const [mindReward7d, setMindReward7d] = useState<string>("");
  const [mindReward14d, setMindReward14d] = useState<string>("");
  const [mindReward28d, setMindReward28d] = useState<string>("");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [treasuryBusy, setTreasuryBusy] = useState(false);
  const [stakingBusy, setStakingBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [treasuryBalanceUi, setTreasuryBalanceUi] = useState<string | null>(null);
  const [treasuryWithdrawUi, setTreasuryWithdrawUi] = useState<string>("0.1");
  const [stakingVaultXntBalanceUi, setStakingVaultXntBalanceUi] = useState<string | null>(null);
  const [stakingVaultMindBalanceUi, setStakingVaultMindBalanceUi] = useState<string | null>(null);
  const [stakingFundAmountUi, setStakingFundAmountUi] = useState<string>("0.1");

  const refresh = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const cfg = await fetchConfig(connection);
      setConfig(cfg);
      const ts = await fetchClockUnixTs(connection);
      setNowTs(ts);

      setTh1(cfg.th1.toString());
      setTh2(cfg.th2.toString());
      setMpCapBps(String(cfg.mpCapBpsPerWallet));
      setEpochSeconds(cfg.epochSeconds.toString());
      setXpPer7d(cfg.xpPer7d.toString());
      setXpPer14d(cfg.xpPer14d.toString());
      setXpPer30d(cfg.xpPer30d.toString());
      setXpTierSilver(cfg.xpTierSilver.toString());
      setXpTierGold(cfg.xpTierGold.toString());
      setXpTierDiamond(cfg.xpTierDiamond.toString());
      setXpBoostSilverBps(String(cfg.xpBoostSilverBps));
      setXpBoostGoldBps(String(cfg.xpBoostGoldBps));
      setXpBoostDiamondBps(String(cfg.xpBoostDiamondBps));
      setMindReward7d(cfg.mindReward7d.toString());
      setMindReward14d(cfg.mindReward14d.toString());
      setMindReward28d(cfg.mindReward28d.toString());

      try {
        const bal = await connection.getTokenAccountBalance(cfg.vaultXntAta, "confirmed");
        const amountBase = bal.value.amount ? BigInt(bal.value.amount) : 0n;
        setTreasuryBalanceUi(formatTokenAmount(amountBase, cfg.xntDecimals, 6));
      } catch {
        setTreasuryBalanceUi(null);
      }
      try {
        const stakingBalance = await connection.getTokenAccountBalance(cfg.stakingVaultXntAta, "confirmed");
        const amountBase = stakingBalance.value.amount ? BigInt(stakingBalance.value.amount) : 0n;
        setStakingVaultXntBalanceUi(formatTokenAmount(amountBase, cfg.xntDecimals, 6));
      } catch {
        setStakingVaultXntBalanceUi(null);
      }
      try {
        const stakingMind = await connection.getTokenAccountBalance(cfg.stakingVaultMindAta, "confirmed");
        const amountBase = stakingMind.value.amount ? BigInt(stakingMind.value.amount) : 0n;
        setStakingVaultMindBalanceUi(formatTokenAmount(amountBase, cfg.mindDecimals, 6));
      } catch {
        setStakingVaultMindBalanceUi(null);
      }
    } catch (e: unknown) {
      console.error(e);
      setError(formatError(e));
    } finally {
      setLoading(false);
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
    const xpDiffs = updateXpConfig
      ? [
          { k: "xp_per_7d", before: config.xpPer7d.toString(), after: xpPer7d },
          { k: "xp_per_14d", before: config.xpPer14d.toString(), after: xpPer14d },
          { k: "xp_per_30d", before: config.xpPer30d.toString(), after: xpPer30d },
          { k: "xp_tier_silver", before: config.xpTierSilver.toString(), after: xpTierSilver },
          { k: "xp_tier_gold", before: config.xpTierGold.toString(), after: xpTierGold },
          { k: "xp_tier_diamond", before: config.xpTierDiamond.toString(), after: xpTierDiamond },
          { k: "xp_boost_silver_bps", before: String(config.xpBoostSilverBps), after: xpBoostSilverBps },
          { k: "xp_boost_gold_bps", before: String(config.xpBoostGoldBps), after: xpBoostGoldBps },
          { k: "xp_boost_diamond_bps", before: String(config.xpBoostDiamondBps), after: xpBoostDiamondBps },
        ]
      : [];
    const mindDiffs = updateMindRewards
      ? [
          { k: "mind_reward_7d", before: config.mindReward7d.toString(), after: mindReward7d },
          { k: "mind_reward_14d", before: config.mindReward14d.toString(), after: mindReward14d },
          { k: "mind_reward_28d", before: config.mindReward28d.toString(), after: mindReward28d },
        ]
      : [];
    return [
      { k: "th1", before: config.th1.toString(), after: th1 },
      { k: "th2", before: config.th2.toString(), after: th2 },
      { k: "mp_cap_bps_per_wallet", before: String(config.mpCapBpsPerWallet), after: mpCapBps },
      {
        k: "epoch_seconds",
        before: config.epochSeconds.toString(),
        after: updateEpochSeconds ? epochSeconds : "(unchanged)",
      },
      ...xpDiffs,
      ...mindDiffs,
    ];
  }, [
    config,
    th1,
    th2,
    mpCapBps,
    updateEpochSeconds,
    epochSeconds,
    updateXpConfig,
    xpPer7d,
    xpPer14d,
    xpPer30d,
    xpTierSilver,
    xpTierGold,
    xpTierDiamond,
    xpBoostSilverBps,
    xpBoostGoldBps,
    xpBoostDiamondBps,
    updateMindRewards,
    mindReward7d,
    mindReward14d,
    mindReward28d,
  ]);

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
          updateXpConfig,
          xpPer7D: new BN(xpPer7d || "0"),
          xpPer14D: new BN(xpPer14d || "0"),
          xpPer30D: new BN(xpPer30d || "0"),
          xpTierSilver: new BN(xpTierSilver || "0"),
          xpTierGold: new BN(xpTierGold || "0"),
          xpTierDiamond: new BN(xpTierDiamond || "0"),
          xpBoostSilverBps: Number(xpBoostSilverBps || "0"),
          xpBoostGoldBps: Number(xpBoostGoldBps || "0"),
          xpBoostDiamondBps: Number(xpBoostDiamondBps || "0"),
          updateMindRewards,
          mindReward7D: new BN(mindReward7d || "0"),
          mindReward14D: new BN(mindReward14d || "0"),
          mindReward28D: new BN(mindReward28d || "0"),
        })
        .accounts({
          admin: publicKey,
          config: deriveConfigPda(),
          systemProgram: SystemProgram.programId,
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

  const fundStakingVault = async () => {
    if (!publicKey) throw new Error("Connect wallet");
    if (!anchorWallet) throw new Error("Wallet is not ready for Anchor");
    if (!config) throw new Error("Config not loaded");
    if (!isAdmin) throw new Error("Connected wallet is not the admin");
    if (stakingBusy || busy || treasuryBusy) return;

    const amountBase = parseUiAmountToBase(stakingFundAmountUi, config.xntDecimals);
    if (amountBase <= 0n) throw new Error("Amount must be > 0");

    setStakingBusy(true);
    setLastSig(null);
    setError(null);
    pushToast({ title: "Staking vault funding", description: "Confirm in your wallet…", variant: "info" });
    try {
      const program = getProgram(connection, anchorWallet);
      const vaultAuthority = deriveVaultPda();
      const adminXntAta = getAssociatedTokenAddressSync(config.xntMint, publicKey);
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey,
          adminXntAta,
          publicKey,
          config.xntMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
      const ix = await program.methods
        .adminFundStakingXnt(new BN(amountBase.toString()))
        .accounts({
          admin: publicKey,
          config: deriveConfigPda(),
          xntMint: config.xntMint,
          stakingVaultXntAta: config.stakingVaultXntAta,
          adminXntAta,
          vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      tx.add(ix);
      const sig = await signAndSend(tx);
      setLastSig(sig);
      pushToast({ title: "Staking vault funded", description: shortPk(sig, 6), variant: "success" });
      await refresh();
    } catch (e: any) {
      const msg = formatError(e);
      setError(msg);
      pushToast({
        title: msg.includes("Plugin Closed") ? "Wallet action required" : "Funding failed",
        description: msg.includes("Plugin Closed") ? "Open/unlock the wallet and retry." : "See details on the page.",
        variant: "error",
      });
      throw e;
    } finally {
      setStakingBusy(false);
    }
  };

  return (
    <div className="min-h-dvh">
      <TopBar title="Admin Console" subtitle="Config + treasury controls" link={{ href: "/", label: "Public" }} />

      <main className="mx-auto grid max-w-6xl gap-5 px-4 pb-10 pt-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold text-white">Protocol Config</h1>
            <div className="mt-2 text-sm text-zinc-400">Admin-only. All changes are on-chain and irreversible.</div>
          </div>
          {publicKey ? (
            <div className="flex items-center gap-2">
              <Badge variant={isAdmin ? "success" : "warning"}>{isAdmin ? "admin connected" : "not admin"}</Badge>
              <Badge variant="muted">{shortPk(publicKey.toBase58(), 6)}</Badge>
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
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-zinc-400">Staking vault (XNT)</div>
                  <div className="mt-1 font-mono text-sm">{stakingVaultXntBalanceUi ?? "(unavailable)"}</div>
                  <div className="mt-1 text-xs text-zinc-500">
                    vault ATA: <span className="font-mono">{shortPk(config.stakingVaultXntAta.toBase58(), 8)}</span>
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-zinc-400">Staking vault (MIND)</div>
                  <div className="mt-1 font-mono text-sm">{stakingVaultMindBalanceUi ?? "(unavailable)"}</div>
                  <div className="mt-1 text-xs text-zinc-500">
                    tracked staked:{" "}
                    <span className="font-mono">
                      {config
                        ? formatTokenAmount(BigInt(config.totalStakedMind.toString()), config.mindDecimals, 4)
                        : "-"}
                    </span>
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-zinc-400">XP boosts</div>
                  <div className="mt-1 text-xs text-zinc-300">
                    Silver @ {config.xpTierSilver.toString()} XP → +{formatBps(config.xpBoostSilverBps)}
                  </div>
                  <div className="mt-1 text-xs text-zinc-300">
                    Gold @ {config.xpTierGold.toString()} XP → +{formatBps(config.xpBoostGoldBps)}
                  </div>
                  <div className="mt-1 text-xs text-zinc-300">
                    Diamond @ {config.xpTierDiamond.toString()} XP → +{formatBps(config.xpBoostDiamondBps)}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">XP minted: {config.totalXp.toString()}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-zinc-400">MIND rewards per plan</div>
                  <div className="mt-1 text-xs text-zinc-300">
                    7d: {formatTokenAmount(BigInt(config.mindReward7d.toString()), config.mindDecimals, 2)} MIND
                  </div>
                  <div className="mt-1 text-xs text-zinc-300">
                    14d: {formatTokenAmount(BigInt(config.mindReward14d.toString()), config.mindDecimals, 2)} MIND
                  </div>
                  <div className="mt-1 text-xs text-zinc-300">
                    28d: {formatTokenAmount(BigInt(config.mindReward28d.toString()), config.mindDecimals, 2)} MIND
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
                  <div className="text-xs text-zinc-400" title="Tier threshold 1 in base units">TH1 (base units)</div>
                  <Input value={th1} onChange={setTh1} placeholder="u64" mono />
                </div>
                <div className="grid gap-2">
                  <div className="text-xs text-zinc-400" title="Tier threshold 2 in base units">TH2 (base units)</div>
                  <Input value={th2} onChange={setTh2} placeholder="u64" mono />
                </div>
                <div className="grid gap-2">
                  <div className="text-xs text-zinc-400" title="Max effective MP cap per wallet in bps">mp_cap_bps_per_wallet</div>
                  <Input value={mpCapBps} onChange={setMpCapBps} placeholder="0-10000" mono />
                </div>
                <div className="grid gap-2">
                  <div className="text-xs text-zinc-400" title="Epoch length in seconds">epoch_seconds</div>
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

              <div className="mt-5 border-t border-white/5 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm font-semibold">XP configuration</div>
                  <label className="flex items-center gap-2 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={updateXpConfig}
                      onChange={(e) => setUpdateXpConfig(e.target.checked)}
                    />
                    update XP config
                  </label>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div className="grid gap-2">
                    <div className="text-xs text-zinc-400" title="XP granted for a 7 day miner">XP per 7d</div>
                    <Input value={xpPer7d} onChange={setXpPer7d} placeholder="u64" mono disabled={!updateXpConfig} />
                  </div>
                  <div className="grid gap-2">
                    <div className="text-xs text-zinc-400" title="XP granted for a 14 day miner">XP per 14d</div>
                    <Input value={xpPer14d} onChange={setXpPer14d} placeholder="u64" mono disabled={!updateXpConfig} />
                  </div>
                  <div className="grid gap-2">
                    <div className="text-xs text-zinc-400" title="XP granted for a 30 day miner">XP per 30d</div>
                    <Input value={xpPer30d} onChange={setXpPer30d} placeholder="u64" mono disabled={!updateXpConfig} />
                  </div>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div className="grid gap-2">
                    <div className="text-xs text-zinc-400" title="XP threshold for Silver tier">Silver tier XP</div>
                    <Input value={xpTierSilver} onChange={setXpTierSilver} placeholder="u64" mono disabled={!updateXpConfig} />
                  </div>
                  <div className="grid gap-2">
                    <div className="text-xs text-zinc-400" title="XP threshold for Gold tier">Gold tier XP</div>
                    <Input value={xpTierGold} onChange={setXpTierGold} placeholder="u64" mono disabled={!updateXpConfig} />
                  </div>
                  <div className="grid gap-2">
                    <div className="text-xs text-zinc-400" title="XP threshold for Diamond tier">Diamond tier XP</div>
                    <Input value={xpTierDiamond} onChange={setXpTierDiamond} placeholder="u64" mono disabled={!updateXpConfig} />
                  </div>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div className="grid gap-2">
                    <div className="text-xs text-zinc-400" title="Stake boost for Silver tier in bps">Silver boost (bps)</div>
                    <Input value={xpBoostSilverBps} onChange={setXpBoostSilverBps} placeholder="bps" mono disabled={!updateXpConfig} />
                  </div>
                  <div className="grid gap-2">
                    <div className="text-xs text-zinc-400" title="Stake boost for Gold tier in bps">Gold boost (bps)</div>
                    <Input value={xpBoostGoldBps} onChange={setXpBoostGoldBps} placeholder="bps" mono disabled={!updateXpConfig} />
                  </div>
                  <div className="grid gap-2">
                    <div className="text-xs text-zinc-400" title="Stake boost for Diamond tier in bps">Diamond boost (bps)</div>
                    <Input value={xpBoostDiamondBps} onChange={setXpBoostDiamondBps} placeholder="bps" mono disabled={!updateXpConfig} />
                  </div>
                </div>
                <div className="mt-2 text-xs text-zinc-500">
                  XP directly affects staking boosts. Enable the toggle to push new parameters on-chain.
                </div>
              </div>

              <div className="mt-5 border-t border-white/5 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm font-semibold">MIND rewards (per miner)</div>
                  <label className="flex items-center gap-2 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={updateMindRewards}
                      onChange={(e) => setUpdateMindRewards(e.target.checked)}
                    />
                    update rewards
                  </label>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div className="grid gap-2">
                    <div className="text-xs text-zinc-400" title="Total MIND minted for a 7 day miner">MIND per 7d</div>
                    <Input value={mindReward7d} onChange={setMindReward7d} placeholder="u64" mono disabled={!updateMindRewards} />
                  </div>
                  <div className="grid gap-2">
                    <div className="text-xs text-zinc-400" title="Total MIND minted for a 14 day miner">MIND per 14d</div>
                    <Input value={mindReward14d} onChange={setMindReward14d} placeholder="u64" mono disabled={!updateMindRewards} />
                  </div>
                  <div className="grid gap-2">
                    <div className="text-xs text-zinc-400" title="Total MIND minted for a 28 day miner">MIND per 28d</div>
                    <Input value={mindReward28d} onChange={setMindReward28d} placeholder="u64" mono disabled={!updateMindRewards} />
                  </div>
                </div>
                <div className="mt-2 text-xs text-zinc-500">
                  Rewards are total MIND minted across the full plan duration. These values affect mining claims.
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

            <Card className="mt-4">
              <CardHeader
                title="Staking vault fund"
                description="Top-up rewards pool (25% of deposits + manual additions)."
                right={config ? <Badge variant="muted">Vault {shortPk(config.stakingVaultXntAta.toBase58(), 8)}</Badge> : null}
              />
              <div className="mt-4 grid gap-3">
                <Input value={stakingFundAmountUi} onChange={setStakingFundAmountUi} placeholder="Amount (XNT)" />
                <Button
                  size="lg"
                  disabled={!publicKey || !isAdmin || !config || busy || stakingBusy}
                  onClick={() => void fundStakingVault().catch(() => null)}
                >
                  {stakingBusy ? "Submitting…" : "Fund staking vault"}
                </Button>
                <div className="text-xs text-zinc-500">
                  Rewards are drawn from this vault when users claim weekly staking rewards.
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
            <CardHeader
              title="Error"
              description="Actionable details from RPC/simulation."
              right={
                <div className="flex items-center gap-2">
                  <Button variant="secondary" onClick={() => void refresh()} disabled={loading}>
                    {loading ? "Retrying…" : "Retry"}
                  </Button>
                  <Badge variant="danger">failed</Badge>
                </div>
              }
            />
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
