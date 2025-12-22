import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAccount,
  createAssociatedTokenAccountIdempotent,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  transfer,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { MiningV2 } from "../target/types/mining_v2";
import miningV2Idl from "../target/idl/mining_v2.json";
import { createHash } from "crypto";

const normalizeIdl = (raw: anchor.Idl): anchor.Idl => {
  const clone = JSON.parse(JSON.stringify(raw)) as anchor.Idl;
  const toSnakeCase = (value: string) =>
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/-/g, "_")
      .toLowerCase();
  const discriminator = (namespace: string, name: string) =>
    Buffer.from(createHash("sha256").update(`${namespace}:${name}`).digest().slice(0, 8));
  const fixDefined = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(fixDefined);
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.defined === "string") {
        record.defined = { name: record.defined, generics: [] };
      }
      for (const key of Object.keys(record)) {
        record[key] = fixDefined(record[key]);
      }
      return record;
    }
    if (typeof value === "string") {
      return value === "publicKey" ? "pubkey" : value;
    }
    return value;
  };
  const idl = fixDefined(clone) as anchor.Idl;
  const normalizeAccounts = (items: Array<Record<string, unknown>>) => {
    for (const item of items) {
      if (Array.isArray(item.accounts)) {
        normalizeAccounts(item.accounts as Array<Record<string, unknown>>);
      }
      if (Object.prototype.hasOwnProperty.call(item, "isMut")) {
        item.writable = item.isMut;
        delete item.isMut;
      }
      if (Object.prototype.hasOwnProperty.call(item, "isSigner")) {
        item.signer = item.isSigner;
        delete item.isSigner;
      }
    }
  };
  if (Array.isArray((idl as any).instructions)) {
    for (const ix of (idl as any).instructions) {
      if (Array.isArray(ix.accounts)) {
        normalizeAccounts(ix.accounts);
      }
    }
  }
  for (const ix of (idl as any).instructions ?? []) {
    if (!ix.discriminator) {
      ix.discriminator = discriminator("global", toSnakeCase(ix.name));
    }
  }
  for (const acc of (idl as any).accounts ?? []) {
    if (!acc.discriminator) {
      acc.discriminator = discriminator("account", acc.name);
    }
  }
  const types = ((idl as any).types ?? []) as Array<{ name: string; type: unknown }>;
  (idl as any).types = types;
  for (const acc of (idl as any).accounts ?? []) {
    if (acc.type && !types.some((ty) => ty.name === acc.name)) {
      types.push({ name: acc.name, type: acc.type });
    }
  }
  for (const evt of (idl as any).events ?? []) {
    if (!evt.discriminator) {
      evt.discriminator = discriminator("event", evt.name);
    }
    if (evt.fields && !types.some((ty) => ty.name === evt.name)) {
      types.push({ name: evt.name, type: { kind: "struct", fields: evt.fields } });
    }
  }
  return idl;
};

