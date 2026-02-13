import 'dotenv/config';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as anchor from '@coral-xyz/anchor';
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

const CONFIG_SEED = 'melt_config';
const LAMPORTS_PER_XNT = 1_000_000_000n;
const MELT_CONFIG_NEW_SIZE = 174;

type Cli = {
  dryRun: boolean;
  capXnt: bigint;
  roundWindowSec: number;
  rolloverBps: number;
  burnMinMind: bigint;
};

const TESTNET_RPC_URL = 'https://rpc.testnet.x1.xyz';

function assertTestnetOnly(provider: anchor.AnchorProvider) {
  const envRpc = (process.env.ANCHOR_PROVIDER_URL || '').trim();
  if (envRpc !== TESTNET_RPC_URL) {
    throw new Error('TESTNET ONLY: ANCHOR_PROVIDER_URL must be https://rpc.testnet.x1.xyz');
  }
  const rpc = provider.connection.rpcEndpoint;
  if (rpc !== TESTNET_RPC_URL || rpc.includes('mainnet') || envRpc.includes('mainnet')) {
    throw new Error('TESTNET ONLY');
  }
}

function fixType(t: any): any {
  if (!t) return t;
  if (typeof t === 'string') {
    if (t === 'publicKey') return 'pubkey';
    return t;
  }
  if (t.defined && typeof t.defined === 'string') {
    t.defined = { name: t.defined };
  }
  if (t.option) t.option = fixType(t.option);
  if (t.coption) t.coption = fixType(t.coption);
  if (t.vec) t.vec = fixType(t.vec);
  if (t.array) t.array = [fixType(t.array[0]), t.array[1]];
  return t;
}

