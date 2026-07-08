import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { resolveLaunchpadTokenIdentity, APP_BASE_URL } from "@/lib/launchpad";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RPC = "https://rpc.mainnet.x1.xyz";

// This is what the on-chain Metaplex metadata `uri` field points to for every launchpad
// token — standard off-chain JSON schema (name/symbol/image/description), derived live from
// the LaunchpadMintCreated event of the token's own creation transaction. No database: the
// event is the permanent source of truth, this just re-serves it as the JSON shape wallets
// and explorers expect.
export async function GET(_req: NextRequest, { params }: { params: { mint: string } }) {
  let mint: PublicKey;
  try {
    mint = new PublicKey(params.mint);
  } catch {
    return NextResponse.json({ error: "Invalid mint" }, { status: 400 });
  }

  const conn = new Connection(RPC, "confirmed");
  const identity = await resolveLaunchpadTokenIdentity(conn, mint);
  if (!identity) {
    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  }

  return NextResponse.json(
    {
      name: identity.name,
      symbol: identity.symbol,
      description: `${identity.name} ($${identity.symbol}) — bonding curve token on the X1Factory launchpad, with a built-in GigaSwap jackpot.`,
      image: identity.image || `${APP_BASE_URL}/x1factory-logo.png`,
      external_url: `${APP_BASE_URL}/launchpad/${mint.toBase58()}`,
      properties: {
        category: "image",
        files: identity.image ? [{ uri: identity.image, type: "image" }] : [],
      },
    },
    { headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" } }
  );
}
