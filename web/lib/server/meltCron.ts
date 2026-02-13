import "server-only";

import crypto from "crypto";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

export const EXPECTED_KEEPER_PUBKEY = new PublicKey(
  "Ahe1dJs48PWozTDfBg7a3X3AFrUafnGkcoBg7NMNKSCA"
);
const CONFIG_SEED = "melt_config";
const ROUND_SEED = "melt_round";

export type MeltConfigSnapshot = {
  configPda: PublicKey;
  vault: PublicKey;
  roundSeq: bigint;
  activeRoundSeq: bigint;
  activeRoundActive: boolean;
};

export type MeltRoundSnapshot = {
  roundPda: PublicKey;
  seq: bigint;
  endTs: number;
  status: number;
};

const mustEnv = (name: string) => {
  const value = (process.env[name] ?? "").trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
};

export const getMeltRpcUrl = () => mustEnv("MELT_RPC_URL");
export const getMeltProgramId = () => new PublicKey(mustEnv("MELT_PROGRAM_ID"));

const parseJsonArraySecret = (raw: string): Uint8Array | null => {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (parsed.some((v) => typeof v !== "number")) return null;
    return Uint8Array.from(parsed);
  } catch {
    return null;
  }
};

const parseBase58Secret = (raw: string): Uint8Array | null => {
  try {
    return bs58.decode(raw);
  } catch {
    return null;
  }
};

export const loadKeeper = () => {
  const raw = mustEnv("KEEPER_PRIVATE_KEY");
  const fromArray = parseJsonArraySecret(raw);
  const fromBase58 = parseBase58Secret(raw);
  const secret = fromArray ?? fromBase58;
  if (!secret) {
    throw new Error("Invalid KEEPER_PRIVATE_KEY format. Use base58 or JSON byte array.");
  }

  let keypair: Keypair;
  if (secret.length === 64) {
    keypair = Keypair.fromSecretKey(secret);
  } else if (secret.length === 32) {
    keypair = Keypair.fromSeed(secret);
  } else {
    throw new Error(`Invalid KEEPER_PRIVATE_KEY length: ${secret.length}`);
  }

  if (!keypair.publicKey.equals(EXPECTED_KEEPER_PUBKEY)) {
    throw new Error(
      `KEEPER_PRIVATE_KEY pubkey mismatch. Expected ${EXPECTED_KEEPER_PUBKEY.toBase58()}, got ${keypair.publicKey.toBase58()}`
    );
  }
  return keypair;
};

export const isCronAuthorized = (req: Request) => {
  const expected = (process.env.CRON_SECRET ?? "").trim();
  if (!expected) return false;
  const url = new URL(req.url);
  const querySecret = (url.searchParams.get("secret") ?? "").trim();
  const headerSecret = (req.headers.get("x-cron-secret") ?? "").trim();
  const provided = querySecret || headerSecret;
  if (!provided) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
};

export const createMeltConnection = () => new Connection(getMeltRpcUrl(), "confirmed");

export const deriveMeltConfigPda = (programId: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED)], programId)[0];

export const deriveMeltRoundPda = (programId: PublicKey, seq: bigint) => {
  const seqLe = Buffer.alloc(8);
  seqLe.writeBigUInt64LE(seq);
  return PublicKey.findProgramAddressSync([Buffer.from(ROUND_SEED), seqLe], programId)[0];
};

export const readMeltConfigSnapshot = async (
  connection: Connection,
  programId: PublicKey
): Promise<MeltConfigSnapshot | null> => {
  const configPda = deriveMeltConfigPda(programId);
  const info = await connection.getAccountInfo(configPda, "confirmed");
  if (!info) return null;
  const data = info.data;
  if (data.length < 172) {
    throw new Error(`MELT config account too small: ${data.length} bytes`);
  }
  let offset = 8;
  const readPubkey = () => {
    const value = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    return value;
  };
  const readU64 = () => {
    const value = data.readBigUInt64LE(offset);
    offset += 8;
    return value;
  };
  const readU16 = () => {
    const value = data.readUInt16LE(offset);
    offset += 2;
    return value;
  };
  const readBool = () => {
    const value = data.readUInt8(offset) === 1;
    offset += 1;
    return value;
  };

  readPubkey(); // admin
  readPubkey(); // mind_mint
  const vault = readPubkey();
  readU64(); // cap
  readU16(); // rollover
  readU64(); // burn_min
  readU64(); // round_window
  readBool(); // test_mode
  const roundSeq = readU64();
  readU64(); // vial
  readU64(); // bonus
  const activeRoundSeq = readU64();
  const activeRoundActive = readBool();

  return {
    configPda,
    vault,
    roundSeq,
    activeRoundSeq,
    activeRoundActive,
  };
};

export const readMeltRoundSnapshot = async (
  connection: Connection,
  roundPda: PublicKey
): Promise<MeltRoundSnapshot | null> => {
  const info = await connection.getAccountInfo(roundPda, "confirmed");
  if (!info) return null;
  const data = info.data;
  if (data.length < 58) {
    throw new Error(`MELT round account too small: ${data.length} bytes`);
  }
  const seq = data.readBigUInt64LE(8);
  const endTs = Number(data.readBigInt64LE(24));
  const status = data.readUInt8(56); // 0 Planned, 1 Active, 2 Finalized
  return { roundPda, seq, endTs, status };
};

export const ixDiscriminator = (nameSnakeCase: string) =>
  crypto.createHash("sha256").update(`global:${nameSnakeCase}`).digest().subarray(0, 8);

