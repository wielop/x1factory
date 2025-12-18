import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createSyncNativeInstruction,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { SystemProgram, Transaction } from "@solana/web3.js";
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

  const amountStr = process.env.AMOUNT;
  if (!amountStr) {
    throw new Error("AMOUNT env var (base units of XNT) is required");
  }
  const amount = new BN(amountStr);
  const durationDays = Number(process.env.DURATION_DAYS ?? 14);

  const configPda = deriveConfigPda();
  const xntMint = new anchor.web3.PublicKey(
    process.env.XNT_MINT ?? NATIVE_MINT.toBase58()
  );
  const positionPda = derivePositionPda(wallet.publicKey);
  const vaultAuthority = deriveVaultPda();
  const vaultXntAta = getAssociatedTokenAddressSync(
    xntMint,
    vaultAuthority,
    true
  );

  try {
    const info = await provider.connection.getAccountInfo(positionPda, "confirmed");
    if (!info) {
      throw new Error("missing");
    }
    console.log("Position already exists");
  } catch {
    console.log("Creating position with duration", durationDays, "days");
    await program.methods
      .createPosition(durationDays)
      .accounts({
        owner: wallet.publicKey,
        config: configPda,
        position: positionPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  const ownerXntAta = (
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      xntMint,
      wallet.publicKey
    )
  ).address;

  if (xntMint.equals(NATIVE_MINT)) {
    const wrapTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: ownerXntAta,
        lamports: BigInt(amount.toString()),
      }),
      createSyncNativeInstruction(ownerXntAta)
    );
    await provider.sendAndConfirm(wrapTx, []);
    console.log("Wrapped", amount.toString(), "lamports into wSOL ATA");
  }

  console.log("Depositing", amount.toString(), "XNT base units");
  await program.methods
    .deposit(amount)
    .accounts({
      owner: wallet.publicKey,
      config: configPda,
      position: positionPda,
      vaultAuthority,
      xntMint,
      vaultXntAta,
      ownerXntAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  console.log("Deposit complete. Position:", positionPda.toBase58());
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
