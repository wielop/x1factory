import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
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
import { fetchConfig, fetchClockUnixTs, getProgramId, getRpcUrl } from "@/lib/solana";
import type { AlertEntry, FlowStats, ProtocolSnapshot } from "@/lib/adminData";
import { isAlertResolved } from "@/lib/adminAlertsStore";
import { getErrorCount, getRpcStats, getTxStats, recordRpcSample } from "@/lib/adminMetricsStore";
import { scoreEconomicHealth, scoreTechnicalHealth } from "@/lib/healthScoring";

const XNT_DECIMALS = 9;
const NATIVE_VAULT_SPACE = 9;
const HP_SCALE = 100n;
const BPS_DENOMINATOR = 10_000n;
const BUFFER_DAYS = 3;
const WINDOW_15M = 15 * 60 * 1000;
const WINDOW_10M = 10 * 60 * 1000;

const toUi = (amount: bigint, decimals: number) =>
  Number(amount) / Math.pow(10, decimals);

const approxEqual = (a: number, b: number, tolerance = 0.01) => Math.abs(a - b) <= tolerance;

const levelBonusBps = (level: number) => {
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
};

const rigTypeFromDuration = (startTs: number, endTs: number, secondsPerDay: number) => {
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
};

const rigBuffBps = (rigType: number, buffLevel: number) => {
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
};

