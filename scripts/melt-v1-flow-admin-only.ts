import 'dotenv/config';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as anchor from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';

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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function toXnt(lamports: number | bigint | string): number {
  return Number(lamports) / 1e9;
}

function toPubkey(v: any): PublicKey {
  return v instanceof PublicKey ? v : new PublicKey(v);
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
  const fixAccounts = (accs: any[]): any[] => {
    return (accs || []).map((acc) => {
      if (acc.accounts) {
        acc.accounts = fixAccounts(acc.accounts);
      }
      if ('isMut' in acc && acc.writable === undefined) {
        acc.writable = acc.isMut;
      }
      if ('isSigner' in acc && acc.signer === undefined) {
        acc.signer = acc.isSigner;
      }
      return acc;
    });
  };

  for (const ix of idl.instructions || []) {
    if (!ix.discriminator) {
      const snake = ix.name.includes('_') ? ix.name : ix.name.replace(/([A-Z])/g, '_$1').toLowerCase();
      const preimage = `global:${snake}`;
      const hash = crypto.createHash('sha256').update(preimage).digest();
      ix.discriminator = hash.subarray(0, 8);
    }
    ix.accounts = fixAccounts(ix.accounts || []);
    if (ix.name === 'burnMind' || ix.name === 'burn_mind') {
      for (const acc of ix.accounts || []) {
        if (acc.name === 'mindMint' || acc.name === 'mind_mint') {
          acc.writable = true;
        }
      }
    }
    for (const arg of ix.args || []) {
      arg.type = fixType(arg.type);
    }
  }
  for (const acc of idl.accounts || []) {
    if (!acc.discriminator) {
      const preimage = `account:${acc.name}`;
      const hash = crypto.createHash('sha256').update(preimage).digest();
      acc.discriminator = hash.subarray(0, 8);
    }
    if (acc.type && !idl.types.find((t: any) => t.name === acc.name)) {
      idl.types.push({ name: acc.name, type: acc.type });
    }
    for (const field of acc.type?.fields || []) {
      field.type = fixType(field.type);
    }
  }
  for (const t of idl.types || []) {
    for (const field of t.type?.fields || []) {
      field.type = fixType(field.type);
    }
  }
  for (const ev of idl.events || []) {
    if (!ev.discriminator) {
      const preimage = `event:${ev.name}`;
      const hash = crypto.createHash('sha256').update(preimage).digest();
      ev.discriminator = hash.subarray(0, 8);
    }
    if (ev.fields && !idl.types.find((t: any) => t.name === ev.name)) {
      idl.types.push({
        name: ev.name,
        type: { kind: 'struct', fields: ev.fields },
      });
    }
    for (const field of ev.fields || []) {
      field.type = fixType(field.type);
    }
  }
  return idl;
}

