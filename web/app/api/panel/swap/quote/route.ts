import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RPC = "https://rpc.mainnet.x1.xyz";
const MIND_XNT_POOL = new PublicKey("FAVw1iDioK69epJf1YY3Z1oakSCUYtmfUpVBxR14BGpm");
const XNT_VAULT = new PublicKey("AGy9mSe6pmmHzVTuagfSHzJBe4hn2FpYq3hrsoF5i2ys");
const MIND_VAULT = new PublicKey("94F7JppAqiJkkwy31CqvfLd1a8BcT3AzESE8j533zGjg");
const CONFIG_PDA = new PublicKey("2jphFVpP8M7yPC9syAis7sN28aTWBU4MssmXiQGxrZb6");

// RouterConfig layout offsets (all after 8-byte discriminator):
// authority(32) + treasury(32) + xnt_usd_cents(8) + swap_counter(8) + giga_hits(8)
// + reward_pool_mind_balance(8) + reward_pool_xnt_balance(8)
const CONFIG_XNT_USD_OFFSET          = 8 + 32 + 32;       // 72
const CONFIG_SWAP_COUNTER_OFFSET     = 72 + 8;             // 80
const CONFIG_GIGA_HITS_OFFSET        = 80 + 8;             // 88
const CONFIG_REWARD_MIND_OFFSET      = 88 + 8;             // 96
const CONFIG_REWARD_XNT_OFFSET       = 96 + 8;             // 104

const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
const OUR_FEE_BPS = 100n; // 0.4%
const XDEX_FEE_BPS = 25n; // estimated xdex 0.25%

async function readVaultAmount(conn: Connection, vault: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(vault);
  if (!info || info.data.length < 72) throw new Error(`Vault ${vault.toBase58()} not found`);
  return info.data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET);
}

function computeAmountOut(amountIn: bigint, vaultIn: bigint, vaultOut: bigint): bigint {
  if (vaultIn === 0n || amountIn === 0n) return 0n;
  // constant product: vaultOut * amountIn / (vaultIn + amountIn)
  return (vaultOut * amountIn) / (vaultIn + amountIn);
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const amountInStr = searchParams.get("amountIn");
    const direction = searchParams.get("direction") ?? "mind_to_xnt";

    if (!amountInStr) {
      return NextResponse.json({ ok: false, error: "amountIn required" }, { status: 400 });
    }

    const amountIn = BigInt(amountInStr);
    if (amountIn <= 0n) {
      return NextResponse.json({ ok: false, error: "amountIn must be > 0" }, { status: 400 });
    }

    const conn = new Connection(RPC, "confirmed");
    const [xntAmount, mindAmount, configInfo] = await Promise.all([
      readVaultAmount(conn, XNT_VAULT),
      readVaultAmount(conn, MIND_VAULT),
      conn.getAccountInfo(CONFIG_PDA),
    ]);

    // Read fields from on-chain RouterConfig
    let xntUsdCents = 50n; // fallback $0.50
    let rewardPoolMind = 0n;
    let rewardPoolXnt  = 0n;
    let swapCounter    = 0n;
    let gigaHits       = 0n;
    if (configInfo && configInfo.data.length >= CONFIG_REWARD_XNT_OFFSET + 8) {
      xntUsdCents    = configInfo.data.readBigUInt64LE(CONFIG_XNT_USD_OFFSET);
      swapCounter    = configInfo.data.readBigUInt64LE(CONFIG_SWAP_COUNTER_OFFSET);
      gigaHits       = configInfo.data.readBigUInt64LE(CONFIG_GIGA_HITS_OFFSET);
      rewardPoolMind = configInfo.data.readBigUInt64LE(CONFIG_REWARD_MIND_OFFSET);
      rewardPoolXnt  = configInfo.data.readBigUInt64LE(CONFIG_REWARD_XNT_OFFSET);
      if (xntUsdCents === 0n) xntUsdCents = 50n;
    }

    // Our fee deduction
    const ourFee = (amountIn * OUR_FEE_BPS) / 10_000n;
    const afterOurFee = amountIn - ourFee;
    // xdex fee deduction from swap_amount
    const xdexFee = (afterOurFee * XDEX_FEE_BPS) / 10_000n;
    const netSwap = afterOurFee - xdexFee;

    let estimatedOut: bigint;
    let vaultIn: bigint;
    let vaultOut: bigint;

    if (direction === "mind_to_xnt") {
      vaultIn = mindAmount;
      vaultOut = xntAmount;
    } else {
      vaultIn = xntAmount;
      vaultOut = mindAmount;
    }

    estimatedOut = computeAmountOut(netSwap, vaultIn, vaultOut);

    const priceImpactBps = vaultIn > 0n
      ? Number((netSwap * 10_000n) / (vaultIn + netSwap))
      : 0;

    const mindPerXnt = mindAmount * 1_000_000n / (xntAmount || 1n); // scaled 1e6

    // Compute USD value of swap for GigaSwap indicator (mirrors on-chain logic)
    const swapAmount = amountIn - ourFee;
    let usdCents: bigint;
    if (direction === "mind_to_xnt") {
      // MIND price = XNT_price × xnt_vault / mind_vault
      usdCents = mindAmount > 0n
        ? (swapAmount * xntUsdCents * xntAmount) / (mindAmount * 1_000_000_000n)
        : 0n;
    } else {
      // XNT input
      usdCents = (swapAmount * xntUsdCents) / 1_000_000_000n;
    }

    const gigaQualified = usdCents >= 500n; // $5 threshold (próg niezmieniony)
    const mindPerXntNum = xntAmount > 0n ? Number(mindAmount) / Number(xntAmount) : 0;

    // Compute USD value of reward pool for UI
    const DECIMALS_9 = 1_000_000_000n;
    const rewardMindUsdCents = xntAmount > 0n
      ? (rewardPoolMind * xntUsdCents * xntAmount) / (mindAmount > 0n ? mindAmount * DECIMALS_9 : DECIMALS_9)
      : 0n;
    const rewardXntUsdCents = (rewardPoolXnt * xntUsdCents) / DECIMALS_9;
    const rewardPoolUsdCents = rewardMindUsdCents + rewardXntUsdCents;

    return NextResponse.json({
      ok: true,
      amountIn: amountIn.toString(),
      estimatedOut: estimatedOut.toString(),
      ourFee: ourFee.toString(),
      priceImpactBps,
      direction,
      poolXnt: xntAmount.toString(),
      poolMind: mindAmount.toString(),
      mindPerXnt1000: mindPerXnt.toString(),
      mindPerXntNum,
      usdCents: usdCents.toString(),
      gigaQualified,
      xntUsdCents: xntUsdCents.toString(),
      // Reward pool info
      rewardPoolMind: rewardPoolMind.toString(),
      rewardPoolXnt: rewardPoolXnt.toString(),
      rewardPoolUsdCents: rewardPoolUsdCents.toString(),
      swapCounter: swapCounter.toString(),
      gigaHits: gigaHits.toString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Quote failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
