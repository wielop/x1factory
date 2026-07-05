import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";

import { deriveConfigPda, deriveVaultPda, fetchConfig, getProgram, getProvider } from "./v2-common";

const MIND_DECIMALS = 9;

/**
 * Usage:
 *   RPC_URL=... WALLET=~/.config/solana/id.json ts-node scripts/admin-mint-mind.ts <amount_mind>
 *
 * Calls admin_mint_mind to mint <amount_mind> MIND (whole tokens) to the admin's MIND ATA.
 */
const main = async () => {
  const amountArg = process.argv[2];
  if (!amountArg) {
    console.error("Usage: ts-node scripts/admin-mint-mind.ts <amount_mind>");
    process.exit(1);
  }
  const amountMind = BigInt(amountArg);
  const amountBaseUnits = amountMind * 10n ** BigInt(MIND_DECIMALS);

  const provider = getProvider();
  const connection = provider.connection;
  const program = getProgram();

  const config = await fetchConfig(connection);
  if (!config) {
    throw new Error("Config account not found");
  }

  const admin = provider.wallet.publicKey;
  if (!admin.equals(config.admin)) {
    throw new Error(
      `Wallet ${admin.toBase58()} is not the configured admin (${config.admin.toBase58()})`
    );
  }

  const configPda = deriveConfigPda();
  const vaultAuthority = deriveVaultPda();
  const mindMint = config.mindMint;
  const adminMindAta = await getAssociatedTokenAddress(mindMint, admin);
  const ataInfo = await connection.getAccountInfo(adminMindAta);

  const preInstructions = [];
  if (!ataInfo) {
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        admin,
        adminMindAta,
        admin,
        mindMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  console.log(
    `Minting ${amountMind} MIND (${amountBaseUnits} base units) to admin ATA ${adminMindAta.toBase58()}`
  );

  const sig = await program.methods
    .adminMintMind(new anchor.BN(amountBaseUnits.toString()))
    .accounts({
      admin,
      config: configPda,
      vaultAuthority,
      mindMint,
      adminMindAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions(preInstructions)
    .rpc();

  console.log(`tx: ${sig}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
