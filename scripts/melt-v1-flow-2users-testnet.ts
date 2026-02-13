import 'dotenv/config';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as anchor from '@coral-xyz/anchor';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
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
      if (acc.accounts) acc.accounts = fixAccounts(acc.accounts);
      if ('isMut' in acc && acc.writable === undefined) acc.writable = acc.isMut;
      if ('isSigner' in acc && acc.signer === undefined) acc.signer = acc.isSigner;
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
    for (const arg of ix.args || []) arg.type = fixType(arg.type);
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
    for (const field of acc.type?.fields || []) field.type = fixType(field.type);
  }

  for (const t of idl.types || []) {
    for (const field of t.type?.fields || []) field.type = fixType(field.type);
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
    for (const field of ev.fields || []) field.type = fixType(field.type);
  }
  return idl;
}

async function ensureAtaIx(opts: {
  payer: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  connection: anchor.web3.Connection;
}) {
  const ata = getAssociatedTokenAddressSync(opts.mint, opts.owner, false);
  const info = await opts.connection.getAccountInfo(ata);
  if (info) return { ata, ix: null as any };
  const ix = createAssociatedTokenAccountInstruction(opts.payer, ata, opts.owner, opts.mint);
  return { ata, ix };
}

function writeKeypair(filePath: string, kp: Keypair) {
  fs.writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)));
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
  const adminPk = provider.wallet.publicKey;

  const tmpDir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const userA = Keypair.generate();
  const userB = Keypair.generate();
  const userAPath = path.join(tmpDir, 'melt_userA.json');
  const userBPath = path.join(tmpDir, 'melt_userB.json');
  writeKeypair(userAPath, userA);
  writeKeypair(userBPath, userB);

  const idl = fixIdl(JSON.parse(fs.readFileSync(idlPath, 'utf8')));
  idl.address = programId.toBase58();
  const program: any = new (anchor as any).Program(idl, provider);
  const userAProvider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(userA),
    provider.opts,
  );
  const userBProvider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(userB),
    provider.opts,
  );
  const programUserA: any = new (anchor as any).Program(idl, userAProvider);
  const programUserB: any = new (anchor as any).Program(idl, userBProvider);

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('melt_config')], programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('melt_vault')], programId);

  console.log('cluster', connection.rpcEndpoint);
  console.log('programId', programId.toBase58());
  console.log('admin', adminPk.toBase58());
  console.log('userA', userA.publicKey.toBase58());
  console.log('userB', userB.publicKey.toBase58());
  console.log('userAKeypair', userAPath);
  console.log('userBKeypair', userBPath);
  console.log('configPda', configPda.toBase58());
  console.log('vaultPda', vaultPda.toBase58());

  const cfgInfo = await connection.getAccountInfo(configPda);
  if (!cfgInfo) {
    throw new Error('Config not initialized. Run admin init first.');
  }
  const cfg = await (program.account as any).meltConfig.fetch(configPda);
  const vaultPk = toPubkey(cfg.vault);
  console.log('vaultFromConfig', vaultPk.toBase58());

  // 1) Fund users with lamports for fees
  const feeLamports = 5n * 1_000_000_000n;
  const feeTx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({ fromPubkey: adminPk, toPubkey: userA.publicKey, lamports: feeLamports }),
    SystemProgram.transfer({ fromPubkey: adminPk, toPubkey: userB.publicKey, lamports: feeLamports }),
  );
  await provider.sendAndConfirm(feeTx, []);

  // 2) Transfer MIND to users (ensure ATAs)
  const userAAmount = 20n * 1_000_000_000n;
  const userBAmount = 60n * 1_000_000_000n;
  const totalMind = userAAmount + userBAmount;

  const { ata: adminAta, ix: ixAdminAta } = await ensureAtaIx({
    payer: adminPk,
    owner: adminPk,
    mint: mindMint,
    connection,
  });
  if (ixAdminAta) {
    const tx = new anchor.web3.Transaction().add(ixAdminAta);
    await provider.sendAndConfirm(tx, []);
  }
  const adminAtaInfo = await connection.getTokenAccountBalance(adminAta);
  const adminMind = BigInt(adminAtaInfo.value.amount);
  if (adminMind < totalMind) {
    throw new Error(
      `Admin MIND balance too low: have ${Number(adminMind) / 1e9}, need ${Number(totalMind) / 1e9}`,
    );
  }

  const { ata: userAAta, ix: ixUserAAta } = await ensureAtaIx({
    payer: adminPk,
    owner: userA.publicKey,
    mint: mindMint,
    connection,
  });
  const { ata: userBAta, ix: ixUserBAta } = await ensureAtaIx({
    payer: adminPk,
    owner: userB.publicKey,
    mint: mindMint,
    connection,
  });

  const mindTx = new anchor.web3.Transaction();
  if (ixUserAAta) mindTx.add(ixUserAAta);
  if (ixUserBAta) mindTx.add(ixUserBAta);
  mindTx.add(
    createTransferInstruction(adminAta, userAAta, adminPk, userAAmount),
    createTransferInstruction(adminAta, userBAta, adminPk, userBAmount),
  );
  await provider.sendAndConfirm(mindTx, []);

  // 3) Round setup
  const roundSeq = BigInt(cfg.roundSeq.toString());
  const seqBuf = Buffer.alloc(8);
  seqBuf.writeBigUInt64LE(roundSeq);
  const [roundPda] = PublicKey.findProgramAddressSync([Buffer.from('melt_round'), seqBuf], programId);
  console.log('roundSeq', roundSeq.toString(), 'roundPda', roundPda.toBase58());

  // 4) Topup vault (admin)
  const topupLamports = 10n * 1_000_000_000n;
  const sigTopup = await program.methods
    .adminTopupVault(new anchor.BN(topupLamports))
    .accounts({
      admin: adminPk,
      config: configPda,
      vault: vaultPk,
      round: roundPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const now = Math.floor(Date.now() / 1000);
  const startTs = Number(process.env.MELT_TEST_START_TS || now + 5);
  const endTs = Number(process.env.MELT_TEST_END_TS || startTs + 75);
  const sigSchedule = await program.methods
    .adminSetSchedule(new anchor.BN(startTs), new anchor.BN(endTs))
    .accounts({
      admin: adminPk,
      config: configPda,
      round: roundPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  while (Math.floor(Date.now() / 1000) < startTs + 1) {
    await sleep(750);
  }
  const sigStart = await program.methods
    .startRound()
    .accounts({
      admin: adminPk,
      config: configPda,
      vault: vaultPk,
      round: roundPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // 5) Burns in round
  const [userARoundPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('melt_user_round'), userA.publicKey.toBuffer(), roundPda.toBuffer()],
    programId,
  );
  const [userBRoundPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('melt_user_round'), userB.publicKey.toBuffer(), roundPda.toBuffer()],
    programId,
  );

  const sigBurnA = await program.methods
    .burnMind(new anchor.BN(userAAmount))
    .accounts({
      user: userA.publicKey,
      config: configPda,
      round: roundPda,
      mindMint,
      userMindAta: userAAta,
      userRound: userARoundPda,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([userA])
    .rpc();

  const sigBurnB = await program.methods
    .burnMind(new anchor.BN(userBAmount))
    .accounts({
      user: userB.publicKey,
      config: configPda,
      round: roundPda,
      mindMint,
      userMindAta: userBAta,
      userRound: userBRoundPda,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([userB])
    .rpc();

  // 6) Finalize after end
  while (Math.floor(Date.now() / 1000) <= endTs) {
    await sleep(1000);
  }
  const sigFinalize = await program.methods
    .finalizeRound()
    .accounts({
      admin: adminPk,
      config: configPda,
      round: roundPda,
      vault: vaultPk,
    })
    .rpc();

  // 7) Claims
  const vaultBeforeClaims = await connection.getBalance(vaultPk, commitment);

  const balA0 = await connection.getBalance(userA.publicKey, commitment);
  const sigClaimA = await programUserA.methods
    .claim()
    .accounts({
      user: userA.publicKey,
      config: configPda,
      vault: vaultPk,
      round: roundPda,
      userRound: userARoundPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  const balA1 = await connection.getBalance(userA.publicKey, commitment);

  const balB0 = await connection.getBalance(userB.publicKey, commitment);
  const sigClaimB = await programUserB.methods
    .claim()
    .accounts({
      user: userB.publicKey,
      config: configPda,
      vault: vaultPk,
      round: roundPda,
      userRound: userBRoundPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  const balB1 = await connection.getBalance(userB.publicKey, commitment);

  const claimATx = await connection.getTransaction(sigClaimA, {
    commitment,
    maxSupportedTransactionVersion: 0,
  });
  const claimBTx = await connection.getTransaction(sigClaimB, {
    commitment,
    maxSupportedTransactionVersion: 0,
  });
  const feeA = claimATx?.meta?.fee ?? 0;
  const feeB = claimBTx?.meta?.fee ?? 0;

  const deltaA = balA1 - balA0;
  const deltaB = balB1 - balB0;

  // 8) Verify payouts
  const round = await (program.account as any).meltRound.fetch(roundPda);
  const vPay = BigInt(round.vPay.toString());
  const expectedA = (vPay * 20n) / 80n;
  const expectedB = (vPay * 60n) / 80n;

  const payoutA = BigInt(deltaA + feeA);
  const payoutB = BigInt(deltaB + feeB);

  const diffA = payoutA >= expectedA ? payoutA - expectedA : expectedA - payoutA;
  const diffB = payoutB >= expectedB ? payoutB - expectedB : expectedB - payoutB;
  const okA = diffA <= 1n;
  const okB = diffB <= 1n;

  const vaultAfterClaims = await connection.getBalance(vaultPk, commitment);
  const vaultDelta = BigInt(vaultAfterClaims) - BigInt(vaultBeforeClaims);
  const okVault = vaultDelta === -(payoutA + payoutB);

  console.log('--- signatures ---');
  console.log('topup', sigTopup);
  console.log('set_schedule', sigSchedule);
  console.log('start', sigStart);
  console.log('burnA', sigBurnA);
  console.log('burnB', sigBurnB);
  console.log('finalize', sigFinalize);
  console.log('claimA', sigClaimA);
  console.log('claimB', sigClaimB);

  console.log('--- round state ---');
  console.log('v_round', round.vRound.toString(), '=>', toXnt(round.vRound.toString()), 'XNT');
  console.log('v_pay', round.vPay.toString(), '=>', toXnt(round.vPay.toString()), 'XNT');
  console.log('total_burn', round.totalBurn.toString(), '=>', Number(round.totalBurn.toString()) / 1e9, 'MIND');

  console.log('--- payouts ---');
  console.log('expectedA', expectedA.toString(), '=>', toXnt(expectedA.toString()), 'XNT');
  console.log('expectedB', expectedB.toString(), '=>', toXnt(expectedB.toString()), 'XNT');
  console.log('deltaA', deltaA, 'feeA', feeA, 'payoutA', payoutA.toString(), okA ? 'PASS' : 'FAIL');
  console.log('deltaB', deltaB, 'feeB', feeB, 'payoutB', payoutB.toString(), okB ? 'PASS' : 'FAIL');
  console.log(
    'vault delta (lamports)',
    vaultDelta.toString(),
    okVault ? 'PASS' : 'FAIL',
  );
  console.log('vault balance (lamports)', vaultAfterClaims, '=>', toXnt(vaultAfterClaims), 'XNT');

  if (!okA || !okB || !okVault) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
