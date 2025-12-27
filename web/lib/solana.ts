import { PublicKey, type Connection } from "@solana/web3.js";

export const DEFAULT_RPC_URL = "https://rpc.testnet.x1.xyz";
export const DEFAULT_PROGRAM_ID = "uaDkkJGLLEY3kFMhhvrh5MZJ6fmwCmhNf8L7BZQJ9Aw";

const CONFIG_SEED = "config";
const LEVEL_CONFIG_SEED = "level_config";
const VAULT_SEED = "vault";
const STAKING_REWARD_VAULT_SEED = "staking_reward_vault";
const TREASURY_VAULT_SEED = "treasury_vault";
const POSITION_SEED = "position";
const PROFILE_SEED = "profile";
const STAKE_SEED = "stake";

type EnvCache = { rpcUrl: string; programId: PublicKey };
let cachedEnv: EnvCache | null = null;

export function assertEnv(): EnvCache {
  if (cachedEnv) return cachedEnv;
  const rpcUrl = (process.env.NEXT_PUBLIC_RPC_URL ?? DEFAULT_RPC_URL).trim();
  if (!rpcUrl) {
    throw new Error("Missing NEXT_PUBLIC_RPC_URL. Set it in Vercel Environment Variables.");
  }
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new Error(`Invalid NEXT_PUBLIC_RPC_URL: "${rpcUrl}"`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`NEXT_PUBLIC_RPC_URL must be https, got "${parsed.protocol}"`);
  }
  const programIdStr = (process.env.NEXT_PUBLIC_PROGRAM_ID ?? DEFAULT_PROGRAM_ID).trim();
  if (!programIdStr) {
    throw new Error("Missing NEXT_PUBLIC_PROGRAM_ID. Set it in Vercel Environment Variables.");
  }
  let programId: PublicKey;
  try {
    programId = new PublicKey(programIdStr);
  } catch {
    throw new Error(`Invalid NEXT_PUBLIC_PROGRAM_ID: "${programIdStr}"`);
  }
  cachedEnv = { rpcUrl, programId };
  return cachedEnv;
}

export function getRpcUrl() {
  return assertEnv().rpcUrl;
}

export function getProgramId() {
  return assertEnv().programId;
}

export function rpcUrl() {
  return getRpcUrl();
}

const HEALTH_TIMEOUT_MS = 6_000;

type HealthResult =
  | { ok: true; url: string; method: "getHealth" | "getSlot" }
  | { ok: false; url: string; error: string };

