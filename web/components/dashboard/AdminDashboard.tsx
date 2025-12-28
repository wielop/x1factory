"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getMint } from "@solana/spl-token";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TopBar } from "@/components/shared/TopBar";
import { useToast } from "@/components/shared/ToastProvider";
import { AdminNav } from "@/components/admin/AdminNav";
import { getProgram } from "@/lib/anchor";
import {
  deriveConfigPda,
  deriveStakingRewardVaultPda,
  deriveTreasuryVaultPda,
  deriveUserProfilePda,
  fetchClockUnixTs,
  fetchConfig,
  getProgramId,
} from "@/lib/solana";
import { formatTokenAmount, parseUiAmountToBase, shortPk } from "@/lib/format";
import { formatError } from "@/lib/formatError";
import { sendTelemetry } from "@/lib/telemetryClient";
import {
  decodeMinerPositionAccount,
  decodeUserMiningProfileAccount,
  decodeUserStakeAccount,
  MINER_POSITION_LEN,
  USER_PROFILE_LEN_V1,
  USER_PROFILE_LEN_V2,
  USER_STAKE_LEN,
} from "@/lib/decoders";

const DAY_SECONDS = 86_400n;
const XNT_DECIMALS = 9;
const NATIVE_VAULT_SPACE = 9;
const BPS_DENOMINATOR = 10_000n;
const HP_SCALE = 100n;

function formatHp(value: bigint) {
  const whole = value / HP_SCALE;
  const frac = value % HP_SCALE;
  return `${whole.toString()}.${frac.toString().padStart(2, "0")}`;
}

function levelBonusBps(level: number) {
  switch (level) {
    case 1:
      return 0n;
    case 2:
      return 160n;
    case 3:
      return 340n;
    case 4:
      return 550n;
    case 5:
      return 780n;
    default:
      return 1000n;
  }
}

