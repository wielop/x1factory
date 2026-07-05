import * as anchor from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";

import { deriveConfigPda, deriveTreasuryVaultPda, getProgram, getProvider } from "./v2-common";

/**
 * Withdraws the full available balance (vault balance minus rent-exempt minimum)
 * from the mining_v2 treasury_vault to the admin wallet via admin_withdraw_treasury.
 */
const main = async () => {
  const provider = getProvider();
  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const program: any = getProgram();

  const configPda = deriveConfigPda();
  const treasuryVault = deriveTreasuryVaultPda();

  const info = await connection.getAccountInfo(treasuryVault, "confirmed");
  if (!info) {
    throw new Error("treasury_vault account not found");
  }
  const rent = await connection.getMinimumBalanceForRentExemption(info.data.length);
  const available = BigInt(info.lamports) - BigInt(rent);
  if (available <= 0n) {
    console.log("Nothing available to withdraw.");
    return;
  }

  console.log(`treasury_vault=${treasuryVault.toBase58()} balance=${info.lamports} rent=${rent} available=${available}`);

  const sig = await program.methods
    .adminWithdrawTreasury(new anchor.BN(available.toString()))
    .accounts({
      admin: wallet.publicKey,
      config: configPda,
      treasuryVault,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("tx:", sig);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
