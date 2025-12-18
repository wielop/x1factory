import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import dotenv from "dotenv";
import {
  deriveConfigPda,
  deriveEpochPda,
  derivePositionPda,
  deriveUserEpochPda,
  deriveVaultPda,
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
  const vaultAuthority = deriveVaultPda();
  const mindMint = cfg.mindMint;
  const userMindAta = getAssociatedTokenAddressSync(
    mindMint,
    wallet.publicKey
  );

  await program.methods
    .claim()
    .accounts({
      owner: wallet.publicKey,
      config: configPda,
      vaultAuthority,
      position,
      epochState,
      userEpoch,
      mindMint,
      userMindAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log("Claimed epoch", epochIndex);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
