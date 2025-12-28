import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAccount,
  createAssociatedTokenAccountIdempotent,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import dotenv from "dotenv";
import {
  deriveConfigPda,
  deriveLevelConfigPda,
  fetchConfig,
  getProgram,
  getProvider,
} from "./v2-common";

dotenv.config();

const INCINERATOR = new PublicKey("1nc1nerator11111111111111111111111111111111");

const parseBigInt = (value: string | undefined) => {
  if (!value) return null;
  return BigInt(value);
};

const readLevelConfigVaults = (data: Buffer) => {
  if (data.length < 8 + 32 * 4 + 1) return null;
  let offset = 8 + 32 * 2;
  const mindBurnVault = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const mindTreasuryVault = new PublicKey(data.subarray(offset, offset + 32));
  return { mindBurnVault, mindTreasuryVault };
};

const main = async () => {
  const program = getProgram();
  const provider = getProvider();
  const wallet = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  const configPda = deriveConfigPda();
  const rigBuffConfigPda = PublicKey.findProgramAddressSync(
    [Buffer.from("rig_buff")],
    program.programId
  )[0];

  const configInfo = await connection.getAccountInfo(configPda, "confirmed");
  if (!configInfo) {
    throw new Error("Config not found. Run scripts/testnet-v2-init.ts first.");
  }
  const cfg = await fetchConfig(connection);
  if (!cfg) {
    throw new Error("Failed to load config after initialization.");
  }

  const rigBuffInfo = await connection.getAccountInfo(rigBuffConfigPda, "confirmed");
  if (rigBuffInfo) {
    console.log("Rig buff config already exists:", rigBuffConfigPda.toBase58());
    return;
  }

  const mindPerHpPerDay =
    parseBigInt(process.env.RIG_BUFF_MIND_PER_HP_PER_DAY) ??
    parseBigInt(process.env.MIND_PER_HP_PER_DAY);
  if (mindPerHpPerDay == null) {
    throw new Error(
      "Set RIG_BUFF_MIND_PER_HP_PER_DAY (or MIND_PER_HP_PER_DAY) before initializing."
    );
  }

  let mindBurnVault = process.env.MIND_BURN_VAULT
    ? new PublicKey(process.env.MIND_BURN_VAULT)
    : null;
  let mindTreasuryVault = process.env.MIND_TREASURY_VAULT
    ? new PublicKey(process.env.MIND_TREASURY_VAULT)
    : null;

  if (!mindBurnVault || !mindTreasuryVault) {
    const levelConfigInfo = await connection.getAccountInfo(
      deriveLevelConfigPda(),
      "confirmed"
    );
    if (levelConfigInfo) {
      const decoded = readLevelConfigVaults(levelConfigInfo.data);
      if (decoded) {
        mindBurnVault = mindBurnVault ?? decoded.mindBurnVault;
        mindTreasuryVault = mindTreasuryVault ?? decoded.mindTreasuryVault;
      }
    }
  }

  if (!mindTreasuryVault) {
    mindTreasuryVault = await createAssociatedTokenAccountIdempotent(
      connection,
      wallet.payer,
      cfg.mindMint,
      wallet.publicKey,
      undefined,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  }

  if (!mindBurnVault) {
    mindBurnVault = await createAccount(
      connection,
      wallet.payer,
      cfg.mindMint,
      INCINERATOR,
      Keypair.generate()
    );
  } else {
    const burnAccount = await getAccount(
      connection,
      mindBurnVault,
      "confirmed",
      TOKEN_PROGRAM_ID
    );
    if (!burnAccount.mint.equals(cfg.mindMint)) {
      throw new Error("MIND_BURN_VAULT mint does not match config mind mint.");
    }
    if (!burnAccount.owner.equals(INCINERATOR)) {
      throw new Error("MIND_BURN_VAULT owner must be the incinerator address.");
    }
  }

  const adminTreasuryAta = getAssociatedTokenAddressSync(
    cfg.mindMint,
    wallet.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  if (!mindTreasuryVault.equals(adminTreasuryAta)) {
    console.warn(
      `MIND_TREASURY_VAULT is not the admin ATA (${adminTreasuryAta.toBase58()}).`
    );
  }

  await program.methods
    .initRigBuffConfig({
      mindPerHpPerDay: new anchor.BN(mindPerHpPerDay.toString()),
    })
    .accounts({
      admin: wallet.publicKey,
      config: configPda,
      rigBuffConfig: rigBuffConfigPda,
      mindMint: cfg.mindMint,
      mindBurnVault,
      mindTreasuryVault,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("Rig buff config initialized:", rigBuffConfigPda.toBase58());
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
