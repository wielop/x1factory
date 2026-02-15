import * as anchor from "@coral-xyz/anchor";
import { sha256 } from "@noble/hashes/sha256";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";

export const MELT_DEFAULT_RPC_URL = "https://rpc.testnet.x1.xyz";
export const MELT_DEFAULT_PROGRAM_ID = "HAWdiMtvTfiFhENgxPdWEgBQmoa3A5oN1KV9N3LSmxXz";
export const MELT_DEFAULT_MIND_MINT = "AJhe17P7jFTUgsTUJYxvTdqpND5RG1cr1SSXxLrG9QUc";

const CONFIG_SEED = "melt_config";
const VAULT_SEED = "melt_vault";
const ROUND_SEED = "melt_round";
const USER_ROUND_SEED = "melt_user_round";

type EnvCache = { rpcUrl: string; programId: PublicKey; mindMint: PublicKey };
let cachedEnv: EnvCache | null = null;

export function getMeltEnv(): EnvCache {
  if (cachedEnv) return cachedEnv;
  const rpcUrl = (process.env.NEXT_PUBLIC_MELT_RPC_URL ?? MELT_DEFAULT_RPC_URL).trim();
  if (!rpcUrl) {
    throw new Error("Missing NEXT_PUBLIC_MELT_RPC_URL. Set it in Vercel Environment Variables.");
  }
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new Error(`Invalid NEXT_PUBLIC_MELT_RPC_URL: "${rpcUrl}"`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`NEXT_PUBLIC_MELT_RPC_URL must be https, got "${parsed.protocol}"`);
  }
  const programIdStr = (process.env.NEXT_PUBLIC_MELT_PROGRAM_ID ?? MELT_DEFAULT_PROGRAM_ID).trim();
  if (!programIdStr) {
    throw new Error("Missing NEXT_PUBLIC_MELT_PROGRAM_ID. Set it in Vercel Environment Variables.");
  }
  let programId: PublicKey;
  try {
    programId = new PublicKey(programIdStr);
  } catch {
    throw new Error(`Invalid NEXT_PUBLIC_MELT_PROGRAM_ID: "${programIdStr}"`);
  }
  const mindMintStr = (process.env.NEXT_PUBLIC_MIND_MINT ?? MELT_DEFAULT_MIND_MINT).trim();
  if (!mindMintStr) {
    throw new Error("Missing NEXT_PUBLIC_MIND_MINT. Set it in Vercel Environment Variables.");
  }
  let mindMint: PublicKey;
  try {
    mindMint = new PublicKey(mindMintStr);
  } catch {
    throw new Error(`Invalid NEXT_PUBLIC_MIND_MINT: "${mindMintStr}"`);
  }
  cachedEnv = { rpcUrl, programId, mindMint };
  return cachedEnv;
}

export const getMeltRpcUrl = () => getMeltEnv().rpcUrl;
export const getMeltProgramId = () => getMeltEnv().programId;
export const getMindMint = () => getMeltEnv().mindMint;
export const getMiningProgramId = (): PublicKey | null => {
  const raw =
    process.env.NEXT_PUBLIC_PROGRAM_ID ??
    process.env.NEXT_PUBLIC_MINING_V2_PROGRAM_ID ??
    "";
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new PublicKey(trimmed);
  } catch {
    return null;
  }
};

export const deriveMeltConfigPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED)], getMeltProgramId())[0];

export const deriveMeltVaultPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from(VAULT_SEED)], getMeltProgramId())[0];

export const deriveMeltRoundPda = (seq: bigint) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(seq);
  return PublicKey.findProgramAddressSync([Buffer.from(ROUND_SEED), buf], getMeltProgramId())[0];
};

export const deriveMeltUserRoundPda = (user: PublicKey, round: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(USER_ROUND_SEED), user.toBuffer(), round.toBuffer()],
    getMeltProgramId()
  )[0];

type IdlAccountItem = { accounts?: IdlAccountItem[] } & Record<string, unknown>;