// Data Center API: aggregates on-chain state + simple alert rules.
export async function GET() {
  const connection = new Connection(getRpcUrl(), "confirmed");
  const cfg = await fetchConfig(connection);
  if (!cfg) {
    return NextResponse.json({ error: "Config not found" }, { status: 404 });
  }
  const nowTs = await fetchClockUnixTs(connection);

  const mindMintInfo = await getMint(connection, cfg.mindMint, "confirmed");
  const dailyEmissionBase = cfg.emissionPerSec * cfg.secondsPerDay;
  const totalMindMined = toUi(mindMintInfo.supply, mindMintInfo.decimals);

  const rentLamports = BigInt(
    await connection.getMinimumBalanceForRentExemption(NATIVE_VAULT_SPACE)
  );
  const rewardVaultLamports = BigInt(
    await connection.getBalance(cfg.stakingRewardVault, "confirmed")
  );
  const treasuryLamports = BigInt(await connection.getBalance(cfg.treasuryVault, "confirmed"));
  const rewardPoolAvailable =
    rewardVaultLamports > rentLamports ? rewardVaultLamports - rentLamports : 0n;
  const treasuryAvailable =
    treasuryLamports > rentLamports ? treasuryLamports - rentLamports : 0n;

  const snapshot: ProtocolSnapshot = {
    timestamp: new Date().toISOString(),
    mining: {
      networkHp: Number(cfg.networkHpActive) / Number(HP_SCALE),
      maxHp: Number(cfg.maxEffectiveHp),
      dailyEmissionMind: toUi(dailyEmissionBase, mindMintInfo.decimals),
      totalMindMined,
    },
    staking: {
      totalStakedMind: toUi(cfg.stakingTotalStakedMind, mindMintInfo.decimals),
      rewardPoolXnt: toUi(rewardPoolAvailable, XNT_DECIMALS),
      epochEndsAt: cfg.stakingEpochEndTs > 0 ? new Date(cfg.stakingEpochEndTs * 1000).toISOString() : null,
    },
    treasury: {
      totalXntIn: toUi(rewardPoolAvailable + treasuryAvailable, XNT_DECIMALS),
      available: toUi(treasuryAvailable, XNT_DECIMALS),
      inStakingBucket: 0,
      inLp: 0,
      inInvestments: 0,
      inReserve: 0,
    },
  };

  const flows: FlowStats[] = [
    {
      window: "24h",
      xntFromMining: 0,
      xntToStakingRewards: 0,
      xntToTreasury: 0,
      xntUsedForBuyback: 0,
      xntAddedToLp: 0,
    },
    {
      window: "7d",
      xntFromMining: 0,
      xntToStakingRewards: 0,
      xntToTreasury: 0,
      xntUsedForBuyback: 0,
      xntAddedToLp: 0,
    },
    {
      window: "30d",
      xntFromMining: 0,
      xntToStakingRewards: 0,
      xntToTreasury: 0,
      xntUsedForBuyback: 0,
      xntAddedToLp: 0,
    },
  ];
  // TODO: Replace zeroed FlowStats with real aggregation from event logs / DB.

  // Lightweight RPC health probe to collect latency + success samples.
  const rpcStart = Date.now();
  try {
    await connection.getSlot("confirmed");
    recordRpcSample({ ts: Date.now(), ok: true, latencyMs: Date.now() - rpcStart }, WINDOW_15M);
  } catch {
    recordRpcSample({ ts: Date.now(), ok: false, latencyMs: Date.now() - rpcStart }, WINDOW_15M);
  }

  const alerts: AlertEntry[] = [];

  const flow24h = flows.find((item) => item.window === "24h")!;
  const expectedFlow = flow24h.xntToStakingRewards + flow24h.xntToTreasury;
  if (flow24h.xntFromMining > 0 && !approxEqual(flow24h.xntFromMining, expectedFlow, 0.01)) {
    const id = "flow_mismatch";
    alerts.push({
      id,
      level: "CRITICAL",
      createdAt: new Date().toISOString(),
      message: "XNT mining inflow does not match staking + treasury outflow (24h).",
      details: `In: ${flow24h.xntFromMining}, Out: ${expectedFlow}`,
      resolved: isAlertResolved(id),
    });
  }

  const rewardRatePerDay = toUi(cfg.stakingRewardRateXntPerSec * 86_400n, XNT_DECIMALS);
  if (rewardRatePerDay > 0 && snapshot.staking.rewardPoolXnt < rewardRatePerDay * BUFFER_DAYS) {
    const id = "reward_buffer_low";
    alerts.push({
      id,
      level: "WARN",
      createdAt: new Date().toISOString(),
      message: "Reward pool buffer is below the target window.",
      details: `Buffer < ${BUFFER_DAYS} days at current pace.`,
      resolved: isAlertResolved(id),
    });
  }

  const programId = getProgramId();
  const [positionsV1, positionsV2, stakes, profilesV1, profilesV2, profilesV3] = await Promise.all([
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

  const positions = [...positionsV1, ...positionsV2];
  const secondsPerDay = Number(cfg.secondsPerDay);
  const buffedHpByOwner = new Map<string, bigint>();
  for (const entry of positions) {
    const decoded = decodeMinerPositionAccount(Buffer.from(entry.account.data));
    if (decoded.deactivated || decoded.expired || decoded.endTs <= nowTs) continue;
    const ownerKey = new PublicKey(decoded.owner).toBase58();
    const rigType = decoded.hpScaled
      ? decoded.rigType
      : rigTypeFromDuration(decoded.startTs, decoded.endTs, secondsPerDay);
    const buffBpsBase = rigBuffBps(rigType, decoded.buffLevel);
    const buffApplied =
      decoded.buffLevel > 0 &&
      (decoded.buffAppliedFromCycle === 0n ||
        BigInt(nowTs) >= decoded.buffAppliedFromCycle);
    const buffBps = buffApplied ? BigInt(buffBpsBase) : 0n;
    const buffedHp = (decoded.hp * (BPS_DENOMINATOR + buffBps)) / BPS_DENOMINATOR;
    buffedHpByOwner.set(ownerKey, (buffedHpByOwner.get(ownerKey) ?? 0n) + buffedHp);
  }
  let totalEffectiveHp = 0n;
  for (const [owner, buffedHp] of buffedHpByOwner.entries()) {
    const level = levels.get(owner) ?? 1;
    const bonus = levelBonusBps(level);
    totalEffectiveHp += (buffedHp * (BPS_DENOMINATOR + bonus)) / BPS_DENOMINATOR;
  }
  const totalHp = cfg.networkHpActive > 0n ? cfg.networkHpActive : totalEffectiveHp;
  let topOwner: { owner: string; share: number } | null = null;
  if (totalHp > 0n) {
    for (const [owner, buffedHp] of buffedHpByOwner.entries()) {
      const level = levels.get(owner) ?? 1;
      const bonus = levelBonusBps(level);
      const effectiveHp = (buffedHp * (BPS_DENOMINATOR + bonus)) / BPS_DENOMINATOR;
      const share = Number((effectiveHp * 10_000n) / totalHp) / 100;
      if (!topOwner || share > topOwner.share) {
        topOwner = { owner, share };
      }
    }
  }
  if (topOwner && topOwner.share > 40) {
    const id = `whale_hp_${topOwner.owner}`;
    alerts.push({
      id,
      level: topOwner.share > 60 ? "CRITICAL" : "WARN",
      createdAt: new Date().toISOString(),
      message: "Single address controls a large share of network HP.",
      details: `${topOwner.owner} has ${topOwner.share.toFixed(2)}% of active HP.`,
      resolved: isAlertResolved(id),
    });
  }

  let maxStakingShare = 0;
  if (cfg.stakingTotalStakedMind > 0n) {
    for (const entry of stakes) {
      const decoded = decodeUserStakeAccount(Buffer.from(entry.account.data));
      if (decoded.stakedMind === 0n) continue;
      const share = Number((decoded.stakedMind * 10_000n) / cfg.stakingTotalStakedMind) / 100;
      if (share > maxStakingShare) {
        maxStakingShare = share;
      }
    }
  }
  const maxConcentration =
    topOwner && topOwner.share > maxStakingShare ? topOwner.share : maxStakingShare || null;

  const flow7d = flows.find((item) => item.window === "7d")!;
  const flow30d = flows.find((item) => item.window === "30d")!;
  const splitTotal = flow7d.xntToStakingRewards + flow7d.xntToTreasury;
  const splitDiffPct =
    splitTotal > 0
      ? Math.abs(flow7d.xntToStakingRewards / splitTotal - 0.3) * 100
      : null;
  const treasuryNet =
    flow30d.xntToTreasury - flow30d.xntUsedForBuyback - flow30d.xntAddedToLp;
  const treasuryRatio =
    flow30d.xntFromMining > 0 ? treasuryNet / flow30d.xntFromMining : null;

  const runwayDays =
    rewardRatePerDay > 0 ? snapshot.staking.rewardPoolXnt / rewardRatePerDay : null;

  const { successRate: rpcSuccess } = getRpcStats(WINDOW_15M);
  const { successRate: txSuccess, medianLatency: txLatency } = getTxStats(WINDOW_15M);
  const appErrors = getErrorCount(WINDOW_10M);

  const economic = scoreEconomicHealth({
    runwayDays,
    splitDiffPct,
    concentrationPct: maxConcentration,
    treasuryNet: flow30d.xntFromMining > 0 ? treasuryNet : null,
    treasuryRatio,
  });

  const technical = scoreTechnicalHealth({
    rpcSuccessRate: rpcSuccess,
    txSuccessRate: txSuccess,
    txLatencyMedianMs: txLatency,
    appErrors,
  });

  return NextResponse.json({ snapshot, flows, alerts, health: { economic, technical } });
}
