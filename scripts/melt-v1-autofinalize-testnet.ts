import "dotenv/config";

import fs from "fs";
import path from "path";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

const TESTNET_RPC_URL = "https://rpc.testnet.x1.xyz";
const CONFIG_SEED = "melt_config";
const ROUND_SEED = "melt_round";

function assertTestnetOnly(provider: anchor.AnchorProvider) {
  const envRpc = (process.env.ANCHOR_PROVIDER_URL || "").trim();
  if (envRpc !== TESTNET_RPC_URL) {
    throw new Error("TESTNET ONLY: ANCHOR_PROVIDER_URL must be https://rpc.testnet.x1.xyz");
  }
  const rpc = provider.connection.rpcEndpoint;
  if (rpc !== TESTNET_RPC_URL || rpc.includes("mainnet") || envRpc.includes("mainnet")) {
    throw new Error("TESTNET ONLY");
  }
}

function fixIdl(idl: any): any {
  const fixAccounts = (accounts: any[]): any[] =>
    (accounts || []).map((account) => {
      if (account.accounts) account.accounts = fixAccounts(account.accounts);
      if ("isMut" in account && account.writable === undefined) account.writable = account.isMut;
      if ("isSigner" in account && account.signer === undefined) account.signer = account.isSigner;
      return account;
    });

  for (const ix of idl.instructions || []) {
    ix.accounts = fixAccounts(ix.accounts || []);
  }
  return idl;
}

function parseCli() {
  const watch = process.argv.includes("--watch");
  const idx = process.argv.indexOf("--interval-sec");
  const intervalSec = idx >= 0 ? Number(process.argv[idx + 1]) : 15;
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    throw new Error("interval-sec must be > 0");
  }
  return { watch, intervalSec };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnce(program: any, provider: anchor.AnchorProvider, programId: PublicKey) {
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED)], programId);
  const config = await program.account.meltConfig.fetch(configPda);
  const activeRound = Boolean(config.activeRoundActive);
  if (!activeRound) {
    console.log("autofinalize: no active round");
    return;
  }

  const activeSeq = BigInt(config.activeRoundSeq.toString());
  const seqLe = Buffer.alloc(8);
  seqLe.writeBigUInt64LE(activeSeq);
  const [roundPda] = PublicKey.findProgramAddressSync([Buffer.from(ROUND_SEED), seqLe], programId);
  const round = await program.account.meltRound.fetch(roundPda);
  const nowTs = Math.floor(Date.now() / 1000);
  const endTs = Number(round.endTs.toString());
  const isActiveStatus = "active" in round.status || "Active" in round.status;

  console.log(
    "autofinalize: round",
    JSON.stringify({
      seq: round.seq.toString(),
      status: Object.keys(round.status)[0] ?? "unknown",
      nowTs,
      endTs,
    })
  );

  if (!isActiveStatus) {
    console.log("autofinalize: round already finalized");
    return;
  }
  if (nowTs <= endTs) {
    console.log(`autofinalize: waiting (${endTs - nowTs}s left)`);
    return;
  }

  const sig = await program.methods
    .finalizeRound()
    .accounts({
      admin: provider.wallet.publicKey,
      config: configPda,
      round: roundPda,
      vault: config.vault,
    })
    .rpc();

  console.log("autofinalize: finalized", sig);
}

async function main() {
  const { watch, intervalSec } = parseCli();
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  assertTestnetOnly(provider);

  const idlPath = path.join(__dirname, "..", "target", "idl", "melt_v1.json");
  const idl = fixIdl(JSON.parse(fs.readFileSync(idlPath, "utf8")));
  const programId = new PublicKey(process.env.MELT_V1_PROGRAM_ID ?? idl.address ?? idl.metadata?.address);
  const program = new anchor.Program(idl as anchor.Idl, provider);

  console.log("cluster", provider.connection.rpcEndpoint);
  console.log("programId", programId.toBase58());
  console.log("keeper", provider.wallet.publicKey.toBase58());

  if (!watch) {
    await runOnce(program, provider, programId);
    return;
  }

  while (true) {
    try {
      await runOnce(program, provider, programId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("autofinalize:error", msg);
    }
    await sleep(intervalSec * 1000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

