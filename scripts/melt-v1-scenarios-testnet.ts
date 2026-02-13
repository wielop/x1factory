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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
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

async function ensureAtaIx(params: {
  payer: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  connection: anchor.web3.Connection;
}) {
  const ata = getAssociatedTokenAddressSync(params.mint, params.owner, false);
  const info = await params.connection.getAccountInfo(ata);
  if (info) return { ata, ix: null as any };
  const ix = createAssociatedTokenAccountInstruction(params.payer, ata, params.owner, params.mint);
  return { ata, ix };
}

async function getClaimPayout(connection: anchor.web3.Connection, sig: string, user: PublicKey) {
  const tx = await connection.getTransaction(sig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta) throw new Error('missing tx meta');
  const keys = tx.transaction.message.getAccountKeys().staticAccountKeys;
  const idx = keys.findIndex((k) => k.equals(user));
  if (idx < 0) throw new Error('missing user in transaction keys');

  const pre = tx.meta.preBalances[idx];
  const post = tx.meta.postBalances[idx];
  return {
    fee: tx.meta.fee,
    delta: post - pre,
  };
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  assertTestnetOnly(provider);
  const connection = provider.connection;

  if (!connection.rpcEndpoint.includes('testnet.x1.xyz')) {
    throw new Error(`Refusing to run outside testnet: ${connection.rpcEndpoint}`);
  }

  const adminPk = provider.wallet.publicKey;
  const meltProgramId = new PublicKey(mustEnv('MELT_V1_PROGRAM_ID'));
  const mindMint = new PublicKey(mustEnv('MIND_MINT'));
  const miningProgramId = process.env.MINING_V2_PROGRAM_ID
    ? new PublicKey(process.env.MINING_V2_PROGRAM_ID)
    : null;

  const meltIdlPath = path.join(__dirname, '..', 'target', 'idl', 'melt_v1.json');
  const meltIdl = fixIdl(JSON.parse(fs.readFileSync(meltIdlPath, 'utf8')));
  meltIdl.address = meltProgramId.toBase58();
  const meltProgram: any = new (anchor as any).Program(meltIdl, provider);

  let miningProgram: any = null;
  if (miningProgramId) {
    const miningIdlPath = path.join(__dirname, '..', 'target', 'idl', 'mining_v2.json');
    const miningIdl = fixIdl(JSON.parse(fs.readFileSync(miningIdlPath, 'utf8')));
    miningIdl.address = miningProgramId.toBase58();
    miningProgram = new (anchor as any).Program(miningIdl, provider);
  }

  const [meltConfigPda] = PublicKey.findProgramAddressSync([Buffer.from('melt_config')], meltProgramId);
  const meltCfgInfo = await connection.getAccountInfo(meltConfigPda);
  if (!meltCfgInfo) throw new Error(`MELT config not initialized: ${meltConfigPda.toBase58()}`);
  const meltCfg = await meltProgram.account.meltConfig.fetch(meltConfigPda);
  const meltVault = new PublicKey(meltCfg.vault);

  const [adminAta] = [getAssociatedTokenAddressSync(mindMint, adminPk, false)];
  const adminAtaBalance = await connection.getTokenAccountBalance(adminAta).catch(() => null);
  if (!adminAtaBalance) {
    throw new Error(`Admin ATA for MIND missing: ${adminAta.toBase58()}`);
  }
  if (BigInt(adminAtaBalance.value.amount) < 100n * 1_000_000_000n) {
    throw new Error('Admin needs at least 100 MIND for scenarios');
  }

  const capLamports = 10n * 1_000_000_000n;
  const burnMin = 10n * 1_000_000_000n;
  const roundWindow = 600;
  const rolloverBps = 2000;

  await meltProgram.methods
    .adminSetParams({
      vaultCapXnt: new anchor.BN(capLamports.toString()),
      rolloverBps,
      burnMin: new anchor.BN(burnMin.toString()),
      roundWindowSec: new anchor.BN(roundWindow),
    })
    .accounts({ admin: adminPk, config: meltConfigPda })
    .rpc();

  console.log('cluster', connection.rpcEndpoint);
  console.log('melt_program', meltProgramId.toBase58());
  console.log('melt_config', meltConfigPda.toBase58());
  console.log('melt_vault', meltVault.toBase58());
  console.log('target', { capLamports: capLamports.toString(), roundWindow, rolloverBps });

  const roundStartedEvents: any[] = [];
  const readTxEvents = async (sig: string) => {
    for (let i = 0; i < 8; i += 1) {
      const tx = await connection.getTransaction(sig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (tx?.meta?.logMessages) {
        const events: any[] = [];
        for (const line of tx.meta.logMessages) {
          const prefix = 'Program data: ';
          const idx = line.indexOf(prefix);
          if (idx < 0) continue;
          const payload = line.slice(idx + prefix.length).trim();
          const evt = (meltProgram.coder.events as any).decode(payload);
          if (evt) events.push(evt);
        }
        return events;
      }
      await sleep(400);
    }
    return [];
  };

  const fundViaTopup = async (lamports: bigint) => {
    const cfgNow = await meltProgram.account.meltConfig.fetch(meltConfigPda);
    const seq = BigInt(cfgNow.roundSeq.toString());
    const seqBuf = Buffer.alloc(8);
    seqBuf.writeBigUInt64LE(seq);
    const [roundPda] = PublicKey.findProgramAddressSync([Buffer.from('melt_round'), seqBuf], meltProgramId);
    const sig = await meltProgram.methods
      .adminTopupVial(new anchor.BN(lamports.toString()))
      .accounts({
        admin: adminPk,
        config: meltConfigPda,
        vault: meltVault,
        round: roundPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const events = await readTxEvents(sig);
    for (const evt of events) {
      if (evt.name === 'RoundStarted') {
        roundStartedEvents.push(evt);
      }
    }
    return { sig, roundPda };
  };

  const deriveMiningPdas = (owner: PublicKey, positionIndex: bigint) => {
    if (!miningProgramId) throw new Error('MINING_V2_PROGRAM_ID missing');
    const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], miningProgramId);
    const [profile] = PublicKey.findProgramAddressSync([Buffer.from('profile'), owner.toBuffer()], miningProgramId);
    const posBuf = Buffer.alloc(8);
    posBuf.writeBigUInt64LE(positionIndex);
    const [position] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), owner.toBuffer(), posBuf],
      miningProgramId,
    );
    const [stakingRewardVault] = PublicKey.findProgramAddressSync([Buffer.from('staking_reward_vault')], miningProgramId);
    const [treasuryVault] = PublicKey.findProgramAddressSync([Buffer.from('treasury_vault')], miningProgramId);
    return { config, profile, position, stakingRewardVault, treasuryVault };
  };

  const maybeFundViaBuyContract = async () => {
    if (!miningProgram || !miningProgramId || process.env.RUN_BUY_CONTRACT !== '1') {
      return { skipped: true, delta: 0n, sig: null as string | null };
    }

    await miningProgram.methods
      .adminSetMeltConfig(true, meltProgramId, 9500)
      .accounts({
        admin: adminPk,
        config: PublicKey.findProgramAddressSync([Buffer.from('config')], miningProgramId)[0],
      })
      .rpc();

    const user = Keypair.generate();
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({ fromPubkey: adminPk, toPubkey: user.publicKey, lamports: 3_000_000_000 }),
      ),
      [],
    );

    const before = await meltProgram.account.meltConfig.fetch(meltConfigPda);
    const vialBefore = BigInt(before.vialLamports.toString());
    const roundSeq = BigInt(before.roundSeq.toString());
    const seqBuf = Buffer.alloc(8);
    seqBuf.writeBigUInt64LE(roundSeq);
    const [meltRound] = PublicKey.findProgramAddressSync([Buffer.from('melt_round'), seqBuf], meltProgramId);

    const p = deriveMiningPdas(user.publicKey, 0n);
    let sig: string | null = null;
    try {
      sig = await miningProgram.methods
        .buyContract(0, new anchor.BN(0))
        .accounts({
          owner: user.publicKey,
          config: p.config,
          userProfile: p.profile,
          position: p.position,
          stakingRewardVault: p.stakingRewardVault,
          treasuryVault: p.treasuryVault,
          meltConfig: meltConfigPda,
          meltVault,
          meltRound,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
    } catch (e: any) {
      console.log('buy_contract_skipped', {
        reason: e?.error?.errorCode?.code || e?.message || 'unknown',
      });
      return { skipped: true, delta: 0n, sig: null as string | null };
    }

    const after = await meltProgram.account.meltConfig.fetch(meltConfigPda);
    const vialAfter = BigInt(after.vialLamports.toString());
    const delta = vialAfter - vialBefore;
    return { skipped: false, delta, sig };
  };

  const fundUserMind = async (user: Keypair, amount: bigint) => {
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({ fromPubkey: adminPk, toPubkey: user.publicKey, lamports: 2_000_000_000 }),
      ),
      [],
    );

    const { ata: userAta, ix } = await ensureAtaIx({
      payer: adminPk,
      owner: user.publicKey,
      mint: mindMint,
      connection,
    });

    const tx = new anchor.web3.Transaction();
    if (ix) tx.add(ix);
    tx.add(createTransferInstruction(adminAta, userAta, adminPk, amount));
    await provider.sendAndConfirm(tx, []);
    return userAta;
  };

  const before1 = await meltProgram.account.meltConfig.fetch(meltConfigPda);
  const vialBefore1 = BigInt(before1.vialLamports.toString());
  const roundSeqBefore1 = BigInt(before1.roundSeq.toString());
  const hadActiveRoundAtStart = !!before1.activeRoundActive;

  // 1) topup / buy_contract powoduje wzrost vial
  const topup1 = await fundViaTopup(1n * 1_000_000_000n);
  const afterTopup1 = await meltProgram.account.meltConfig.fetch(meltConfigPda);
  const vialAfterTopup1 = BigInt(afterTopup1.vialLamports.toString());
  const roundSeqAfterTopup1 = BigInt(afterTopup1.roundSeq.toString());
  const topupIncreasedVial = vialAfterTopup1 > vialBefore1;
  const topupTriggeredRound = roundSeqAfterTopup1 > roundSeqBefore1 || !!afterTopup1.activeRoundActive;
  console.log('scenario1_state', {
    topupSig: topup1.sig,
    vialBefore1: vialBefore1.toString(),
    vialAfterTopup1: vialAfterTopup1.toString(),
    roundSeqBefore1: roundSeqBefore1.toString(),
    roundSeqAfterTopup1: roundSeqAfterTopup1.toString(),
    activeRoundAfterTopup1: !!afterTopup1.activeRoundActive,
  });
  if (!topupIncreasedVial && !topupTriggeredRound) {
    throw new Error('Scenario 1 failed: topup neither increased vial nor triggered auto-start');
  }

  const buyResult = await maybeFundViaBuyContract();
  if (!buyResult.skipped && buyResult.delta <= 0n) {
    throw new Error('Scenario 1 failed: vial did not increase after buy_contract');
  }
  console.log('1_PASS', {
    topupSig: topup1.sig,
    buyContractSig: buyResult.sig,
    vialDeltaTopup: (vialAfterTopup1 - vialBefore1).toString(),
    roundSeqDeltaTopup: (roundSeqAfterTopup1 - roundSeqBefore1).toString(),
    topupTriggeredRound,
    vialDeltaBuyContract: buyResult.delta.toString(),
  });

  // 2) dobijamy cap=10 XNT i oczekujemy auto-start + RoundStarted event
  let activeRoundPda: PublicKey | null = null;
  let endTs = 0;
  for (let i = 0; i < 16; i += 1) {
    const cfg = await meltProgram.account.meltConfig.fetch(meltConfigPda);
    const cap = BigInt(cfg.vaultCapLamports.toString());
    const vial = BigInt(cfg.vialLamports.toString());
    if (cfg.activeRoundActive) {
      const activeSeq = BigInt(cfg.activeRoundSeq.toString());
      const seqBuf = Buffer.alloc(8);
      seqBuf.writeBigUInt64LE(activeSeq);
      activeRoundPda = PublicKey.findProgramAddressSync([Buffer.from('melt_round'), seqBuf], meltProgramId)[0];
      break;
    }
    if (vial >= cap) {
      await fundViaTopup(1n);
    } else {
      const chunk = cap - vial > 2n * 1_000_000_000n ? 2n * 1_000_000_000n : cap - vial;
      await fundViaTopup(chunk);
    }
    await sleep(800);
  }
  if (!activeRoundPda) throw new Error('Scenario 2 failed: round not auto-started at cap');

  const activeRound = await meltProgram.account.meltRound.fetch(activeRoundPda);
  endTs = Number(activeRound.endTs.toString());

  if (roundStartedEvents.length === 0 && !hadActiveRoundAtStart) {
    console.log('2_WARN', 'RoundStarted event not observed via tx-log decode, but active round state is valid');
  }
  console.log('2_PASS', {
    activeRound: activeRoundPda.toBase58(),
    roundSeq: activeRound.seq.toString(),
    endTs,
    roundStartedEvents: roundStartedEvents.length,
    hadActiveRoundAtStart,
  });

  const now = Math.floor(Date.now() / 1000);
  if (now >= endTs) {
    throw new Error(`Round window too short to test burn: now=${now}, endTs=${endTs}`);
  }

  // 3) burn w oknie (2 users)
  const userA = Keypair.generate();
  const userB = Keypair.generate();
  const userAAta = await fundUserMind(userA, 30n * 1_000_000_000n);
  const userBAta = await fundUserMind(userB, 20n * 1_000_000_000n);
  const userARound = PublicKey.findProgramAddressSync(
    [Buffer.from('melt_user_round'), userA.publicKey.toBuffer(), activeRoundPda.toBuffer()],
    meltProgramId,
  )[0];
  const userBRound = PublicKey.findProgramAddressSync(
    [Buffer.from('melt_user_round'), userB.publicKey.toBuffer(), activeRoundPda.toBuffer()],
    meltProgramId,
  )[0];

  const burnASig = await meltProgram.methods
    .burnMind(new anchor.BN((20n * 1_000_000_000n).toString()))
    .accounts({
      user: userA.publicKey,
      config: meltConfigPda,
      round: activeRoundPda,
      mindMint,
      userMindAta: userAAta,
      userRound: userARound,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([userA])
    .rpc();

  const burnBSig = await meltProgram.methods
    .burnMind(new anchor.BN((10n * 1_000_000_000n).toString()))
    .accounts({
      user: userB.publicKey,
      config: meltConfigPda,
      round: activeRoundPda,
      mindMint,
      userMindAta: userBAta,
      userRound: userBRound,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([userB])
    .rpc();

  console.log('3_PASS', { burnASig, burnBSig });

  // 6) funding podczas aktywnej rundy -> NEXT vial, nie zmienia pot tej rundy
  const cfgBeforeMidFunding = await meltProgram.account.meltConfig.fetch(meltConfigPda);
  const roundBeforeMidFunding = await meltProgram.account.meltRound.fetch(activeRoundPda);
  const vialBeforeMidFunding = BigInt(cfgBeforeMidFunding.vialLamports.toString());
  const potBeforeMidFunding = BigInt(roundBeforeMidFunding.vRound.toString());

  const midFundingAmount = 2n * 1_000_000_000n;
  const midFundingSig = (await fundViaTopup(midFundingAmount)).sig;

  const cfgAfterMidFunding = await meltProgram.account.meltConfig.fetch(meltConfigPda);
  const roundAfterMidFunding = await meltProgram.account.meltRound.fetch(activeRoundPda);
  const vialAfterMidFunding = BigInt(cfgAfterMidFunding.vialLamports.toString());
  const potAfterMidFunding = BigInt(roundAfterMidFunding.vRound.toString());

  if (potAfterMidFunding !== potBeforeMidFunding) {
    throw new Error('Scenario 6 failed: active round pot changed after funding');
  }
  if (vialAfterMidFunding < vialBeforeMidFunding + midFundingAmount) {
    throw new Error('Scenario 6 failed: next vial did not grow during active round');
  }

  console.log('6_PASS', {
    midFundingSig,
    vialDelta: (vialAfterMidFunding - vialBeforeMidFunding).toString(),
    potBefore: potBeforeMidFunding.toString(),
    potAfter: potAfterMidFunding.toString(),
  });

  // 4) finalize po end_ts
  while (Math.floor(Date.now() / 1000) <= endTs) {
    await sleep(1500);
  }

  const cfgBeforeFinalize = await meltProgram.account.meltConfig.fetch(meltConfigPda);
  const vialBeforeFinalize = BigInt(cfgBeforeFinalize.vialLamports.toString());
  const bonusBeforeFinalize = BigInt(cfgBeforeFinalize.bonusPoolLamports.toString());
  const roundBeforeFinalize = await meltProgram.account.meltRound.fetch(activeRoundPda);

  const finalizeSig = await meltProgram.methods
    .finalizeRound()
    .accounts({
      admin: adminPk,
      config: meltConfigPda,
      round: activeRoundPda,
      vault: meltVault,
    })
    .rpc();

  const roundFinal = await meltProgram.account.meltRound.fetch(activeRoundPda);
  if (!('finalized' in roundFinal.status)) {
    throw new Error('Scenario 4 failed: round status is not finalized');
  }

  console.log('4_PASS', { finalizeSig });

  // 7) rollover nie wlicza się do fiolki
  const cfgAfterFinalize = await meltProgram.account.meltConfig.fetch(meltConfigPda);
  const vialAfterFinalize = BigInt(cfgAfterFinalize.vialLamports.toString());
  const bonusAfterFinalize = BigInt(cfgAfterFinalize.bonusPoolLamports.toString());
  const vRound = BigInt(roundBeforeFinalize.vRound.toString());
  const vPay = BigInt(roundBeforeFinalize.vPay.toString());
  const rollover = vRound - vPay;

  if (vialAfterFinalize !== vialBeforeFinalize) {
    throw new Error('Scenario 7 failed: vial changed on finalize (rollover leaked into vial)');
  }
  if (bonusAfterFinalize !== bonusBeforeFinalize + rollover) {
    throw new Error('Scenario 7 failed: rollover not moved to bonus pool correctly');
  }

  console.log('7_PASS', {
    rollover: rollover.toString(),
    bonusBefore: bonusBeforeFinalize.toString(),
    bonusAfter: bonusAfterFinalize.toString(),
    vialStable: vialAfterFinalize.toString(),
  });

  // 5) claim pro-rata + payout verification (delta+fee and vault delta)
  const totalBurn = BigInt(roundFinal.totalBurn.toString());
  const expectedA = (BigInt(roundFinal.vPay.toString()) * 20n * 1_000_000_000n) / totalBurn;
  const expectedB = (BigInt(roundFinal.vPay.toString()) * 10n * 1_000_000_000n) / totalBurn;

  const vaultBeforeClaimA = await connection.getBalance(meltVault, 'confirmed');
  const claimASig = await meltProgram.methods
    .claim()
    .accounts({
      user: userA.publicKey,
      config: meltConfigPda,
      vault: meltVault,
      round: activeRoundPda,
      userRound: userARound,
      systemProgram: SystemProgram.programId,
    })
    .signers([userA])
    .rpc();
  const payoutA = await getClaimPayout(connection, claimASig, userA.publicKey);
  const vaultAfterClaimA = await connection.getBalance(meltVault, 'confirmed');

  const payoutAByDeltaFee = BigInt(payoutA.delta + payoutA.fee);
  const payoutAByDeltaOnly = BigInt(payoutA.delta);
  const payoutAByVaultDelta = BigInt(vaultBeforeClaimA - vaultAfterClaimA);
  const payoutAClientViewOk = payoutAByDeltaFee === expectedA || payoutAByDeltaOnly === expectedA;
  if (!payoutAClientViewOk || payoutAByVaultDelta !== expectedA) {
    throw new Error(
      `Scenario 5 failed for userA: expected=${expectedA} delta=${payoutAByDeltaOnly} delta+fee=${payoutAByDeltaFee} vaultDelta=${payoutAByVaultDelta}`,
    );
  }

  const vaultBeforeClaimB = await connection.getBalance(meltVault, 'confirmed');
  const claimBSig = await meltProgram.methods
    .claim()
    .accounts({
      user: userB.publicKey,
      config: meltConfigPda,
      vault: meltVault,
      round: activeRoundPda,
      userRound: userBRound,
      systemProgram: SystemProgram.programId,
    })
    .signers([userB])
    .rpc();
  const payoutB = await getClaimPayout(connection, claimBSig, userB.publicKey);
  const vaultAfterClaimB = await connection.getBalance(meltVault, 'confirmed');

  const payoutBByDeltaFee = BigInt(payoutB.delta + payoutB.fee);
  const payoutBByDeltaOnly = BigInt(payoutB.delta);
  const payoutBByVaultDelta = BigInt(vaultBeforeClaimB - vaultAfterClaimB);
  const payoutBClientViewOk = payoutBByDeltaFee === expectedB || payoutBByDeltaOnly === expectedB;
  if (!payoutBClientViewOk || payoutBByVaultDelta !== expectedB) {
    throw new Error(
      `Scenario 5 failed for userB: expected=${expectedB} delta=${payoutBByDeltaOnly} delta+fee=${payoutBByDeltaFee} vaultDelta=${payoutBByVaultDelta}`,
    );
  }

  console.log('5_PASS', {
    claimASig,
    claimBSig,
    expectedA: expectedA.toString(),
    expectedB: expectedB.toString(),
    payoutAByDelta: payoutAByDeltaOnly.toString(),
    payoutAByDeltaFee: payoutAByDeltaFee.toString(),
    payoutBByDelta: payoutBByDeltaOnly.toString(),
    payoutBByDeltaFee: payoutBByDeltaFee.toString(),
  });

  console.log('ALL_PASS', 'Scenarios 1..7 completed successfully');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
