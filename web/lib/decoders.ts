export type DecodedMinerPosition = {
  owner: Uint8Array;
  hp: bigint;
  startTs: number;
  endTs: number;
  rewardDebt: bigint;
  finalAccMindPerHp: bigint;
  deactivated: boolean;
  rigType: number;
  buffLevel: number;
  hpScaled: boolean;
  expired: boolean;
  buffAppliedFromCycle: bigint;
  lastLevelApplied?: number;
};

export type DecodedUserMiningProfile = {
  owner: Uint8Array;
  nextPositionIndex: bigint;
  activeHp: bigint;
  buffedHp?: bigint;
  buffedHpSynced?: boolean;
  xp: bigint;
  badgeTier: number;
  badgeBonusBps: number;
  level: number;
  lastXpUpdateTs: number;
  hpScaled: boolean;
  levelAccSnapshots?: bigint[];
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

export const MINER_POSITION_LEN_V1 = 8 + 32 + 8 + 8 + 8 + 16 + 16 + 1 + 1;
export const MINER_POSITION_LEN_V2 = MINER_POSITION_LEN_V1 + 1 + 1 + 1 + 1 + 8;
export const MINER_POSITION_LEN_V3 = MINER_POSITION_LEN_V2 + 1;
export const USER_PROFILE_LEN_V1 = 8 + 32 + 8 + 8 + 8 + 1 + 2 + 1;
export const USER_PROFILE_LEN_V2 = USER_PROFILE_LEN_V1 + 1 + 8;
export const USER_PROFILE_LEN_V3 = USER_PROFILE_LEN_V2 + 1;
export const USER_PROFILE_LEN_V4 = USER_PROFILE_LEN_V3 + 8 + 1 + 112;
export const USER_STAKE_LEN = 8 + 32 + 8 + 16 + 8 + 1;

export function decodeMinerPositionAccount(data: Buffer): DecodedMinerPosition {
  assertMinLen(data, MINER_POSITION_LEN_V1, "MinerPosition");
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
  offset += 1;
  offset += 1;
  let rigType = 0;
  let buffLevel = 0;
  let hpScaled = false;
  let expired = false;
  let buffAppliedFromCycle = 0n;
  let lastLevelApplied: number | undefined;
  if (data.length >= MINER_POSITION_LEN_V2) {
    rigType = data.readUInt8(offset);
    offset += 1;
    buffLevel = data.readUInt8(offset);
    offset += 1;
    hpScaled = data.readUInt8(offset) !== 0;
    offset += 1;
    expired = data.readUInt8(offset) !== 0;
    offset += 1;
    buffAppliedFromCycle = data.readBigUInt64LE(offset);
    offset += 8;
  }
  if (data.length >= MINER_POSITION_LEN_V3) {
    lastLevelApplied = data.readUInt8(offset);
    offset += 1;
  }
  if (deactivated) {
    if (hp & HP_SCALED_MARKER) {
      hp = hp & ~HP_SCALED_MARKER;
    } else {
      hp = hp * HP_SCALE;
    }
  } else if (!hpScaled) {
    hp = hp * HP_SCALE;
  }
  return {
    owner,
    hp,
    startTs,
    endTs,
    rewardDebt,
    finalAccMindPerHp,
    deactivated,
    rigType,
    buffLevel,
    hpScaled,
    expired,
    buffAppliedFromCycle,
    lastLevelApplied,
  };
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
  let buffedHp: bigint | undefined;
  let buffedHpSynced: boolean | undefined;
  if (data.length >= USER_PROFILE_LEN_V4) {
    buffedHp = data.readBigUInt64LE(offset);
    offset += 8;
    buffedHpSynced = data.readUInt8(offset) !== 0;
    offset += 1;
  }
  const xp = data.readBigUInt64LE(offset);
  offset += 8;
  const badgeTier = data.readUInt8(offset);
  offset += 1;
  const badgeBonusBps = data.readUInt16LE(offset);
  offset += 2;
  offset += 1;
  let level = 1;
  let lastXpUpdateTs = 0;
  let hpScaled = false;
  let levelAccSnapshots: bigint[] | undefined;
  if (data.length >= USER_PROFILE_LEN_V2) {
    level = data.readUInt8(offset);
    offset += 1;
    lastXpUpdateTs = Number(data.readBigInt64LE(offset));
    offset += 8;
  }
  if (data.length >= USER_PROFILE_LEN_V3 && data.length < USER_PROFILE_LEN_V4) {
    hpScaled = data.readUInt8(offset) !== 0;
    offset += 1;
  } else if (data.length >= USER_PROFILE_LEN_V4) {
    hpScaled = data.readUInt8(offset) !== 0;
    offset += 1;
    levelAccSnapshots = [];
    for (let i = 0; i < 7; i += 1) {
      levelAccSnapshots.push(readU128LE(data, offset));
      offset += 16;
    }
  }
  return {
    owner,
    nextPositionIndex,
    activeHp,
    buffedHp,
    buffedHpSynced,
    xp,
    badgeTier,
    badgeBonusBps,
    level,
    lastXpUpdateTs,
    hpScaled,
    levelAccSnapshots,
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
