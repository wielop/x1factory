import { PublicKey, type Connection } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

export const DEFAULT_RPC_URL = "https://rpc.testnet.x1.xyz";
export const DEFAULT_PROGRAM_ID = "2oJ68QPvNqvdegxPczqGYz7bmTyBSW9D6ZYs4w1HSpL9";

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
  PublicKey.findProgramAddressSync([Buffer.from("config")], getProgramId())[0];

export const deriveVaultPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from("vault")], getProgramId())[0];

export const derivePositionPda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("position"), owner.toBuffer()], getProgramId())[0];

export const derivePositionPdaV2 = (owner: PublicKey, positionIndex: bigint | number) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      owner.toBuffer(),
      new BN(positionIndex).toArrayLike(Buffer, "le", 8),
    ],
    getProgramId()
  )[0];

export const deriveUserProfilePda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("profile"), owner.toBuffer()], getProgramId())[0];

export const deriveEpochPda = (epochIndex: number) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("epoch"), new BN(epochIndex).toArrayLike(Buffer, "le", 8)],
    getProgramId()
  )[0];

export const deriveUserEpochPda = (owner: PublicKey, epochIndex: number) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from("user_epoch"),
      owner.toBuffer(),
      new BN(epochIndex).toArrayLike(Buffer, "le", 8),
    ],
    getProgramId()
  )[0];

export type DecodedConfig = {
  admin: PublicKey;
  xntMint: PublicKey;
  mindMint: PublicKey;
  vaultXntAta: PublicKey;
  stakingVaultXntAta: PublicKey;
  mindDecimals: number;
  xntDecimals: number;
  dailyEmissionInitial: BN;
  dailyEmissionCurrent: BN;
  epochSeconds: BN;
  softHalvingPeriodDays: BN;
  softHalvingBpsDrop: number;
  emissionStartTs: BN;
  lastEpochTs: BN;
  minedTotal: BN;
  minedCap: BN;
  totalSupplyMind: BN;
  mpCapBpsPerWallet: number;
  th1: BN;
  th2: BN;
  allowEpochSecondsEdit: boolean;
  stakingVaultMindAta: PublicKey;
  xpPer7d: BN;
  xpPer14d: BN;
  xpPer30d: BN;
  xpTierSilver: BN;
  xpTierGold: BN;
  xpTierDiamond: BN;
  xpBoostSilverBps: number;
  xpBoostGoldBps: number;
  xpBoostDiamondBps: number;
  totalStakedMind: BN;
  totalXp: BN;
  mindReward7d: BN;
  mindReward14d: BN;
  mindReward28d: BN;
  bumps: { config: number; vaultAuthority: number };
};