const normalizeIdl = (raw: unknown): anchor.Idl => {
  const clone = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
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
  const normalizeAccounts = (items: IdlAccountItem[]): IdlAccountItem[] =>
    items.map((item): IdlAccountItem => {
      if (Array.isArray(item.accounts)) {
        return { ...item, accounts: normalizeAccounts(item.accounts) };
      }
      const { isMut, isSigner, ...rest } = item;
      return {
        ...rest,
        ...(isMut === undefined ? {} : { writable: isMut }),
        ...(isSigner === undefined ? {} : { signer: isSigner }),
      };
    });

  const idlValue = fixDefined(clone) as anchor.Idl;
  const instructions = idlValue.instructions;
  if (Array.isArray(instructions)) {
    for (const ix of instructions) {
      if (ix && typeof ix === "object" && Array.isArray((ix as IdlAccountItem).accounts)) {
        (ix as IdlAccountItem).accounts = normalizeAccounts(
          (ix as IdlAccountItem).accounts as IdlAccountItem[]
        );
      }
    }
  }
  return idlValue;
};

const toSnakeCase = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();

const instructionDiscriminator = (name: string) => {
  const data = new TextEncoder().encode(`global:${toSnakeCase(name)}`);
  return sha256(data).slice(0, 8);
};

const accountDiscriminator = (name: string) => {
  const data = new TextEncoder().encode(`account:${name}`);
  return sha256(data).slice(0, 8);
};

const eventDiscriminator = (name: string) => {
  const data = new TextEncoder().encode(`event:${name}`);
  return sha256(data).slice(0, 8);
};

const normalizeDiscriminator = (name: string, discriminator: unknown) => {
  if (discriminator instanceof Uint8Array) return discriminator;
  if (Array.isArray(discriminator)) return Uint8Array.from(discriminator);
  return instructionDiscriminator(name);
};