async function ensureAta(opts: {
  payer: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  connection: anchor.web3.Connection;
}) {
  const ata = getAssociatedTokenAddressSync(opts.mint, opts.owner, false);
  const info = await opts.connection.getAccountInfo(ata);
  if (info) return ata;
  const ix = createAssociatedTokenAccountInstruction(opts.payer, ata, opts.owner, opts.mint);
  const tx = new anchor.web3.Transaction().add(ix);
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  await provider.sendAndConfirm(tx, []);
  return ata;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  assertTestnetOnly(provider);
  const connection = provider.connection;
  const commitment: anchor.web3.Commitment = 'confirmed';

  const programId = new PublicKey(mustEnv('MELT_V1_PROGRAM_ID'));
  const mindMint = new PublicKey(mustEnv('MIND_MINT'));

  const idlPath = path.join(__dirname, '..', 'target', 'idl', 'melt_v1.json');
  const idl = fixIdl(JSON.parse(fs.readFileSync(idlPath, 'utf8')));
  idl.address = programId.toBase58();
  const program: any = new (anchor as any).Program(idl, provider);

  const adminPk = provider.wallet.publicKey;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('melt_config')], programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('melt_vault')], programId);

  const sigs: Record<string, string> = {};

  console.log('cluster', connection.rpcEndpoint);
  console.log('programId', programId.toBase58());
  console.log('admin', adminPk.toBase58());
  console.log('configPda', configPda.toBase58());
  console.log('vaultPda', vaultPda.toBase58());

  // 1) Init melt if missing
  const cfgInfo = await connection.getAccountInfo(configPda);
  if (!cfgInfo) {
    console.log('init_melt: creating config/vault');
    const vaultCapLamports = new anchor.BN(10n * 1_000_000_000n);
    const burnMin = new anchor.BN(10n * 1_000_000_000n); // 10 MIND
    const roundWindowSec = new anchor.BN(600);
    await program.methods
      .initMelt({
        vaultCapXnt: vaultCapLamports,
        rolloverBps: 2000,
        burnMin,
        roundWindowSec,
        testMode: true,
      })
      .accounts({
        payer: adminPk,
        admin: adminPk,
        mindMint,
        config: configPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  } else {
    console.log('init_melt: already initialized');
  }

  const cfg = await (program.account as any).meltConfig.fetch(configPda);
  const vaultPk = toPubkey(cfg.vault);
  console.log('vaultFromConfig', vaultPk.toBase58());
  const roundSeq = BigInt(cfg.roundSeq.toString());
  const seqBuf = Buffer.alloc(8);
  seqBuf.writeBigUInt64LE(roundSeq);
  const [roundPda] = PublicKey.findProgramAddressSync([Buffer.from('melt_round'), seqBuf], programId);
  console.log('roundSeq', roundSeq.toString(), 'roundPda', roundPda.toBase58());

  // 2) Topup vault (admin)
  const topupLamports = BigInt(process.env.MELT_TEST_TOPUP_XNT || '10') * 1_000_000_000n;
  console.log('admin_topup_vault', toXnt(topupLamports), 'XNT');
  sigs.topup = await program.methods
    .adminTopupVault(new anchor.BN(topupLamports))
    .accounts({
      admin: adminPk,
      config: configPda,
      vault: vaultPk,
      round: roundPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log('sig admin_topup_vault', sigs.topup);

  // 3) Ensure admin has MIND ATA
  const adminAta = await ensureAta({ payer: adminPk, owner: adminPk, mint: mindMint, connection });

  // 4) Set short schedule for tests (admin)
  const now = Math.floor(Date.now() / 1000);
  const startTs = Number(process.env.MELT_TEST_START_TS || (now + 5));
  const endTs = Number(process.env.MELT_TEST_END_TS || (startTs + 45));
  console.log('admin_set_schedule', { startTs, endTs });
  sigs.set_schedule = await program.methods
    .adminSetSchedule(new anchor.BN(startTs), new anchor.BN(endTs))
    .accounts({
      admin: adminPk,
      config: configPda,
      round: roundPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log('sig admin_set_schedule', sigs.set_schedule);

  // 6) Start round (admin)
  while (Math.floor(Date.now() / 1000) < startTs) {
    await sleep(750);
  }
  console.log('start_round');
  sigs.start = await program.methods
    .startRound()
    .accounts({
      admin: adminPk,
      config: configPda,
      vault: vaultPk,
      round: roundPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log('sig start_round', sigs.start);

  // 7) Admin burns MIND
  const burnAmountMind = BigInt(process.env.MELT_TEST_BURN_MIND || '20') * 1_000_000_000n;
  console.log('burn_mind (admin)', Number(burnAmountMind) / 1e9, 'MIND');

  const [adminRoundPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('melt_user_round'), adminPk.toBuffer(), roundPda.toBuffer()],
    programId,
  );

  sigs.burn = await program.methods
    .burnMind(new anchor.BN(burnAmountMind))
    .accounts({
      user: adminPk,
      config: configPda,
      round: roundPda,
      mindMint,
      userMindAta: adminAta,
      userRound: adminRoundPda,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log('sig burn_mind', sigs.burn);

  // 8) Finalize
  while (Math.floor(Date.now() / 1000) <= endTs) {
    await sleep(1000);
  }
  console.log('finalize_round');
  sigs.finalize = await program.methods
    .finalizeRound()
    .accounts({
      admin: adminPk,
      config: configPda,
      round: roundPda,
      vault: vaultPk,
    })
    .rpc();
  console.log('sig finalize_round', sigs.finalize);

  // 9) Claim
  const adminBalBeforeClaim = await connection.getBalance(adminPk, commitment);
  console.log('claim (admin)');
  let claimError: any = null;
  try {
    sigs.claim = await program.methods
      .claim()
      .accounts({
        user: adminPk,
        config: configPda,
        vault: vaultPk,
        round: roundPda,
        userRound: adminRoundPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log('sig claim', sigs.claim);
  } catch (err) {
    claimError = err;
    console.error('claim failed', err);
  }

  const adminBalAfterClaim = await connection.getBalance(adminPk, commitment);

  const round = await (program.account as any).meltRound.fetch(roundPda);
  const userRound = await (program.account as any).meltUserRound.fetch(adminRoundPda);

  const vaultBal = await connection.getBalance(vaultPk);
  console.log('vault balance (lamports)', vaultBal, '=>', toXnt(vaultBal), 'XNT');

  let payoutLamports: number | null = null;
  if (sigs.claim) {
    const claimTx = await connection.getTransaction(sigs.claim, {
      commitment,
      maxSupportedTransactionVersion: 0,
    });
    const claimFee = claimTx?.meta?.fee ?? 0;
    payoutLamports = adminBalAfterClaim - adminBalBeforeClaim + claimFee;
  }

  console.log('--- signatures ---');
  console.log('topup', sigs.topup);
  console.log('set_schedule', sigs.set_schedule);
  console.log('start', sigs.start);
  console.log('burn', sigs.burn);
  console.log('finalize', sigs.finalize);
  console.log('claim', sigs.claim);

  console.log('--- round state ---');
  console.log('v_round', round.vRound.toString(), '=>', toXnt(round.vRound.toString()), 'XNT');
  console.log('v_pay', round.vPay.toString(), '=>', toXnt(round.vPay.toString()), 'XNT');
  console.log('total_burn', round.totalBurn.toString(), '=>', Number(round.totalBurn.toString()) / 1e9, 'MIND');
  console.log('user_burn', userRound.burned.toString(), '=>', Number(userRound.burned.toString()) / 1e9, 'MIND');
  if (payoutLamports === null) {
    console.log('payout (lamports)', 'n/a (claim failed)');
  } else {
    console.log('payout (lamports)', payoutLamports, '=>', toXnt(payoutLamports), 'XNT');
  }

  if (claimError) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
