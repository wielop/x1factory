import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { homedir } from "os";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const idl = require("../target/idl/pocm_vault_mining.json");

export const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? idl.address
);

const idlForScripts = {
  ...idl,
  // The generated JSON IDL in this repo does not include account sizes/types in
  // `idl.accounts`, which breaks Anchor's Account namespace construction.
  // Scripts decode on-chain accounts manually where needed.
  accounts: [],
};

export const loadKeypair = (filePath: string): Keypair => {
  const fullPath = filePath.replace("~", homedir());
  const secret = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
};

export const getProvider = () => {
  const rpc =
    process.env.RPC_URL ??
    process.env.ANCHOR_PROVIDER_URL ??
    "https://rpc.testnet.x1.xyz";
  const walletPath =
    process.env.WALLET ??
    process.env.ANCHOR_WALLET ??
    `${homedir()}/.config/solana/id.json`;
  const wallet = new anchor.Wallet(loadKeypair(walletPath));
  const connection = new Connection(rpc, "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  return provider;
};

export const getProgram = () => {
  const provider = getProvider();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (anchor as any).Program(idlForScripts, provider);
};

export const deriveConfigPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];

export const deriveVaultPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID)[0];

export const derivePositionPda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("position"), owner.toBuffer()],
    PROGRAM_ID
  )[0];

export const deriveEpochPda = (epochIndex: number | BN) => {
  const idx = BN.isBN(epochIndex) ? epochIndex : new BN(epochIndex);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("epoch"), idx.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  )[0];
};

export const deriveUserEpochPda = (owner: PublicKey, epochIndex: number | BN) => {
  const idx = BN.isBN(epochIndex) ? epochIndex : new BN(epochIndex);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("user_epoch"),
      owner.toBuffer(),
      idx.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID
  )[0];
};

export type DecodedConfig = {
  admin: PublicKey;
  xntMint: PublicKey;
  mindMint: PublicKey;
  vaultXntAta: PublicKey;
  mindDecimals: number;
  xntDecimals: number;
  epochSeconds: BN;
  emissionStartTs: BN;
};

export const fetchConfig = async (provider: anchor.AnchorProvider) => {
  const configPda = deriveConfigPda();
  const info = await provider.connection.getAccountInfo(configPda, "confirmed");
  if (!info) {
    throw new Error(`Config not found: ${configPda.toBase58()}`);
  }
  const data = info.data;
  if (data.length < 233) {
    throw new Error(
      `Config account too small: ${data.length} bytes (expected >= 233)`
    );
  }
  let offset = 8; // discriminator
  const readPubkey = () => {
    const pk = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    return pk;
  };
  const readU8 = () => data.readUInt8(offset++);
  const readU16 = () => {
    const v = data.readUInt16LE(offset);
    offset += 2;
    return v;
  };
  const readU64 = () => {
    const v = data.readBigUInt64LE(offset);
    offset += 8;
    return new BN(v.toString());
  };
  const readI64 = () => {
    const v = data.readBigInt64LE(offset);
    offset += 8;
    return new BN(v.toString());
  };

  const admin = readPubkey();
  const xntMint = readPubkey();
  const mindMint = readPubkey();
  const vaultXntAta = readPubkey();
  const mindDecimals = readU8();
  const xntDecimals = readU8();
  // skip emissions
  readU64();
  readU64();
  const epochSeconds = readU64();
  // skip halving config
  readU64();
  readU16();
  const emissionStartTs = readI64();
  // skip remaining fields
  return {
    admin,
    xntMint,
    mindMint,
    vaultXntAta,
    mindDecimals,
    xntDecimals,
    epochSeconds,
    emissionStartTs,
  } satisfies DecodedConfig;
};

export const getCurrentEpoch = async (
  provider: anchor.AnchorProvider,
  cfg: Pick<DecodedConfig, "emissionStartTs" | "epochSeconds">
) => {
  const info = await provider.connection.getAccountInfo(
    anchor.web3.SYSVAR_CLOCK_PUBKEY
  );
  if (!info) {
    throw new Error("Clock sysvar unavailable");
  }
  const ts = Number(info.data.readBigInt64LE(32));
  return Math.floor(
    (ts - cfg.emissionStartTs.toNumber()) / cfg.epochSeconds.toNumber()
  );
};
