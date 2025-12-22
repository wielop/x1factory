import * as anchor from "@coral-xyz/anchor";
import type { Connection } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import idl from "@/idl/mining_v2.json";
import { getProgramId } from "@/lib/solana";

// The IDL JSON in this repo does not include account sizes/types in `accounts`,
// which breaks Anchor's `program.account.*` helpers. We only use `.methods`.
const nonClientInstructions = ["initConfig"];
const idlForClient = {
  ...idl,
  // Ensure the Program ID matches the runtime config.
  address: getProgramId().toBase58(),
  instructions: (idl.instructions ?? []).filter(
    (ix) => !nonClientInstructions.includes(ix.name)
  ),
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
