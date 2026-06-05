import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";

const RPC = "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID = new PublicKey("2xXG9bbggrffG976okAbEHzw1BJgfA58d9zHTToke2Z6");
const CONFIG_SEED = Buffer.from("router_config");
const REWARD_POOL_SEED = Buffer.from("reward_pool");

// XNT price in USD cents (e.g. 50 = $0.50). Update via update_price later.
const XNT_USD_CENTS = 50n; // $0.50 initial — update as needed

async function main() {
  const keyPath = process.argv[2] || path.join(process.env.HOME!, ".config/solana/treasury.json");
  const raw = JSON.parse(fs.readFileSync(keyPath, "utf8")) as number[];
  const authority = Keypair.fromSecretKey(new Uint8Array(raw));
  console.log("Authority:", authority.publicKey.toBase58());

  const connection = new Connection(RPC, "confirmed");
  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../target/idl/swap_router.json"),
      "utf8"
    )
  );

  const program = new anchor.Program(idl, PROGRAM_ID, provider);

  const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
  const [rewardPoolPda] = PublicKey.findProgramAddressSync(
    [REWARD_POOL_SEED, configPda.toBuffer()],
    PROGRAM_ID
  );

  console.log("Config PDA:      ", configPda.toBase58());
  console.log("Reward pool PDA: ", rewardPoolPda.toBase58());

  const bal = await connection.getBalance(authority.publicKey);
  console.log("Balance:         ", bal / 1e9, "XNT");

  const tx = await program.methods
    .initialize(new anchor.BN(XNT_USD_CENTS.toString()))
    .accounts({
      config: configPda,
      rewardPoolMind: rewardPoolPda,
      authority: authority.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([authority])
    .rpc();

  console.log("\n✅ initialize tx:", tx);
  console.log("Config account:  ", configPda.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