function fixIdl(idl: any): any {
  idl.types = idl.types || [];
  const fixAccounts = (accounts: any[]): any[] =>
    (accounts || []).map((account) => {
      if (account.accounts) account.accounts = fixAccounts(account.accounts);
      if ('isMut' in account && account.writable === undefined) account.writable = account.isMut;
      if ('isSigner' in account && account.signer === undefined) account.signer = account.isSigner;
      return account;
    });

  for (const ix of idl.instructions || []) {
    if (!ix.discriminator) {
      const snake = ix.name.includes('_') ? ix.name : ix.name.replace(/([A-Z])/g, '_$1').toLowerCase();
      const preimage = `global:${snake}`;
      const hash = crypto.createHash('sha256').update(preimage).digest();
      ix.discriminator = hash.subarray(0, 8);
    }
    ix.accounts = fixAccounts(ix.accounts || []);
    for (const arg of ix.args || []) arg.type = fixType(arg.type);
  }
  for (const account of idl.accounts || []) {
    if (!account.discriminator) {
      const preimage = `account:${account.name}`;
      const hash = crypto.createHash('sha256').update(preimage).digest();
      account.discriminator = hash.subarray(0, 8);
    }
    if (account.type && !idl.types.find((t: any) => t.name === account.name)) {
      idl.types.push({ name: account.name, type: account.type });
    }
    for (const field of account.type?.fields || []) field.type = fixType(field.type);
  }
  for (const t of idl.types || []) {
    for (const field of t.type?.fields || []) field.type = fixType(field.type);
  }
  return idl;
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function parseCli(): Cli {
  const dryRun = process.argv.includes('--dry-run');
  const capXnt = BigInt(argValue('--cap-xnt') ?? process.env.MELT_CAP_XNT ?? '10');
  const roundWindowSec = Number(argValue('--window-sec') ?? process.env.MELT_WINDOW_SEC ?? '600');
  const rolloverBps = Number(argValue('--rollover-bps') ?? process.env.MELT_ROLLOVER_BPS ?? '2000');
  const burnMinMind = BigInt(argValue('--burn-min-mind') ?? process.env.MELT_BURN_MIN_MIND ?? '10');

  if (capXnt <= 0n) throw new Error('cap-xnt must be > 0');
  if (!Number.isFinite(roundWindowSec) || roundWindowSec <= 0) throw new Error('window-sec must be > 0');
  if (!Number.isFinite(rolloverBps) || rolloverBps < 0 || rolloverBps > 10_000) {
    throw new Error('rollover-bps must be 0..10000');
  }
  if (burnMinMind < 0n) throw new Error('burn-min-mind must be >= 0');

  return { dryRun, capXnt, roundWindowSec, rolloverBps, burnMinMind };
}

function readMeltConfigRaw(data: Buffer) {
  let offset = 8;
  const canRead = (bytes: number) => offset + bytes <= data.length;
  const readPubkey = () => {
    if (!canRead(32)) return null;
    const v = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    return v;
  };
  const readU64 = () => {
    if (!canRead(8)) return null;
    const v = data.readBigUInt64LE(offset);
    offset += 8;
    return v;
  };
  const readU16 = () => {
    if (!canRead(2)) return null;
    const v = data.readUInt16LE(offset);
    offset += 2;
    return v;
  };
  const readBool = () => {
    if (!canRead(1)) return null;
    const v = data.readUInt8(offset) === 1;
    offset += 1;
    return v;
  };

  const admin = readPubkey();
  const mindMint = readPubkey();
  const vault = readPubkey();
  const vaultCapLamports = readU64();
  const rolloverBps = readU16();
  const burnMin = readU64();
  const roundWindowSec = readU64();
  const testMode = readBool();
  const roundSeq = readU64();
  const vialLamports = readU64();
  const bonusPoolLamports = readU64();
  const activeRoundSeq = readU64();
  const activeRoundActive = readBool();
  const pendingWindowSec = readU64();
  const bumpConfig = canRead(1) ? data.readUInt8(offset++) : null;
  const bumpVault = canRead(1) ? data.readUInt8(offset++) : null;

  return {
    admin,
    mindMint,
    vault,
    vaultCapLamports,
    rolloverBps,
    burnMin,
    roundWindowSec,
    testMode,
    roundSeq,
    vialLamports,
    bonusPoolLamports,
    activeRoundSeq,
    activeRoundActive,
    pendingWindowSec,
    bumpConfig,
    bumpVault,
    parsedBytes: offset,
    totalBytes: data.length,
  };
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  assertTestnetOnly(provider);
  const rpc = provider.connection.rpcEndpoint;
  if (!rpc.includes('testnet.x1.xyz')) {
    throw new Error(`Refusing to run outside testnet. Current RPC: ${rpc}`);
  }

  const idlPath = path.join(__dirname, '..', 'target', 'idl', 'melt_v1.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  const programId = new PublicKey(process.env.MELT_V1_PROGRAM_ID ?? idl.address ?? idl.metadata?.address);
  const cli = parseCli();

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED)], programId);
  const info = await provider.connection.getAccountInfo(configPda, 'confirmed');
  if (!info) {
    throw new Error(`MELT config not initialized: ${configPda.toBase58()}`);
  }

  const cfg = readMeltConfigRaw(info.data);
  const targetCapLamports = cli.capXnt * LAMPORTS_PER_XNT;
  const targetBurnMin = cli.burnMinMind * LAMPORTS_PER_XNT;

  console.log('cluster', rpc);
  console.log('programId', programId.toBase58());
  console.log('configPda', configPda.toBase58());
  console.log('admin', cfg.admin?.toBase58() ?? null);
  console.log('config_bytes', info.data.length);
  console.log('current', {
    vaultCapLamports: cfg.vaultCapLamports?.toString() ?? null,
    rolloverBps: cfg.rolloverBps,
    burnMin: cfg.burnMin?.toString() ?? null,
    roundWindowSec: cfg.roundWindowSec?.toString() ?? null,
    testMode: cfg.testMode,
    vialLamports: cfg.vialLamports?.toString() ?? null,
    bonusPoolLamports: cfg.bonusPoolLamports?.toString() ?? null,
    activeRoundActive: cfg.activeRoundActive,
    parsedBytes: cfg.parsedBytes,
  });
  console.log('target', {
    capXnt: cli.capXnt.toString(),
    capLamports: targetCapLamports.toString(),
    roundWindowSec: cli.roundWindowSec,
    rolloverBps: cli.rolloverBps,
    burnMinMind: cli.burnMinMind.toString(),
    burnMinBaseUnits: targetBurnMin.toString(),
  });
  const rentMin = await provider.connection.getMinimumBalanceForRentExemption(MELT_CONFIG_NEW_SIZE);
  const currentLamports = info.lamports;
  const topUpLamports = Math.max(0, rentMin - currentLamports);
  console.log('rent', {
    targetSize: MELT_CONFIG_NEW_SIZE,
    rentMin,
    currentLamports,
    topUpLamports,
  });

  if (cli.dryRun) {
    console.log('dry_run', 'No transactions sent.');
    return;
  }

  if (topUpLamports > 0) {
    const topUpIx = SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: configPda,
      lamports: topUpLamports,
    });
    const topUpSig = await provider.sendAndConfirm(new Transaction().add(topUpIx), []);
    console.log('topup_sig', topUpSig);
  }

  const migrateDisc = crypto
    .createHash('sha256')
    .update('global:admin_migrate_config')
    .digest()
    .subarray(0, 8);
  const migrateIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(migrateDisc),
  });
  const migrateSig = await provider.sendAndConfirm(new Transaction().add(migrateIx), []);

  const setParamsDisc = crypto
    .createHash('sha256')
    .update('global:admin_set_params')
    .digest()
    .subarray(0, 8);
  const vaultCapBuf = Buffer.alloc(8);
  vaultCapBuf.writeBigUInt64LE(targetCapLamports, 0);
  const rolloverBuf = Buffer.alloc(2);
  rolloverBuf.writeUInt16LE(cli.rolloverBps, 0);
  const burnMinBuf = Buffer.alloc(8);
  burnMinBuf.writeBigUInt64LE(targetBurnMin, 0);
  const windowBuf = Buffer.alloc(8);
  windowBuf.writeBigUInt64LE(BigInt(cli.roundWindowSec), 0);
  const setParamsData = Buffer.concat([
    setParamsDisc,
    Buffer.from([1]),
    vaultCapBuf,
    Buffer.from([1]),
    rolloverBuf,
    Buffer.from([1]),
    burnMinBuf,
    Buffer.from([1]),
    windowBuf,
  ]);
  const setParamsIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
    ],
    data: setParamsData,
  });
  const setParamsSig = await provider.sendAndConfirm(new Transaction().add(setParamsIx), []);

  const infoAfter = await provider.connection.getAccountInfo(configPda, 'confirmed');
  if (!infoAfter) {
    throw new Error(`MELT config missing after migrate: ${configPda.toBase58()}`);
  }
  const after = readMeltConfigRaw(infoAfter.data);
  console.log('migrate_sig', migrateSig);
  console.log('set_params_sig', setParamsSig);
  console.log('after', {
    vaultCapLamports: after.vaultCapLamports?.toString() ?? null,
    rolloverBps: after.rolloverBps,
    burnMin: after.burnMin?.toString() ?? null,
    roundWindowSec: after.roundWindowSec?.toString() ?? null,
    parsedBytes: after.parsedBytes,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
