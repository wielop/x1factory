import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID as MPL_TOKEN_METADATA_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import {
  deriveConfigPda,
  deriveVaultPda,
  fetchConfig,
  getProgram,
  getProvider,
} from "./v2-common";

dotenv.config();

const DEFAULT_METADATA_PATH = path.resolve(
  __dirname,
  "..",
  "metadata",
  "mind-v2.json"
);
const DEFAULT_METADATA_URI =
  "https://raw.githubusercontent.com/wielop/x1factory/main/metadata/mind-v2.json";

type MetadataFile = {
  name: string;
  symbol: string;
  seller_fee_basis_points?: number;
};

const loadMetadataFile = (filePath: string) => {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as MetadataFile;
};

const main = async () => {
  const program = getProgram();
  const provider = getProvider();
  const wallet = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  const cfg = await fetchConfig(connection);
  if (!cfg) {
    throw new Error("Config not found. Run deploy or init first.");
  }

  const metadataPath = process.env.METADATA_FILE ?? DEFAULT_METADATA_PATH;
  const metadata = loadMetadataFile(metadataPath);

  const name = process.env.METADATA_NAME ?? metadata.name;
  const symbol = process.env.METADATA_SYMBOL ?? metadata.symbol;
  const uri = process.env.METADATA_URI ?? DEFAULT_METADATA_URI;
  const sellerFeeBasisPoints = Number(
    process.env.METADATA_FEE_BPS ??
      metadata.seller_fee_basis_points ??
      0
  );

  const [metadataPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      cfg.mindMint.toBuffer(),
    ],
    MPL_TOKEN_METADATA_PROGRAM_ID
  );

  console.log("Admin:", wallet.publicKey.toBase58());
  console.log("Mint:", cfg.mindMint.toBase58());
  console.log("Metadata PDA:", metadataPda.toBase58());
  console.log("Name:", name);
  console.log("Symbol:", symbol);
  console.log("URI:", uri);
  console.log("Seller fee bps:", sellerFeeBasisPoints);

  await program.methods
    .adminSetMetadata({
      name,
      symbol,
      uri,
      sellerFeeBasisPoints,
    })
    .accounts({
      admin: wallet.publicKey,
      config: deriveConfigPda(),
      vaultAuthority: deriveVaultPda(),
      mindMint: cfg.mindMint,
      metadata: metadataPda,
      metadataProgram: MPL_TOKEN_METADATA_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  console.log("Metadata create/update complete.");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
