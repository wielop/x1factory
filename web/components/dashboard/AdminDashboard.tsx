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
  MINER_POSITION_LEN_V1,
  MINER_POSITION_LEN_V2,
  USER_PROFILE_LEN_V1,
  USER_PROFILE_LEN_V2,
  USER_PROFILE_LEN_V3,
  USER_STAKE_LEN,
} from "@/lib/decoders";

const DAY_SECONDS = 86_400n;
const STAKING_EPOCH_DAYS = 14n;
const XNT_DECIMALS = 9;
const NATIVE_VAULT_SPACE = 9;
const BPS_DENOMINATOR = 10_000n;
const HP_SCALE = 100n;
const EMISSION_PER_DAY_MAX = 1000n;
const EMISSION_JUMP_NUM = 12n; // 1.2x
const EMISSION_JUMP_DEN = 10n;
const SECONDS_PER_DAY_MIN = 82_000n;
const SECONDS_PER_DAY_MAX = 90_000n;

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

function rigTypeFromDuration(startTs: number, endTs: number, secondsPerDay: number) {
  if (!Number.isFinite(secondsPerDay) || secondsPerDay <= 0) return 0;
  const duration = Math.max(0, endTs - startTs);
  const days = Math.round(duration / secondsPerDay);
  switch (days) {
    case 7:
      return 0;
    case 14:
      return 1;
    case 28:
      return 2;
    default:
      return 0;
  }
}

