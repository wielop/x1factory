export type DecodedMinerPosition = {
  owner: Uint8Array;
  hp: bigint;
  startTs: number;
  endTs: number;
  rewardDebt: bigint;
  finalAccMindPerHp: bigint;
  deactivated: boolean;
};

export type DecodedUserMiningProfile = {
  owner: Uint8Array;
  nextPositionIndex: bigint;
  activeHp: bigint;
  xp: bigint;
  badgeTier: number;
  badgeBonusBps: number;
  level: number;
  lastXpUpdateTs: number;
};

export type DecodedUserStake = {
  owner: Uint8Array;
  stakedMind: bigint;
  rewardDebt: bigint;
  rewardOwed: bigint;
};

const HP_SCALE = 100n;
const HP_SCALED_MARKER = 1n << 63n;

function assertMinLen(data: Buffer, min: number, label: string) {
  if (data.length < min) throw new Error(`${label} too small: ${data.length} bytes`);
}

function readU128LE(data: Buffer, offset: number): bigint {
  const lo = data.readBigUInt64LE(offset);
  const hi = data.readBigUInt64LE(offset + 8);
  return lo + (hi << 64n);
}

export const MINER_POSITION_LEN = 8 + 32 + 8 + 8 + 8 + 16 + 16 + 1 + 1;
export const USER_PROFILE_LEN_V1 = 8 + 32 + 8 + 8 + 8 + 1 + 2 + 1;
export const USER_PROFILE_LEN_V2 = USER_PROFILE_LEN_V1 + 1 + 8;
export const USER_STAKE_LEN = 8 + 32 + 8 + 16 + 8 + 1;

export function decodeMinerPositionAccount(data: Buffer): DecodedMinerPosition {
  assertMinLen(data, MINER_POSITION_LEN, "MinerPosition");
  let offset = 8;
  const owner = data.subarray(offset, offset + 32);
  offset += 32;
  let hp = data.readBigUInt64LE(offset);
  offset += 8;
  const startTs = Number(data.readBigInt64LE(offset));
  offset += 8;
  const endTs = Number(data.readBigInt64LE(offset));
  offset += 8;
  const rewardDebt = readU128LE(data, offset);
  offset += 16;
  const finalAccMindPerHp = readU128LE(data, offset);
  offset += 16;
  const deactivated = data.readUInt8(offset) !== 0;
  if (deactivated) {
    if (hp & HP_SCALED_MARKER) {
      hp = hp & ~HP_SCALED_MARKER;
    } else {
      hp = hp * HP_SCALE;
    }
  }
  return { owner, hp, startTs, endTs, rewardDebt, finalAccMindPerHp, deactivated };
}

export function decodeUserMiningProfileAccount(data: Buffer): DecodedUserMiningProfile {
  assertMinLen(data, USER_PROFILE_LEN_V1, "UserMiningProfile");
  let offset = 8;
  const owner = data.subarray(offset, offset + 32);
  offset += 32;
  const nextPositionIndex = data.readBigUInt64LE(offset);
  offset += 8;
  const activeHp = data.readBigUInt64LE(offset);
  offset += 8;
  const xp = data.readBigUInt64LE(offset);
  offset += 8;
  const badgeTier = data.readUInt8(offset);
  offset += 1;
  const badgeBonusBps = data.readUInt16LE(offset);
  offset += 2;
  offset += 1;
  let level = 1;
  let lastXpUpdateTs = 0;
  if (data.length >= USER_PROFILE_LEN_V2) {
    level = data.readUInt8(offset);
    offset += 1;
    lastXpUpdateTs = Number(data.readBigInt64LE(offset));
  }
  return {
    owner,
    nextPositionIndex,
    activeHp,
    xp,
    badgeTier,
    badgeBonusBps,
    level,
    lastXpUpdateTs,
  };
}

export function decodeUserStakeAccount(data: Buffer): DecodedUserStake {
  assertMinLen(data, USER_STAKE_LEN, "UserStake");
  let offset = 8;
  const owner = data.subarray(offset, offset + 32);
  offset += 32;
  const stakedMind = data.readBigUInt64LE(offset);
  offset += 8;
  const rewardDebt = readU128LE(data, offset);
  offset += 16;
  const rewardOwed = data.readBigUInt64LE(offset);
  return { owner, stakedMind, rewardDebt, rewardOwed };
}

export function tryDecodeUserStakeAccount(data: Buffer): DecodedUserStake | null {
  if (data.length < USER_STAKE_LEN) return null;
  try {
    return decodeUserStakeAccount(data);
  } catch {
    return null;
  }
}
