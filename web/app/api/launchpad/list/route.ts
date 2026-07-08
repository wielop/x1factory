import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { resolveLaunchpadTokenIdentity } from "@/lib/launchpad";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RPC = "https://rpc.mainnet.x1.xyz";
const LAUNCHPAD_PROGRAM_ID = new PublicKey("AGAdJKoLhrGrdFwrZZDEWsoR1Tq8kMcXGRKxX2wa2jfm");

// swap_router's RouterConfig — reused here purely as the ecosystem's shared XNT/USD price
// feed, so the launchpad dashboard doesn't need its own oracle-refresh plumbing.
const SWAP_ROUTER_PROGRAM_ID = new PublicKey("2xXG9bbggrffG976okAbEHzw1BJgfA58d9zHTToke2Z6");
const [ROUTER_CONFIG_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("router_config")],
  SWAP_ROUTER_PROGRAM_ID
);
const ROUTER_CONFIG_XNT_USD_OFFSET = 8 + 32 + 32; // after disc + authority + treasury

// BondingCurve layout (after the 8-byte Anchor discriminator):
// mint(32) creator(32) virtual_token_reserves(8) virtual_xnt_reserves(8)
// real_token_reserves(8) real_xnt_reserves(8) reward_pool_xnt_balance(8)
// reward_pool_token_balance(8) trade_counter(8) giga_hits(8) complete(1)
// created_at(8) bump(1) curve_xnt_vault_bump(1) reward_pool_xnt_vault_bump(1)
// reward_pool_token_vault_bump(1) curve_token_vault_bump(1) grad_reserve_vault_bump(1)
const BONDING_CURVE_SIZE = 8 + 32 + 32 + 8 * 8 + 1 + 8 + 6;

const TOKEN_DECIMALS = 6;
const DECIMALS_MULTIPLIER = 1_000_000;
const TOTAL_SUPPLY = 1_000_000_000 * DECIMALS_MULTIPLIER;
const CURVE_ALLOCATION = 800_000_000 * DECIMALS_MULTIPLIER;
const XNT_BASE = 1_000_000_000;

function parseBondingCurve(data: Buffer, pubkey: PublicKey) {
  let o = 8;
  const mint = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const creator = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const virtualTokenReserves = data.readBigUInt64LE(o);
  o += 8;
  const virtualXntReserves = data.readBigUInt64LE(o);
  o += 8;
  const realTokenReserves = data.readBigUInt64LE(o);
  o += 8;
  const realXntReserves = data.readBigUInt64LE(o);
  o += 8;
  const rewardPoolXntBalance = data.readBigUInt64LE(o);
  o += 8;
  const rewardPoolTokenBalance = data.readBigUInt64LE(o);
  o += 8;
  const tradeCounter = data.readBigUInt64LE(o);
  o += 8;
  const gigaHits = data.readBigUInt64LE(o);
  o += 8;
  const complete = data[o] !== 0;
  o += 1;
  const createdAt = data.readBigInt64LE(o);
  o += 8;

  return {
    curve: pubkey.toBase58(),
    mint: mint.toBase58(),
    creator: creator.toBase58(),
    virtualTokenReserves: virtualTokenReserves.toString(),
    virtualXntReserves: virtualXntReserves.toString(),
    realTokenReserves: realTokenReserves.toString(),
    realXntReserves: realXntReserves.toString(),
    rewardPoolXntBalance: rewardPoolXntBalance.toString(),
    rewardPoolTokenBalance: rewardPoolTokenBalance.toString(),
    tradeCounter: tradeCounter.toString(),
    gigaHits: gigaHits.toString(),
    complete,
    createdAt: Number(createdAt),
    virtualTokenReservesNum: Number(virtualTokenReserves),
    virtualXntReservesNum: Number(virtualXntReserves),
    realTokenReservesNum: Number(realTokenReserves),
  };
}

export async function GET() {
  try {
    const conn = new Connection(RPC, "confirmed");

    const [curveAccounts, configInfo] = await Promise.all([
      conn.getProgramAccounts(LAUNCHPAD_PROGRAM_ID, {
        filters: [{ dataSize: BONDING_CURVE_SIZE }],
      }),
      conn.getAccountInfo(ROUTER_CONFIG_PDA).catch(() => null),
    ]);

    let xntUsdCents = 50; // fallback $0.50, same default used elsewhere in the app
    if (configInfo && configInfo.data.length >= ROUTER_CONFIG_XNT_USD_OFFSET + 8) {
      const cents = Number(configInfo.data.readBigUInt64LE(ROUTER_CONFIG_XNT_USD_OFFSET));
      if (cents > 0) xntUsdCents = cents;
    }
    const xntUsd = xntUsdCents / 100;

    const parsed = curveAccounts
      .map(({ pubkey, account }) => parseBondingCurve(account.data, pubkey))
      .map((t) => {
        const priceXnt =
          t.virtualTokenReservesNum > 0 ? t.virtualXntReservesNum / t.virtualTokenReservesNum : 0;
        const priceUsd = priceXnt * xntUsd;
        const fdvUsd = priceUsd * (TOTAL_SUPPLY / DECIMALS_MULTIPLIER);
        const sold = CURVE_ALLOCATION - t.realTokenReservesNum;
        const progressPct = CURVE_ALLOCATION > 0 ? (sold / CURVE_ALLOCATION) * 100 : 0;
        const { virtualTokenReservesNum, virtualXntReservesNum, realTokenReservesNum, ...rest } = t;
        return {
          ...rest,
          priceUsd,
          fdvUsd,
          progressPct: Math.max(0, Math.min(100, progressPct)),
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);

    const identities = await Promise.all(
      parsed.map((t) => resolveLaunchpadTokenIdentity(conn, new PublicKey(t.mint)))
    );
    const tokens = parsed.map((t, i) => ({
      ...t,
      name: identities[i]?.name ?? null,
      symbol: identities[i]?.symbol ?? null,
      image: identities[i]?.image || null,
    }));

    return NextResponse.json({
      ok: true,
      xntUsdCents,
      totalSupplyDisplay: TOTAL_SUPPLY / DECIMALS_MULTIPLIER,
      curveAllocationDisplay: CURVE_ALLOCATION / DECIMALS_MULTIPLIER,
      tokenDecimals: TOKEN_DECIMALS,
      xntBase: XNT_BASE,
      tokens,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? String(err) },
      { status: 500 }
    );
  }
}
