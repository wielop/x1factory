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

type ScenarioResult = { ok: boolean; details?: string };

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
        if (acc.name === 'mindMint' || acc.name === 'mind_mint') acc.writable = true;
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

function parseScenarioArg(argv: string[]) {
  const idx = argv.indexOf('--scenario');
  if (idx === -1) return null;
  return argv[idx + 1] || null;
}

function errHas(err: any, needle: string) {
  const s = JSON.stringify(err);
  return s.includes(needle);
}

async function expectFail(p: Promise<any>, expected: string[], label: string) {
  try {
    await p;
    return { ok: false, details: `${label}: expected failure, got success` };
  } catch (e) {
    const ok = expected.some((x) => errHas(e, x));
    return ok
      ? { ok: true }
      : { ok: false, details: `${label}: unexpected error. Expected one of ${expected.join(', ')}` };
  }
}

async function getClaimPayout(
  connection: anchor.web3.Connection,
  sig: string,
  user: PublicKey,
) {
  const tx = await connection.getTransaction(sig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  const meta = tx?.meta;
  if (!meta) throw new Error('missing tx meta');
  const keys = tx!.transaction.message.getAccountKeys().staticAccountKeys;
  const idx = keys.findIndex((k) => k.equals(user));
  if (idx === -1) throw new Error('user not found in tx');
  const pre = meta.preBalances[idx];
  const post = meta.postBalances[idx];
  const delta = post - pre;
  return { delta, fee: meta.fee };
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const commitment: anchor.web3.Commitment = 'confirmed';

  const programId = new PublicKey(mustEnv('MELT_V1_PROGRAM_ID'));
  const mindMint = new PublicKey(mustEnv('MIND_MINT'));

  const idlPath = path.join(__dirname, '..', 'target', 'idl', 'melt_v1.json');
  const idl = fixIdl(JSON.parse(fs.readFileSync(idlPath, 'utf8')));
  idl.address = programId.toBase58();
  const program: any = new (anchor as any).Program(idl, provider);

  const adminPk = provider.wallet.publicKey;

  const tmpDir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const scenarioFilter = parseScenarioArg(process.argv);
  const results: Array<ScenarioResult & { name: string }> = [];

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('melt_config')], programId);
  const cfgInfo = await connection.getAccountInfo(configPda);
  if (!cfgInfo) throw new Error('Config not initialized');
  const cfg = await (program.account as any).meltConfig.fetch(configPda);
  const vaultPk = toPubkey(cfg.vault);

  console.log('cluster', connection.rpcEndpoint);
  console.log('programId', programId.toBase58());
  console.log('admin', adminPk.toBase58());
  console.log('configPda', configPda.toBase58());
  console.log('vaultPda', vaultPk.toBase58());
  console.log('test_mode', cfg.testMode);

  // Ensure admin ATA exists and has enough MIND for all scenarios.
  const { ata: adminAta, ix: ixAdminAta } = await ensureAtaIx({
    payer: adminPk,
    owner: adminPk,
    mint: mindMint,
    connection,
  });
  if (ixAdminAta) {
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(ixAdminAta), []);
  }
  const adminAtaInfo = await connection.getTokenAccountBalance(adminAta);
  const adminMind = BigInt(adminAtaInfo.value.amount);
  const minNeed = 200n * 1_000_000_000n;
  if (adminMind < minNeed) {
    throw new Error(
      `Admin MIND balance too low: have ${Number(adminMind) / 1e9}, need >= ${Number(minNeed) / 1e9}`,
    );
  }

  async function fundUser(user: Keypair, mindAmount: bigint) {
    const feeLamports = 5n * 1_000_000_000n;
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({ fromPubkey: adminPk, toPubkey: user.publicKey, lamports: feeLamports }),
    );
    await provider.sendAndConfirm(tx, []);
    const { ata: userAta, ix } = await ensureAtaIx({
      payer: adminPk,
      owner: user.publicKey,
      mint: mindMint,
      connection,
    });
    const tx2 = new anchor.web3.Transaction();
    if (ix) tx2.add(ix);
    tx2.add(createTransferInstruction(adminAta, userAta, adminPk, mindAmount));
    await provider.sendAndConfirm(tx2, []);
    return userAta;
  }

  async function startRound(durationSec = 45) {
    const cfgNow = await (program.account as any).meltConfig.fetch(configPda);
    const roundSeq = BigInt(cfgNow.roundSeq.toString());
    const seqBuf = Buffer.alloc(8);
    seqBuf.writeBigUInt64LE(roundSeq);
    const [roundPda] = PublicKey.findProgramAddressSync([Buffer.from('melt_round'), seqBuf], programId);
    const now = Math.floor(Date.now() / 1000);
    const startTs = now + 4;
    const endTs = startTs + durationSec;
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
    return { roundPda, startTs, endTs, sigSchedule, sigStart };
  }

  async function finalizeAfter(endTs: number, roundPda: PublicKey) {
    while (Math.floor(Date.now() / 1000) <= endTs) {
      await sleep(1000);
    }
    for (let i = 0; i < 5; i += 1) {
      try {
        const sigFinalize = await program.methods
          .finalizeRound()
          .accounts({
            admin: adminPk,
            config: configPda,
            round: roundPda,
            vault: vaultPk,
          })
          .rpc();
        return sigFinalize;
      } catch (e) {
        if (errHas(e, 'RoundNotEnded')) {
          await sleep(2000);
          continue;
        }
        throw e;
      }
    }
    throw new Error('finalize failed after retries');
  }

  async function runScenario(name: string, fn: () => Promise<ScenarioResult>) {
    if (scenarioFilter && scenarioFilter !== name) return;
    const res = await fn();
    results.push({ name, ok: res.ok, details: res.details });
  }

  await runScenario('A_zero_burn', async () => {
    const sigTopup = await program.methods
      .adminTopupVault(new anchor.BN(5n * 1_000_000_000n))
      .accounts({ admin: adminPk, config: configPda, vault: vaultPk, systemProgram: SystemProgram.programId })
      .rpc();
    const { roundPda, endTs, sigSchedule, sigStart } = await startRound(35);
    const sigFinalize = await finalizeAfter(endTs, roundPda);
    const round = await (program.account as any).meltRound.fetch(roundPda);
    const vaultBefore = await connection.getBalance(vaultPk, commitment);
    const user = Keypair.generate();
    writeKeypair(path.join(tmpDir, `zero_burn_user.json`), user);
    const res = await expectFail(
      program.methods
        .claim()
        .accounts({
          user: user.publicKey,
          config: configPda,
          vault: vaultPk,
          round: roundPda,
          userRound: PublicKey.findProgramAddressSync(
            [Buffer.from('melt_user_round'), user.publicKey.toBuffer(), roundPda.toBuffer()],
            programId,
          )[0],
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc(),
      ['AccountNotInitialized', 'NothingToClaim', 'ConstraintSeeds', 'Account does not exist'],
      'claim without burn',
    );
    const vaultAfter = await connection.getBalance(vaultPk, commitment);
    const ok = round.totalBurn.toString() === '0' && BigInt(vaultAfter) === BigInt(vaultBefore) && res.ok;
    console.log('A_zero_burn sigs', { sigTopup, sigSchedule, sigStart, sigFinalize });
    return { ok, details: res.details };
  });

  await runScenario('B_below_burn_min', async () => {
    const user = Keypair.generate();
    writeKeypair(path.join(tmpDir, `below_burn_min.json`), user);
    const userAta = await fundUser(user, 2n * 1_000_000_000n);
    await program.methods
      .adminTopupVault(new anchor.BN(3n * 1_000_000_000n))
      .accounts({ admin: adminPk, config: configPda, vault: vaultPk, systemProgram: SystemProgram.programId })
      .rpc();
    const { roundPda, startTs, endTs } = await startRound(40);
    const burnRes = await expectFail(
      program.methods
        .burnMind(new anchor.BN(1n * 1_000_000_000n))
        .accounts({
          user: user.publicKey,
          config: configPda,
          round: roundPda,
          mindMint,
          userMindAta: userAta,
          userRound: PublicKey.findProgramAddressSync(
            [Buffer.from('melt_user_round'), user.publicKey.toBuffer(), roundPda.toBuffer()],
            programId,
          )[0],
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc(),
      ['BelowBurnMin', 'InvalidParams'],
      'burn below min',
    );
    await finalizeAfter(endTs, roundPda);
    console.log('B_below_burn_min timing', { startTs, endTs });
    return { ok: burnRes.ok, details: burnRes.details };
  });

  await runScenario('C_claim_twice', async () => {
    const user = Keypair.generate();
    writeKeypair(path.join(tmpDir, `claim_twice.json`), user);
    const userAta = await fundUser(user, 20n * 1_000_000_000n);
    await program.methods
      .adminTopupVault(new anchor.BN(5n * 1_000_000_000n))
      .accounts({ admin: adminPk, config: configPda, vault: vaultPk, systemProgram: SystemProgram.programId })
      .rpc();
    const { roundPda, endTs } = await startRound(40);
    const sigBurn = await program.methods
      .burnMind(new anchor.BN(20n * 1_000_000_000n))
      .accounts({
        user: user.publicKey,
        config: configPda,
        round: roundPda,
        mindMint,
        userMindAta: userAta,
        userRound: PublicKey.findProgramAddressSync(
          [Buffer.from('melt_user_round'), user.publicKey.toBuffer(), roundPda.toBuffer()],
          programId,
        )[0],
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    const sigFinalize = await finalizeAfter(endTs, roundPda);
    const sigClaim = await program.methods
      .claim()
      .accounts({
        user: user.publicKey,
        config: configPda,
        vault: vaultPk,
        round: roundPda,
        userRound: PublicKey.findProgramAddressSync(
          [Buffer.from('melt_user_round'), user.publicKey.toBuffer(), roundPda.toBuffer()],
          programId,
        )[0],
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    const res = await expectFail(
      program.methods
        .claim()
        .accounts({
          user: user.publicKey,
          config: configPda,
          vault: vaultPk,
          round: roundPda,
          userRound: PublicKey.findProgramAddressSync(
            [Buffer.from('melt_user_round'), user.publicKey.toBuffer(), roundPda.toBuffer()],
            programId,
          )[0],
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc(),
      ['AlreadyClaimed'],
      'claim twice',
    );
    console.log('C_claim_twice sigs', { sigBurn, sigFinalize, sigClaim });
    return { ok: res.ok, details: res.details };
  });

  await runScenario('D_claim_before_finalize', async () => {
    const user = Keypair.generate();
    writeKeypair(path.join(tmpDir, `claim_before_finalize.json`), user);
    const userAta = await fundUser(user, 20n * 1_000_000_000n);
    await program.methods
      .adminTopupVault(new anchor.BN(5n * 1_000_000_000n))
      .accounts({ admin: adminPk, config: configPda, vault: vaultPk, systemProgram: SystemProgram.programId })
      .rpc();
    const { roundPda, endTs } = await startRound(40);
    await program.methods
      .burnMind(new anchor.BN(20n * 1_000_000_000n))
      .accounts({
        user: user.publicKey,
        config: configPda,
        round: roundPda,
        mindMint,
        userMindAta: userAta,
        userRound: PublicKey.findProgramAddressSync(
          [Buffer.from('melt_user_round'), user.publicKey.toBuffer(), roundPda.toBuffer()],
          programId,
        )[0],
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    const res = await expectFail(
      program.methods
        .claim()
        .accounts({
          user: user.publicKey,
          config: configPda,
          vault: vaultPk,
          round: roundPda,
          userRound: PublicKey.findProgramAddressSync(
            [Buffer.from('melt_user_round'), user.publicKey.toBuffer(), roundPda.toBuffer()],
            programId,
          )[0],
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc(),
      ['BadRoundStatus'],
      'claim before finalize',
    );
    await finalizeAfter(endTs, roundPda);
    return { ok: res.ok, details: res.details };
  });

  await runScenario('E_finalize_too_early', async () => {
    await program.methods
      .adminTopupVault(new anchor.BN(3n * 1_000_000_000n))
      .accounts({ admin: adminPk, config: configPda, vault: vaultPk, systemProgram: SystemProgram.programId })
      .rpc();
    const { roundPda, endTs } = await startRound(60);
    const res = await expectFail(
      program.methods
        .finalizeRound()
        .accounts({ admin: adminPk, config: configPda, round: roundPda, vault: vaultPk })
        .rpc(),
      ['RoundNotEnded'],
      'finalize too early',
    );
    await finalizeAfter(endTs, roundPda);
    return { ok: res.ok, details: res.details };
  });

  await runScenario('F_multi_burn_accumulate', async () => {
    const user = Keypair.generate();
    writeKeypair(path.join(tmpDir, `multi_burn.json`), user);
    const userAta = await fundUser(user, 30n * 1_000_000_000n);
    await program.methods
      .adminTopupVault(new anchor.BN(5n * 1_000_000_000n))
      .accounts({ admin: adminPk, config: configPda, vault: vaultPk, systemProgram: SystemProgram.programId })
      .rpc();
    const { roundPda, endTs } = await startRound(40);
    const userRoundPda = PublicKey.findProgramAddressSync(
      [Buffer.from('melt_user_round'), user.publicKey.toBuffer(), roundPda.toBuffer()],
      programId,
    )[0];
    await program.methods
      .burnMind(new anchor.BN(10n * 1_000_000_000n))
      .accounts({
        user: user.publicKey,
        config: configPda,
        round: roundPda,
        mindMint,
        userMindAta: userAta,
        userRound: userRoundPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    await program.methods
      .burnMind(new anchor.BN(15n * 1_000_000_000n))
      .accounts({
        user: user.publicKey,
        config: configPda,
        round: roundPda,
        mindMint,
        userMindAta: userAta,
        userRound: userRoundPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    const ur = await (program.account as any).meltUserRound.fetch(userRoundPda);
    await finalizeAfter(endTs, roundPda);
    return { ok: ur.burned.toString() === (25n * 1_000_000_000n).toString() };
  });

  await runScenario('G_admin_withdraw_test_mode', async () => {
    const vaultBefore = await connection.getBalance(vaultPk, commitment);
    const adminBefore = await connection.getBalance(adminPk, commitment);
    const amt = 1n * 1_000_000_000n;
    let ok = false;
    if (cfg.testMode) {
      const sig = await program.methods
        .adminWithdrawVault(new anchor.BN(amt))
        .accounts({ admin: adminPk, config: configPda, vault: vaultPk, systemProgram: SystemProgram.programId })
        .rpc();
      const vaultAfter = await connection.getBalance(vaultPk, commitment);
      const adminAfter = await connection.getBalance(adminPk, commitment);
      ok = BigInt(vaultAfter) + amt === BigInt(vaultBefore) && BigInt(adminAfter) >= BigInt(adminBefore);
      console.log('G_admin_withdraw_test_mode sig', sig);
    } else {
      const res = await expectFail(
        program.methods
          .adminWithdrawVault(new anchor.BN(amt))
          .accounts({ admin: adminPk, config: configPda, vault: vaultPk, systemProgram: SystemProgram.programId })
          .rpc(),
        ['WithdrawDisabled'],
        'admin withdraw when disabled',
      );
      ok = res.ok;
    }
    return { ok };
  });

  await runScenario('H_snapshot_integrity', async () => {
    const sigTopup = await program.methods
      .adminTopupVault(new anchor.BN(5n * 1_000_000_000n))
      .accounts({ admin: adminPk, config: configPda, vault: vaultPk, systemProgram: SystemProgram.programId })
      .rpc();
    const { roundPda, endTs } = await startRound(40);
    const roundBefore = await (program.account as any).meltRound.fetch(roundPda);
    const sigTopupMid = await program.methods
      .adminTopupVault(new anchor.BN(5n * 1_000_000_000n))
      .accounts({ admin: adminPk, config: configPda, vault: vaultPk, systemProgram: SystemProgram.programId })
      .rpc();
    await finalizeAfter(endTs, roundPda);
    const roundAfter = await (program.account as any).meltRound.fetch(roundPda);
    const sameSnapshot = roundBefore.vRound.toString() === roundAfter.vRound.toString();
    // Next round should include increased vault
    const { roundPda: nextRound, endTs: nextEnd } = await startRound(30);
    await finalizeAfter(nextEnd, nextRound);
    const next = await (program.account as any).meltRound.fetch(nextRound);
    const ok = sameSnapshot && BigInt(next.vRound.toString()) >= BigInt(roundAfter.vRound.toString());
    console.log('H_snapshot_integrity sigs', { sigTopup, sigTopupMid });
    return { ok };
  });

  console.log('--- scenario results ---');
  for (const r of results) {
    console.log(r.name, r.ok ? 'PASS' : 'FAIL', r.details || '');
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
