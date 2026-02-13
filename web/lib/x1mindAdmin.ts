import "server-only";

import bs58 from "bs58";
import { Connection, Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import { getRpcUrl } from "@/lib/solana";
import { getX1MindProgram } from "@/lib/x1mindAnchor";

type SignableTx = Transaction | VersionedTransaction;

const loadAdminKeypair = () => {
  const raw = process.env.X1MIND_ADMIN_KEYPAIR?.trim();
  if (!raw) {
    throw new Error("Missing X1MIND_ADMIN_KEYPAIR env var.");
  }

  const parseArray = (value: unknown): number[] | null => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (Array.isArray(record.secretKey)) return record.secretKey as number[];
      if (Array.isArray(record.data)) return record.data as number[];
    }
    return null;
  };

  let secret: Uint8Array | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const arr = parseArray(parsed);
    if (arr) {
      secret = Uint8Array.from(arr);
    }
  } catch {
    // Ignore and try base58 below.
  }

  if (!secret) {
    try {
      secret = bs58.decode(raw);
    } catch {
      throw new Error("Invalid X1MIND_ADMIN_KEYPAIR; expected JSON array or base58.");
    }
  }

  if (!secret) {
    throw new Error("Invalid X1MIND_ADMIN_KEYPAIR; expected JSON array or base58.");
  }
  return Keypair.fromSecretKey(secret);
};

const signWithKeypair = (tx: SignableTx, keypair: Keypair) => {
  if (tx instanceof VersionedTransaction) {
    tx.sign([keypair]);
    return tx;
  }
  tx.partialSign(keypair);
  return tx;
};

export function getX1MindAdminContext() {
  const keypair = loadAdminKeypair();
  const connection = new Connection(getRpcUrl(), "confirmed");
  const wallet = {
    publicKey: keypair.publicKey,
    signTransaction: async (tx: SignableTx) => signWithKeypair(tx, keypair),
    signAllTransactions: async (txs: SignableTx[]) => txs.map((tx) => signWithKeypair(tx, keypair)),
  };

  return {
    connection,
    keypair,
    program: getX1MindProgram(connection, wallet as any),
  };
}
