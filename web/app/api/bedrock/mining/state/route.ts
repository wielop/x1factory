import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  BEDROCK_RPC_URL,
  CONFIG_PDA,
  VEIN0_PDA,
  deriveProfilePda,
  derivePositionPda,
} from "@/lib/bedrock/constants";
import { tryDecodeClaimsAccount } from "@/lib/bedrock/coder";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function n(v: Any): string {
  if (v === null || v === undefined) return "0";
  return v.toString();
}

export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner");
  const connection = new Connection(BEDROCK_RPC_URL, "confirmed");

  const [configInfo, veinInfo] = await connection.getMultipleAccountsInfo([CONFIG_PDA, VEIN0_PDA]);
  if (!configInfo || !veinInfo) {
    return NextResponse.json({ error: "Config/VeinSeason not found on-chain" }, { status: 500 });
  }
  const config = tryDecodeClaimsAccount<Any>("Config", configInfo.data);
  const vein = tryDecodeClaimsAccount<Any>("VeinSeason", veinInfo.data);
  if (!config || !vein) {
    return NextResponse.json({ error: "Failed to decode Config/VeinSeason" }, { status: 500 });
  }

  const result: Any = {
    vein: {
      seasonId: n(vein.seasonId),
      reserveTotal: n(vein.reserveTotal),
      reserveRemaining: n(vein.reserveRemaining),
      startTs: n(vein.startTs),
      endTs: n(vein.endTs),
    },
    config: {
      networkHpActive: n(config.networkHpActive),
      currentBaseRate: n(config.currentBaseRate),
      halvingEra: config.halvingEra,
      oreMintedTotal: n(config.oreMintedTotal),
    },
    profile: null,
    positions: [] as Any[],
  };

  if (owner) {
    let ownerPk: PublicKey;
    try {
      ownerPk = new PublicKey(owner);
    } catch {
      return NextResponse.json({ error: "Invalid owner pubkey" }, { status: 400 });
    }
    const profilePda = deriveProfilePda(ownerPk);
    const profileInfo = await connection.getAccountInfo(profilePda);
    const profile = profileInfo ? tryDecodeClaimsAccount<Any>("UserProfile", profileInfo.data) : null;
    if (profile) {
      result.profile = {
        activeHp: n(profile.activeHp),
        activeClaimCount: profile.activeClaimCount,
        nextPositionIndex: n(profile.nextPositionIndex),
        level: profile.level,
        xp: n(profile.xp),
        upkeepPaidUntil: n(profile.upkeepPaidUntil),
      };

      const nextIdx = BigInt(profile.nextPositionIndex.toString());
      if (nextIdx > 0n) {
        const positionPdas: PublicKey[] = [];
        for (let i = 0n; i < nextIdx; i++) {
          positionPdas.push(derivePositionPda(ownerPk, i));
        }
        // getMultipleAccountsInfo max 100 per call - nextIdx realistycznie male na testnecie
        const infos = await connection.getMultipleAccountsInfo(positionPdas);
        result.positions = infos
          .map((info, idx) => {
            if (!info) return null;
            const pos = tryDecodeClaimsAccount<Any>("ClaimPosition", info.data);
            if (!pos) return null;
            return {
              index: idx,
              tier: pos.tier,
              hp: n(pos.hp),
              startTs: n(pos.startTs),
              endTs: n(pos.endTs),
              deactivated: pos.deactivated,
              expired: pos.expired,
            };
          })
          .filter(Boolean);
      }
    }
  }

  return NextResponse.json(result);
}
