import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";

import { getProgram, getProvider, PROGRAM_ID, deriveConfigPda, deriveProfilePda, deriveVaultPda } from "./v2-common";
import { decodeMinerPositionAccount, MINER_POSITION_LEN } from "../web/lib/decoders";

const ACC_SCALE = 1_000_000_000_000_000_000n;

async function ensureAta(owner: PublicKey, mint: PublicKey, provider: anchor.AnchorProvider) {
  const ata = await getAssociatedTokenAddress(mint, owner);
  const info = await provider.connection.getAccountInfo(ata);
  if (info) return { ata, ix: null };
  return {
    ata,
    ix: createAssociatedTokenAccountIdempotentInstruction(
      owner,
      ata,
      owner,
      mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
  };
}

async function getPending(
  position: ReturnType<typeof decodeMinerPositionAccount>,
  accMindPerHp: bigint
): Promise<bigint> {
  const earned = (position.hp * accMindPerHp) / ACC_SCALE;
  const rewards = earned > position.rewardDebt ? earned - position.rewardDebt : 0n;
  return rewards;
}

async function main() {
  const provider = getProvider();
  const program = getProgram();
  const connection = provider.connection;
  const owner = provider.wallet.publicKey;
  if (!owner) {
    throw new Error("Wallet not loaded");
  }

  const config = await (program.account as any).config.fetch(deriveConfigPda());
  const accMindPerHp = BigInt(config.accMindPerHp.toString());

  const positions = await connection.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { dataSize: MINER_POSITION_LEN },
      { memcmp: { offset: 8, bytes: owner.toBase58() } },
    ],
  });

  const decoded = positions.map((position) => ({
    pubkey: position.pubkey,
    data: decodeMinerPositionAccount(Buffer.from(position.account.data)),
  }));

  const claimTargets = await Promise.all(
    decoded.map(async (entry) => ({
      entry,
      pending: await getPending(entry.data, accMindPerHp),
    }))
  ).then((items) => items.filter((item) => item.pending > 0n));

  if (claimTargets.length === 0) {
    console.log("No pending MIND to claim");
    return;
  }

  const { ata, ix } = await ensureAta(owner, config.mindMint, provider);
  const tx = new Transaction();
  if (ix) tx.add(ix);

  for (const target of claimTargets) {
    const instruction = await program.methods
      .claimMind()
      .accounts({
        owner,
        config: deriveConfigPda(),
        userProfile: deriveProfilePda(owner),
        position: target.entry.pubkey,
        vaultAuthority: deriveVaultPda(),
        mindMint: config.mindMint,
        userMindAta: ata,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    tx.add(instruction);
  }

  const sig = await provider.sendAndConfirm(tx, []);
  console.log("Claimed MIND:", sig);
}

main().catch((err) => {
  console.error("Claim bot failed:", err);
  process.exit(1);
});
