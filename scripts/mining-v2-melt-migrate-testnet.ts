import 'dotenv/config';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as anchor from '@coral-xyz/anchor';
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

const CONFIG_SEED = 'config';
const LAMPORTS_PER_XNT = 1_000_000_000n;
const MINING_CONFIG_NEW_SIZE = 357;

type Cli = {
  dryRun: boolean;
  meltEnabled: boolean;
  meltProgramId: PublicKey;
  meltFundingBps: number;
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

function parseBool(v: string | undefined, fallback: boolean) {
  if (!v) return fallback;
  if (v === '1' || v.toLowerCase() === 'true') return true;
  if (v === '0' || v.toLowerCase() === 'false') return false;
  throw new Error(`Invalid boolean value: ${v}`);
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function parseCli(): Cli {
  const dryRun = process.argv.includes('--dry-run');
  const meltProgramStr = argValue('--melt-program-id') ?? process.env.MELT_V1_PROGRAM_ID;
  if (!meltProgramStr) {
    throw new Error('Missing --melt-program-id or MELT_V1_PROGRAM_ID');
  }
  const meltProgramId = new PublicKey(meltProgramStr);
  const meltEnabled = parseBool(argValue('--enabled'), true);
  const meltFundingBps = Number(argValue('--funding-bps') ?? process.env.MELT_FUNDING_BPS ?? '9500');
  if (!Number.isFinite(meltFundingBps) || meltFundingBps < 0 || meltFundingBps > 10_000) {
    throw new Error(`Invalid funding bps: ${meltFundingBps}`);
  }
  return {
    dryRun,
    meltEnabled,
    meltProgramId,
    meltFundingBps,
  };
}

function readConfigRaw(data: Buffer) {
  let offset = 8; // account discriminator
  const readPubkey = () => {
    const pk = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    return pk;
  };
  const readU64 = () => {
    const v = data.readBigUInt64LE(offset);
    offset += 8;
    return v;
  };
  const readU128 = () => {
    const lo = data.readBigUInt64LE(offset);
    const hi = data.readBigUInt64LE(offset + 8);
    offset += 16;
    return (hi << 64n) + lo;
  };
  const readI64 = () => {
    const v = data.readBigInt64LE(offset);
    offset += 8;
    return v;
  };

  const admin = readPubkey();
  const emissionPerSec = readU64();
  const accMindPerHp = readU128();
  const lastUpdateTs = readI64();
  const networkHpActive = readU64();
  const mindMint = readPubkey();
  const xntMint = readPubkey();
  const stakingRewardVault = readPubkey();
  const treasuryVault = readPubkey();
  const stakingMindVault = readPubkey();
  const maxEffectiveHp = readU64();
  const secondsPerDay = readU64();
  const stakingAccXntPerMind = readU128();
  const stakingLastUpdateTs = readI64();
  const stakingRewardRate = readU64();
  const stakingEpochEndTs = readI64();
  const stakingTotalStaked = readU64();
  const stakingUndistributed = readU64();
  const stakingAccountedBalance = readU64();

  let meltEnabled = false;
  let meltProgramId = PublicKey.default;
  let meltFundingBps = 0;
  let bumpConfig = 0;
  let bumpVaultAuthority = 0;

  if (offset < data.length) {
    meltEnabled = data.readUInt8(offset) === 1;
    offset += 1;
  }
  if (offset + 32 <= data.length) {
    meltProgramId = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
  }
  if (offset + 2 <= data.length) {
    meltFundingBps = data.readUInt16LE(offset);
    offset += 2;
  }
  if (offset < data.length) {
    bumpConfig = data.readUInt8(offset);
    offset += 1;
  }
  if (offset < data.length) {
    bumpVaultAuthority = data.readUInt8(offset);
    offset += 1;
  }

  return {
    admin,
    emissionPerSec,
    accMindPerHp,
    lastUpdateTs,
    networkHpActive,
    mindMint,
    xntMint,
    stakingRewardVault,
    treasuryVault,
    stakingMindVault,
    maxEffectiveHp,
    secondsPerDay,
    stakingAccXntPerMind,
    stakingLastUpdateTs,
    stakingRewardRate,
    stakingEpochEndTs,
    stakingTotalStaked,
    stakingUndistributed,
    stakingAccountedBalance,
    meltEnabled,
    meltProgramId,
    meltFundingBps,
    bumpConfig,
    bumpVaultAuthority,
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

  const idlPath = path.join(__dirname, '..', 'target', 'idl', 'mining_v2.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  const idlProgramId = idl.address ?? idl.metadata?.address ?? process.env.MINING_V2_PROGRAM_ID;
  if (!idlProgramId && !process.env.MINING_V2_PROGRAM_ID) {
    throw new Error('Missing mining_v2 program id (set MINING_V2_PROGRAM_ID)');
  }
  const programId = new PublicKey(process.env.MINING_V2_PROGRAM_ID ?? idlProgramId);
  const cli = parseCli();
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED)], programId);
  const info = await provider.connection.getAccountInfo(configPda, 'confirmed');
  if (!info) {
    throw new Error(`Config PDA not found: ${configPda.toBase58()}`);
  }

  const raw = readConfigRaw(info.data);

  console.log('cluster', rpc);
  console.log('programId', programId.toBase58());
  console.log('configPda', configPda.toBase58());
  console.log('admin', raw.admin.toBase58());
  console.log('config_bytes', raw.totalBytes);
  console.log('config_parsed_bytes', raw.parsedBytes);
  console.log('seconds_per_day', raw.secondsPerDay.toString());
  console.log('current_melt', {
    enabled: raw.meltEnabled,
    programId: raw.meltProgramId.toBase58(),
    fundingBps: raw.meltFundingBps,
  });
  console.log('target_melt', {
    enabled: cli.meltEnabled,
    programId: cli.meltProgramId.toBase58(),
    fundingBps: cli.meltFundingBps,
  });
  console.log('notes', {
    expectedMeltShareFor1Xnt: `${(1_000_000_000n * BigInt(cli.meltFundingBps)) / 10_000n} lamports`,
    expectedMeltSharePct: `${(cli.meltFundingBps / 100).toFixed(2)}%`,
    targetRoundCap: `10 XNT = ${10n * LAMPORTS_PER_XNT} lamports`,
  });
  const rentMin = await provider.connection.getMinimumBalanceForRentExemption(MINING_CONFIG_NEW_SIZE);
  const currentLamports = info.lamports;
  const topUpLamports = Math.max(0, rentMin - currentLamports);
  console.log('rent', {
    targetSize: MINING_CONFIG_NEW_SIZE,
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

  const adminMigrateDisc = crypto
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
    data: Buffer.from(adminMigrateDisc),
  });
  const migrateSig = await provider.sendAndConfirm(new Transaction().add(migrateIx), []);

  const setMeltDisc = crypto
    .createHash('sha256')
    .update('global:admin_set_melt_config')
    .digest()
    .subarray(0, 8);
  const enabledByte = Buffer.from([cli.meltEnabled ? 1 : 0]);
  const meltFundingBps = Buffer.alloc(2);
  meltFundingBps.writeUInt16LE(cli.meltFundingBps, 0);
  const setMeltData = Buffer.concat([setMeltDisc, enabledByte, cli.meltProgramId.toBuffer(), meltFundingBps]);
  const setMeltIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
    ],
    data: setMeltData,
  });
  const setMeltSig = await provider.sendAndConfirm(new Transaction().add(setMeltIx), []);

  const infoAfter = await provider.connection.getAccountInfo(configPda, 'confirmed');
  if (!infoAfter) {
    throw new Error(`Config PDA disappeared after migrate: ${configPda.toBase58()}`);
  }
  const rawAfter = readConfigRaw(infoAfter.data);
  console.log('migrate_sig', migrateSig);
  console.log('set_melt_sig', setMeltSig);
  console.log('after', {
    meltEnabled: rawAfter.meltEnabled,
    meltProgramId: rawAfter.meltProgramId.toBase58(),
    meltFundingBps: rawAfter.meltFundingBps,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
