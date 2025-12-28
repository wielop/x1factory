import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  decodeMinerPositionAccount,
  decodeUserMiningProfileAccount,
  MINER_POSITION_LEN,
  USER_PROFILE_LEN_V1,
  USER_PROFILE_LEN_V2,
} from "../web/lib/decoders";
import { deriveConfigPda, getProgram, getProvider } from "./v2-common";

dotenvConfig();

const HP_SCALE = 100n;
const BPS_DENOMINATOR = 10_000n;

function levelBonusBps(level: number) {
  switch (level) {
    case 1:
      return 0n;
    case 2:
      return 160n;
    case 3:
      return 340n;
    case 4:
      return 550n;
    case 5:
      return 780n;
    default:
      return 1000n;
  }
}

function dotenvConfig() {
  // Lazy import to avoid eslint errors in ts-node context.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require("dotenv");
  dotenv.config();
}

const main = async () => {
  const program = getProgram();
  const provider = getProvider();
  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;

  const programId = program.programId;

  const [positions, profilesV1, profilesV2] = await Promise.all([
    connection.getProgramAccounts(programId, {
      commitment: "confirmed",
      filters: [{ dataSize: MINER_POSITION_LEN }],
    }),
    connection.getProgramAccounts(programId, {
      commitment: "confirmed",
      filters: [{ dataSize: USER_PROFILE_LEN_V1 }],
    }),
    connection.getProgramAccounts(programId, {
      commitment: "confirmed",
      filters: [{ dataSize: USER_PROFILE_LEN_V2 }],
    }),
  ]);

  const levels = new Map<string, number>();
  const loadProfile = (entry: (typeof profilesV1)[number]) => {
    const decoded = decodeUserMiningProfileAccount(Buffer.from(entry.account.data));
    const owner = new PublicKey(decoded.owner).toBase58();
    levels.set(owner, decoded.level || 1);
  };
  profilesV1.forEach(loadProfile);
  profilesV2.forEach(loadProfile);

  const ownerBaseHp = new Map<string, bigint>();
  for (const entry of positions) {
    const decoded = decodeMinerPositionAccount(Buffer.from(entry.account.data));
    if (decoded.deactivated) continue;
    const owner = new PublicKey(decoded.owner).toBase58();
    ownerBaseHp.set(owner, (ownerBaseHp.get(owner) ?? 0n) + decoded.hp);
  }

  let totalEffectiveHp = 0n;
  for (const [owner, baseHp] of ownerBaseHp) {
    const level = levels.get(owner) ?? 1;
    const bonusBps = levelBonusBps(level);
    const effective =
      baseHp * (BPS_DENOMINATOR + bonusBps) * HP_SCALE / BPS_DENOMINATOR;
    totalEffectiveHp += effective;
  }

  console.log(`Computed network_hp_active (scaled): ${totalEffectiveHp.toString()}`);
  console.log(`Computed network HP: ${Number(totalEffectiveHp) / 100}`);

  const configPda = deriveConfigPda();
  await program.methods
    .adminSetNetworkHpActive(new anchor.BN(totalEffectiveHp.toString()))
    .accounts({
      admin: wallet.publicKey,
      config: configPda,
    })
    .rpc();

  console.log("Network HP updated.");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
