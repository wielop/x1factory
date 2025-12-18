import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import dotenv from "dotenv";
import {
  deriveConfigPda,
  deriveEpochPda,
  derivePositionPda,
  deriveUserEpochPda,
  fetchConfig,
  getCurrentEpoch,
  getProgram,
} from "./common";

dotenv.config();

const main = async () => {
  const program = getProgram();
  const provider = program.provider as anchor.AnchorProvider;
  const wallet = provider.wallet as anchor.Wallet;

  const configPda = deriveConfigPda();
  const cfg = await fetchConfig(provider);
  const epochIndex =
    process.env.EPOCH_INDEX !== undefined
      ? Number(process.env.EPOCH_INDEX)
      : await getCurrentEpoch(provider, cfg);

  const position = derivePositionPda(wallet.publicKey);
  const epochState = deriveEpochPda(epochIndex);
  const userEpoch = deriveUserEpochPda(wallet.publicKey, epochIndex);

  await program.methods
    .heartbeat(new BN(epochIndex))
    .accounts({
      owner: wallet.publicKey,
      config: configPda,
      position,
      epochState,
      userEpoch,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("Heartbeated for epoch", epochIndex);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
