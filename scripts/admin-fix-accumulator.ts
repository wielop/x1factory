import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { decodeMinerPositionAccount, MINER_POSITION_LEN_V2 } from "../web/lib/decoders";
import { deriveConfigPda, deriveProfilePda, getProgram, getProvider, PROGRAM_ID } from "./v2-common";

/**
 * Usage:
 *   RPC_URL=... WALLET=~/.config/solana/id.json ts-node scripts/admin-fix-accumulator.ts <owner> <new_acc_mind_per_hp>
 *
 * - <owner>: user pubkey
 * - <new_acc_mind_per_hp>: accumulator value in base units (u128, e.g. from a calc/script)
 *
 * The script:
 * 1) Loads all MinerPosition accounts for the owner.
 * 2) Calls admin_fix_accumulator with all positions as remaining accounts,
 *    setting reward_debt = earned_per_hp(hp_effective, new_acc_mind_per_hp).
 *
 * NOTE: If a user has many positions, you may need to chunk the calls to stay under
 *       transaction size limits. Chunk size is configurable below.
 */

const CHUNK_SIZE = 10;

const main = async () => {
  const [ownerStr, accStr] = process.argv.slice(2);
  if (!ownerStr || !accStr) {
    console.error("Usage: ts-node scripts/admin-fix-accumulator.ts <owner> <new_acc_mind_per_hp>");
    process.exit(1);
  }
  const owner = new PublicKey(ownerStr.trim());
  const newAcc = BigInt(accStr.trim());

  const provider = getProvider();
  const connection = provider.connection;
  const program = getProgram();

  const filters = [
    { dataSize: MINER_POSITION_LEN_V2 },
    { memcmp: { offset: 8, bytes: owner.toBase58() } },
  ];

  const positions = await connection.getProgramAccounts(PROGRAM_ID, { filters });
  if (positions.length === 0) {
    throw new Error("No positions found for owner");
  }

  const profilePda = deriveProfilePda(owner);
  console.log(
    `Fixing acc_mind_per_hp for owner=${owner.toBase58()} positions=${positions.length} newAcc=${newAcc.toString()}`
  );

  const chunks: typeof positions[] = [];
  for (let i = 0; i < positions.length; i += CHUNK_SIZE) {
    chunks.push(positions.slice(i, i + CHUNK_SIZE));
  }

  for (const [idx, chunk] of chunks.entries()) {
    console.log(`Sending chunk ${idx + 1}/${chunks.length} size=${chunk.length}`);
    // sanity log hp/effective flags
    for (const p of chunk) {
      const decoded = decodeMinerPositionAccount(Buffer.from(p.account.data));
      console.log(
        `  pos=${p.pubkey.toBase58()} hp_scaled=${decoded.hpScaled} hp=${decoded.hp.toString()} end_ts=${decoded.endTs}`
      );
    }

    const sig = await program.methods
      .adminFixAccumulator(new anchor.BN(newAcc.toString()))
      .accounts({
        admin: provider.wallet.publicKey,
        config: deriveConfigPda(),
        userProfile: profilePda,
      })
      .remainingAccounts(
        chunk.map((p) => ({ pubkey: p.pubkey, isWritable: true, isSigner: false }))
      )
      .rpc();
    console.log(`  tx: ${sig}`);
  }

  console.log("Done.");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
