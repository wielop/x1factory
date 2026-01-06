import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "crypto";
import bs58 from "bs58";
import { fetchConfig, getProgramId, getRpcUrl } from "@/lib/solana";

const BPS_DENOMINATOR = 10_000n;
const BURN_BPS = 600n;
const SIGNATURE_PAGE_LIMIT = 1000;
const TX_BATCH_SIZE = 25;
const BURN_CACHE_MS = 5 * 60 * 1000;
const LEVEL_UP_LOG_HINTS = ["Instruction: LevelUp", "Instruction: level_up"];
const UNSTAKE_EXCLUDED_OWNERS = new Set([
  "FPLV6bRcBj4i8sipkim2N7eZMsGJC2xfCsAgeoDsQhoD",
  "Cjk6T9VU2N4eUXC3E5TzazJjwUeMrC25xdJyqf3F1s2z",
]);
const UNSTAKE_EVENT_DISCRIMINATOR = createHash("sha256")
  .update("event:MindUnstaked")
  .digest()
  .subarray(0, 8);

let burnsCache: { ts: number; data: Map<string, bigint> } | null = null;

const decodeInstructionData = (data: string) => {
  try {
    return Buffer.from(bs58.decode(data));
  } catch {
    try {
      return Buffer.from(data, "base64");
    } catch {
      return null;
    }
  }
};

const hasLevelUpLog = (logs: string[]) =>
  logs.some((log) => LEVEL_UP_LOG_HINTS.some((hint) => log.includes(hint)));

const getAccountKey = (keys: Array<PublicKey | string>, index: number) => {
  const key = keys[index];
  return typeof key === "string" ? new PublicKey(key) : key;
};

const parseUnstakeEventsFromLogs = (logs: string[]) => {
  const events: Array<{ owner: string; amount: bigint }> = [];
  const prefix = "Program data: ";
  for (const log of logs) {
    if (!log.startsWith(prefix)) continue;
    const raw = log.slice(prefix.length).trim();
    let buf: Buffer;
    try {
      buf = Buffer.from(raw, "base64");
    } catch {
      continue;
    }
    if (buf.length < 48) continue; // 8 disc + 32 pubkey + 8 amount
    if (!buf.subarray(0, 8).equals(UNSTAKE_EVENT_DISCRIMINATOR)) continue;
    const owner = new PublicKey(buf.subarray(8, 40)).toBase58();
    if (UNSTAKE_EXCLUDED_OWNERS.has(owner)) continue;
    const amount = buf.readBigUInt64LE(40);
    events.push({ owner, amount });
  }
  return events;
};

const parseLevelUpBurnsFromTx = (tx: any, mindMint: PublicKey) => {
  const burns: Array<{ owner: string; amount: bigint }> = [];
  const inner = tx?.meta?.innerInstructions;
  if (!inner) return burns;
  const accountKeys = tx.transaction.message.accountKeys as Array<PublicKey | string>;
  const preBalances = tx.meta?.preTokenBalances ?? [];

  inner.forEach((group: any) => {
    group.instructions.forEach((ix: any) => {
      const programId = getAccountKey(accountKeys, ix.programIdIndex);
      if (!programId.equals(TOKEN_PROGRAM_ID)) return;
      const data = decodeInstructionData(ix.data);
      if (!data || data.length < 9) return;
      const instruction = data[0];
      if (instruction !== 8 && instruction !== 15) return;
      const sourceIndex = ix.accounts?.[0];
      const mintIndex = ix.accounts?.[1];
      if (sourceIndex == null || mintIndex == null) return;
      const mint = getAccountKey(accountKeys, mintIndex);
      if (!mint.equals(mindMint)) return;
      const owner = preBalances.find(
        (b: any) => b.accountIndex === sourceIndex && b.mint === mindMint.toBase58()
      )?.owner;
      if (!owner) return;
      const amount = data.readBigUInt64LE(1);
      burns.push({ owner, amount });
    });
  });
  return burns;
};

const addBurn = (map: Map<string, bigint>, owner: string, amount: bigint) => {
  map.set(owner, (map.get(owner) ?? 0n) + amount);
};

const collectBurnsByOwner = async (connection: Connection, mindMint: PublicKey) => {
  if (burnsCache && Date.now() - burnsCache.ts < BURN_CACHE_MS) {
    return burnsCache.data;
  }
  const programId = getProgramId();
  const signatures: string[] = [];
  let before: string | undefined;
  while (true) {
    const batch = await connection.getSignaturesForAddress(programId, {
      before,
      limit: SIGNATURE_PAGE_LIMIT,
    });
    if (!batch.length) break;
    for (const sig of batch) {
      signatures.push(sig.signature);
    }
    const oldest = batch[batch.length - 1];
    if (batch.length < SIGNATURE_PAGE_LIMIT) break;
    before = oldest.signature;
  }

  const burnsByOwner = new Map<string, bigint>();
  for (let i = 0; i < signatures.length; i += TX_BATCH_SIZE) {
    const chunk = signatures.slice(i, i + TX_BATCH_SIZE);
    const txs = await connection.getTransactions(chunk, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    txs.forEach((tx) => {
      if (!tx?.meta?.logMessages) return;
      const logs = tx.meta.logMessages;
      const unstakeEvents = parseUnstakeEventsFromLogs(logs);
      unstakeEvents.forEach((evt) => {
        const burnBase = (evt.amount * BURN_BPS) / BPS_DENOMINATOR;
        if (burnBase > 0) addBurn(burnsByOwner, evt.owner, burnBase);
      });
      if (hasLevelUpLog(logs)) {
        const burns = parseLevelUpBurnsFromTx(tx, mindMint);
        burns.forEach((burn) => {
          if (burn.amount > 0) addBurn(burnsByOwner, burn.owner, burn.amount);
        });
      }
    });
  }

  burnsCache = { ts: Date.now(), data: burnsByOwner };
  return burnsByOwner;
};

export async function GET(request: NextRequest) {
  const ownersParam = request.nextUrl.searchParams.get("owners") ?? "";
  const owners = ownersParam
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (owners.length === 0) {
    return NextResponse.json({ burnedByOwner: {} });
  }

  try {
    const rpcUrl = getRpcUrl();
    const connection = new Connection(rpcUrl, "confirmed");
    const cfg = await fetchConfig(connection);
    const mindMint = cfg.mindMint;
    const burnsByOwner = await collectBurnsByOwner(connection, mindMint);

    const result: Record<string, string> = {};
    owners.forEach((owner) => {
      result[owner] = (burnsByOwner.get(owner) ?? 0n).toString();
    });

    return NextResponse.json({ burnedByOwner: result, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("Failed to load burn totals", err);
    return NextResponse.json({ burnedByOwner: {} }, { status: 500 });
  }
}