export function AdminDashboard() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { push: pushToast } = useToast();

  const [config, setConfig] = useState<Awaited<ReturnType<typeof fetchConfig>> | null>(null);
  const [nowTs, setNowTs] = useState<number | null>(null);
  const [mintDecimals, setMintDecimals] = useState<{ xnt: number; mind: number } | null>(null);
  const [stakingRewardBalance, setStakingRewardBalance] = useState<bigint>(0n);
  const [treasuryBalance, setTreasuryBalance] = useState<bigint>(0n);
  const [activeMiners, setActiveMiners] = useState<
    Array<{ owner: string; rigs: number; hp: bigint; sharePct: number }>
  >([]);
  const [activeMinerTotal, setActiveMinerTotal] = useState(0);
  const [activeRigTotal, setActiveRigTotal] = useState(0);
  const [activeMinerUpdated, setActiveMinerUpdated] = useState<number | null>(null);
  const [activeStakers, setActiveStakers] = useState<
    Array<{ owner: string; staked: bigint; sharePct: number }>
  >([]);
  const [activeStakerTotal, setActiveStakerTotal] = useState(0);
  const [activeStakedTotal, setActiveStakedTotal] = useState<bigint>(0n);
  const [activeStakerUpdated, setActiveStakerUpdated] = useState<number | null>(null);

  const [emissionPerDayUi, setEmissionPerDayUi] = useState<string>("");
  const [maxEffectiveHpUi, setMaxEffectiveHpUi] = useState<string>("");
  const [epochSecondsUi, setEpochSecondsUi] = useState<string>("86400");
  const [badgeUser, setBadgeUser] = useState<string>("");
  const [badgeTier, setBadgeTier] = useState<string>("0");
  const [badgeBonusBps, setBadgeBonusBps] = useState<string>("0");
  const [rewardTopUpUi, setRewardTopUpUi] = useState<string>("");
  const [treasuryWithdrawUi, setTreasuryWithdrawUi] = useState<string>("3.8");

  const [busy, setBusy] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [criticalBlocked, setCriticalBlocked] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const cfg = await fetchConfig(connection);
      setConfig(cfg);
      const ts = await fetchClockUnixTs(connection);
      setNowTs(ts);
      let useNativeXnt = cfg.xntMint.equals(SystemProgram.programId);
      const rewardVaultInfo = await connection.getAccountInfo(cfg.stakingRewardVault, "confirmed");
      if (rewardVaultInfo && !rewardVaultInfo.owner.equals(TOKEN_PROGRAM_ID)) {
        useNativeXnt = true;
      }
      const mindMintInfo = await getMint(connection, cfg.mindMint, "confirmed");
      if (!useNativeXnt) {
        try {
          await getMint(connection, cfg.xntMint, "confirmed");
        } catch {
          useNativeXnt = true;
        }
      }
      setMintDecimals({ xnt: XNT_DECIMALS, mind: mindMintInfo.decimals });
      let rewardBal: bigint;
      try {
        if (useNativeXnt) {
          rewardBal = BigInt(await connection.getBalance(cfg.stakingRewardVault, "confirmed"));
        } else {
          const rewardBalRaw = await connection.getTokenAccountBalance(
            cfg.stakingRewardVault,
            "confirmed"
          );
          rewardBal = BigInt(rewardBalRaw.value.amount || "0");
        }
      } catch {
        useNativeXnt = true;
        rewardBal = BigInt(await connection.getBalance(cfg.stakingRewardVault, "confirmed"));
      }
      let rentLamports = 0n;
      if (useNativeXnt) {
        rentLamports = BigInt(
          await connection.getMinimumBalanceForRentExemption(NATIVE_VAULT_SPACE)
        );
        rewardBal = rewardBal > rentLamports ? rewardBal - rentLamports : 0n;
      }
      let treasuryBal: bigint;
      try {
        if (useNativeXnt) {
          treasuryBal = BigInt(await connection.getBalance(cfg.treasuryVault, "confirmed"));
        } else {
          const treasuryBalRaw = await connection.getTokenAccountBalance(
            cfg.treasuryVault,
            "confirmed"
          );
          treasuryBal = BigInt(treasuryBalRaw.value.amount || "0");
        }
      } catch {
        treasuryBal = BigInt(await connection.getBalance(cfg.treasuryVault, "confirmed"));
      }
      if (useNativeXnt) {
        treasuryBal = treasuryBal > rentLamports ? treasuryBal - rentLamports : 0n;
      }
      setStakingRewardBalance(rewardBal);
      setTreasuryBalance(treasuryBal);
      if (mindMintInfo.decimals >= 0) {
        const emissionPerDay = (cfg.emissionPerSec * DAY_SECONDS) / 10n ** BigInt(mindMintInfo.decimals);
        setEmissionPerDayUi(emissionPerDay.toString());
      }
      setMaxEffectiveHpUi(cfg.maxEffectiveHp.toString());
      try {
        const programId = getProgramId();
        const [positions, stakes] = await Promise.all([
          connection.getProgramAccounts(programId, {
            commitment: "confirmed",
            filters: [{ dataSize: MINER_POSITION_LEN }],
          }),
          connection.getProgramAccounts(programId, {
            commitment: "confirmed",
            filters: [{ dataSize: USER_STAKE_LEN }],
          }),
        ]);
        const now = ts ?? Math.floor(Date.now() / 1000);
        const map = new Map<string, { rigs: number; hp: bigint }>();
        let totalRigs = 0;
        let totalHp = 0n;
        for (const entry of positions) {
          const decoded = decodeMinerPositionAccount(Buffer.from(entry.account.data));
          if (decoded.deactivated || decoded.endTs <= now) continue;
          const ownerKey = new PublicKey(decoded.owner).toBase58();
          const current = map.get(ownerKey) ?? { rigs: 0, hp: 0n };
          current.rigs += 1;
          current.hp += decoded.hp;
          map.set(ownerKey, current);
          totalRigs += 1;
          totalHp += decoded.hp;
        }
        const networkHp =
          cfg.networkHpActive > 0n ? cfg.networkHpActive : totalHp * HP_SCALE;
        const list = Array.from(map.entries())
          .map(([owner, value]) => {
            const sharePct =
              networkHp > 0n
                ? Number((value.hp * HP_SCALE * 10_000n) / networkHp) / 100
                : 0;
            return { owner, rigs: value.rigs, hp: value.hp, sharePct };
          })
          .sort((a, b) => (b.rigs !== a.rigs ? b.rigs - a.rigs : Number(b.hp - a.hp)));
        setActiveMiners(list);
        setActiveMinerTotal(map.size);
        setActiveRigTotal(totalRigs);
        setActiveMinerUpdated(now);

        const stakerMap = new Map<string, bigint>();
        let totalStaked = cfg.stakingTotalStakedMind;
        if (totalStaked === 0n) {
          totalStaked = 0n;
        }
        for (const entry of stakes) {
          const decoded = decodeUserStakeAccount(Buffer.from(entry.account.data));
          if (decoded.stakedMind === 0n) continue;
          const ownerKey = new PublicKey(decoded.owner).toBase58();
          stakerMap.set(ownerKey, decoded.stakedMind);
          if (cfg.stakingTotalStakedMind === 0n) {
            totalStaked += decoded.stakedMind;
          }
        }
        const stakerList = Array.from(stakerMap.entries())
          .map(([owner, staked]) => {
            const sharePct =
              totalStaked > 0n ? Number((staked * 10_000n) / totalStaked) / 100 : 0;
            return { owner, staked, sharePct };
          })
          .sort((a, b) =>
            b.staked !== a.staked ? (b.staked > a.staked ? 1 : -1) : b.sharePct - a.sharePct
          );
        setActiveStakers(stakerList);
        setActiveStakerTotal(stakerMap.size);
        setActiveStakedTotal(totalStaked);
        setActiveStakerUpdated(now);
      } catch (err) {
        console.warn("Failed to load active miners", err);
        setActiveMiners([]);
        setActiveMinerTotal(0);
        setActiveRigTotal(0);
        setActiveMinerUpdated(null);
        setActiveStakers([]);
        setActiveStakerTotal(0);
        setActiveStakedTotal(0n);
        setActiveStakerUpdated(null);
      }
    } catch (e: unknown) {
      console.error(e);
      setError(formatError(e));
    }
  }, [connection]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let active = true;
    const loadAlerts = async () => {
      try {
        const res = await fetch("/api/admin/state", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        const hasCritical = (data.alerts ?? []).some(
          (alert: { level: string; resolved: boolean }) =>
            alert.level === "CRITICAL" && !alert.resolved
        );
        if (active) setCriticalBlocked(hasCritical);
      } catch {
        if (active) setCriticalBlocked(false);
      }
    };
    void loadAlerts();
    const interval = setInterval(loadAlerts, 30_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const isAdmin = useMemo(() => {
    if (!publicKey || !config) return false;
    return publicKey.equals(config.admin);
  }, [publicKey, config]);

  const mapTxAction = (label: string) => {
    switch (label) {
      case "Update config":
        return "admin_update_config";
      case "Roll epoch":
        return "roll_epoch";
      case "Set badge":
        return "admin_set_badge";
      case "Fund reward vault":
        return "admin_fund_reward";
      case "Withdraw treasury":
        return "admin_withdraw_treasury";
      case "Use native XNT vaults":
        return "admin_sync_vaults";
      case "Recalc network HP":
        return "admin_set_network_hp_active";
      default:
        return "admin_other";
    }
  };

  const withTx = async (label: string, fn: () => Promise<string>) => {
    const start = typeof performance !== "undefined" ? performance.now() : Date.now();
    let ok = false;
    let errorMsg: string | undefined;
    setBusy(label);
    setError(null);
    try {
      const sig = await fn();
      setLastSig(sig);
      pushToast({ title: label, description: shortPk(sig, 6) });
      ok = true;
    } catch (e: unknown) {
      console.error(e);
      errorMsg = formatError(e);
      setError(errorMsg);
    } finally {
      setBusy(null);
      const durationMs =
        (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
      void sendTelemetry({
        kind: "tx",
        action: mapTxAction(label),
        ok,
        durationMs,
      });
      if (!ok && errorMsg) {
        void sendTelemetry({ kind: "app_error", message: errorMsg });
      }
      await refresh();
    }
  };

  const onUpdateConfig = async () => {
    if (!anchorWallet || !config || !mintDecimals) return;
    let emissionPerSec: bigint;
    try {
      const perDayBase = parseUiAmountToBase(emissionPerDayUi, mintDecimals.mind);
      emissionPerSec = perDayBase / DAY_SECONDS;
    } catch (e: unknown) {
      setError(formatError(e));
      return;
    }
    let maxHp: bigint;
    try {
      maxHp = BigInt(maxEffectiveHpUi || "0");
    } catch {
      setError("Invalid max HP value");
      return;
    }
    if (emissionPerSec <= 0n || maxHp <= 0n) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Update config", async () => {
      const sig = await program.methods
        .adminUpdateConfig(new BN(emissionPerSec.toString()), new BN(maxHp.toString()))
        .accounts({
          admin: publicKey!,
          config: deriveConfigPda(),
        })
        .rpc();
      return sig;
    });
  };

  const onRollEpoch = async () => {
    if (!anchorWallet || !config) return;
    let seconds: bigint;
    try {
      seconds = BigInt(epochSecondsUi || "0");
    } catch {
      setError("Invalid epoch seconds");
      return;
    }
    if (seconds <= 0n) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Roll epoch", async () => {
      const sig = await program.methods
        .rollEpoch(new BN(seconds.toString()))
        .accounts({
          config: deriveConfigPda(),
          stakingRewardVault: config.stakingRewardVault,
        })
        .rpc();
      return sig;
    });
  };

  const onSetBadge = async () => {
    if (!anchorWallet || !config) return;
    let userPk: PublicKey;
    try {
      userPk = new PublicKey(badgeUser.trim());
    } catch {
      setError("Invalid user public key");
      return;
    }
    const tier = Number(badgeTier || 0);
    const bonus = Number(badgeBonusBps || 0);
    if (!Number.isFinite(tier) || !Number.isFinite(bonus)) {
      setError("Invalid badge inputs");
      return;
    }
    const program = getProgram(connection, anchorWallet);
    await withTx("Set badge", async () => {
      const sig = await program.methods
        .adminSetBadge(tier, bonus)
        .accounts({
          admin: publicKey!,
          config: deriveConfigPda(),
          user: userPk,
          userProfile: deriveUserProfilePda(userPk),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      return sig;
    });
  };

  const onFundRewardVault = async () => {
    if (!anchorWallet || !config || !mintDecimals || !publicKey) return;
    let amountBase: bigint;
    try {
      amountBase = parseUiAmountToBase(rewardTopUpUi, mintDecimals.xnt);
    } catch (e: unknown) {
      setError(formatError(e));
      return;
    }
    if (amountBase <= 0n) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Fund reward vault", async () => {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: config.stakingRewardVault,
          lamports: Number(amountBase),
        })
      );
      return await program.provider.sendAndConfirm(tx, []);
    });
  };

  const onWithdrawTreasury = async () => {
    if (!anchorWallet || !config || !mintDecimals || !publicKey) return;
    let amountBase: bigint;
    try {
      amountBase = parseUiAmountToBase(treasuryWithdrawUi, mintDecimals.xnt);
    } catch (e: unknown) {
      setError(formatError(e));
      return;
    }
    if (amountBase <= 0n) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Withdraw treasury", async () => {
      const sig = await program.methods
        .adminWithdrawTreasury(new BN(amountBase.toString()))
        .accounts({
          admin: publicKey,
          config: deriveConfigPda(),
          treasuryVault: config.treasuryVault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      return sig;
    });
  };

  const onUseNativeVaults = async () => {
    if (!anchorWallet || !config || !publicKey) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Use native XNT vaults", async () => {
      const sig = await program.methods
        .adminUseNativeXnt()
        .accounts({
          admin: publicKey,
          config: deriveConfigPda(),
          stakingRewardVault: deriveStakingRewardVaultPda(),
          treasuryVault: deriveTreasuryVaultPda(),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      return sig;
    });
  };

  const onRecalcNetworkHp = async () => {
    if (!anchorWallet || !config || !publicKey) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Recalc network HP", async () => {
      const programId = getProgramId();
      const now = await fetchClockUnixTs(connection);
      const [positions, profilesV1, profilesV2] = await Promise.all([
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: MINER_POSITION_LEN }],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: USER_PROFILE_LEN_V1 }],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: USER_PROFILE_LEN_V2 }],
        }),
      ]);

      const levels = new Map<string, number>();
      const loadProfile = (entry: (typeof profilesV1)[number]) => {
        const decoded = decodeUserMiningProfileAccount(Buffer.from(entry.account.data));
        const ownerKey = new PublicKey(decoded.owner).toBase58();
        levels.set(ownerKey, decoded.level || 1);
      };
      profilesV1.forEach(loadProfile);
      profilesV2.forEach(loadProfile);

      const ownerBaseHp = new Map<string, bigint>();
      for (const entry of positions) {
        const decoded = decodeMinerPositionAccount(Buffer.from(entry.account.data));
        if (decoded.deactivated || decoded.endTs <= now) continue;
        const ownerKey = new PublicKey(decoded.owner).toBase58();
        ownerBaseHp.set(ownerKey, (ownerBaseHp.get(ownerKey) ?? 0n) + decoded.hp);
      }

      let totalEffectiveHp = 0n;
      for (const [ownerKey, baseHp] of ownerBaseHp) {
        const level = levels.get(ownerKey) ?? 1;
        const bonus = levelBonusBps(level);
        const effective =
          baseHp * (BPS_DENOMINATOR + bonus) * HP_SCALE / BPS_DENOMINATOR;
        totalEffectiveHp += effective;
      }

      const sig = await program.methods
        .adminSetNetworkHpActive(new BN(totalEffectiveHp.toString()))
        .accounts({
          admin: publicKey,
          config: deriveConfigPda(),
        })
        .rpc();
      return sig;
    });
  };


  return (
    <div className="min-h-screen bg-ink text-white">
      <TopBar link={{ href: "/", label: "Dashboard" }} />

      <main className="mx-auto max-w-5xl px-4 pb-20 pt-10">
        <AdminNav active="panel" isAdmin={isAdmin} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Card className="p-4">
            <div className="text-sm font-semibold">Config</div>
            <div className="mt-3 text-xs text-zinc-400">
              Admin: {config ? shortPk(config.admin.toBase58(), 6) : "-"}
            </div>
            <div className="mt-2 text-xs text-zinc-400">
              Network HP: {config ? formatHp(config.networkHpActive) : "-"}
            </div>
            <div className="mt-2 text-xs text-zinc-400">
              Emission/sec: {config?.emissionPerSec.toString() ?? "-"} base
            </div>
            <div className="mt-2 text-xs text-zinc-400">
              Epoch end: {config?.stakingEpochEndTs ?? "-"}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge variant={isAdmin ? "success" : "danger"}>{isAdmin ? "admin" : "readonly"}</Badge>
              <Badge variant="muted">Now {nowTs ?? "-"}</Badge>
            </div>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-semibold">Vaults</div>
            <div className="mt-3 text-xs text-zinc-400">
              Reward vault (available):{" "}
              {mintDecimals ? formatTokenAmount(stakingRewardBalance, mintDecimals.xnt, 4) : "-"} XNT
            </div>
            <div className="mt-2 text-xs text-zinc-400">
              Treasury vault (available):{" "}
              {mintDecimals ? formatTokenAmount(treasuryBalance, mintDecimals.xnt, 4) : "-"} XNT
            </div>
          </Card>
        </div>

        <Card className="mt-4 p-4">
          <div className="text-sm font-semibold">Active miners</div>
          <div className="mt-2 text-xs text-zinc-400">
            Unique addresses: {activeMinerTotal} | Active rigs: {activeRigTotal}
            {activeMinerUpdated != null ? ` | Updated ${activeMinerUpdated}` : ""}
          </div>
          <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
            {activeMiners.length === 0 ? (
              <div className="text-xs text-zinc-500">No active rigs found.</div>
            ) : (
              activeMiners.map((entry) => (
                <div
                  key={entry.owner}
                  className="flex flex-col gap-1 border-b border-white/5 pb-2 text-xs text-zinc-300"
                >
                  <div className="font-mono break-all">{entry.owner}</div>
                  <div className="text-zinc-500">
                    Rigs: {entry.rigs} | HP: {entry.hp.toString()} | Share: {entry.sharePct.toFixed(2)}%
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card className="mt-4 p-4">
          <div className="text-sm font-semibold">Active stakers</div>
          <div className="mt-2 text-xs text-zinc-400">
            Unique addresses: {activeStakerTotal} | Total staked:{" "}
            {mintDecimals ? formatTokenAmount(activeStakedTotal, mintDecimals.mind, 4) : "-"} MIND
            {activeStakerUpdated != null ? ` | Updated ${activeStakerUpdated}` : ""}
          </div>
          <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
            {activeStakers.length === 0 ? (
              <div className="text-xs text-zinc-500">No active stakers found.</div>
            ) : (
              activeStakers.map((entry) => (
                <div
                  key={entry.owner}
                  className="flex flex-col gap-1 border-b border-white/5 pb-2 text-xs text-zinc-300"
                >
                  <div className="font-mono break-all">{entry.owner}</div>
                  <div className="text-zinc-500">
                    Staked:{" "}
                    {mintDecimals ? formatTokenAmount(entry.staked, mintDecimals.mind, 4) : "-"} MIND
                    {" | "}Share: {entry.sharePct.toFixed(2)}%
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        <section className="mt-8 grid gap-4 lg:grid-cols-2">
          <Card className="p-4">
            <div className="text-sm font-semibold">Update mining config</div>
            <div className="mt-3 text-xs text-zinc-400">Emission per day (MIND)</div>
            <Input value={emissionPerDayUi} onChange={setEmissionPerDayUi} />
            <div className="mt-3 text-xs text-zinc-400">Max effective HP</div>
            <Input value={maxEffectiveHpUi} onChange={setMaxEffectiveHpUi} />
            <Button className="mt-4" onClick={() => void onUpdateConfig()} disabled={!isAdmin || busy != null}>
              {busy === "Update config" ? "Submitting..." : "Update Config"}
            </Button>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-semibold">Roll staking epoch</div>
            <div className="mt-3 text-xs text-zinc-400">Epoch length (seconds)</div>
            <Input value={epochSecondsUi} onChange={setEpochSecondsUi} />
            <Button
              className="mt-4"
              onClick={() => void onRollEpoch()}
              disabled={busy != null || criticalBlocked}
            >
              {busy === "Roll epoch" ? "Submitting..." : "Roll Epoch"}
            </Button>
            {criticalBlocked ? (
              <div className="mt-2 text-xs text-amber-200">
                Rolling is blocked while there are unresolved critical alerts. Check the "Dane" tab.
              </div>
            ) : null}
          </Card>

          <Card className="p-4">
            <div className="text-sm font-semibold">Fund reward vault</div>
            <div className="mt-2 text-xs text-zinc-400">
              Send XNT from the admin wallet to the staking reward vault.
            </div>
            <div className="mt-3 text-xs text-zinc-400">Amount (XNT)</div>
            <Input value={rewardTopUpUi} onChange={setRewardTopUpUi} />
            <Button className="mt-4" onClick={() => void onFundRewardVault()} disabled={!isAdmin || busy != null}>
              {busy === "Fund reward vault" ? "Submitting..." : "Top up reward vault"}
            </Button>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-semibold">Use native XNT vaults</div>
            <div className="mt-2 text-xs text-zinc-400">
              Syncs the config to the native (lamports) reward + treasury vault PDAs.
            </div>
            <Button className="mt-4" onClick={() => void onUseNativeVaults()} disabled={!isAdmin || busy != null}>
              {busy === "Use native XNT vaults" ? "Submitting..." : "Sync native vaults"}
            </Button>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-semibold">Recalculate network HP</div>
            <div className="mt-2 text-xs text-zinc-400">
              Rebuilds total network HP from active rigs and current level bonuses.
            </div>
            <Button className="mt-4" onClick={() => void onRecalcNetworkHp()} disabled={!isAdmin || busy != null}>
              {busy === "Recalc network HP" ? "Submitting..." : "Recalc network HP"}
            </Button>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-semibold">Withdraw from treasury</div>
            <div className="mt-2 text-xs text-zinc-400">
              Transfer XNT from the treasury vault to the admin wallet.
            </div>
            <div className="mt-3 text-xs text-zinc-400">Amount (XNT)</div>
            <Input value={treasuryWithdrawUi} onChange={setTreasuryWithdrawUi} />
            <Button className="mt-4" onClick={() => void onWithdrawTreasury()} disabled={!isAdmin || busy != null}>
              {busy === "Withdraw treasury" ? "Submitting..." : "Withdraw to admin wallet"}
            </Button>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-semibold">Set badge</div>
            <div className="mt-3 text-xs text-zinc-400">User pubkey</div>
            <Input value={badgeUser} onChange={setBadgeUser} />
            <div className="mt-3 text-xs text-zinc-400">Badge tier</div>
            <Input value={badgeTier} onChange={setBadgeTier} />
            <div className="mt-3 text-xs text-zinc-400">Bonus bps (cap 2000)</div>
            <Input value={badgeBonusBps} onChange={setBadgeBonusBps} />
            <Button className="mt-4" onClick={() => void onSetBadge()} disabled={!isAdmin || busy != null}>
              {busy === "Set badge" ? "Submitting..." : "Set Badge"}
            </Button>
          </Card>
        </section>

        {error ? <div className="mt-6 text-sm text-amber-200">{error}</div> : null}
        {lastSig ? (
          <div className="mt-4 text-xs text-zinc-400">
            Last tx: <span className="font-mono">{shortPk(lastSig, 8)}</span>
          </div>
        ) : null}
      </main>
    </div>
  );
}
