import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import bs58 from "bs58";
import {
  USER_PROFILE_LEN_V1,
  USER_PROFILE_LEN_V2,
  USER_PROFILE_LEN_V3,
  USER_PROFILE_LEN_V4,
  decodeUserMiningProfileAccount,
} from "@/lib/decoders";
import { getProgramId, getRpcUrl } from "@/lib/solana";
import {
  computeTotalWeight,
  getWeeklyPoolXnt,
  LEVELS,
  LEVEL_WEIGHTS,
  type CountsByLevel,
  type YieldSummary,
} from "@/lib/yieldMath";
import { getStoredPoolXnt } from "@/lib/yieldPoolStore";

const CACHE_TTL_MS = 60_000;
let cached: { at: number; value: YieldSummary } | null = null;
const USER_PROFILE_DISCRIMINATOR = bs58.encode(
  createHash("sha256").update("account:UserMiningProfile").digest().subarray(0, 8)
);

async function loadYieldSummary(): Promise<YieldSummary> {
  const connection = new Connection(getRpcUrl(), "confirmed");
  const programId = getProgramId();

  const sizes = [USER_PROFILE_LEN_V1, USER_PROFILE_LEN_V2, USER_PROFILE_LEN_V3, USER_PROFILE_LEN_V4];
  const batches = await Promise.all(
    sizes.map((dataSize) =>
      connection.getProgramAccounts(programId, {
        commitment: "confirmed",
        filters: [
          { dataSize },
          { memcmp: { offset: 0, bytes: USER_PROFILE_DISCRIMINATOR } },
        ],
      })
    )
  );

  const counts: CountsByLevel = {};
  for (const level of LEVELS) {
    counts[level] = 0;
  }

  for (const accounts of batches) {
    for (const entry of accounts) {
      try {
        const decoded = decodeUserMiningProfileAccount(entry.account.data);
        const level = decoded.level ?? 1;
        if (LEVELS.includes(level as (typeof LEVELS)[number])) {
          const typedLevel = level as keyof typeof counts;
          counts[typedLevel] = (counts[typedLevel] ?? 0) + 1;
        }
      } catch {
        // Skip unknown account layouts.
      }
    }
  }

  const totalWeight = computeTotalWeight(counts);
  const weeklyPoolXnt = getStoredPoolXnt()?.value ?? getWeeklyPoolXnt();
  const byLevel = LEVELS.reduce<YieldSummary["byLevel"]>((acc, level) => {
    const count = counts[level] ?? 0;
    const weight = count * LEVEL_WEIGHTS[level];
    const share = totalWeight > 0 ? weight / totalWeight : 0;
    acc[level] = {
      count,
      weight,
      payoutXnt: share * weeklyPoolXnt,
      sharePct: share * 100,
    };
    return acc;
  }, {} as YieldSummary["byLevel"]);
  return {
    poolXnt: weeklyPoolXnt,
    totalWeight,
    countsByLevel: counts,
    byLevel,
    updatedAt: Date.now(),
  };
}

export async function GET() {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return NextResponse.json(cached.value, {
      headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=30" },
    });
  }

  try {
    const summary = await loadYieldSummary();
    cached = { at: now, value: summary };
    return NextResponse.json(summary, {
      headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=30" },
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to load yield estimates" },
      { status: 500 }
    );
  }
}
