import * as anchor from "@coral-xyz/anchor";
import { sha256 } from "@noble/hashes/sha256";
import type { Connection } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import idl from "@/idl/mining_v2.json";
import { getProgramId } from "@/lib/solana";

// The IDL JSON in this repo does not include account sizes/types in `accounts`,
// which breaks Anchor's `program.account.*` helpers. We only use `.methods`.
const nonClientInstructions = ["initConfig"];

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

const normalizeDiscriminator = (name: string, discriminator: unknown) => {
  if (discriminator instanceof Uint8Array) return discriminator;
  if (Array.isArray(discriminator)) return Uint8Array.from(discriminator);
  return instructionDiscriminator(name);
};
const normalizedIdl = normalizeIdl(idl);
if (Array.isArray(normalizedIdl.instructions)) {
  const hasSyncProfile = normalizedIdl.instructions.some((ix) => ix.name === "syncProfile");
  if (!hasSyncProfile) {
    normalizedIdl.instructions.push({
      name: "syncProfile",
      accounts: [
        { name: "owner", writable: true, signer: true },
        { name: "config", writable: false, signer: false },
        { name: "userProfile", writable: true, signer: false },
        { name: "systemProgram", writable: false, signer: false },
      ],
      args: [],
    });
  }
}
const idlForClient = {
  ...normalizedIdl,
  // Ensure the Program ID matches the runtime config.
  address: getProgramId().toBase58(),
  instructions: (normalizedIdl.instructions ?? [])
    .filter((ix) => !nonClientInstructions.includes(ix.name))
    .map((ix) => {
      const disc = (ix as { discriminator?: unknown }).discriminator;
      return {
        ...ix,
        discriminator: normalizeDiscriminator(ix.name, disc),
      };
    }),
  accounts: [],
  events: [],
};

export function getProgram(connection: Connection, wallet: AnchorWallet) {
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  // Anchor v0.30+ Program constructor signature: `new Program(idl, provider, coder?, resolver?)`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (anchor as any).Program(idlForClient, provider);
}
