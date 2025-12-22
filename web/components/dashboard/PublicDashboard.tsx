"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TopBar } from "@/components/shared/TopBar";
import { useToast } from "@/components/shared/ToastProvider";
import { getProgram } from "@/lib/anchor";
import type { DecodedConfig } from "@/lib/solana";
import {
  deriveConfigPda,
  derivePositionPda,
  deriveUserProfilePda,
  deriveUserStakePda,
  deriveVaultPda,
  fetchClockUnixTs,
  fetchConfig,
  getProgramId,
} from "@/lib/solana";
import type { DecodedUserStake } from "@/lib/decoders";
import {
  decodeMinerPositionAccount,
  decodeUserMiningProfileAccount,
  MINER_POSITION_LEN,
  tryDecodeUserStakeAccount,
} from "@/lib/decoders";
import { formatDurationSeconds, formatTokenAmount, parseUiAmountToBase, shortPk } from "@/lib/format";
import { formatError } from "@/lib/formatError";

const ACC_SCALE = 1_000_000_000_000_000_000n;
const BPS_DENOMINATOR = 10_000n;
const BADGE_BONUS_CAP_BPS = 2_000n;
const CONTRACTS = [
  { key: 0, label: "Starter Rig", durationDays: 7, costXnt: 1, hp: 1 },
  { key: 1, label: "Pro Rig", durationDays: 14, costXnt: 10, hp: 5 },
  { key: 2, label: "Industrial Rig", durationDays: 28, costXnt: 20, hp: 7 },
] as const;

function statValue(value: string, label: string) {
  return (
    <Card className="p-4">
      <div className="text-xl font-semibold text-white">{value}</div>
      <div className="mt-2 text-[10px] uppercase tracking-[0.2em] text-zinc-400">{label}</div>
    </Card>
  );
}