export async function fetchClockUnixTs(connection: Connection) {
  const info = await connection.getAccountInfo(
    // SYSVAR_CLOCK_PUBKEY
    new PublicKey("SysvarC1ock11111111111111111111111111111111"),
    "confirmed"
  );
  if (!info) throw new Error("Clock sysvar unavailable");
  return Number(info.data.readBigInt64LE(32));
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
  if (data.length === 233) {
    return decodeConfigLegacy(data);
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
  const readBool = () => {
    ensure(1, "bool");
    return data.readUInt8(offset++) !== 0;
  };
  const readU16 = () => {
    ensure(2, "u16");
    const v = data.readUInt16LE(offset);
    offset += 2;
    return v;
  };
  const readU64 = () => {
    ensure(8, "u64");
    const v = data.readBigUInt64LE(offset);
    offset += 8;
    return new BN(v.toString());
  };
  const readI64 = () => {
    ensure(8, "i64");
    const v = data.readBigInt64LE(offset);
    offset += 8;
    return new BN(v.toString());
  };
  const readU128 = () => {
    ensure(16, "u128");
    const lo = data.readBigUInt64LE(offset);
    const hi = data.readBigUInt64LE(offset + 8);
    offset += 16;
    const loBn = new BN(lo.toString());
    const hiBn = new BN(hi.toString());
    hiBn.iushln(64);
    return hiBn.iadd(loBn);
  };

  const admin = readPubkey();
  const xntMint = readPubkey();
  const mindMint = readPubkey();
  const vaultXntAta = readPubkey();
  const stakingVaultXntAta = readPubkey();
  const mindDecimals = readU8();
  const xntDecimals = readU8();
  const dailyEmissionInitial = readU64();
  const dailyEmissionCurrent = readU64();
  const epochSeconds = readU64();
  const softHalvingPeriodDays = readU64();
  const softHalvingBpsDrop = readU16();
  const emissionStartTs = readI64();
  const lastEpochTs = readI64();
  const minedTotal = readU64();
  const minedCap = readU64();
  const totalSupplyMind = readU64();
  const mpCapBpsPerWallet = readU16();
  const th1 = readU64();
  const th2 = readU64();
  const allowEpochSecondsEdit = readBool();
  const stakingVaultMindAta = readPubkey();
  const xpPer7d = readU64();
  const xpPer14d = readU64();
  const xpPer30d = readU64();
  const xpTierSilver = readU64();
  const xpTierGold = readU64();
  const xpTierDiamond = readU64();
  const xpBoostSilverBps = readU16();
  const xpBoostGoldBps = readU16();
  const xpBoostDiamondBps = readU16();
  const totalStakedMind = readU64();
  const totalXp = readU128();
  const canReadRewards = offset + 24 <= data.length;
  const mindReward7d = canReadRewards ? readU64() : new BN(0);
  const mindReward14d = canReadRewards ? readU64() : new BN(0);
  const mindReward28d = canReadRewards ? readU64() : new BN(0);
  // bumps: 2x u8
  const bumpConfig = readU8();
  const bumpVault = readU8();

  return {
    admin,
    xntMint,
    mindMint,
    vaultXntAta,
    stakingVaultXntAta,
    mindDecimals,
    xntDecimals,
    dailyEmissionInitial,
    dailyEmissionCurrent,
    epochSeconds,
    softHalvingPeriodDays,
    softHalvingBpsDrop,
    emissionStartTs,
    lastEpochTs,
    minedTotal,
    minedCap,
    totalSupplyMind,
    mpCapBpsPerWallet,
    th1,
    th2,
    allowEpochSecondsEdit,
    stakingVaultMindAta,
    xpPer7d,
    xpPer14d,
    xpPer30d,
    xpTierSilver,
    xpTierGold,
    xpTierDiamond,
    xpBoostSilverBps,
    xpBoostGoldBps,
    xpBoostDiamondBps,
    totalStakedMind,
    totalXp,
    mindReward7d,
    mindReward14d,
    mindReward28d,
    bumps: { config: bumpConfig, vaultAuthority: bumpVault },
  };
}

function decodeConfigLegacy(data: Buffer): DecodedConfig {
  // Legacy layout (233 bytes total). No staking vault + XP fields.
  let offset = 8;
  const ensure = (size: number, label: string) => {
    if (offset + size > data.length) {
      throw new Error(
        `Config legacy layout mismatch: need ${offset + size} bytes for ${label}, got ${data.length}.`
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
  const readBool = () => {
    ensure(1, "bool");
    return data.readUInt8(offset++) !== 0;
  };
  const readU16 = () => {
    ensure(2, "u16");
    const v = data.readUInt16LE(offset);
    offset += 2;
    return v;
  };
  const readU64 = () => {
    ensure(8, "u64");
    const v = data.readBigUInt64LE(offset);
    offset += 8;
    return new BN(v.toString());
  };
  const readI64 = () => {
    ensure(8, "i64");
    const v = data.readBigInt64LE(offset);
    offset += 8;
    return new BN(v.toString());
  };

  const admin = readPubkey();
  const xntMint = readPubkey();
  const mindMint = readPubkey();
  const vaultXntAta = readPubkey();
  const mindDecimals = readU8();
  const xntDecimals = readU8();
  const dailyEmissionInitial = readU64();
  const dailyEmissionCurrent = readU64();
  const epochSeconds = readU64();
  const softHalvingPeriodDays = readU64();
  const softHalvingBpsDrop = readU16();
  const emissionStartTs = readI64();
  const lastEpochTs = readI64();
  const minedTotal = readU64();
  const minedCap = readU64();
  const totalSupplyMind = readU64();
  const mpCapBpsPerWallet = readU16();
  const th1 = readU64();
  const th2 = readU64();
  const allowEpochSecondsEdit = readBool();
  const bumpConfig = readU8();
  const bumpVault = readU8();

  const zero = new BN(0);
  return {
    admin,
    xntMint,
    mindMint,
    vaultXntAta,
    stakingVaultXntAta: vaultXntAta,
    mindDecimals,
    xntDecimals,
    dailyEmissionInitial,
    dailyEmissionCurrent,
    epochSeconds,
    softHalvingPeriodDays,
    softHalvingBpsDrop,
    emissionStartTs,
    lastEpochTs,
    minedTotal,
    minedCap,
    totalSupplyMind,
    mpCapBpsPerWallet,
    th1,
    th2,
    allowEpochSecondsEdit,
    stakingVaultMindAta: vaultXntAta,
    xpPer7d: zero,
    xpPer14d: zero,
    xpPer30d: zero,
    xpTierSilver: zero,
    xpTierGold: zero,
    xpTierDiamond: zero,
    xpBoostSilverBps: 0,
    xpBoostGoldBps: 0,
    xpBoostDiamondBps: 0,
    totalStakedMind: zero,
    totalXp: zero,
    mindReward7d: zero,
    mindReward14d: zero,
    mindReward28d: zero,
    bumps: { config: bumpConfig, vaultAuthority: bumpVault },
  };
}

export function getCurrentEpochFrom(cfg: Pick<DecodedConfig, "epochSeconds" | "emissionStartTs">, nowTs: number) {
  return Math.floor(
    (nowTs - cfg.emissionStartTs.toNumber()) / cfg.epochSeconds.toNumber()
  );
}

export async function fetchTokenBalanceUi(connection: Connection, ata: PublicKey) {
  try {
    const bal = await connection.getTokenAccountBalance(ata, "confirmed");
    return bal.value.uiAmountString ?? "0";
  } catch {
    return "0";
  }
}

export const deriveStakingPositionPda = (
  owner: PublicKey,
  stakeIndex: bigint | number
) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from("stake"),
      owner.toBuffer(),
      new BN(stakeIndex).toArrayLike(Buffer, "le", 8),
    ],
    getProgramId()
  )[0];
