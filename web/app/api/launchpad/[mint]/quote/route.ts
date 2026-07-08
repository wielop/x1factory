import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  curvePda,
  parseBondingCurve,
  BONDING_CURVE_SIZE,
  quoteBuy,
  quoteSell,
  priceUsd,
  fdvUsd,
  progressPct,
  resolveLaunchpadTokenIdentity,
} from "@/lib/launchpad";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RPC = "https://rpc.mainnet.x1.xyz";
const SWAP_ROUTER_PROGRAM_ID = new PublicKey("2xXG9bbggrffG976okAbEHzw1BJgfA58d9zHTToke2Z6");
const [ROUTER_CONFIG_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("router_config")],
  SWAP_ROUTER_PROGRAM_ID
);
const ROUTER_CONFIG_XNT_USD_OFFSET = 8 + 32 + 32;

export async function GET(req: NextRequest, { params }: { params: { mint: string } }) {
  try {
    const { searchParams } = new URL(req.url);
    const side = searchParams.get("side") ?? "buy";
    const amountStr = searchParams.get("amount");

    let mint: PublicKey;
    try {
      mint = new PublicKey(params.mint);
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid mint" }, { status: 400 });
    }

    const conn = new Connection(RPC, "confirmed");
    const curve = curvePda(mint);
    const [curveInfo, configInfo, identity] = await Promise.all([
      conn.getAccountInfo(curve),
      conn.getAccountInfo(ROUTER_CONFIG_PDA).catch(() => null),
      resolveLaunchpadTokenIdentity(conn, mint),
    ]);
    if (!curveInfo || curveInfo.data.length < BONDING_CURVE_SIZE) {
      return NextResponse.json({ ok: false, error: "Curve not found for this mint" }, { status: 404 });
    }
    const curveState = parseBondingCurve(curveInfo.data, curve);

    let xntUsdCents = 50;
    if (configInfo && configInfo.data.length >= ROUTER_CONFIG_XNT_USD_OFFSET + 8) {
      const cents = Number(configInfo.data.readBigUInt64LE(ROUTER_CONFIG_XNT_USD_OFFSET));
      if (cents > 0) xntUsdCents = cents;
    }

    const base = {
      ok: true,
      xntUsdCents,
      name: identity?.name ?? null,
      symbol: identity?.symbol ?? null,
      image: identity?.image || null,
      priceUsd: priceUsd(curveState, xntUsdCents),
      fdvUsd: fdvUsd(curveState, xntUsdCents),
      progressPct: progressPct(curveState),
      complete: curveState.complete,
      realXntReserves: curveState.realXntReserves.toString(),
      realTokenReserves: curveState.realTokenReserves.toString(),
      virtualTokenReserves: curveState.virtualTokenReserves.toString(),
      virtualXntReserves: curveState.virtualXntReserves.toString(),
      rewardPoolXntBalance: curveState.rewardPoolXntBalance.toString(),
      rewardPoolTokenBalance: curveState.rewardPoolTokenBalance.toString(),
      gigaHits: curveState.gigaHits.toString(),
      tradeCounter: curveState.tradeCounter.toString(),
    };

    if (!amountStr) {
      return NextResponse.json(base);
    }
    const amount = BigInt(amountStr);
    if (amount <= 0n) return NextResponse.json(base);

    if (side === "sell") {
      const q = quoteSell(curveState, amount);
      return NextResponse.json({
        ...base,
        estimatedOut: q.netXntOut.toString(),
        feeTotal: q.feeTotal.toString(),
        insufficientLiquidity: q.insufficientLiquidity,
      });
    }
    const q = quoteBuy(curveState, amount);
    return NextResponse.json({
      ...base,
      estimatedOut: q.tokensOut.toString(),
      feeTotal: q.feeTotal.toString(),
      soldOut: q.soldOut,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Quote failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