async function postRpc(url: string, method: string, signal?: AbortSignal) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] });
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal,
  });
  if (!res.ok) {
    throw new Error(`RPC HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json?.error) {
    throw new Error(`RPC error: ${json.error.message ?? "unknown"}`);
  }
  return json?.result;
}

async function postRpcWithTimeout(url: string, method: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    await postRpc(url, method, controller.signal);
    return { ok: true as const };
  } catch (err: unknown) {
    return { ok: false as const, error: err };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkRpcHealth(url = getRpcUrl()): Promise<HealthResult> {
  const health = await postRpcWithTimeout(url, "getHealth");
  if (health.ok) {
    return { ok: true, url, method: "getHealth" };
  }
  const msg = health.error instanceof Error ? health.error.message : String(health.error);
  const isTimeout = health.error instanceof Error && health.error.name === "AbortError";
  const hinted = msg.includes("Failed to fetch")
    ? `${msg} (possible CORS or network error)`
    : isTimeout
    ? `${msg} (timeout after ${HEALTH_TIMEOUT_MS}ms)`
    : msg;

  const fallback = await postRpcWithTimeout(url, "getSlot");
  if (fallback.ok) {
    return { ok: true, url, method: "getSlot" };
  }
  const fallbackMsg = fallback.error instanceof Error ? fallback.error.message : String(fallback.error);
  return {
    ok: false,
    url,
    error: `RPC healthcheck failed for ${url}: ${hinted}. Fallback getSlot failed: ${fallbackMsg}`,
  };
}

export const deriveConfigPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED)], getProgramId())[0];

export const deriveLevelConfigPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from(LEVEL_CONFIG_SEED)], getProgramId())[0];

export const deriveVaultPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from(VAULT_SEED)], getProgramId())[0];

export const deriveStakingRewardVaultPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from(STAKING_REWARD_VAULT_SEED)], getProgramId())[0];

export const deriveTreasuryVaultPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from(TREASURY_VAULT_SEED)], getProgramId())[0];

export const derivePositionPda = (owner: PublicKey, positionIndex: bigint | number) => {
  const idx = typeof positionIndex === "bigint" ? positionIndex : BigInt(positionIndex);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(idx);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(POSITION_SEED), owner.toBuffer(), buf],
    getProgramId()
  )[0];
};

export const deriveUserProfilePda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from(PROFILE_SEED), owner.toBuffer()], getProgramId())[0];

export const deriveUserStakePda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from(STAKE_SEED), owner.toBuffer()], getProgramId())[0];

export type DecodedConfig = {
  admin: PublicKey;
  emissionPerSec: bigint;
  accMindPerHp: bigint;
  lastUpdateTs: number;
  networkHpActive: bigint;
  mindMint: PublicKey;
  xntMint: PublicKey;
  stakingRewardVault: PublicKey;
  treasuryVault: PublicKey;
  stakingMindVault: PublicKey;
  maxEffectiveHp: bigint;
  secondsPerDay: bigint;
  stakingAccXntPerMind: bigint;
  stakingLastUpdateTs: number;
  stakingRewardRateXntPerSec: bigint;
  stakingEpochEndTs: number;
  stakingTotalStakedMind: bigint;
  stakingUndistributedXnt: bigint;
  stakingAccountedBalance: bigint;
  bumps: { config: number; vaultAuthority: number };
};

export type DecodedLevelConfig = {
  admin: PublicKey;
  mindMint: PublicKey;
  mindBurnVault: PublicKey;
  mindTreasuryVault: PublicKey;
  bump: number;
};

export async function fetchClockUnixTs(connection: Connection) {
  const info = await connection.getAccountInfo(
    new PublicKey("SysvarC1ock11111111111111111111111111111111"),
    "confirmed"
  );
  if (!info) throw new Error("Clock sysvar unavailable");
  return Number(info.data.readBigInt64LE(32));
}

function readU128LE(data: Buffer, offset: number): bigint {
  const lo = data.readBigUInt64LE(offset);
  const hi = data.readBigUInt64LE(offset + 8);
  return lo + (hi << 64n);
}

export async function fetchConfig(connection: Connection): Promise<DecodedConfig> {
  const configPda = deriveConfigPda();
  const info = await connection.getAccountInfo(configPda, "confirmed");
  if (!info) {
    throw new Error(`Config not found: ${configPda.toBase58()}`);
  }
  const data = info.data;
  if (data.length < 8) {
    throw new Error(`Config account too small: ${data.length} bytes`);
  }
  let offset = 8;
  const ensure = (size: number, label: string) => {
    if (offset + size > data.length) {
      throw new Error(
        `Config layout mismatch: need ${offset + size} bytes for ${label}, got ${data.length}. ` +
          "Check NEXT_PUBLIC_PROGRAM_ID and IDL/version."
      );
    }
  };
  const readPubkey = () => {
    ensure(32, "pubkey");
    const pk = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    return pk;
  };
  const readU8 = () => {
    ensure(1, "u8");
    return data.readUInt8(offset++);
  };
  const readU64 = () => {
    ensure(8, "u64");
    const v = data.readBigUInt64LE(offset);
    offset += 8;
    return v;
  };
  const readI64 = () => {
    ensure(8, "i64");
    const v = data.readBigInt64LE(offset);
    offset += 8;
    return Number(v);
  };
  const readU128 = () => {
    ensure(16, "u128");
    const v = readU128LE(data, offset);
    offset += 16;
    return v;
  };

  const admin = readPubkey();
  const emissionPerSec = readU64();
  const accMindPerHp = readU128();
  const lastUpdateTs = readI64();
  const networkHpActive = readU64();
  const mindMint = readPubkey();
  const xntMint = readPubkey();
  const stakingRewardVault = readPubkey();
  const treasuryVault = readPubkey();
  const stakingMindVault = readPubkey();
  const maxEffectiveHp = readU64();
  const secondsPerDay = readU64();
  const stakingAccXntPerMind = readU128();
  const stakingLastUpdateTs = readI64();
  const stakingRewardRateXntPerSec = readU64();
  const stakingEpochEndTs = readI64();
  const stakingTotalStakedMind = readU64();
  const stakingUndistributedXnt = readU64();
  const stakingAccountedBalance = readU64();
  const configBump = readU8();
  const vaultAuthorityBump = readU8();

  return {
    admin,
    emissionPerSec,
    accMindPerHp,
    lastUpdateTs,
    networkHpActive,
    mindMint,
    xntMint,
    stakingRewardVault,
    treasuryVault,
    stakingMindVault,
    maxEffectiveHp,
    secondsPerDay,
    stakingAccXntPerMind,
    stakingLastUpdateTs,
    stakingRewardRateXntPerSec,
    stakingEpochEndTs,
    stakingTotalStakedMind,
    stakingUndistributedXnt,
    stakingAccountedBalance,
    bumps: { config: configBump, vaultAuthority: vaultAuthorityBump },
  };
}

export async function fetchLevelConfig(connection: Connection): Promise<DecodedLevelConfig> {
  const levelConfigPda = deriveLevelConfigPda();
  const info = await connection.getAccountInfo(levelConfigPda, "confirmed");
  if (!info) {
    throw new Error(`Level config not found: ${levelConfigPda.toBase58()}`);
  }
  const data = info.data;
  const minSize = 8 + 32 * 4 + 1;
  if (data.length < minSize) {
    throw new Error(`Level config too small: ${data.length} bytes`);
  }
  let offset = 8;
  const admin = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const mindMint = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const mindBurnVault = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const mindTreasuryVault = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const bump = data.readUInt8(offset);
  return { admin, mindMint, mindBurnVault, mindTreasuryVault, bump };
}