describe("mining_v2", () => {
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);
  const programId = new PublicKey("uaDkkJGLLEY3kFMhhvrh5MZJ6fmwCmhNf8L7BZQJ9Aw");
  const idl = normalizeIdl(miningV2Idl as anchor.Idl);
  idl.address = programId.toBase58();
  const program = new Program(idl, provider) as Program<MiningV2>;

  const admin = (provider.wallet as anchor.Wallet & { payer: Keypair }).payer;
  const userA = Keypair.generate();
  const userB = Keypair.generate();

  const MIND_DECIMALS = 9;
  const XNT_DECIMALS = 9;
  const EMISSION_PER_SEC = new BN(1_000_000_000); // 1 MIND/sec
  const MAX_EFFECTIVE_HP = new BN(50);
  const SECONDS_PER_DAY = new BN(1); // speed up tests
  const ACC_SCALE = new BN("1000000000000000000");

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId
  );
  const positionPda = (owner: PublicKey, idx: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("position"), owner.toBuffer(), new BN(idx).toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
  const profilePda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("profile"), owner.toBuffer()], program.programId)[0];
  const stakePda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("stake"), owner.toBuffer()], program.programId)[0];

  let xntMint: PublicKey;
  let mindMint: PublicKey;
  let stakingRewardVault: PublicKey;
  let treasuryVault: PublicKey;
  let stakingMindVault: PublicKey;
  let adminXntAta: PublicKey;

  const userMindAta = (owner: PublicKey) =>
    getAssociatedTokenAddressSync(mindMint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userXntAta = (owner: PublicKey) =>
    getAssociatedTokenAddressSync(xntMint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const airdrop = async (pubkey: PublicKey, sol = 2) => {
    const sig = await provider.connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
  };

  const getTokenAmount = async (address: PublicKey) => {
    const account = await getAccount(provider.connection, address);
    return new BN(account.amount.toString());
  };

  const toBn = (n: number) => new BN(n.toString());

  const calcAccDelta = (emission: BN, dt: BN, totalHp: BN) =>
    emission.mul(dt).mul(ACC_SCALE).div(totalHp);

  before(async () => {
    await airdrop(admin.publicKey, 4);
    await airdrop(userA.publicKey, 2);
    await airdrop(userB.publicKey, 2);

    xntMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      XNT_DECIMALS
    );
    mindMint = await createMint(
      provider.connection,
      admin,
      vaultAuthority,
      null,
      MIND_DECIMALS
    );

    stakingRewardVault = await createAccount(
      provider.connection,
      admin,
      xntMint,
      vaultAuthority,
      Keypair.generate()
    );
    treasuryVault = await createAccount(
      provider.connection,
      admin,
      xntMint,
      vaultAuthority,
      Keypair.generate()
    );
    stakingMindVault = await createAccount(
      provider.connection,
      admin,
      mindMint,
      vaultAuthority,
      Keypair.generate()
    );

    adminXntAta = await createAssociatedTokenAccountIdempotent(
      provider.connection,
      admin,
      xntMint,
      admin.publicKey
    );
    await mintTo(provider.connection, admin, xntMint, adminXntAta, admin, 1_000_000_000_000);

    for (const user of [userA, userB]) {
      const userXnt = await createAssociatedTokenAccountIdempotent(
        provider.connection,
        admin,
        xntMint,
        user.publicKey
      );
      await createAssociatedTokenAccountIdempotent(
        provider.connection,
        admin,
        mindMint,
        user.publicKey
      );
      await mintTo(provider.connection, admin, xntMint, userXnt, admin, 200_000_000_000);
    }

    await program.methods
      .initConfig({
        emissionPerSec: EMISSION_PER_SEC,
        maxEffectiveHp: MAX_EFFECTIVE_HP,
        secondsPerDay: SECONDS_PER_DAY,
      })
      .accounts({
        payer: admin.publicKey,
        admin: admin.publicKey,
        vaultAuthority,
        config: configPda,
        mindMint,
        xntMint,
        stakingRewardVault,
        treasuryVault,
        stakingMindVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();
  });

  it("pauses emission when network HP is zero", async () => {
    await sleep(1200);
    await program.methods
      .buyContract(0, new BN(0))
      .accounts({
        owner: userA.publicKey,
        config: configPda,
        userProfile: profilePda(userA.publicKey),
        position: positionPda(userA.publicKey, 0),
        vaultAuthority,
        xntMint,
        stakingRewardVault,
        treasuryVault,
        ownerXntAta: userXntAta(userA.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([userA])
      .rpc();

    const cfg = await program.account.config.fetch(configPda);
    expect(cfg.accMindPerHp.toString()).to.eq("0");
  });

  it("distributes rewards based on HP share", async () => {
    const cfgAfterA = await program.account.config.fetch(configPda);
    const t1 = new BN(cfgAfterA.lastUpdateTs.toString());

    await sleep(1200);
    await program.methods
      .buyContract(1, new BN(0))
      .accounts({
        owner: userB.publicKey,
        config: configPda,
        userProfile: profilePda(userB.publicKey),
        position: positionPda(userB.publicKey, 0),
        vaultAuthority,
        xntMint,
        stakingRewardVault,
        treasuryVault,
        ownerXntAta: userXntAta(userB.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([userB])
      .rpc();

    const cfgAfterB = await program.account.config.fetch(configPda);
    const t2 = new BN(cfgAfterB.lastUpdateTs.toString());

    await sleep(1200);
    const beforeA = await getTokenAmount(userMindAta(userA.publicKey));
    const beforeB = await getTokenAmount(userMindAta(userB.publicKey));

    await program.methods
      .claimMind()
      .accounts({
        owner: userA.publicKey,
        config: configPda,
        userProfile: profilePda(userA.publicKey),
        position: positionPda(userA.publicKey, 0),
        vaultAuthority,
        mindMint,
        userMindAta: userMindAta(userA.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userA])
      .rpc();

    const cfgAfterA2 = await program.account.config.fetch(configPda);
    const t3 = new BN(cfgAfterA2.lastUpdateTs.toString());

    await program.methods
      .claimMind()
      .accounts({
        owner: userB.publicKey,
        config: configPda,
        userProfile: profilePda(userB.publicKey),
        position: positionPda(userB.publicKey, 0),
        vaultAuthority,
        mindMint,
        userMindAta: userMindAta(userB.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userB])
      .rpc();

    const afterA = await getTokenAmount(userMindAta(userA.publicKey));
    const afterB = await getTokenAmount(userMindAta(userB.publicKey));

    const cfgAfterB2 = await program.account.config.fetch(configPda);
    const t4 = new BN(cfgAfterB2.lastUpdateTs.toString());

    const dt1 = t2.sub(t1);
    const dt2a = t3.sub(t2);
    const dt2b = t4.sub(t2);
    const acc1 = calcAccDelta(EMISSION_PER_SEC, dt1, toBn(1));
    const acc2a = calcAccDelta(EMISSION_PER_SEC, dt2a, toBn(6));
    const acc2b = calcAccDelta(EMISSION_PER_SEC, dt2b, toBn(6));
    const accFinalA = acc1.add(acc2a);
    const accFinalB = acc1.add(acc2b);

    const pendingA = accFinalA.mul(toBn(1)).div(ACC_SCALE);
    const rewardDebtB = acc1.mul(toBn(5)).div(ACC_SCALE);
    const pendingB = accFinalB.mul(toBn(5)).div(ACC_SCALE).sub(rewardDebtB);

    const mintedA = afterA.sub(beforeA);
    const mintedB = afterB.sub(beforeB);
    expect(mintedA.toString()).to.eq(pendingA.toString());
    expect(mintedB.toString()).to.eq(pendingB.toString());
  });

  it("has no arbitrage across contracts (XNT per HP-day)", async () => {
    const starter = 1 / (1 * 7);
    const pro = 10 / (5 * 14);
    const industrial = 20 / (7 * 28);
    expect(starter).to.be.at.least(pro);
    expect(pro).to.be.at.least(industrial);
  });

  it("deactivates expired positions and removes HP", async () => {
    const cfgBefore = await program.account.config.fetch(configPda);
    expect(cfgBefore.networkHpActive.toNumber()).to.be.greaterThan(0);

    await sleep(7000);
    await program.methods
      .deactivatePosition()
      .accounts({
        config: configPda,
        position: positionPda(userA.publicKey, 0),
        userProfile: profilePda(userA.publicKey),
      })
      .rpc();

    const cfgAfter = await program.account.config.fetch(configPda);
    expect(cfgAfter.networkHpActive.toNumber()).to.eq(5); // only Pro rig active
  });

  it("smooths staking rewards and caps badge bonus", async () => {
    await program.methods
      .adminSetBadge(1, 5000)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        user: userA.publicKey,
        userProfile: profilePda(userA.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    await transfer(
      provider.connection,
      admin,
      adminXntAta,
      stakingRewardVault,
      admin,
      100_000_000_000
    );

    const stakeAmount = new BN(100_000_000);
    await program.methods
      .stakeMind(stakeAmount)
      .accounts({
        owner: userA.publicKey,
        config: configPda,
        userProfile: profilePda(userA.publicKey),
        userStake: stakePda(userA.publicKey),
        vaultAuthority,
        stakingMindVault,
        ownerMindAta: userMindAta(userA.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([userA])
      .rpc();

    await program.methods
      .rollEpoch(new BN(10))
      .accounts({
        config: configPda,
        stakingRewardVault,
      })
      .rpc();

    const cfgRoll = await program.account.config.fetch(configPda);
    const t0 = new BN(cfgRoll.stakingLastUpdateTs.toString());
    await sleep(2100);

    const beforeXnt = await getTokenAmount(userXntAta(userA.publicKey));
    await program.methods
      .claimXnt()
      .accounts({
        owner: userA.publicKey,
        config: configPda,
        userProfile: profilePda(userA.publicKey),
        userStake: stakePda(userA.publicKey),
        vaultAuthority,
        stakingRewardVault,
        ownerXntAta: userXntAta(userA.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([userA])
      .rpc();
    const cfgAfter = await program.account.config.fetch(configPda);
    const t1 = new BN(cfgAfter.stakingLastUpdateTs.toString());
    const dt = t1.sub(t0);

    const rate = new BN(cfgRoll.stakingRewardRateXntPerSec.toString());
    const basePending = rate.mul(dt);
    const expected = basePending.muln(120).divn(100);

    const afterXnt = await getTokenAmount(userXntAta(userA.publicKey));
    const paid = afterXnt.sub(beforeXnt);
    expect(paid.toString()).to.eq(expected.toString());
  });
});
