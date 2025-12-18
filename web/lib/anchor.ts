import * as anchor from "@coral-xyz/anchor";
import type { Connection } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import idl from "@/idl/pocm_vault_mining.json";
import { PROGRAM_ID } from "@/lib/solana";

// The IDL JSON in this repo does not include account sizes/types in `accounts`,
// which breaks Anchor's `program.account.*` helpers. We only use `.methods`.
const idlForClient = {
  ...idl,
  accounts: [],
};

export function getProgram(connection: Connection, wallet: AnchorWallet) {
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (anchor as any).Program(idlForClient, PROGRAM_ID, provider);
}