const MELT_IDL = {
  version: "0.1.0",
  name: "melt_v1",
  instructions: [
    {
      name: "adminTopupVault",
      accounts: [
        { name: "admin", isMut: true, isSigner: true },
        { name: "config", isMut: true, isSigner: false },
        { name: "vault", isMut: true, isSigner: false },
        { name: "round", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [{ name: "lamports", type: "u64" }],
    },
    {
      name: "adminTopupVial",
      accounts: [
        { name: "admin", isMut: true, isSigner: true },
        { name: "config", isMut: true, isSigner: false },
        { name: "vault", isMut: true, isSigner: false },
        { name: "round", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [{ name: "lamports", type: "u64" }],
    },
    {
      name: "initMelt",
      accounts: [
        { name: "payer", isMut: true, isSigner: true },
        { name: "admin", isMut: true, isSigner: true },
        { name: "mindMint", isMut: false, isSigner: false },
        { name: "config", isMut: true, isSigner: false },
        { name: "vault", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [{ name: "params", type: { defined: "InitMeltParams" } }],
    },
    {
      name: "adminWithdrawVault",
      accounts: [
        { name: "admin", isMut: true, isSigner: true },
        { name: "config", isMut: true, isSigner: false },
        { name: "vault", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [{ name: "lamports", type: "u64" }],
    },
    {
      name: "adminSetSchedule",
      accounts: [
        { name: "admin", isMut: true, isSigner: true },
        { name: "config", isMut: true, isSigner: false },
        { name: "round", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [
        { name: "startTs", type: "i64" },
        { name: "endTs", type: "i64" },
      ],
    },
    {
      name: "adminSetParams",
      accounts: [
        { name: "admin", isMut: true, isSigner: true },
        { name: "config", isMut: true, isSigner: false },
      ],
      args: [{ name: "params", type: { defined: "AdminSetParamsParams" } }],
    },
    {
      name: "adminMigrateConfig",
      accounts: [
        { name: "admin", isMut: true, isSigner: true },
        { name: "config", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      name: "startRound",
      accounts: [
        { name: "admin", isMut: true, isSigner: true },
        { name: "config", isMut: true, isSigner: false },
        { name: "vault", isMut: true, isSigner: false },
        { name: "round", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      name: "burnMind",
      accounts: [
        { name: "user", isMut: true, isSigner: true },
        { name: "config", isMut: false, isSigner: false },
        { name: "round", isMut: true, isSigner: false },
        { name: "mindMint", isMut: true, isSigner: false },
        { name: "userMindAta", isMut: true, isSigner: false },
        { name: "userRound", isMut: true, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [{ name: "amount", type: "u64" }],
    },
    {
      name: "finalizeRound",
      accounts: [
        { name: "admin", isMut: true, isSigner: true },
        { name: "config", isMut: true, isSigner: false },
        { name: "round", isMut: true, isSigner: false },
        { name: "vault", isMut: false, isSigner: false },
        { name: "nextRound", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      name: "claim",
      accounts: [
        { name: "user", isMut: true, isSigner: true },
        { name: "config", isMut: true, isSigner: false },
        { name: "vault", isMut: true, isSigner: false },
        { name: "round", isMut: true, isSigner: false },
        { name: "nextRound", isMut: true, isSigner: false },
        { name: "userRound", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      name: "endAndClaim",
      accounts: [
        { name: "user", isMut: true, isSigner: true },
        { name: "config", isMut: true, isSigner: false },
        { name: "vault", isMut: true, isSigner: false },
        { name: "round", isMut: true, isSigner: false },
        { name: "nextRound", isMut: true, isSigner: false },
        { name: "userRound", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [],
    },
  ],
  accounts: [
    {
      name: "MeltConfig",
      type: {
        kind: "struct",
        fields: [
          { name: "admin", type: "publicKey" },
          { name: "mindMint", type: "publicKey" },
          { name: "vault", type: "publicKey" },
          { name: "vaultCapLamports", type: "u64" },
          { name: "rolloverBps", type: "u16" },
          { name: "burnMin", type: "u64" },
          { name: "roundWindowSec", type: "u64" },
          { name: "testMode", type: "bool" },
          { name: "roundSeq", type: "u64" },
          { name: "vialLamports", type: "u64" },
          { name: "bonusPoolLamports", type: "u64" },
          { name: "activeRoundSeq", type: "u64" },
          { name: "activeRoundActive", type: "bool" },
          { name: "pendingWindowSec", type: "u64" },
          { name: "bumpConfig", type: "u8" },
          { name: "bumpVault", type: "u8" },
        ],
      },
    },
    {
      name: "MeltRound",
      type: {
        kind: "struct",
        fields: [
          { name: "seq", type: "u64" },
          { name: "startTs", type: "i64" },
          { name: "endTs", type: "i64" },
          { name: "vRound", type: "u64" },
          { name: "vPay", type: "u64" },
          { name: "totalBurn", type: "u64" },
          { name: "status", type: { defined: "RoundStatus" } },
          { name: "bump", type: "u8" },
        ],
      },
    },
    {
      name: "MeltUserRound",
      type: {
        kind: "struct",
        fields: [
          { name: "user", type: "publicKey" },
          { name: "round", type: "publicKey" },
          { name: "burned", type: "u64" },
          { name: "claimed", type: "bool" },
          { name: "bump", type: "u8" },
        ],
      },
    },
  ],
  types: [
    {
      name: "MeltConfig",
      type: {
        kind: "struct",
        fields: [
          { name: "admin", type: "publicKey" },
          { name: "mindMint", type: "publicKey" },
          { name: "vault", type: "publicKey" },
          { name: "vaultCapLamports", type: "u64" },
          { name: "rolloverBps", type: "u16" },
          { name: "burnMin", type: "u64" },
          { name: "roundWindowSec", type: "u64" },
          { name: "testMode", type: "bool" },
          { name: "roundSeq", type: "u64" },
          { name: "vialLamports", type: "u64" },
          { name: "bonusPoolLamports", type: "u64" },
          { name: "activeRoundSeq", type: "u64" },
          { name: "activeRoundActive", type: "bool" },
          { name: "pendingWindowSec", type: "u64" },
          { name: "bumpConfig", type: "u8" },
          { name: "bumpVault", type: "u8" },
        ],
      },
    },
    {
      name: "MeltRound",
      type: {
        kind: "struct",
        fields: [
          { name: "seq", type: "u64" },
          { name: "startTs", type: "i64" },
          { name: "endTs", type: "i64" },
          { name: "vRound", type: "u64" },
          { name: "vPay", type: "u64" },
          { name: "totalBurn", type: "u64" },
          { name: "status", type: { defined: "RoundStatus" } },
          { name: "bump", type: "u8" },
        ],
      },
    },
    {
      name: "MeltUserRound",
      type: {
        kind: "struct",
        fields: [
          { name: "user", type: "publicKey" },
          { name: "round", type: "publicKey" },
          { name: "burned", type: "u64" },
          { name: "claimed", type: "bool" },
          { name: "bump", type: "u8" },
        ],
      },
    },
    {
      name: "InitMeltParams",
      type: {
        kind: "struct",
        fields: [
          { name: "vaultCapXnt", type: "u64" },
          { name: "rolloverBps", type: "u16" },
          { name: "burnMin", type: "u64" },
          { name: "roundWindowSec", type: "u64" },
          { name: "testMode", type: "bool" },
        ],
      },
    },
    {
      name: "AdminSetParamsParams",
      type: {
        kind: "struct",
        fields: [
          { name: "vaultCapXnt", type: { option: "u64" } },
          { name: "rolloverBps", type: { option: "u16" } },
          { name: "burnMin", type: { option: "u64" } },
          { name: "roundWindowSec", type: { option: "u64" } },
        ],
      },
    },
    {
      name: "RoundStatus",
      type: {
        kind: "enum",
        variants: [{ name: "Planned" }, { name: "Active" }, { name: "Finalized" }],
      },
    },
    {
      name: "FundingRecorded",
      type: {
        kind: "struct",
        fields: [
          { name: "amount", type: "u64" },
          { name: "vialLamports", type: "u64" },
        ],
      },
    },
    {
      name: "RoundStarted",
      type: {
        kind: "struct",
        fields: [
          { name: "seq", type: "u64" },
          { name: "startTs", type: "i64" },
          { name: "endTs", type: "i64" },
          { name: "pot", type: "u64" },
          { name: "vPay", type: "u64" },
        ],
      },
    },
    {
      name: "Burned",
      type: {
        kind: "struct",
        fields: [
          { name: "user", type: "publicKey" },
          { name: "round", type: "publicKey" },
          { name: "amount", type: "u64" },
          { name: "totalBurn", type: "u64" },
        ],
      },
    },
    {
      name: "Finalized",
      type: {
        kind: "struct",
        fields: [
          { name: "seq", type: "u64" },
          { name: "rollover", type: "u64" },
        ],
      },
    },
    {
      name: "Claimed",
      type: {
        kind: "struct",
        fields: [
          { name: "user", type: "publicKey" },
          { name: "round", type: "publicKey" },
          { name: "payout", type: "u64" },
        ],
      },
    },
  ],
  events: [
    {
      name: "FundingRecorded",
      discriminator: Array.from(eventDiscriminator("FundingRecorded")),
    },
    {
      name: "RoundStarted",
      discriminator: Array.from(eventDiscriminator("RoundStarted")),
    },
    {
      name: "Burned",
      discriminator: Array.from(eventDiscriminator("Burned")),
    },
    {
      name: "Finalized",
      discriminator: Array.from(eventDiscriminator("Finalized")),
    },
    {
      name: "Claimed",
      discriminator: Array.from(eventDiscriminator("Claimed")),
    },
  ],
};

const normalizedIdl = normalizeIdl(MELT_IDL);
const idlForClient = {
  ...normalizedIdl,
  address: getMeltProgramId().toBase58(),
  instructions: (normalizedIdl.instructions ?? []).map((ix) => {
    const disc = (ix as { discriminator?: unknown }).discriminator;
    return {
      ...ix,
      discriminator: normalizeDiscriminator(ix.name, disc),
    };
  }),
  accounts: (normalizedIdl.accounts ?? []).map((acc) => ({
    ...acc,
    discriminator: accountDiscriminator(acc.name),
  })),
  events: normalizedIdl.events ?? [],
};

export function getMeltProgram(connection: Connection, wallet: AnchorWallet) {
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (anchor as any).Program(idlForClient, provider);
}

export async function fetchMiningMeltConfig(connection: Connection) {
  const miningProgramId = getMiningProgramId();
  if (!miningProgramId) return null;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], miningProgramId);
  const info = await connection.getAccountInfo(configPda, "confirmed");
  if (!info || info.data.length < 321) return null;
  const data = info.data;
  let offset = 8;

  offset += 32; // admin
  offset += 8; // emission_per_sec
  offset += 16; // acc_mind_per_hp
  offset += 8; // last_update_ts
  offset += 8; // network_hp_active
  offset += 32; // mind_mint
  offset += 32; // xnt_mint
  offset += 32; // staking_reward_vault
  offset += 32; // treasury_vault
  offset += 32; // staking_mind_vault
  offset += 8; // max_effective_hp
  offset += 8; // seconds_per_day
  offset += 16; // staking_acc_xnt_per_mind
  offset += 8; // staking_last_update_ts
  offset += 8; // staking_reward_rate_xnt_per_sec
  offset += 8; // staking_epoch_end_ts
  offset += 8; // staking_total_staked_mind
  offset += 8; // staking_undistributed_xnt
  offset += 8; // staking_accounted_balance
  if (offset + 1 > data.length) return null;
  const meltEnabled = data.readUInt8(offset) === 1;
  offset += 1;
  if (offset + 32 + 2 > data.length) return null;
  const meltProgramId = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const meltFundingBps = data.readUInt16LE(offset);
  return { meltEnabled, meltProgramId, meltFundingBps };
}
