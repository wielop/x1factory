import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RPC = "https://rpc.mainnet.x1.xyz";
const MIND_XNT_POOL = new PublicKey("FAVw1iDioK69epJf1YY3Z1oakSCUYtmfUpVBxR14BGpm");
const XNT_VAULT = new PublicKey("AGy9mSe6pmmHzVTuagfSHzJBe4hn2FpYq3hrsoF5i2ys");
const MIND_VAULT = new PublicKey("94F7JppAqiJkkwy31CqvfLd1a8BcT3AzESE8j533zGjg");

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
    const [xntAmount, mindAmount] = await Promise.all([
      readVaultAmount(conn, XNT_VAULT),
      readVaultAmount(conn, MIND_VAULT),
    ]);

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

    // XNT/USD price from XNT/USDC pool vaults (cached in config — approximate)
    // Use simple ratio from MIND/XNT pool: 1 XNT ≈ mindAmount/xntAmount MIND
    const mindPerXnt = mindAmount * 1_000_000n / (xntAmount || 1n); // scaled 1e6

    return NextResponse.json({
      ok: true,
      amountIn: amountIn.toString(),
      estimatedOut: estimatedOut.toString(),
      ourFee: ourFee.toString(),
      priceImpactBps,
      direction,
      poolXnt: xntAmount.toString(),
      poolMind: mindAmount.toString(),
      mindPerXnt1000: mindPerXnt.toString(), // MIND per XNT * 1e6 / 1e3 = MIND per XNT * 1000
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Quote failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