function rigBuffBps(rigType: number, buffLevel: number) {
  if (rigType === 0) return buffLevel >= 1 ? 100 : 0;
  if (rigType === 1) {
    if (buffLevel >= 3) return 350;
    if (buffLevel === 2) return 200;
    if (buffLevel === 1) return 100;
    return 0;
  }
  if (rigType === 2) {
    if (buffLevel >= 3) return 500;
    if (buffLevel === 2) return 300;
    if (buffLevel === 1) return 150;
    return 0;
  }
  return 0;
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
    Array<{
      owner: string;
      rigs: number;
      hp: bigint;
      level: number;
      sharePct: number;
      levelBonusHp: bigint;
      levelBonusSharePct: number;
    }>
  >([]);
  const [activeMinerTotal, setActiveMinerTotal] = useState(0);
  const [activeRigTotal, setActiveRigTotal] = useState(0);
  const [activeMinerUpdated, setActiveMinerUpdated] = useState<number | null>(null);
  const [activeStakers, setActiveStakers] = useState<
    Array<{ owner: string; staked: bigint; sharePct: number; predictedDailyXnt: bigint }>
  >([]);
  const [activeStakerTotal, setActiveStakerTotal] = useState(0);
  const [activeStakedTotal, setActiveStakedTotal] = useState<bigint>(0n);
  const [activeStakerUpdated, setActiveStakerUpdated] = useState<number | null>(null);

  const [emissionPerDayUi, setEmissionPerDayUi] = useState<string>("");
  const [maxEffectiveHpUi, setMaxEffectiveHpUi] = useState<string>("");
  const [secondsPerDayUi, setSecondsPerDayUi] = useState<string>(DAY_SECONDS.toString());
  const [epochSecondsUi, setEpochSecondsUi] = useState<string>(
    (DAY_SECONDS * STAKING_EPOCH_DAYS).toString()
  );
  const [badgeUser, setBadgeUser] = useState<string>("");
  const [badgeTier, setBadgeTier] = useState<string>("0");
  const [badgeBonusBps, setBadgeBonusBps] = useState<string>("0");
  const [adminXpAmount, setAdminXpAmount] = useState<string>("");
  const [rewardTopUpUi, setRewardTopUpUi] = useState<string>("");
  const [treasuryWithdrawUi, setTreasuryWithdrawUi] = useState<string>("3.8");
  const [stakingWithdrawUi, setStakingWithdrawUi] = useState<string>("1");

  const [busy, setBusy] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const loadConfig = async () => {
      try {
        const cfg = await fetchConfig(connection);
        if (!active) return;
        setConfig(cfg);
      } catch {
        if (!active) return;
        setConfig(null);
      }
    };
    void loadConfig();
    return () => {
      active = false;
    };
  }, [connection]);

  const stakingEpochBalances = useMemo(() => {
    if (!config) return null;
    const unaccounted =
      stakingRewardBalance > config.stakingAccountedBalance
        ? stakingRewardBalance - config.stakingAccountedBalance
        : 0n;
    const nextEpoch = config.stakingUndistributedXnt + unaccounted;
    const currentEpoch =
      stakingRewardBalance > nextEpoch ? stakingRewardBalance - nextEpoch : 0n;
    return { currentEpoch, nextEpoch };
  }, [config, stakingRewardBalance]);

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
      setEpochSecondsUi((cfg.secondsPerDay * STAKING_EPOCH_DAYS).toString());
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
      setSecondsPerDayUi(cfg.secondsPerDay.toString());
      try {
        const programId = getProgramId();
        const [positionsV1, positionsV2, stakes, profilesV1, profilesV2, profilesV3] =
          await Promise.all([
          connection.getProgramAccounts(programId, {
            commitment: "confirmed",
            filters: [{ dataSize: MINER_POSITION_LEN_V1 }],
          }),
          connection.getProgramAccounts(programId, {
            commitment: "confirmed",
            filters: [{ dataSize: MINER_POSITION_LEN_V2 }],
          }),
          connection.getProgramAccounts(programId, {
            commitment: "confirmed",
            filters: [{ dataSize: USER_STAKE_LEN }],
          }),
          connection.getProgramAccounts(programId, {
            commitment: "confirmed",
            filters: [{ dataSize: USER_PROFILE_LEN_V1 }],
          }),
          connection.getProgramAccounts(programId, {
            commitment: "confirmed",
            filters: [{ dataSize: USER_PROFILE_LEN_V2 }],
          }),
          connection.getProgramAccounts(programId, {
            commitment: "confirmed",
            filters: [{ dataSize: USER_PROFILE_LEN_V3 }],
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
        profilesV3.forEach(loadProfile);
        const now = ts ?? Math.floor(Date.now() / 1000);
        const positions = [...positionsV1, ...positionsV2];
        const secondsPerDay = Number(cfg.secondsPerDay);
        const map = new Map<
          string,
          { rigs: number; baseHp: bigint; buffedHp: bigint; effectiveHp: bigint }
        >();
        let totalRigs = 0;
        let totalEffectiveHp = 0n;
        for (const entry of positions) {
          const decoded = decodeMinerPositionAccount(Buffer.from(entry.account.data));
          if (decoded.deactivated || decoded.expired || decoded.endTs <= now) continue;
          const ownerKey = new PublicKey(decoded.owner).toBase58();
          const rigType = decoded.hpScaled
            ? decoded.rigType
            : rigTypeFromDuration(decoded.startTs, decoded.endTs, secondsPerDay);
          const buffBpsBase = rigBuffBps(rigType, decoded.buffLevel);
          const buffApplied =
            decoded.buffLevel > 0 &&
            (decoded.buffAppliedFromCycle === 0n ||
              BigInt(now) >= decoded.buffAppliedFromCycle);
          const buffBps = buffApplied ? BigInt(buffBpsBase) : 0n;
          const buffedHp = (decoded.hp * (BPS_DENOMINATOR + buffBps)) / BPS_DENOMINATOR;
          const level = levels.get(ownerKey) ?? 1;
          const bonus = levelBonusBps(level);
          const effectiveHp = (buffedHp * (BPS_DENOMINATOR + bonus)) / BPS_DENOMINATOR;
          const current = map.get(ownerKey) ?? {
            rigs: 0,
            baseHp: 0n,
            buffedHp: 0n,
            effectiveHp: 0n,
          };
          current.rigs += 1;
          current.baseHp += decoded.hp;
          current.buffedHp += buffedHp;
          current.effectiveHp += effectiveHp;
          map.set(ownerKey, current);
          totalRigs += 1;
          totalEffectiveHp += effectiveHp;
        }
        const networkHp =
          cfg.networkHpActive > 0n ? cfg.networkHpActive : totalEffectiveHp;
        const list = Array.from(map.entries())
          .map(([owner, value]) => {
            const level = levels.get(owner) ?? 1;
            const sharePct =
              networkHp > 0n
                ? Number((value.effectiveHp * 10_000n) / networkHp) / 100
                : 0;
            const levelBonusHp =
              value.effectiveHp > value.buffedHp ? value.effectiveHp - value.buffedHp : 0n;
            const levelBonusSharePct =
              networkHp > 0n
                ? Number((levelBonusHp * 10_000n) / networkHp) / 100
                : 0;
            return {
              owner,
              rigs: value.rigs,
              hp: value.effectiveHp,
              level,
              sharePct,
              levelBonusHp,
              levelBonusSharePct,
            };
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
        const rewardPerDay = cfg.stakingRewardRateXntPerSec * DAY_SECONDS;
        const stakerList = Array.from(stakerMap.entries())
          .map(([owner, staked]) => {
            const sharePct =
              totalStaked > 0n ? Number((staked * 10_000n) / totalStaked) / 100 : 0;
            const predictedDailyXnt =
              totalStaked > 0n ? (rewardPerDay * staked) / totalStaked : 0n;
            return { owner, staked, sharePct, predictedDailyXnt };
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

  const isAdmin = useMemo(() => {
    if (!publicKey || !config) return false;
    return publicKey.equals(config.admin);
  }, [publicKey, config]);

  useEffect(() => {
    if (!isAdmin) return;
    void refresh();
  }, [refresh, isAdmin]);


  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-ink text-white">
        <TopBar link={{ href: "/", label: "Dashboard" }} />
        <main className="mx-auto max-w-6xl px-4 pb-20 pt-10">
          <Card className="mt-6 p-4 text-sm text-zinc-400">
            Connect with the admin wallet to access this dashboard.
          </Card>
        </main>
      </div>
    );
  }

  const mapTxAction = (label: string) => {
    switch (label) {
      case "Update config":
        return "admin_update_config";
      case "Roll epoch":
        return "roll_epoch";
      case "Set badge":
        return "admin_set_badge";
      case "Add XP":
        return "admin_add_xp";
      case "Fund reward vault":
        return "admin_fund_reward";
      case "Withdraw treasury":
        return "admin_withdraw_treasury";
      case "Withdraw staking rewards":
        return "admin_withdraw_staking_rewards";
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
    let perDayBase: bigint;
    try {
      perDayBase = parseUiAmountToBase(emissionPerDayUi, mintDecimals.mind);
      const maxPerDayBase = EMISSION_PER_DAY_MAX * 10n ** BigInt(mintDecimals.mind);
      if (perDayBase > maxPerDayBase) {
        setError("Emission per day above allowed maximum (1000 MIND)");
        return;
      }
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
    let secondsPerDay: bigint;
    try {
      secondsPerDay = BigInt(secondsPerDayUi || "0");
    } catch {
      setError("Invalid seconds per day value");
      return;
    }
    if (secondsPerDay < SECONDS_PER_DAY_MIN || secondsPerDay > SECONDS_PER_DAY_MAX) {
      setError("Seconds per day out of allowed range");
      return;
    }
    if (emissionPerSec <= 0n || maxHp <= 0n) return;
    const currentEmission = BigInt(config.emissionPerSec.toString());
    if (currentEmission > 0n) {
      if (emissionPerSec * EMISSION_JUMP_DEN > currentEmission * EMISSION_JUMP_NUM) {
        setError("Emission change too large (>1.2x)");
        return;
      }
      if (emissionPerSec !== currentEmission) {
        const ok = window.confirm(
          `Change emission from ${emissionPerDayUi} MIND/day to ${perDayBase / DAY_SECONDS} base/sec?`
        );
        if (!ok) return;
      }
    }
    const program = getProgram(connection, anchorWallet);
    await withTx("Update config", async () => {
      const sig = await program.methods
        .adminUpdateConfig(
          new BN(emissionPerSec.toString()),
          new BN(maxHp.toString()),
          new BN(secondsPerDay.toString())
        )
        .accounts({
          admin: publicKey!,
          config: deriveConfigPda(),
        })
        .rpc();
      return sig;
    });
  };

  const onRollEpoch = async () => {
    if (!anchorWallet || !config || !publicKey) return;
    let seconds: bigint;
    try {
      seconds = BigInt(epochSecondsUi || "0");
    } catch {
      setError("Invalid epoch length value");
      return;
    }
    if (seconds <= 0n) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Roll epoch", async () => {
      const sig = await program.methods
        .rollEpoch(new BN(seconds.toString()))
        .accounts({
          admin: publicKey!,
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

  const onAddXp = async () => {
    if (!anchorWallet || !config || !publicKey) return;
    const raw = adminXpAmount.trim();
    if (!raw) {
      setError("Enter an XP amount.");
      return;
    }
    if (!/^\d+$/.test(raw)) {
      setError("XP must be a whole number.");
      return;
    }
    let amount: bigint;
    try {
      amount = BigInt(raw);
    } catch {
      setError("Invalid XP amount.");
      return;
    }
    if (amount <= 0n) {
      setError("XP amount must be greater than zero.");
      return;
    }
    if (amount > 18_446_744_073_709_551_615n) {
      setError("XP amount exceeds max u64.");
      return;
    }
    const program = getProgram(connection, anchorWallet);
    await withTx("Add XP", async () => {
      const sig = await program.methods
        .adminAddXp(new BN(amount.toString()))
        .accounts({
          admin: publicKey,
          config: deriveConfigPda(),
          userProfile: deriveUserProfilePda(publicKey),
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

  const onWithdrawStakingRewards = async () => {
    if (!anchorWallet || !config || !mintDecimals || !publicKey) return;
    let amountBase: bigint;
    try {
      amountBase = parseUiAmountToBase(stakingWithdrawUi, mintDecimals.xnt);
    } catch (e: unknown) {
      setError(formatError(e));
      return;
    }
    if (amountBase <= 0n) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Withdraw staking rewards", async () => {
      const sig = await program.methods
        .adminWithdrawStakingRewards(new BN(amountBase.toString()))
        .accounts({
          admin: publicKey,
          config: deriveConfigPda(),
          stakingRewardVault: config.stakingRewardVault,
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
      const [positionsV1, positionsV2, profilesV1, profilesV2, profilesV3] =
        await Promise.all([
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: MINER_POSITION_LEN_V1 }],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: MINER_POSITION_LEN_V2 }],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: USER_PROFILE_LEN_V1 }],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: USER_PROFILE_LEN_V2 }],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: USER_PROFILE_LEN_V3 }],
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
      profilesV3.forEach(loadProfile);

      const positions = [...positionsV1, ...positionsV2];
      const secondsPerDay = Number(config?.secondsPerDay ?? 0);
      const ownerBuffedHp = new Map<string, bigint>();
      for (const entry of positions) {
        const decoded = decodeMinerPositionAccount(Buffer.from(entry.account.data));
        if (decoded.deactivated || decoded.expired || decoded.endTs <= now) continue;
        const ownerKey = new PublicKey(decoded.owner).toBase58();
        const rigType = decoded.hpScaled
          ? decoded.rigType
          : rigTypeFromDuration(decoded.startTs, decoded.endTs, secondsPerDay);
        const buffBpsBase = rigBuffBps(rigType, decoded.buffLevel);
        const buffApplied =
          decoded.buffLevel > 0 &&
          (decoded.buffAppliedFromCycle === 0n ||
            BigInt(now) >= decoded.buffAppliedFromCycle);
        const buffBps = buffApplied ? BigInt(buffBpsBase) : 0n;
        const buffedHp = (decoded.hp * (BPS_DENOMINATOR + buffBps)) / BPS_DENOMINATOR;
        ownerBuffedHp.set(ownerKey, (ownerBuffedHp.get(ownerKey) ?? 0n) + buffedHp);
      }

      let totalEffectiveHp = 0n;
      for (const [ownerKey, buffedHp] of ownerBuffedHp) {
        const level = levels.get(ownerKey) ?? 1;
        const bonus = levelBonusBps(level);
        const effective =
          (buffedHp * (BPS_DENOMINATOR + bonus)) / BPS_DENOMINATOR;
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
            <div className="mt-2 text-xs text-zinc-400">
              Staking (current epoch):{" "}
              {mintDecimals && stakingEpochBalances
                ? formatTokenAmount(stakingEpochBalances.currentEpoch, mintDecimals.xnt, 4)
                : "-"}{" "}
              XNT
            </div>
            <div className="mt-2 text-xs text-zinc-400">
              Staking (next epoch):{" "}
              {mintDecimals && stakingEpochBalances
                ? formatTokenAmount(stakingEpochBalances.nextEpoch, mintDecimals.xnt, 4)
                : "-"}{" "}
              XNT
            </div>
            <div className="mt-2 text-xs text-zinc-400">
              Rig revenue (total):{" "}
              {mintDecimals
                ? formatTokenAmount(stakingRewardBalance + treasuryBalance, mintDecimals.xnt, 4)
                : "-"}{" "}
              XNT
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
                    Lvl bonus: +{(Number(levelBonusBps(entry.level)) / 100).toFixed(1)}% (+{formatHp(entry.levelBonusHp)} HP, {entry.levelBonusSharePct.toFixed(2)}% network)
                  </div>
                  <div className="text-zinc-500">
                    Rigs: {entry.rigs} | HP: {formatHp(entry.hp)} | Lvl: {entry.level} | Share:{" "}
                    {entry.sharePct.toFixed(2)}%
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
                    {mintDecimals ? (
                      <>
                        {" | "}Reward/day:{" "}
                        {formatTokenAmount(entry.predictedDailyXnt, mintDecimals.xnt, 4)} XNT
                      </>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        <section className="mt-8 grid gap-4 lg:grid-cols-2">
          <Card className="p-4">
            <div className="text-sm font-semibold">Update mining config</div>
            <div className="mt-2 text-xs text-zinc-400">
              Current: {config ? config.emissionPerSec.toString() : "-"} base/sec (~{" "}
              {config && mintDecimals
                ? (BigInt(config.emissionPerSec.toString()) * DAY_SECONDS) /
                  10n ** BigInt(mintDecimals.mind)
                : "-"}{" "}
              MIND/day) | allowed ≤ {EMISSION_PER_DAY_MAX.toString()} MIND/day, jump ≤ 1.2×, seconds/day{" "}
              {SECONDS_PER_DAY_MIN.toString()}–{SECONDS_PER_DAY_MAX.toString()}
            </div>
            <div className="mt-3 text-xs text-zinc-400">Emission per day (MIND)</div>
            <Input value={emissionPerDayUi} onChange={setEmissionPerDayUi} />
            <div className="mt-3 text-xs text-zinc-400">Max effective HP</div>
            <Input value={maxEffectiveHpUi} onChange={setMaxEffectiveHpUi} />
            <div className="mt-3 text-xs text-zinc-400">Seconds per day</div>
            <Input value={secondsPerDayUi} onChange={setSecondsPerDayUi} />
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
              disabled={!isAdmin || busy != null}
            >
              {busy === "Roll epoch" ? "Submitting..." : "Roll Epoch"}
            </Button>
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
            <div className="text-sm font-semibold">Withdraw staking rewards</div>
            <div className="mt-2 text-xs text-zinc-400">
              Transfer XNT from the staking reward vault to the admin wallet.
            </div>
            <div className="mt-3 text-xs text-zinc-400">Amount (XNT)</div>
            <Input value={stakingWithdrawUi} onChange={setStakingWithdrawUi} />
            <Button
              className="mt-4"
              onClick={() => void onWithdrawStakingRewards()}
              disabled={!isAdmin || busy != null}
            >
              {busy === "Withdraw staking rewards" ? "Submitting..." : "Withdraw to admin wallet"}
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

          <Card className="p-4">
            <div className="text-sm font-semibold">Add XP (admin)</div>
            <div className="mt-2 text-xs text-zinc-400">
              Adds XP to the admin profile only.
            </div>
            <div className="mt-3 text-xs text-zinc-400">Amount (XP)</div>
            <Input value={adminXpAmount} onChange={setAdminXpAmount} />
            <Button className="mt-4" onClick={() => void onAddXp()} disabled={!isAdmin || busy != null}>
              {busy === "Add XP" ? "Submitting..." : "Add XP"}
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
