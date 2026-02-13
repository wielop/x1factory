import * as anchor from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import dotenv from "dotenv";

import { deriveConfigPda, getProgram, getProvider } from "./v2-common";

dotenv.config();

const parseAmount = (value: string | undefined): bigint => {
  if (!value) {
    throw new Error(
      "Set WITHDRAW_STAKING_REWARDS_LAMPORTS to the number of lamports to withdraw."
    );
  }
  if (!/^\d+$/.test(value)) {
    throw new Error("WITHDRAW_STAKING_REWARDS_LAMPORTS must be an integer.");
  }
  return BigInt(value);
};

const main = async () => {
  const amount = parseAmount(process.env.WITHDRAW_STAKING_REWARDS_LAMPORTS);
  const provider = getProvider();
  const wallet = provider.wallet as anchor.Wallet;
  if (!wallet.publicKey) {
    throw new Error("Wallet not loaded");
  }

  const program: any = getProgram();
  const configPda = deriveConfigPda();
  const cfg = await (program.account as any).config.fetch(configPda);

  console.log(
    "Withdrawing from staking reward vault:",
    cfg.stakingRewardVault.toBase58()
  );

  const signature = await program.methods
    .adminWithdrawStakingRewards(new anchor.BN(amount.toString()))
    .accounts({
      admin: wallet.publicKey,
      config: configPda,
      stakingRewardVault: cfg.stakingRewardVault,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("Withdraw tx signature:", signature);
};

main().catch((err) => {
  console.error("Withdrawal failed:", err);
  process.exit(1);
});
