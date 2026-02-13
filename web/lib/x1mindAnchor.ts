import * as anchor from "@coral-xyz/anchor";
import { sha256 } from "@noble/hashes/sha256";
import type { Connection } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import idl from "@/idl/x1mind.json";
import { getX1MindProgramId } from "@/lib/x1mind";

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

const normalizeDiscriminator = (name: string, discriminator: unknown) => {
  if (discriminator instanceof Uint8Array) return discriminator;
  if (Array.isArray(discriminator)) return Uint8Array.from(discriminator);
  return instructionDiscriminator(name);
};

const normalizeAccountDiscriminator = (name: string, discriminator: unknown) => {
  if (discriminator instanceof Uint8Array) return discriminator;
  if (Array.isArray(discriminator)) return Uint8Array.from(discriminator);
  return accountDiscriminator(name);
};

const withAccountTypes = (idlValue: anchor.Idl): anchor.Idl => {
  const types = [...(idlValue.types ?? [])];
  const typeNames = new Set(types.map((typeDef) => typeDef.name));
  for (const account of idlValue.accounts ?? []) {
    const accountDef = account as { name: string; type?: unknown };
    if (!accountDef.type) continue;
    if (!typeNames.has(accountDef.name)) {
      types.push({ name: accountDef.name, type: accountDef.type as any });
      typeNames.add(accountDef.name);
    }
  }
  return { ...idlValue, types };
};

const normalizedIdl = normalizeIdl(idl);
const normalizedWithTypes = withAccountTypes(normalizedIdl);
const idlForClient = {
  ...normalizedWithTypes,
  address: getX1MindProgramId().toBase58(),
  instructions: (normalizedWithTypes.instructions ?? []).map((ix) => {
    const disc = (ix as { discriminator?: unknown }).discriminator;
    return {
      ...ix,
      discriminator: normalizeDiscriminator(ix.name, disc),
    };
  }),
  accounts: (normalizedWithTypes.accounts ?? []).map((account) => {
    const disc = (account as { discriminator?: unknown }).discriminator;
    return {
      ...account,
      discriminator: normalizeAccountDiscriminator(account.name, disc),
    };
  }),
  events: normalizedWithTypes.events ?? [],
};

export function getX1MindProgram(connection: Connection, wallet: AnchorWallet) {
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (anchor as any).Program(idlForClient, provider);
}
