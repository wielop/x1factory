import 'dotenv/config';

import fs from 'fs';
import path from 'path';
import * as anchor from '@coral-xyz/anchor';
import { PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} from '@solana/spl-token';

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
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

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;

  const programId = new PublicKey(mustEnv('MELT_V1_PROGRAM_ID'));
  const mindMint = new PublicKey(mustEnv('MIND_MINT'));

  const userKeypairPath = mustEnv('MELT_TEST_USER_KEYPAIR');
  const user = loadKeypair(userKeypairPath);

  const idlPath = path.join(__dirname, '..', 'target', 'idl', 'melt_v1.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  const program = new anchor.Program(idl, programId, provider);

  const adminPk = provider.wallet.publicKey;
  const userPk = user.publicKey;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('melt_config')], programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('melt_vault')], programId);

  console.log('cluster', connection.rpcEndpoint);
  console.log('programId', programId.toBase58());
  console.log('admin', adminPk.toBase58());
  console.log('user', userPk.toBase58());
  console.log('configPda', configPda.toBase58());
  console.log('vaultPda', vaultPda.toBase58());

  // 1) Init melt if missing
  const cfgInfo = await connection.getAccountInfo(configPda);
  if (!cfgInfo) {
    console.log('init_melt: creating config/vault');
    const vaultCapLamports = new anchor.BN(150n * 1_000_000_000n);
    const burnMin = new anchor.BN(10n * 1_000_000_000n); // 10 MIND
    const roundWindowSec = new anchor.BN(24 * 3600);
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

  // 2) Topup vault (admin)
  const topupLamports = BigInt(process.env.MELT_TEST_TOPUP_XNT || '5') * 1_000_000_000n;
  console.log('admin_topup_vault', Number(topupLamports) / 1e9, 'XNT');
  await program.methods
    .adminTopupVault(new anchor.BN(topupLamports))
    .accounts({
      admin: adminPk,
      config: configPda,
      vault: vaultPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // 3) Ensure user has some MIND by transferring from admin ATA
  const burnAmountMind = BigInt(process.env.MELT_TEST_BURN_MIND || '20') * 1_000_000_000n;
  console.log('burnAmountMind', Number(burnAmountMind) / 1e9, 'MIND');

  const { ata: adminAta, ix: ixAdminAta } = await ensureAtaIx({ payer: adminPk, owner: adminPk, mint: mindMint, connection });
  const { ata: userAta, ix: ixUserAta } = await ensureAtaIx({ payer: adminPk, owner: userPk, mint: mindMint, connection });

  const txIxs: anchor.web3.TransactionInstruction[] = [];
  if (ixAdminAta) txIxs.push(ixAdminAta);
  if (ixUserAta) txIxs.push(ixUserAta);
  // transfer a bit more than burn, so user has enough
  const transferAmt = burnAmountMind + 5n * 1_000_000_000n;
  txIxs.push(createTransferInstruction(adminAta, userAta, adminPk, BigInt(transferAmt)) as any);

  if (txIxs.length) {
    const tx = new anchor.web3.Transaction().add(...txIxs);
    const sig = await provider.sendAndConfirm(tx, []);
    console.log('fund user MIND sig', sig);
  }

  // 4) Derive current round PDA (seq from config)
  const cfg = await (program.account as any).meltConfig.fetch(configPda);
  const roundSeq = BigInt(cfg.roundSeq.toString());
  const seqBuf = Buffer.alloc(8);
  seqBuf.writeBigUInt64LE(roundSeq);
  const [roundPda] = PublicKey.findProgramAddressSync([Buffer.from('melt_round'), seqBuf], programId);

  console.log('roundSeq', roundSeq.toString(), 'roundPda', roundPda.toBase58());

  // 5) Set short schedule for tests (admin)
  const now = Math.floor(Date.now() / 1000);
  const startTs = Number(process.env.MELT_TEST_START_TS || (now + 5));
  const endTs = Number(process.env.MELT_TEST_END_TS || (startTs + 45));
  console.log('admin_set_schedule', { startTs, endTs });
  await program.methods
    .adminSetSchedule(new anchor.BN(startTs), new anchor.BN(endTs))
    .accounts({
      admin: adminPk,
      config: configPda,
      round: roundPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // 6) Start round (admin) - must be >= startTs
  while (Math.floor(Date.now() / 1000) < startTs) {
    await sleep(750);
  }
  console.log('start_round');
  await program.methods
    .startRound()
    .accounts({
      admin: adminPk,
      config: configPda,
      vault: vaultPda,
      round: roundPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // 7) User burns MIND
  const [userRoundPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('melt_user_round'), userPk.toBuffer(), roundPda.toBuffer()],
    programId,
  );
  console.log('burn_mind as user');
  const burnTx = await program.methods
    .burnMind(new anchor.BN(burnAmountMind))
    .accounts({
      user: userPk,
      config: configPda,
      round: roundPda,
      mindMint,
      userMindAta: userAta,
      userRound: userRoundPda,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  burnTx.feePayer = userPk;
  burnTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  burnTx.sign(user);
  const burnSig = await connection.sendRawTransaction(burnTx.serialize());
  await connection.confirmTransaction(burnSig, 'confirmed');
  console.log('burn sig', burnSig);

  // 8) Finalize after endTs (admin)
  while (Math.floor(Date.now() / 1000) <= endTs) {
    await sleep(1000);
  }
  console.log('finalize_round');
  await program.methods
    .finalizeRound()
    .accounts({
      admin: adminPk,
      config: configPda,
      round: roundPda,
      vault: vaultPda,
    })
    .rpc();

  // 9) Claim as user
  console.log('claim as user');
  const claimTx = await program.methods
    .claim()
    .accounts({
      user: userPk,
      config: configPda,
      vault: vaultPda,
      round: roundPda,
      userRound: userRoundPda,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  claimTx.feePayer = userPk;
  claimTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  claimTx.sign(user);
  const claimSig = await connection.sendRawTransaction(claimTx.serialize());
  await connection.confirmTransaction(claimSig, 'confirmed');
  console.log('claim sig', claimSig);

  const vaultBal = await connection.getBalance(vaultPda);
  console.log('vault balance (lamports)', vaultBal, '=>', vaultBal / 1e9, 'XNT');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
