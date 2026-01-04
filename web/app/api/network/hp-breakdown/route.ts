import { NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import {
  decodeMinerPositionAccount,
  MINER_POSITION_LEN_V1,
  MINER_POSITION_LEN_V2,
  MINER_POSITION_LEN_V3,
} from "@/lib/decoders";
import { fetchClockUnixTs, fetchConfig, getProgramId, getRpcUrl } from "@/lib/solana";

const BPS_DENOMINATOR = 10_000n;
const CACHE_TTL_MS = 15_000;

type CachedPayload = {
  baseHp: string;
  rigBuffHp: string;
  accountBonusHp: string;
  effectiveHp: string;
  updatedAt: string;
};

let cached: { ts: number; payload: CachedPayload } | null = null;

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

export async function GET() {
  try {
    const nowMs = Date.now();
    if (cached && nowMs - cached.ts < CACHE_TTL_MS) {
      return NextResponse.json(cached.payload);
    }

    const connection = new Connection(getRpcUrl(), "confirmed");
    const cfg = await fetchConfig(connection);
    const nowTs = await fetchClockUnixTs(connection);
    const programId = getProgramId();

    const [positionsV1, positionsV2, positionsV3] = await Promise.all([
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
        filters: [{ dataSize: MINER_POSITION_LEN_V3 }],
      }),
    ]);

    const secondsPerDay = Number(cfg.secondsPerDay);
    let totalBaseHp = 0n;
    let totalBuffedHp = 0n;

    for (const entry of [...positionsV1, ...positionsV2, ...positionsV3]) {
      const decoded = decodeMinerPositionAccount(Buffer.from(entry.account.data));
      if (decoded.deactivated || decoded.expired || decoded.endTs <= nowTs) continue;
      const rigType = decoded.hpScaled
        ? decoded.rigType
        : rigTypeFromDuration(decoded.startTs, decoded.endTs, secondsPerDay);
      const buffBpsBase = rigBuffBps(rigType, decoded.buffLevel);
      const buffApplied =
        decoded.buffLevel > 0 &&
        (decoded.buffAppliedFromCycle === 0n || BigInt(nowTs) >= decoded.buffAppliedFromCycle);
      const buffBps = buffApplied ? BigInt(buffBpsBase) : 0n;
      const baseHp = decoded.hp;
      const buffedHp = (baseHp * (BPS_DENOMINATOR + buffBps)) / BPS_DENOMINATOR;
      totalBaseHp += baseHp;
      totalBuffedHp += buffedHp;
    }

    const effectiveHp =
      cfg.networkHpActive > 0n ? cfg.networkHpActive : totalBuffedHp;
    const rigBuffHp = totalBuffedHp > totalBaseHp ? totalBuffedHp - totalBaseHp : 0n;
    const accountBonusHp = effectiveHp > totalBuffedHp ? effectiveHp - totalBuffedHp : 0n;

    const payload: CachedPayload = {
      baseHp: totalBaseHp.toString(),
      rigBuffHp: rigBuffHp.toString(),
      accountBonusHp: accountBonusHp.toString(),
      effectiveHp: effectiveHp.toString(),
      updatedAt: new Date().toISOString(),
    };
    cached = { ts: nowMs, payload };

    return NextResponse.json(payload);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
