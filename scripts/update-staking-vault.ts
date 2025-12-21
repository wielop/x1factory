import * as anchor from "@coral-xyz/anchor";
import {
  ACCOUNT_SIZE,
  createInitializeAccountInstruction,
  getMinimumBalanceForRentExemptAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import dotenv from "dotenv";
import { deriveConfigPda, deriveVaultPda, getProgram, getProvider } from "./common";
import { fetchConfig } from "../web/lib/solana";

dotenv.config();

const main = async () => {
  const program = getProgram();
  const provider = getProvider();
  const wallet = provider.wallet as anchor.Wallet;

  const cfgPda = deriveConfigPda();
  const cfg = await fetchConfig(provider.connection);

  const vaultAuthority = deriveVaultPda();
  const xntMint = new PublicKey(cfg.xntMint);

  // Create a dedicated staking vault token account for XNT (non-ATA).
  const stakingVaultKp = Keypair.generate();
  const rentLamports = await getMinimumBalanceForRentExemptAccount(provider.connection);
  const createIx = SystemProgram.createAccount({
    fromPubkey: wallet.publicKey,
    newAccountPubkey: stakingVaultKp.publicKey,
    lamports: rentLamports,
    space: ACCOUNT_SIZE,
    programId: TOKEN_PROGRAM_ID,
  });
  const initIx = createInitializeAccountInstruction(
    stakingVaultKp.publicKey,
    xntMint,
    vaultAuthority,
    TOKEN_PROGRAM_ID
  );
  const createTx = new Transaction().add(createIx, initIx);
  await sendAndConfirmTransaction(provider.connection, createTx, [wallet.payer, stakingVaultKp], {
    commitment: "confirmed",
  });
  const stakingVaultXnt = stakingVaultKp.publicKey;

  console.log("New staking vault XNT account:", stakingVaultXnt.toBase58());

  const updateTx = await program.methods
    .adminUpdateStakingVault()
    .accounts({
      admin: wallet.publicKey,
      config: cfgPda,
      vaultAuthority,
      stakingVaultXntAta: stakingVaultXnt,
    })
    .rpc();

  console.log("Updated staking vault in config:", updateTx);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
