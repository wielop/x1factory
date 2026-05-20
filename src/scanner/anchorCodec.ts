import { createHash } from "node:crypto";

import { PublicKey } from "@solana/web3.js";

import type { RigType } from "./types.js";

type DecoderCursor = {
  offset: number;
};

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map(BASE58_ALPHABET.split("").map((char, index) => [char, index]));

function discriminator(namespace: string, name: string): Buffer {
  return createHash("sha256")
    .update(`${namespace}:${name}`)
    .digest()
    .subarray(0, 8);
}

function toPascalCase(value: string): string {
  if (!value) {
    return value;
  }

  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

export function encodeAnchorDiscriminator(namespace: string, name: string): string {
  return discriminator(namespace, name).toString("hex");
}

export function decodeBase58(value: string): Buffer {
  if (!value) {
    return Buffer.alloc(0);
  }

  let bytes = [0];

  for (const char of value) {
    const carryBase = BASE58_MAP.get(char);

    if (carryBase == null) {
      throw new Error("Invalid base58 value.");
    }

    let carry = carryBase;

    for (let index = 0; index < bytes.length; index += 1) {
      const next = bytes[index] * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (const char of value) {
    if (char !== "1") {
      break;
    }

    bytes.push(0);
  }

  return Buffer.from(bytes.reverse());
}

function readPublicKey(buffer: Buffer, cursor: DecoderCursor): string {
  const value = new PublicKey(buffer.subarray(cursor.offset, cursor.offset + 32)).toBase58();
  cursor.offset += 32;
  return value;
}

function readBool(buffer: Buffer, cursor: DecoderCursor): boolean {
  const value = buffer.readUInt8(cursor.offset) !== 0;
  cursor.offset += 1;
  return value;
}

function readU8(buffer: Buffer, cursor: DecoderCursor): number {
  const value = buffer.readUInt8(cursor.offset);
  cursor.offset += 1;
  return value;
}

function readU16(buffer: Buffer, cursor: DecoderCursor): number {
  const value = buffer.readUInt16LE(cursor.offset);
  cursor.offset += 2;
  return value;
}

function readU64(buffer: Buffer, cursor: DecoderCursor): bigint {
  const value = buffer.readBigUInt64LE(cursor.offset);
  cursor.offset += 8;
  return value;
}

function readI64(buffer: Buffer, cursor: DecoderCursor): bigint {
  const value = buffer.readBigInt64LE(cursor.offset);
  cursor.offset += 8;
  return value;
}

function readU128(buffer: Buffer, cursor: DecoderCursor): bigint {
  const low = buffer.readBigUInt64LE(cursor.offset);
  const high = buffer.readBigUInt64LE(cursor.offset + 8);
  cursor.offset += 16;
  return low + (high << 64n);
}

function toNumber(value: bigint): number {
  return Number(value);
}

export function mindAtomicToDecimal(value: bigint): number {
  return Number(value) / 1_000_000_000;
}

export function rigTypeFromIndex(value: number): RigType | null {
  if (value === 0) {
    return "starter";
  }

  if (value === 1) {
    return "pro";
  }

  if (value === 2) {
    return "industrial";
  }

  return null;
}

export function decodeInstructionName(dataBase58: string, instructionNames: string[]): string | null {
  const data = decodeBase58(dataBase58);

  if (data.length < 8) {
    return null;
  }

  const signature = data.subarray(0, 8).toString("hex");

  for (const name of instructionNames) {
    if (
      signature === encodeAnchorDiscriminator("global", name) ||
      signature === encodeAnchorDiscriminator("global", toPascalCase(name)) ||
      signature === encodeAnchorDiscriminator("global", toSnakeCase(name))
    ) {
      return name;
    }
  }

  return null;
}

export function decodeBuyContractArgs(dataBase58: string): { contractType: number; positionIndex: number } {
  const data = decodeBase58(dataBase58);
  const cursor = { offset: 8 };

  return {
    contractType: readU8(data, cursor),
    positionIndex: toNumber(readU64(data, cursor))
  };
}

export function decodeStakeMindArgs(dataBase58: string): { amountAtomic: bigint } {
  const data = decodeBase58(dataBase58);
  const cursor = { offset: 8 };

  return {
    amountAtomic: readU64(data, cursor)
  };
}

export function decodeAnchorEvent(buffer: Buffer): { name: string; fields: Record<string, unknown> } | null {
  if (buffer.length < 8) {
    return null;
  }

  const signature = buffer.subarray(0, 8).toString("hex");
  const cursor = { offset: 8 };

  if (signature === encodeAnchorDiscriminator("event", "ContractPurchased")) {
    return {
      name: "ContractPurchased",
      fields: {
        owner: readPublicKey(buffer, cursor),
        hp: toNumber(readU64(buffer, cursor)),
        durationDays: toNumber(readU64(buffer, cursor)),
        costBase: toNumber(readU64(buffer, cursor))
      }
    };
  }

  if (signature === encodeAnchorDiscriminator("event", "MindClaimed")) {
    return {
      name: "MindClaimed",
      fields: {
        owner: readPublicKey(buffer, cursor),
        amountAtomic: readU64(buffer, cursor)
      }
    };
  }

  if (signature === encodeAnchorDiscriminator("event", "MindStaked")) {
    return {
      name: "MindStaked",
      fields: {
        owner: readPublicKey(buffer, cursor),
        amountAtomic: readU64(buffer, cursor)
      }
    };
  }

  return null;
}

export function decodeUserMiningProfileAccount(data: Buffer) {
  const cursor = { offset: 8 };

  return {
    owner: readPublicKey(data, cursor),
    nextPositionIndex: toNumber(readU64(data, cursor)),
    activeHp: toNumber(readU64(data, cursor)),
    buffedHp: toNumber(readU64(data, cursor)),
    buffedHpSynced: readBool(data, cursor),
    xp: toNumber(readU64(data, cursor)),
    badgeTier: readU8(data, cursor),
    badgeBonusBps: readU16(data, cursor),
    bump: readU8(data, cursor),
    level: readU8(data, cursor),
    lastXpUpdateTs: Number(readI64(data, cursor)),
    hpScaled: readBool(data, cursor),
    levelAccSnapshots: Array.from({ length: 7 }, () => readU128(data, cursor))
  };
}

export function decodeMinerPositionAccount(data: Buffer) {
  const cursor = { offset: 8 };
  const rigTypeValue = readU8(data, cursor);

  return {
    owner: readPublicKey(data, cursor),
    hp: toNumber(readU64(data, { offset: 8 + 32 })),
    startTs: Number(data.readBigInt64LE(48)),
    endTs: Number(data.readBigInt64LE(56)),
    rewardDebt: (() => {
      const local = { offset: 64 };
      return readU128(data, local);
    })(),
    finalAccMindPerHp: (() => {
      const local = { offset: 80 };
      return readU128(data, local);
    })(),
    deactivated: data.readUInt8(96) !== 0,
    bump: data.readUInt8(97),
    rigType: rigTypeFromIndex(rigTypeValue),
    buffLevel: data.readUInt8(99),
    hpScaled: data.readUInt8(100) !== 0,
    expired: data.readUInt8(101) !== 0,
    buffAppliedFromCycle: Number(data.readBigUInt64LE(102)),
    lastLevelApplied: data.readUInt8(110)
  };
}

export function decodeMinerPositionAccountSafe(data: Buffer) {
  const cursor = { offset: 8 };
  const owner = readPublicKey(data, cursor);
  const hp = toNumber(readU64(data, cursor));
  const startTs = Number(readI64(data, cursor));
  const endTs = Number(readI64(data, cursor));
  readU128(data, cursor);
  readU128(data, cursor);
  const deactivated = readBool(data, cursor);
  readU8(data, cursor);
  const rigType = rigTypeFromIndex(readU8(data, cursor));
  readU8(data, cursor);
  readBool(data, cursor);
  const expired = readBool(data, cursor);
  readU64(data, cursor);
  readU8(data, cursor);

  return {
    owner,
    hp,
    startTs,
    endTs,
    deactivated,
    expired,
    rigType
  };
}

export function decodeUserStakeAccount(data: Buffer) {
  const cursor = { offset: 8 };

  return {
    owner: readPublicKey(data, cursor),
    stakedMind: mindAtomicToDecimal(readU64(data, cursor)),
    rewardDebt: readU128(data, cursor),
    rewardOwed: mindAtomicToDecimal(readU64(data, cursor)),
    bump: readU8(data, cursor)
  };
}

export function isExpectedAccountDiscriminator(data: Buffer, accountName: string): boolean {
  if (data.length < 8) {
    return false;
  }

  return data.subarray(0, 8).equals(discriminator("account", accountName));
}
