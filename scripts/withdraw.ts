import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import dotenv from "dotenv";
import {
  deriveConfigPda,
  derivePositionPda,
  deriveVaultPda,
  getProgram,
} from "./common";

dotenv.config();

const main = async () => {
  const program = getProgram();
  const provider = program.provider as anchor.AnchorProvider;
  const wallet = provider.wallet as anchor.Wallet;

  const configPda = deriveConfigPda();
  const cfg = await program.account.config.fetch(configPda);
  const position = derivePositionPda(wallet.publicKey);
  const vaultAuthority = deriveVaultPda();
  const xntMint = cfg.xntMint as anchor.web3.PublicKey;
  const vaultXntAta = cfg.vaultXntAta as anchor.web3.PublicKey;

  const ownerXntAta = (
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      xntMint,
      wallet.publicKey
    )
  ).address;

  await program.methods
    .withdraw()
    .accounts({
      owner: wallet.publicKey,
      config: configPda,
      position,
      vaultAuthority,
      xntMint,
      vaultXntAta,
      ownerXntAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log("Withdrawn funds to", ownerXntAta.toBase58());
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