export function PublicDashboard() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { push: pushToast } = useToast();

  const [config, setConfig] = useState<DecodedConfig | null>(null);
  const [nowTs, setNowTs] = useState<number | null>(null);
  const [positions, setPositions] = useState<
    Array<{ pubkey: string; data: ReturnType<typeof decodeMinerPositionAccount> }>
  >([]);
  const [userProfile, setUserProfile] = useState<
    ReturnType<typeof decodeUserMiningProfileAccount> | null
  >(null);
  const [userStake, setUserStake] = useState<DecodedUserStake | null>(null);
  const [mintDecimals, setMintDecimals] = useState<{ xnt: number; mind: number } | null>(null);
  const [xntBalance, setXntBalance] = useState<bigint>(0n);
  const [mindBalance, setMindBalance] = useState<bigint>(0n);
  const [stakingRewardBalance, setStakingRewardBalance] = useState<bigint>(0n);
  const [stakingMindBalance, setStakingMindBalance] = useState<bigint>(0n);
  const [networkTrend, setNetworkTrend] = useState<{ delta: bigint; pct: number } | null>(null);

  const [selectedContract, setSelectedContract] = useState<number>(1);
  const [stakeAmountUi, setStakeAmountUi] = useState<string>("");
  const [unstakeAmountUi, setUnstakeAmountUi] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const contract = CONTRACTS.find((c) => c.key === selectedContract) ?? CONTRACTS[0];

  const refresh = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const cfg = await fetchConfig(connection);
      setConfig(cfg);
      const ts = await fetchClockUnixTs(connection);
      setNowTs(ts);

      const [xntMintInfo, mindMintInfo] = await Promise.all([
        getMint(connection, cfg.xntMint, "confirmed"),
        getMint(connection, cfg.mindMint, "confirmed"),
      ]);
      setMintDecimals({ xnt: xntMintInfo.decimals, mind: mindMintInfo.decimals });

      const [rewardBal, mindBal] = await Promise.all([
        connection.getTokenAccountBalance(cfg.stakingRewardVault, "confirmed"),
        connection.getTokenAccountBalance(cfg.stakingMindVault, "confirmed"),
      ]);
      setStakingRewardBalance(BigInt(rewardBal.value.amount || "0"));
      setStakingMindBalance(BigInt(mindBal.value.amount || "0"));

      if (!publicKey) {
        setPositions([]);
        setUserProfile(null);
        setUserStake(null);
        setXntBalance(0n);
        setMindBalance(0n);
        return;
      }

      const programId = getProgramId();
      const [posGpa, profileAcc, stakeAcc] = await Promise.all([
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [
            { dataSize: MINER_POSITION_LEN },
            { memcmp: { offset: 8, bytes: publicKey.toBase58() } },
          ],
        }),
        connection.getAccountInfo(deriveUserProfilePda(publicKey), "confirmed"),
        connection.getAccountInfo(deriveUserStakePda(publicKey), "confirmed"),
      ]);

      const decodedPositions = posGpa
        .map((p) => ({
          pubkey: p.pubkey.toBase58(),
          data: decodeMinerPositionAccount(Buffer.from(p.account.data)),
        }))
        .sort((a, b) => b.data.startTs - a.data.startTs);
      setPositions(decodedPositions);

      setUserProfile(
        profileAcc?.data ? decodeUserMiningProfileAccount(Buffer.from(profileAcc.data)) : null
      );
      setUserStake(
        stakeAcc?.data ? tryDecodeUserStakeAccount(Buffer.from(stakeAcc.data)) : null
      );

      const xntAta = getAssociatedTokenAddressSync(cfg.xntMint, publicKey);
      const mindAta = getAssociatedTokenAddressSync(cfg.mindMint, publicKey);
      const [xntBal, mindBalUser] = await Promise.all([
        connection
          .getTokenAccountBalance(xntAta, "confirmed")
          .then((b) => BigInt(b.value.amount || "0"))
          .catch(() => 0n),
        connection
          .getTokenAccountBalance(mindAta, "confirmed")
          .then((b) => BigInt(b.value.amount || "0"))
          .catch(() => 0n),
      ]);
      setXntBalance(xntBal);
      setMindBalance(mindBalUser);

      if (typeof window !== "undefined") {
        const key = "mining_v2_network_hp_history";
        const historyRaw = window.localStorage.getItem(key);
        const history: Array<{ ts: number; hp: string }> = historyRaw ? JSON.parse(historyRaw) : [];
        const pruned = history.filter((entry) => ts - entry.ts <= 86_400);
        const last = pruned[pruned.length - 1];
        if (!last || ts - last.ts >= 3_600) {
          pruned.push({ ts, hp: cfg.networkHpActive.toString() });
        } else {
          pruned[pruned.length - 1] = { ts, hp: cfg.networkHpActive.toString() };
        }
        while (pruned.length > 32) pruned.shift();
        window.localStorage.setItem(key, JSON.stringify(pruned));
        const oldest = pruned[0];
        if (oldest && ts - oldest.ts >= 86_400) {
          const prevHp = BigInt(oldest.hp);
          const delta = cfg.networkHpActive - prevHp;
          const pct = prevHp > 0n ? Number((delta * 10_000n) / prevHp) / 100 : 0;
          setNetworkTrend({ delta, pct });
        } else {
          setNetworkTrend(null);
        }
      }
    } catch (e: unknown) {
      console.error(e);
      setError(formatError(e));
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const id = window.setInterval(() => void refresh().catch(() => null), 15_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const userHp = useMemo(() => {
    if (userProfile) return userProfile.activeHp;
    if (!nowTs) return 0n;
    return positions
      .filter((p) => !p.data.deactivated && nowTs < p.data.endTs)
      .reduce((acc, p) => acc + p.data.hp, 0n);
  }, [positions, userProfile, nowTs]);

  const effectiveUserHp = useMemo(() => {
    if (!config) return userHp;
    return userHp > config.maxEffectiveHp ? config.maxEffectiveHp : userHp;
  }, [config, userHp]);

  const networkHp = config?.networkHpActive ?? 0n;
  const sharePct = networkHp > 0n ? Number((effectiveUserHp * 10_000n) / networkHp) / 100 : 0;

  const pendingByPosition = useMemo(() => {
    if (!config) return [] as Array<bigint>;
    return positions.map((p) => {
      const acc = p.data.deactivated ? p.data.finalAccMindPerHp : config.accMindPerHp;
      const earned = (p.data.hp * acc) / ACC_SCALE;
      const pending = earned > p.data.rewardDebt ? earned - p.data.rewardDebt : 0n;
      return pending;
    });
  }, [positions, config]);

  const totalPendingMind = pendingByPosition.reduce((acc, v) => acc + v, 0n);

  const basePendingXnt = useMemo(() => {
    if (!config || !userStake) return 0n;
    const earned = (userStake.stakedMind * config.stakingAccXntPerMind) / ACC_SCALE;
    const pending = earned > userStake.rewardDebt ? earned - userStake.rewardDebt : 0n;
    return pending + userStake.rewardOwed;
  }, [config, userStake]);

  const badgeBonusBps = userProfile?.badgeBonusBps ?? 0;
  const effectiveBonusBps = Math.min(badgeBonusBps, Number(BADGE_BONUS_CAP_BPS));
  const finalPendingXnt =
    basePendingXnt > 0n
      ? (basePendingXnt * (BPS_DENOMINATOR + BigInt(effectiveBonusBps))) / BPS_DENOMINATOR
      : 0n;

  const emissionPerDay = config ? config.emissionPerSec * 86_400n : 0n;
  const estUserPerDay =
    config && networkHp > 0n
      ? (emissionPerDay * effectiveUserHp) / networkHp
      : 0n;

  const epochCountdown = useMemo(() => {
    if (!config || nowTs == null) return null;
    const remaining = Math.max(0, config.stakingEpochEndTs - nowTs);
    return remaining;
  }, [config, nowTs]);

  const estRewardsPer1k = useMemo(() => {
    if (!config || config.stakingTotalStakedMind === 0n) return null;
    const rewards7d = config.stakingRewardRateXntPerSec * 86_400n * 7n;
    return (rewards7d * 1_000n) / config.stakingTotalStakedMind;
  }, [config]);

  const ensureAta = async (owner: PublicKey, mint: PublicKey) => {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const info = await connection.getAccountInfo(ata, "confirmed");
    if (info) return { ata, ix: null };
    return {
      ata,
      ix: createAssociatedTokenAccountIdempotentInstruction(
        owner,
        ata,
        owner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      ),
    };
  };

  const withTx = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setError(null);
    try {
      const sig = await fn();
      setLastSig(sig);
      pushToast({ title: label, description: shortPk(sig, 6) });
    } catch (e: unknown) {
      console.error(e);
      setError(formatError(e));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const onBuy = async () => {
    if (!anchorWallet || !publicKey || !config) return;
    const program = getProgram(connection, anchorWallet);
    const nextIndex = userProfile?.nextPositionIndex ?? BigInt(positions.length);
    const positionIndex = new BN(nextIndex.toString());
    await withTx("Buy contract", async () => {
      const ix = await ensureAta(publicKey, config.xntMint);
      const tx = new Transaction();
      if (ix.ix) tx.add(ix.ix);
      const sig = await program.methods
        .buyContract(contract.key, positionIndex)
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          userProfile: deriveUserProfilePda(publicKey),
          position: derivePositionPda(publicKey, nextIndex),
          vaultAuthority: deriveVaultPda(),
          xntMint: config.xntMint,
          stakingRewardVault: config.stakingRewardVault,
          treasuryVault: config.treasuryVault,
          ownerXntAta: ix.ata,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions(tx.instructions)
        .rpc();
      return sig;
    });
  };

  const onClaim = async (posPubkey: string) => {
    if (!anchorWallet || !publicKey || !config) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Claim MIND", async () => {
      const ix = await ensureAta(publicKey, config.mindMint);
      const tx = new Transaction();
      if (ix.ix) tx.add(ix.ix);
      const sig = await program.methods
        .claimMind()
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          userProfile: deriveUserProfilePda(publicKey),
          position: new PublicKey(posPubkey),
          vaultAuthority: deriveVaultPda(),
          mindMint: config.mindMint,
          userMindAta: ix.ata,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions(tx.instructions)
        .rpc();
      return sig;
    });
  };

  const onDeactivate = async (posPubkey: string, ownerBytes: Uint8Array) => {
    if (!anchorWallet || !config) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Deactivate position", async () => {
      const sig = await program.methods
        .deactivatePosition()
        .accounts({
          config: deriveConfigPda(),
          position: new PublicKey(posPubkey),
          userProfile: deriveUserProfilePda(new PublicKey(ownerBytes)),
        })
        .rpc();
      return sig;
    });
  };

  const onStake = async () => {
    if (!anchorWallet || !publicKey || !config || !mintDecimals) return;
    let amountBase: bigint;
    try {
      amountBase = parseUiAmountToBase(stakeAmountUi, mintDecimals.mind);
    } catch (e: unknown) {
      setError(formatError(e));
      return;
    }
    if (amountBase <= 0n) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Stake MIND", async () => {
      const ix = await ensureAta(publicKey, config.mindMint);
      const tx = new Transaction();
      if (ix.ix) tx.add(ix.ix);
      const sig = await program.methods
        .stakeMind(new BN(amountBase.toString()))
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          userProfile: deriveUserProfilePda(publicKey),
          userStake: deriveUserStakePda(publicKey),
          vaultAuthority: deriveVaultPda(),
          stakingMindVault: config.stakingMindVault,
          ownerMindAta: ix.ata,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions(tx.instructions)
        .rpc();
      return sig;
    });
  };

  const onUnstake = async () => {
    if (!anchorWallet || !publicKey || !config || !mintDecimals) return;
    let amountBase: bigint;
    try {
      amountBase = parseUiAmountToBase(unstakeAmountUi, mintDecimals.mind);
    } catch (e: unknown) {
      setError(formatError(e));
      return;
    }
    if (amountBase <= 0n) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Unstake MIND", async () => {
      const ix = await ensureAta(publicKey, config.mindMint);
      const tx = new Transaction();
      if (ix.ix) tx.add(ix.ix);
      const sig = await program.methods
        .unstakeMind(new BN(amountBase.toString()))
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          userStake: deriveUserStakePda(publicKey),
          vaultAuthority: deriveVaultPda(),
          stakingMindVault: config.stakingMindVault,
          ownerMindAta: ix.ata,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions(tx.instructions)
        .rpc();
      return sig;
    });
  };

  const onClaimXnt = async () => {
    if (!anchorWallet || !publicKey || !config) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Claim XNT", async () => {
      const ix = await ensureAta(publicKey, config.xntMint);
      const tx = new Transaction();
      if (ix.ix) tx.add(ix.ix);
      const sig = await program.methods
        .claimXnt()
        .accounts({
          owner: publicKey,
          config: deriveConfigPda(),
          userProfile: deriveUserProfilePda(publicKey),
          userStake: deriveUserStakePda(publicKey),
          vaultAuthority: deriveVaultPda(),
          stakingRewardVault: config.stakingRewardVault,
          ownerXntAta: ix.ata,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions(tx.instructions)
        .rpc();
      return sig;
    });
  };

  const buyDisabled = !publicKey || !config || Boolean(busy);
  const stakeDisabled = !publicKey || !config || !mintDecimals || Boolean(busy) || stakeAmountUi.trim() === "";
  const unstakeDisabled = !publicKey || !config || !mintDecimals || Boolean(busy) || unstakeAmountUi.trim() === "";

  return (
    <div className="min-h-screen bg-ink text-white">
      <TopBar title="Mining V2" subtitle="Pro-rata emission + staking rewards" link={{ href: "/admin", label: "Admin" }} />

      <main className="mx-auto max-w-6xl px-4 pb-24 pt-10">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {statValue(`HP ${effectiveUserHp.toString()} (raw ${userHp.toString()})`, "Your HP")}
          {statValue(`HP ${networkHp.toString()} (raw)`, "Network HP")}
          {statValue(`${sharePct.toFixed(2)}%`, "Your share")}
          {statValue(
            config && mintDecimals
              ? `${formatTokenAmount(estUserPerDay, mintDecimals.mind, 4)} MIND/day`
              : "-",
            "Est. MIND/day"
          )}
          {statValue(
            config && mintDecimals
              ? `${formatTokenAmount(totalPendingMind, mintDecimals.mind, 4)} MIND`
              : "-",
            "Accrued MIND"
          )}
          {statValue(
            config && mintDecimals
              ? `${formatTokenAmount(stakingRewardBalance, mintDecimals.xnt, 4)} XNT`
              : "-",
            "Reward pool"
          )}
          {statValue(
            config && mintDecimals
              ? `${formatTokenAmount(stakingMindBalance, mintDecimals.mind, 4)} MIND`
              : "-",
            "Total staked"
          )}
          {statValue(
            epochCountdown != null ? formatDurationSeconds(epochCountdown) : "-",
            "Epoch ends"
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-400">
          <Badge variant="muted">Max HP: {config?.maxEffectiveHp.toString() ?? "-"}</Badge>
          <Badge variant="muted">
            Emission/day: {config && mintDecimals ? formatTokenAmount(emissionPerDay, mintDecimals.mind, 4) : "-"}
          </Badge>
          <Badge variant="muted">
            Network 24h:{" "}
            {networkTrend
              ? `${networkTrend.delta.toString()} (${networkTrend.pct.toFixed(2)}%)`
              : "0 (warming up)"}
          </Badge>
          <Badge variant="muted">Badge bonus: +{effectiveBonusBps / 100}%</Badge>
        </div>

        <section className="mt-10 grid gap-6 lg:grid-cols-[2fr_1fr]">
          <Card className="border-cyan-400/20 bg-ink/90 p-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Mining Contracts</div>
                <div className="mt-2 text-2xl font-semibold">Buy hashpower</div>
              </div>
              <Badge variant="muted">HP cap {config?.maxEffectiveHp.toString() ?? "-"}</Badge>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-3">
              {CONTRACTS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setSelectedContract(c.key)}
                  className={[
                    "rounded-2xl border px-4 py-3 text-left text-xs transition",
                    selectedContract === c.key
                      ? "border-cyan-300/50 bg-cyan-300/10 text-white"
                      : "border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10",
                  ].join(" ")}
                >
                  <div className="text-sm font-semibold">{c.label}</div>
                  <div className="mt-1 text-[11px] text-zinc-400">{c.durationDays} days</div>
                  <div className="mt-1 text-[11px] text-cyan-200">HP {c.hp}</div>
                  <div className="mt-3 text-sm text-emerald-200">{c.costXnt} XNT</div>
                </button>
              ))}
            </div>

            <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span>Balance</span>
                <span className="font-mono">
                  {mintDecimals ? formatTokenAmount(xntBalance, mintDecimals.xnt, 4) : "-"} XNT
                </span>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <div className="text-sm text-zinc-300">Selected: {contract.label}</div>
                <Badge variant="success">HP {contract.hp}</Badge>
                <Badge variant="muted">{contract.durationDays}d</Badge>
              </div>
              <div className="mt-4">
                <Button size="lg" className="h-12" onClick={() => void onBuy()} disabled={buyDisabled}>
                  {busy === "Buy contract" ? "Submitting..." : "Buy Contract"}
                </Button>
              </div>
            </div>
          </Card>

          <Card className="border-cyan-400/20 bg-ink/90 p-6">
            <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Mining Positions</div>
            <div className="mt-2 text-2xl font-semibold">Your rigs</div>
            <div className="mt-4 grid gap-3">
              {positions.length === 0 ? (
                <div className="text-xs text-zinc-500">No positions yet.</div>
              ) : (
                positions.map((p, idx) => {
                  const pending = pendingByPosition[idx] ?? 0n;
                  const remaining = nowTs ? Math.max(0, p.data.endTs - nowTs) : null;
                  const expired = nowTs != null && nowTs >= p.data.endTs;
                  return (
                    <div key={p.pubkey} className="rounded-2xl border border-white/10 bg-white/5 p-3">
                      <div className="flex items-center justify-between">
                        <div className="text-sm text-zinc-200">HP {p.data.hp.toString()}</div>
                        <Badge variant={expired ? "danger" : "success"}>
                          {expired ? "expired" : "active"}
                        </Badge>
                      </div>
                      <div className="mt-2 text-xs text-zinc-400">
                        Ends in {remaining == null ? "-" : formatDurationSeconds(remaining)}
                      </div>
                      <div className="mt-2 text-xs text-cyan-200">
                        Pending {mintDecimals ? formatTokenAmount(pending, mintDecimals.mind, 4) : "-"} MIND
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={() => void onClaim(p.pubkey)}
                          disabled={busy != null || pending === 0n}
                        >
                          Claim
                        </Button>
                        <Button size="sm" onClick={() => void onDeactivate(p.pubkey, p.data.owner)} disabled={busy != null || !expired}>
                          Deactivate
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </Card>
        </section>

        <section className="mt-10 grid gap-6 lg:grid-cols-[1fr_1fr]">
          <Card className="border-emerald-400/20 bg-ink/90 p-6">
            <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Staking</div>
            <div className="mt-2 text-2xl font-semibold">Stake MIND</div>
            <div className="mt-3 text-xs text-zinc-400">
              Pending rewards: {mintDecimals ? formatTokenAmount(finalPendingXnt, mintDecimals.xnt, 4) : "-"} XNT
            </div>
            <div className="mt-4">
              <Input
                value={stakeAmountUi}
                onChange={setStakeAmountUi}
                placeholder="Amount (MIND)"
              />
              <Button
                className="mt-3"
                onClick={() => void onStake()}
                disabled={stakeDisabled}
              >
                {busy === "Stake MIND" ? "Submitting..." : "Stake"}
              </Button>
            </div>
            <div className="mt-6">
              <Input
                value={unstakeAmountUi}
                onChange={setUnstakeAmountUi}
                placeholder="Unstake amount (MIND)"
              />
              <Button className="mt-3" onClick={() => void onUnstake()} disabled={unstakeDisabled}>
                {busy === "Unstake MIND" ? "Submitting..." : "Unstake"}
              </Button>
            </div>
            <div className="mt-6">
              <Button onClick={() => void onClaimXnt()} disabled={busy != null || finalPendingXnt === 0n}>
                {busy === "Claim XNT" ? "Claiming..." : "Claim XNT"}
              </Button>
            </div>
          </Card>

          <Card className="border-emerald-400/20 bg-ink/90 p-6">
            <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Pool stats</div>
            <div className="mt-2 text-2xl font-semibold">Rewards</div>
            <div className="mt-4 grid gap-2 text-xs text-zinc-400">
              <div>
                Reward rate:{" "}
                {config && mintDecimals
                  ? `${formatTokenAmount(config.stakingRewardRateXntPerSec, mintDecimals.xnt, 6)} XNT/sec`
                  : "-"}
              </div>
              <div>
                7d est per 1k MIND: {mintDecimals && estRewardsPer1k
                  ? `${formatTokenAmount(estRewardsPer1k, mintDecimals.xnt, 4)} XNT`
                  : "-"}
              </div>
              <div>Epoch ends in: {epochCountdown != null ? formatDurationSeconds(epochCountdown) : "-"}</div>
              <div>
                Your staked:{" "}
                {userStake && mintDecimals
                  ? `${formatTokenAmount(userStake.stakedMind, mintDecimals.mind, 4)} MIND`
                  : "-"}
              </div>
            </div>
          </Card>
        </section>

        {error ? <div className="mt-6 text-sm text-amber-200">{error}</div> : null}
        {lastSig ? (
          <div className="mt-4 text-xs text-zinc-400">
            Last tx: <span className="font-mono">{shortPk(lastSig, 8)}</span>
          </div>
        ) : null}
        {loading ? <div className="mt-4 text-xs text-zinc-500">Refreshing...</div> : null}
      </main>
    </div>
  );
}
