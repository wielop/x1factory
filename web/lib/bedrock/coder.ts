import * as anchor from "@coral-xyz/anchor";
import { sha256 } from "@noble/hashes/sha256";
import claimsIdlRaw from "@/idl/bedrock/claims_v1.json";

// claims_v1.json wyszedl z `anchor build` na Anchor 0.28 (stary format IDL:
// isMut/isSigner, "publicKey" zamiast "pubkey", {defined: "Name"} zamiast
// {defined: {name: "Name", generics: []}}, BRAK jawnych discriminator[] na
// instrukcjach/kontach, definicje pol kont embedded w accounts[].type zamiast
// osobno w types[]). @coral-xyz/anchor 0.30 (uzywany w tym repo, ten sam
// wzorzec co lib/anchor.ts dla mining_v2.json) wymaga nowego formatu wszedzie
// naraz - bez tego BorshCoder rzuca rozne bledy w zaleznosci od tego co
// dotknie pierwsze ("Expected Buffer", "Account not found", "Cannot use 'in'
// operator..."). Naprawiamy wszystko tu, rownolegle do lib/anchor.ts.
type Any = Record<string, unknown>;

const toSnakeCase = (value: string) =>
  value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();

const instructionDiscriminator = (name: string): number[] =>
  Array.from(sha256(`global:${toSnakeCase(name)}`).slice(0, 8));

const accountDiscriminator = (name: string): number[] =>
  Array.from(sha256(`account:${name}`).slice(0, 8));

function fixDefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fixDefined);
  if (value && typeof value === "object") {
    const record = value as Any;
    if (typeof record.defined === "string") {
      record.defined = { name: record.defined, generics: [] };
    }
    for (const key of Object.keys(record)) {
      record[key] = fixDefined(record[key]);
    }
    return record;
  }
  if (value === "publicKey") return "pubkey";
  return value;
}

function normalizeIdl(raw: unknown): anchor.Idl {
  const clone = fixDefined(JSON.parse(JSON.stringify(raw))) as Any;

  const instructions = (clone.instructions as Any[] | undefined) ?? [];
  for (const ix of instructions) {
    if (!ix.discriminator) ix.discriminator = instructionDiscriminator(ix.name as string);
  }

  const accounts = (clone.accounts as Any[] | undefined) ?? [];
  const types = (clone.types as Any[] | undefined) ?? (clone.types = []);
  const typeNames = new Set((types as Any[]).map((t) => t.name as string));
  for (const acc of accounts) {
    if (!acc.discriminator) acc.discriminator = accountDiscriminator(acc.name as string);
    // Anchor 0.30 BorshAccountsCoder resolves kazde konto przez idl.types (po
    // nazwie), nie przez acc.type embedded bezposrednio (0.28 robil to tak).
    if (!typeNames.has(acc.name as string) && acc.type) {
      (types as Any[]).push({ name: acc.name, type: acc.type });
      typeNames.add(acc.name as string);
    }
  }

  return clone as unknown as anchor.Idl;
}

const claimsIdl = normalizeIdl(claimsIdlRaw);

// Leniwa inicjalizacja - BorshCoder konstruowany PRZY PIERWSZYM realnym
// wywolaniu (nie na module scope), zeby ominac crash Next.js podczas
// "Collecting page data" (build-time execution modulu bez pelnych natywnych
// bigint bindingow).
let _coder: anchor.BorshCoder | null = null;
function getCoder(): anchor.BorshCoder {
  if (!_coder) _coder = new anchor.BorshCoder(claimsIdl);
  return _coder;
}

export function encodeClaimsIx(name: string, args: Record<string, unknown>): Buffer {
  return getCoder().instruction.encode(name, args);
}

export function decodeClaimsAccount<T = unknown>(accountName: string, data: Buffer): T {
  return getCoder().accounts.decode(accountName, data) as T;
}

export function tryDecodeClaimsAccount<T = unknown>(accountName: string, data: Buffer): T | null {
  try {
    return getCoder().accounts.decode(accountName, data) as T;
  } catch {
    return null;
  }
}
