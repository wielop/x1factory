import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createMint,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "fs";
import dotenv from "dotenv";
import {
  PROGRAM_ID,
  deriveConfigPda,
  deriveVaultPda,
  getProgram,
  loadKeypair,
} from "./common";

dotenv.config();

const DEFAULT_MIND_DECIMALS = 9;
const DEFAULT_MINED_CAP_BPS = 7000;
const DEFAULT_EPOCH_SECONDS = 86_400;

const loadOrCreateKeypair = (path: string) => {
  if (fs.existsSync(path)) {
    return loadKeypair(path);
  }
  const kp = Keypair.generate();
  fs.writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
};

const main = async () => {
  const program = getProgram();
  const provider = program.provider as anchor.AnchorProvider;
  const wallet = provider.wallet as anchor.Wallet;

  const xntMintStr = process.env.XNT_MINT;
  if (!xntMintStr) {
    throw new Error("XNT_MINT env var is required");
  }
  const xntMint = new PublicKey(xntMintStr);
  const xntMintAccount = await getMint(provider.connection, xntMint);

  const mindMintPath =
    process.env.MIND_MINT_KEYPAIR ??
    "./target/deploy/pocm_mind_mint-keypair.json";
  const mindMint = loadOrCreateKeypair(mindMintPath);

  const mindDecimals =
    Number(process.env.MIND_DECIMALS ?? DEFAULT_MIND_DECIMALS) | 0;
  const xntDecimals = Number(process.env.XNT_DECIMALS ?? xntMintAccount.decimals);
  const totalSupplyMind = process.env.TOTAL_SUPPLY_MIND;
  if (!totalSupplyMind) {
    throw new Error("TOTAL_SUPPLY_MIND env var (base units) is required");
  }
  const minedCapPctBps = Number(
    process.env.MINED_CAP_BPS ?? DEFAULT_MINED_CAP_BPS
  );
  const epochSeconds = Number(
    process.env.EPOCH_SECONDS ?? DEFAULT_EPOCH_SECONDS
  );
  const allowEpochSecondsEdit = (process.env.ALLOW_EPOCH_EDIT ?? "false") ===
    "true";

  const th1Default = new BN(1_000).mul(
    new BN(10).pow(new BN(xntMintAccount.decimals))
  );
  const th2Default = new BN(4_000).mul(
    new BN(10).pow(new BN(xntMintAccount.decimals))
  );
  const th1 = new BN(process.env.THRESHOLD_1 ?? th1Default.toString());
  const th2 = new BN(process.env.THRESHOLD_2 ?? th2Default.toString());

  const config = deriveConfigPda();
  const vaultAuthority = deriveVaultPda();
  const vaultXntAta = getAssociatedTokenAddressSync(
    xntMint,
    vaultAuthority,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log("Admin:", wallet.publicKey.toBase58());
  console.log("XNT mint:", xntMint.toBase58());
  console.log("MIND mint:", mindMint.publicKey.toBase58());
  console.log("Vault ATA:", vaultXntAta.toBase58());

  // Ensure MIND mint exists and is owned by the vault PDA (program mint authority).
  try {
    await getMint(provider.connection, mindMint.publicKey);
    console.log("MIND mint already exists");
  } catch {
    console.log("Creating MIND mint...");
    await createMint(
      provider.connection,
      wallet.payer,
      vaultAuthority,
      null,
      mindDecimals,
      mindMint
    );
  }

  // Ensure the vault PDA has an ATA for XNT (wSOL).
  await createAssociatedTokenAccountIdempotent(
    provider.connection,
    wallet.payer,
    xntMint,
    vaultAuthority,
    undefined,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    true
  );

  await program.methods
    .initialize({
      xntMint,
      mindDecimals,
      xntDecimals,
      totalSupplyMind: new BN(totalSupplyMind),
      minedCapPctBps,
      th1,
      th2,
      allowEpochSecondsEdit,
      epochSeconds: new BN(epochSeconds),
    })
    .accounts({
      payer: wallet.publicKey,
      admin: wallet.publicKey,
      vaultAuthority,
      config,
      mindMint: mindMint.publicKey,
      xntMint,
      vaultXntAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  console.log("Initialized config:", config.toBase58());
  console.log("Program ID:", PROGRAM_ID.toBase58());
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
