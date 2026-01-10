import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import {
  DataV2,
  PROGRAM_ID as MPL_TOKEN_METADATA_PROGRAM_ID,
  createCreateMetadataAccountV3Instruction,
  createUpdateMetadataAccountV2Instruction,
} from '@metaplex-foundation/mpl-token-metadata';

const METADATA_FILE_PATH = path.resolve(
  __dirname,
  '..',
  'metadata',
  'mind-v2.json'
);

type ConfigMode = 'create-only' | 'create-or-update';

const CONFIG = {
  rpcUrl: 'https://rpc.mainnet.x1.xyz',
  mintAddress: 'DohWBfvXER6qs8zFGtdZRDpgbHmm97ZZwgCUTCdtHQNT',
  metadataUri:
    'https://x1factory.xyz/metadata/mind-v2.json',
  metadataFilePath: METADATA_FILE_PATH,
  mode: 'create-or-update' as ConfigMode,
};

const DEFAULT_KEYPAIR_PATH = path.join(
  os.homedir(),
  '.config',
  'solana',
  'id.json'
);

async function main() {
  try {
    const connection = new Connection(CONFIG.rpcUrl, 'confirmed');
    const payer = loadLocalKeypair();
    const mintPublicKey = new PublicKey(CONFIG.mintAddress);
    const [metadataPda] = await PublicKey.findProgramAddress(
      [
        Buffer.from('metadata'),
        MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mintPublicKey.toBuffer(),
      ],
      MPL_TOKEN_METADATA_PROGRAM_ID
    );

    console.log('RPC endpoint:', CONFIG.rpcUrl);
    console.log('Mint address:', mintPublicKey.toBase58());
    console.log('Derived metadata PDA:', metadataPda.toBase58());

    const metadataAccount = await connection.getAccountInfo(metadataPda);
    const metadataExists = metadataAccount !== null;

    if (metadataExists && CONFIG.mode === 'create-only') {
      console.log(
        'Metadata already exists for this mint. Skipping (create-only mode).'
      );
      return;
    }

    const metadataSource = loadMetadataFile(CONFIG.metadataFilePath);
    console.log('Local metadata file path:', CONFIG.metadataFilePath);
    console.log('Metadata URI (on-chain):', CONFIG.metadataUri);

    const metadataData: DataV2 = {
      name: metadataSource.name,
      symbol: metadataSource.symbol,
      uri: CONFIG.metadataUri,
      sellerFeeBasisPoints: metadataSource.seller_fee_basis_points ?? 0,
      creators: null,
      collection: null,
      uses: null,
    };

    let instruction;

    if (!metadataExists) {
      instruction = createCreateMetadataAccountV3Instruction(
        {
          metadata: metadataPda,
          mint: mintPublicKey,
          mintAuthority: payer.publicKey,
          payer: payer.publicKey,
          updateAuthority: payer.publicKey,
        },
        {
          createMetadataAccountArgsV3: {
            data: metadataData,
            isMutable: true,
            collectionDetails: null,
          },
        }
      );
    } else if (CONFIG.mode === 'create-or-update') {
      instruction = createUpdateMetadataAccountV2Instruction(
        {
          metadata: metadataPda,
          updateAuthority: payer.publicKey,
        },
        {
          updateMetadataAccountArgsV2: {
            data: metadataData,
            updateAuthority: payer.publicKey,
            primarySaleHappened: null,
            isMutable: null,
          },
        }
      );
    } else {
      throw new Error('No valid instruction path for the selected mode.');
    }

    const transaction = new Transaction().add(instruction);
    const signature = await sendAndConfirmTransaction(connection, transaction, [
      payer,
    ]);

    console.log('Transaction signature:', signature);
    console.log('Metadata successfully created/updated on X1.');
  } catch (error) {
    console.error(
      'Failed to set metadata on X1:',
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}

function loadLocalKeypair(): Keypair {
      const keypairEnv = process.env.SOLANA_KEYPAIR;
      const keypairPath = path.resolve(
        keypairEnv ?? DEFAULT_KEYPAIR_PATH
      );
      const rawKeypair = JSON.parse(readFileSync(keypairPath, 'utf-8'));
      const secretKey = Array.isArray(rawKeypair)
        ? rawKeypair
        : Array.isArray(rawKeypair.secretKey)
        ? rawKeypair.secretKey
        : Array.isArray(rawKeypair.data)
    ? rawKeypair.data
    : undefined;

  if (!secretKey) {
    throw new Error(
      `Unable to parse secret key from ${keypairPath}; expected numeric array.`
    );
  }

  console.log('Loaded payer keypair from', keypairPath);
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

type MetadataFile = {
  name: string;
  symbol: string;
  description: string;
  image: string;
  external_url?: string;
  attributes?: Array<Record<string, unknown>>;
  properties?: Record<string, unknown>;
  seller_fee_basis_points?: number;
};

function loadMetadataFile(pathToFile: string): MetadataFile {
  const raw = readFileSync(pathToFile, 'utf-8');
  return JSON.parse(raw) as MetadataFile;
}

main();
