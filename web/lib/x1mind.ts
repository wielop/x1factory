import { PublicKey } from "@solana/web3.js";

export const DEFAULT_X1MIND_PROGRAM_ID = "7qH6rrAoNEp2oWmVurvqD9onVu1cCJcg7vLR6NigvkLz";
export const DEFAULT_X1MIND_MIND_MINT = "AJhe17P7jFTUgsTUJYxvTdqpND5RG1cr1SSXxLrG9QUc";

const CONFIG_SEED = "config";
const ROUND_SEED = "round";
const ENTRY_SEED = "entry";
const MIND_VAULT_AUTH_SEED = "mind_vault_auth";
const MOTHERLODE_VAULT_SEED = "motherlode_vault";

type X1MindEnv = { programId: PublicKey; mindMint: PublicKey };
let cachedEnv: X1MindEnv | null = null;

function assertX1MindEnv(): X1MindEnv {
  if (cachedEnv) return cachedEnv;
  const programIdStr = (process.env.NEXT_PUBLIC_X1MIND_PROGRAM_ID ?? DEFAULT_X1MIND_PROGRAM_ID).trim();
  const mindMintStr = (process.env.NEXT_PUBLIC_X1MIND_MIND_MINT ?? DEFAULT_X1MIND_MIND_MINT).trim();
  if (!programIdStr) {
    throw new Error("Missing NEXT_PUBLIC_X1MIND_PROGRAM_ID");
  }
  if (!mindMintStr) {
    throw new Error("Missing NEXT_PUBLIC_X1MIND_MIND_MINT");
  }
  let programId: PublicKey;
  let mindMint: PublicKey;
  try {
    programId = new PublicKey(programIdStr);
  } catch {
    throw new Error(`Invalid NEXT_PUBLIC_X1MIND_PROGRAM_ID: "${programIdStr}"`);
  }
  try {
    mindMint = new PublicKey(mindMintStr);
  } catch {
    throw new Error(`Invalid NEXT_PUBLIC_X1MIND_MIND_MINT: "${mindMintStr}"`);
  }
  cachedEnv = { programId, mindMint };
  return cachedEnv;
}

export function getX1MindProgramId() {
  return assertX1MindEnv().programId;
}

export function getX1MindMindMint() {
  return assertX1MindEnv().mindMint;
}

function toU64LE(value: bigint) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

export function deriveX1MindConfigPda() {
  return PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED)], getX1MindProgramId())[0];
}

export function deriveX1MindRoundPda(roundId: bigint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ROUND_SEED), toU64LE(roundId)],
    getX1MindProgramId()
  )[0];
}

export function deriveX1MindEntryPda(roundId: bigint, owner: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ENTRY_SEED), toU64LE(roundId), owner.toBuffer()],
    getX1MindProgramId()
  )[0];
}

export function deriveX1MindMindVaultAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(MIND_VAULT_AUTH_SEED)],
    getX1MindProgramId()
  )[0];
}

export function deriveX1MindMotherlodeVault() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(MOTHERLODE_VAULT_SEED)],
    getX1MindProgramId()
  )[0];
}
