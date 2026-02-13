import { PublicKey } from "@solana/web3.js";
import { decodeMinerPositionAccount, MINER_POSITION_LEN_V1, MINER_POSITION_LEN_V2, MINER_POSITION_LEN_V3 } from "../web/lib/decoders";
import { getProgram, getProvider, deriveConfigPda, PROGRAM_ID } from "./v2-common";

const OWNER = new PublicKey("2UQZkgiXwgRxvP4iYnGSnB97LnE9vwToQNCmZ5LtDLLx");
const ACC_SCALE = 1_000_000_000_000_000_000n;

async function main() {
  const provider = getProvider();
  const program = getProgram();
  const connection = provider.connection;

  const config = await (program.account as any).config.fetch(deriveConfigPda());
  const accMindPerHp = BigInt(config.accMindPerHp.toString());

  const baseFilters = [{ memcmp: { offset: 8, bytes: OWNER.toBase58() } }];
  const positions = [
    ...(await connection.getProgramAccounts(PROGRAM_ID, {
      commitment: "confirmed",
      filters: [{ dataSize: MINER_POSITION_LEN_V1 }, ...baseFilters],
    })),
    ...(await connection.getProgramAccounts(PROGRAM_ID, {
      commitment: "confirmed",
      filters: [{ dataSize: MINER_POSITION_LEN_V2 }, ...baseFilters],
    })),
    ...(await connection.getProgramAccounts(PROGRAM_ID, {
      commitment: "confirmed",
      filters: [{ dataSize: MINER_POSITION_LEN_V3 }, ...baseFilters],
    })),
  ];

  const decoded = positions.map((position) => ({
    pubkey: position.pubkey,
    data: decodeMinerPositionAccount(Buffer.from(position.account.data)),
  }));

  let totalPending = 0n;
  const lines: string[] = [];
  for (const entry of decoded) {
    const earned = (entry.data.hp * accMindPerHp) / ACC_SCALE;
    const pending = earned > entry.data.rewardDebt ? earned - entry.data.rewardDebt : 0n;
    totalPending += pending;
    lines.push(`${entry.pubkey.toBase58()}\t${pending.toString()}`);
  }

  lines.sort((a, b) => {
    const pa = BigInt(a.split("\t")[1]);
    const pb = BigInt(b.split("\t")[1]);
    return pb > pa ? 1 : pb < pa ? -1 : 0;
  });

  console.log("positions:", decoded.length);
  console.log("pending_base_total:", totalPending.toString());
  console.log("pending_tokens_total:", (Number(totalPending) / 1e9).toFixed(9));
  console.log("---- per position (pending base units) ----");
  for (const line of lines) console.log(line);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
