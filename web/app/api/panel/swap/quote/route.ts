import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RPC = "https://rpc.mainnet.x1.xyz";
const MIND_XNT_POOL = new PublicKey("FAVw1iDioK69epJf1YY3Z1oakSCUYtmfUpVBxR14BGpm");
const XNT_VAULT = new PublicKey("AGy9mSe6pmmHzVTuagfSHzJBe4hn2FpYq3hrsoF5i2ys");
const MIND_VAULT = new PublicKey("94F7JppAqiJkkwy31CqvfLd1a8BcT3AzESE8j533zGjg");
const CONFIG_PDA = new PublicKey("2jphFVpP8M7yPC9syAis7sN28aTWBU4MssmXiQGxrZb6");

// RouterConfig layout: discriminator(8) + authority(32) + treasury(32) + xnt_usd_cents(8) at offset 72
const CONFIG_XNT_USD_OFFSET = 8 + 32 + 32; // = 72

const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
const OUR_FEE_BPS = 40n; // 0.4%
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

    // Read xnt_usd_cents from on-chain RouterConfig (offset 72, u64 LE)
    let xntUsdCents = 50n; // fallback $0.50
    if (configInfo && configInfo.data.length >= CONFIG_XNT_USD_OFFSET + 8) {
      xntUsdCents = configInfo.data.readBigUInt64LE(CONFIG_XNT_USD_OFFSET);
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

    const gigaQualified = usdCents >= 500n; // $5 threshold
    const mindPerXntNum = xntAmount > 0n ? Number(mindAmount) / Number(xntAmount) : 0;

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
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Quote failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
