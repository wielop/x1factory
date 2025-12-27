import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import fs from "fs";
import { homedir } from "os";
import dotenv from "dotenv";

dotenv.config();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const rawIdl = require("../web/idl/mining_v2.json");

const programAddress =
  process.env.NEXT_PUBLIC_PROGRAM_ID ??
  rawIdl.address ??
  rawIdl.metadata?.address;
if (!programAddress) {
  throw new Error("NEXT_PUBLIC_PROGRAM_ID is required for mining_v2.");
}

export const PROGRAM_ID = new PublicKey(programAddress);

export const loadKeypair = (filePath: string): Keypair => {
  const fullPath = filePath.replace("~", homedir());
  const secret = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
};

export const getProvider = () => {
  const rpc =
    process.env.RPC_URL ??
    process.env.ANCHOR_PROVIDER_URL ??
    "https://rpc.testnet.x1.xyz";
  const walletPath =
    process.env.WALLET ??
    process.env.ANCHOR_WALLET ??
    `${homedir()}/.config/solana/id.json`;
  const wallet = new anchor.Wallet(loadKeypair(walletPath));
  const connection = new Connection(rpc, "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  return provider;
};

const normalizeIdl = (raw: anchor.Idl): anchor.Idl => {
  const clone = JSON.parse(JSON.stringify(raw)) as anchor.Idl;
  const toSnakeCase = (value: string) =>
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/-/g, "_")
      .toLowerCase();
  const discriminator = (namespace: string, name: string) =>
    Buffer.from(createHash("sha256").update(`${namespace}:${name}`).digest().slice(0, 8));
  const fixDefined = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(fixDefined);
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.defined === "string") {
        record.defined = { name: record.defined, generics: [] };
      }
      for (const key of Object.keys(record)) {
        record[key] = fixDefined(record[key]);
      }
      return record;
    }
    if (typeof value === "string") {
      return value === "publicKey" ? "pubkey" : value;
    }
    return value;
  };

  const idl = fixDefined(clone) as anchor.Idl;
  const normalizeAccounts = (items: Array<Record<string, unknown>>) => {
    for (const item of items) {
      if (Array.isArray(item.accounts)) {
        normalizeAccounts(item.accounts as Array<Record<string, unknown>>);
      }
      if (Object.prototype.hasOwnProperty.call(item, "isMut")) {
        item.writable = item.isMut;
        delete item.isMut;
      }
      if (Object.prototype.hasOwnProperty.call(item, "isSigner")) {
        item.signer = item.isSigner;
        delete item.isSigner;
      }
    }
  };
  if (Array.isArray((idl as any).instructions)) {
    for (const ix of (idl as any).instructions) {
      if (Array.isArray(ix.accounts)) {
        normalizeAccounts(ix.accounts);
      }
    }
  }

  for (const ix of (idl as any).instructions ?? []) {
    if (!ix.discriminator) {
      ix.discriminator = discriminator("global", toSnakeCase(ix.name));
    }
  }
  for (const acc of (idl as any).accounts ?? []) {
    if (!acc.discriminator) {
      acc.discriminator = discriminator("account", acc.name);
    }
  }
  const types = ((idl as any).types ?? []) as Array<{ name: string; type: unknown }>;
  (idl as any).types = types;
  for (const acc of (idl as any).accounts ?? []) {
    if (acc.type && !types.some((ty) => ty.name === acc.name)) {
      types.push({ name: acc.name, type: acc.type });
    }
  }
  for (const evt of (idl as any).events ?? []) {
    if (!evt.discriminator) {
      evt.discriminator = discriminator("event", evt.name);
    }
    if (evt.fields && !types.some((ty) => ty.name === evt.name)) {
      types.push({ name: evt.name, type: { kind: "struct", fields: evt.fields } });
    }
  }
  return idl;
};

export const getProgram = () => {
  const provider = getProvider();
  const idl = normalizeIdl(rawIdl as anchor.Idl);
  idl.address = PROGRAM_ID.toBase58();
  return new anchor.Program(idl, provider);
};

export const deriveConfigPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];

export const deriveLevelConfigPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from("level_config")], PROGRAM_ID)[0];

export const deriveHpScaleConfigPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from("hp_scale")], PROGRAM_ID)[0];

export const deriveVaultPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID)[0];

export const deriveStakingRewardVaultPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from("staking_reward_vault")], PROGRAM_ID)[0];

export const deriveTreasuryVaultPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from("treasury_vault")], PROGRAM_ID)[0];

export const deriveProfilePda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("profile"), owner.toBuffer()],
    PROGRAM_ID
  )[0];

export const derivePositionPda = (owner: PublicKey, index: bigint) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      owner.toBuffer(),
      Buffer.from(new anchor.BN(index.toString()).toArray("le", 8)),
    ],
    PROGRAM_ID
  )[0];

export const deriveStakePda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("stake"), owner.toBuffer()],
    PROGRAM_ID
  )[0];

export type DecodedConfig = {
  admin: PublicKey;
  emissionPerSec: bigint;
  mindMint: PublicKey;
  xntMint: PublicKey;
  stakingRewardVault: PublicKey;
  treasuryVault: PublicKey;
  stakingMindVault: PublicKey;
  maxEffectiveHp: bigint;
  secondsPerDay: bigint;
};

export const fetchConfig = async (connection: Connection) => {
  const configPda = deriveConfigPda();
  const info = await connection.getAccountInfo(configPda, "confirmed");
  if (!info) {
    return null;
  }
  const data = info.data;
  if (data.length < 322) {
    throw new Error(`Config account too small: ${data.length} bytes`);
  }
  let offset = 8;
  const readPubkey = () => {
    const pk = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    return pk;
  };
  const readU64 = () => {
    const v = data.readBigUInt64LE(offset);
    offset += 8;
    return v;
  };
  const readU128 = () => {
    const lo = data.readBigUInt64LE(offset);
    const hi = data.readBigUInt64LE(offset + 8);
    offset += 16;
    return (hi << 64n) + lo;
  };
  const readI64 = () => {
    const v = data.readBigInt64LE(offset);
    offset += 8;
    return v;
  };

  const admin = readPubkey();
  const emissionPerSec = readU64();
  readU128();
  readI64();
  readU64();
  const mindMint = readPubkey();
  const xntMint = readPubkey();
  const stakingRewardVault = readPubkey();
  const treasuryVault = readPubkey();
  const stakingMindVault = readPubkey();
  const maxEffectiveHp = readU64();
  const secondsPerDay = readU64();

  return {
    admin,
    emissionPerSec,
    mindMint,
    xntMint,
    stakingRewardVault,
    treasuryVault,
    stakingMindVault,
    maxEffectiveHp,
    secondsPerDay,
  } satisfies DecodedConfig;
};

export const fetchUserProfile = async (
  connection: Connection,
  owner: PublicKey
) => {
  const profilePda = deriveProfilePda(owner);
  const info = await connection.getAccountInfo(profilePda, "confirmed");
  if (!info) {
    return null;
  }
  const data = info.data;
  if (data.length < 68) {
    throw new Error(`User profile too small: ${data.length} bytes`);
  }
  let offset = 8 + 32;
  const nextPositionIndex = data.readBigUInt64LE(offset);
  return { nextPositionIndex };
};
