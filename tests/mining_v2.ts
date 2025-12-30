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
  transfer,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
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
  const upgradeableLoaderId = new PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111"
  );
  const [programData] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    upgradeableLoaderId
  );

  const admin = (provider.wallet as anchor.Wallet & { payer: Keypair }).payer;
  const userA = Keypair.generate();
  const userB = Keypair.generate();

  const MIND_DECIMALS = 9;
  const EMISSION_PER_SEC = new BN(1_000_000_000); // 1 MIND/sec
  const MAX_EFFECTIVE_HP = new BN(50);
  const SECONDS_PER_DAY = new BN(1); // speed up tests
  const ACC_SCALE = new BN("1000000000000000000");
  const HP_SCALE = new BN(100);
  const STARTER_HP = new BN(60);
  const PRO_HP = new BN(700);
  const INDUSTRIAL_HP = new BN(1500);
  const MIND_PER_HP_PER_DAY = new BN(1_000_000_000);

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const [levelConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("level_config")],
    program.programId
  );
  const [rigBuffConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("rig_buff")],
    program.programId
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId
  );
  const [stakingRewardVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("staking_reward_vault")],
    program.programId
  );
  const [treasuryVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury_vault")],
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

  let mindMint: PublicKey;
  let stakingMindVault: PublicKey;
  let mindBurnVault: PublicKey;
  let mindTreasuryVault: PublicKey;

  const userMindAta = (owner: PublicKey) =>
    getAssociatedTokenAddressSync(mindMint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const airdrop = async (pubkey: PublicKey, sol = 2) => {
    const sig = await provider.connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
  };

  const getClusterTime = async () => {
    const info = await provider.connection.getAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY);
    if (!info) {
      throw new Error("Clock sysvar unavailable");
    }
    return Number(info.data.readBigInt64LE(32));
  };

  const warpForwardSeconds = async (seconds: number) => {
    const start = await getClusterTime();
    const startSlot = await provider.connection.getSlot();
    const slotMs = 400;
    const advanceSlots = Math.max(1, Math.ceil((seconds * 1000) / slotMs));
    await (provider.connection as any)._rpcRequest("warpSlot", [startSlot + advanceSlots]);
    let now = await getClusterTime();
    if (now < start + seconds) {
      const remaining = start + seconds - now;
      const extraSlots = Math.ceil((remaining * 1000) / slotMs);
      const slot = await provider.connection.getSlot();
      await (provider.connection as any)._rpcRequest("warpSlot", [slot + extraSlots]);
      now = await getClusterTime();
    }
    return now;
  };

  const getTokenAmount = async (address: PublicKey) => {
    const account = await getAccount(provider.connection, address);
    return new BN(account.amount.toString());
  };

  const getLamports = async (address: PublicKey) => {
    const balance = await provider.connection.getBalance(address);
    return new BN(balance.toString());
  };

  const calcAccDelta = (emission: BN, dt: BN, totalHp: BN) =>
    emission.mul(dt).mul(ACC_SCALE).div(totalHp);

  let stressPositions: Array<{ owner: Keypair; index: number }> = [];

  before(async () => {
    await airdrop(admin.publicKey, 500);
    await airdrop(userA.publicKey, 100);
    await airdrop(userB.publicKey, 100);

    mindMint = await createMint(
      provider.connection,
      admin,
      vaultAuthority,
      null,
      MIND_DECIMALS
    );

    stakingMindVault = await createAccount(
      provider.connection,
      admin,
      mindMint,
      vaultAuthority,
      Keypair.generate()
    );
    mindBurnVault = await createAccount(
      provider.connection,
      admin,
      mindMint,
      admin.publicKey,
      Keypair.generate()
    );
    mindTreasuryVault = await createAccount(
      provider.connection,
      admin,
      mindMint,
      admin.publicKey,
      Keypair.generate()
    );

    for (const user of [userA, userB]) {
      await createAssociatedTokenAccountIdempotent(
        provider.connection,
        admin,
        mindMint,
        user.publicKey
      );
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
        programData,
        vaultAuthority,
        config: configPda,
        mindMint,
        stakingRewardVault,
        treasuryVault,
        stakingMindVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    await program.methods
      .initLevelConfig()
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        levelConfig: levelConfigPda,
        mindMint,
        mindBurnVault,
        mindTreasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    await program.methods
      .initRigBuffConfig({
        mindPerHpPerDay: MIND_PER_HP_PER_DAY,
      })
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        rigBuffConfig: rigBuffConfigPda,
        mindMint,
        mindBurnVault,
        mindTreasuryVault,
        systemProgram: SystemProgram.programId,
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
        stakingRewardVault,
        treasuryVault,
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
        stakingRewardVault,
        treasuryVault,
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
        systemProgram: SystemProgram.programId,
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
        systemProgram: SystemProgram.programId,
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
    const totalHpAfter = STARTER_HP.add(PRO_HP);
    const acc1 = calcAccDelta(EMISSION_PER_SEC, dt1, STARTER_HP);
    const acc2a = calcAccDelta(EMISSION_PER_SEC, dt2a, totalHpAfter);
    const acc2b = calcAccDelta(EMISSION_PER_SEC, dt2b, totalHpAfter);
    const accFinalA = acc1.add(acc2a);
    const accFinalB = acc1.add(acc2b);

    const pendingA = accFinalA.mul(STARTER_HP).div(ACC_SCALE);
    const rewardDebtB = acc1.mul(PRO_HP).div(ACC_SCALE);
    const pendingB = accFinalB.mul(PRO_HP).div(ACC_SCALE).sub(rewardDebtB);

    const mintedA = afterA.sub(beforeA);
    const mintedB = afterB.sub(beforeB);
    expect(mintedA.toString()).to.eq(pendingA.toString());
    expect(mintedB.toString()).to.eq(pendingB.toString());
  });

  it("has no arbitrage across contracts (XNT per HP-day)", async () => {
    const starter = 1 / (0.6 * 7);
    const pro = 8 / (7 * 14);
    const industrial = 16 / (15 * 28);
    expect(starter).to.be.at.least(pro);
    expect(pro).to.be.at.least(industrial);
  });

  it("deactivates expired positions and removes HP", async () => {
    const cfgBefore = await program.account.config.fetch(configPda);
    expect(cfgBefore.networkHpActive.toNumber()).to.be.greaterThan(0);

    await sleep(10_000);
    await program.methods
      .deactivatePosition()
      .accounts({
        owner: userA.publicKey,
        config: configPda,
        position: positionPda(userA.publicKey, 0),
        userProfile: profilePda(userA.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([userA])
      .rpc();

    const cfgAfter = await program.account.config.fetch(configPda);
    expect(cfgAfter.networkHpActive.toNumber()).to.eq(PRO_HP.toNumber()); // only Pro rig active
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

    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: stakingRewardVault,
        lamports: 100_000_000_000,
      })
    );
    await provider.sendAndConfirm(fundTx, [admin]);

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
      .rollEpoch(new BN(14))
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        stakingRewardVault,
      })
      .rpc();

    const cfgRoll = await program.account.config.fetch(configPda);
    const t0 = new BN(cfgRoll.stakingLastUpdateTs.toString());
    await sleep(2100);

    const beforeXnt = await getLamports(userA.publicKey);
    await program.methods
      .claimXnt()
      .accounts({
        owner: userA.publicKey,
        config: configPda,
        userProfile: profilePda(userA.publicKey),
        userStake: stakePda(userA.publicKey),
        stakingRewardVault,
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

    const afterXnt = await getLamports(userA.publicKey);
    const paid = afterXnt.sub(beforeXnt);
    expect(paid.toString()).to.eq(expected.toString());
  });

  it("stress: 50 buys then claim stays within emission", async () => {
    const users: Keypair[] = [];
    const positionIndex = new Map<string, number>();

    for (let i = 0; i < 10; i += 1) {
      const user = Keypair.generate();
      users.push(user);
      await airdrop(user.publicKey, 100);
      await createAssociatedTokenAccountIdempotent(
        provider.connection,
        admin,
        mindMint,
        user.publicKey
      );
      positionIndex.set(user.publicKey.toBase58(), 0);
    }

    stressPositions = [];

    const tStart = await getClusterTime();
    for (let i = 0; i < 50; i += 1) {
      const user = users[i % users.length];
      const idxKey = user.publicKey.toBase58();
      const idx = positionIndex.get(idxKey) ?? 0;
      const contractType = i % 3;
      await program.methods
        .buyContract(contractType, new BN(idx))
        .accounts({
          owner: user.publicKey,
          config: configPda,
          userProfile: profilePda(user.publicKey),
          position: positionPda(user.publicKey, idx),
          stakingRewardVault,
          treasuryVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      positionIndex.set(idxKey, idx + 1);
      stressPositions.push({ owner: user, index: idx });
    }

    await sleep(2500);

    const beforeBalances = new Map<string, BN>();
    for (const user of users) {
      beforeBalances.set(
        user.publicKey.toBase58(),
        await getTokenAmount(userMindAta(user.publicKey))
      );
    }

    for (const { owner, index } of stressPositions) {
      await program.methods
        .claimMind()
        .accounts({
          owner: owner.publicKey,
          config: configPda,
          userProfile: profilePda(owner.publicKey),
          position: positionPda(owner.publicKey, index),
          vaultAuthority,
          mindMint,
          userMindAta: userMindAta(owner.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    }

    let mintedTotal = new BN(0);
    for (const user of users) {
      const before = beforeBalances.get(user.publicKey.toBase58()) ?? new BN(0);
      const after = await getTokenAmount(userMindAta(user.publicKey));
      mintedTotal = mintedTotal.add(after.sub(before));
    }

    const tEnd = await getClusterTime();
    const dt = Math.max(0, tEnd - tStart);
    const emissionMax = EMISSION_PER_SEC.mul(new BN(dt.toString()));
    expect(mintedTotal.lte(emissionMax)).to.be.true;
  });

  it("stress: expiry deactivate -> hp zero -> emission pauses", async () => {
    const candidates = [
      { owner: userA, index: 0 },
      { owner: userB, index: 0 },
      ...stressPositions,
    ];
    const unique = new Map<string, { owner: Keypair; index: number }>();
    for (const item of candidates) {
      unique.set(`${item.owner.publicKey.toBase58()}:${item.index}`, item);
    }

    let maxEndTs = 0;
    for (const item of unique.values()) {
      try {
        const position = await program.account.minerPosition.fetch(
          positionPda(item.owner.publicKey, item.index)
        );
        if (!position.deactivated) {
          maxEndTs = Math.max(maxEndTs, position.endTs.toNumber());
        }
      } catch {
        // ignore missing positions
      }
    }

    const now = await getClusterTime();
    const graceSeconds = SECONDS_PER_DAY.toNumber() * 2;
    if (maxEndTs + graceSeconds > now) {
      await sleep((maxEndTs + graceSeconds - now + 1) * 1000);
    }

    for (const item of unique.values()) {
      try {
        await program.methods
          .deactivatePosition()
          .accounts({
            owner: item.owner.publicKey,
            config: configPda,
            position: positionPda(item.owner.publicKey, item.index),
            userProfile: profilePda(item.owner.publicKey),
            systemProgram: SystemProgram.programId,
          })
          .signers([item.owner])
          .rpc();
      } catch {
        // ignore failures for missing/already-closed positions
      }
    }

    const cfgAfter = await program.account.config.fetch(configPda);
    expect(cfgAfter.networkHpActive.toNumber()).to.eq(0);

    const accBefore = cfgAfter.accMindPerHp.toString();
    await sleep(1200);
    await program.methods
      .deactivatePosition()
      .accounts({
        owner: userA.publicKey,
        config: configPda,
        position: positionPda(userA.publicKey, 0),
        userProfile: profilePda(userA.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([userA])
      .rpc();
    const cfgAfterPause = await program.account.config.fetch(configPda);
    expect(cfgAfterPause.accMindPerHp.toString()).to.eq(accBefore);
  });

  it("stress: staking badge cap stays within 20%", async () => {
    const users = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    for (const user of users) {
      await airdrop(user.publicKey, 50);
      await createAssociatedTokenAccountIdempotent(
        provider.connection,
        admin,
        mindMint,
        user.publicKey
      );
    }

    const buyAndClaim = async (user: Keypair, index: number) => {
      await program.methods
        .buyContract(0, new BN(index))
        .accounts({
          owner: user.publicKey,
          config: configPda,
          userProfile: profilePda(user.publicKey),
          position: positionPda(user.publicKey, index),
          stakingRewardVault,
          treasuryVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      await sleep(1500);

      await program.methods
        .claimMind()
        .accounts({
          owner: user.publicKey,
          config: configPda,
          userProfile: profilePda(user.publicKey),
          position: positionPda(user.publicKey, index),
          vaultAuthority,
          mindMint,
          userMindAta: userMindAta(user.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
    };

    await buyAndClaim(users[0], 0);
    await buyAndClaim(users[1], 0);
    await buyAndClaim(users[2], 0);

    const mind0 = await getTokenAmount(userMindAta(users[0].publicKey));
    const mind1 = await getTokenAmount(userMindAta(users[1].publicKey));
    const mind2 = await getTokenAmount(userMindAta(users[2].publicKey));

    const stakeBase = mind0.lt(mind1) ? mind0 : mind1;
    const stakeThird = mind2.div(new BN(2));

    await program.methods
      .adminSetBadge(0, 0)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        user: users[0].publicKey,
        userProfile: profilePda(users[0].publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
    await program.methods
      .adminSetBadge(1, 5000)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        user: users[1].publicKey,
        userProfile: profilePda(users[1].publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
    await program.methods
      .adminSetBadge(1, 2000)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        user: users[2].publicKey,
        userProfile: profilePda(users[2].publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const stakeFor = async (user: Keypair, amount: BN) => {
      await program.methods
        .stakeMind(amount)
        .accounts({
          owner: user.publicKey,
          config: configPda,
          userProfile: profilePda(user.publicKey),
          userStake: stakePda(user.publicKey),
          vaultAuthority,
          stakingMindVault,
          ownerMindAta: userMindAta(user.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
    };

    await stakeFor(users[0], stakeBase);
    await stakeFor(users[1], stakeBase);
    if (stakeThird.gt(new BN(0))) {
      await stakeFor(users[2], stakeThird);
    }

    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: stakingRewardVault,
        lamports: 200_000_000_000,
      })
    );
    await provider.sendAndConfirm(fundTx, [admin]);

    await program.methods
      .rollEpoch(new BN(14))
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        stakingRewardVault,
      })
      .rpc();

    await sleep(2000);

    const claimIxFor = async (user: Keypair) =>
      program.methods
        .claimXnt()
        .accounts({
          owner: user.publicKey,
          config: configPda,
          userProfile: profilePda(user.publicKey),
          userStake: stakePda(user.publicKey),
          stakingRewardVault,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

    const before0 = await getLamports(users[0].publicKey);
    const before1 = await getLamports(users[1].publicKey);
    const before2 = await getLamports(users[2].publicKey);

    const tx = new Transaction();
    tx.add(await claimIxFor(users[0]));
    tx.add(await claimIxFor(users[1]));
    if (stakeThird.gt(new BN(0))) {
      tx.add(await claimIxFor(users[2]));
    }
    const signers = stakeThird.gt(new BN(0)) ? users : users.slice(0, 2);
    await provider.sendAndConfirm(tx, signers);

    const after0 = await getLamports(users[0].publicKey);
    const after1 = await getLamports(users[1].publicKey);
    const after2 = await getLamports(users[2].publicKey);

    const payout0 = after0.sub(before0);
    const payout1 = after1.sub(before1);
    const payout2 = stakeThird.gt(new BN(0)) ? after2.sub(before2) : new BN(0);

    const cap = payout0.muln(12).divn(10).add(new BN(1_000_000));
    expect(payout1.lte(cap)).to.be.true;

    if (stakeThird.gt(new BN(0)) && stakeBase.gt(new BN(0))) {
      const baseThird = payout0.mul(stakeThird).div(stakeBase);
      const capThird = baseThird.muln(12).divn(10).add(new BN(1_000_000));
      expect(payout2.lte(capThird)).to.be.true;
    }
  });

  it("updates XP with time and base HP", async () => {
    const user = Keypair.generate();
    await airdrop(user.publicKey, 50);
    await createAssociatedTokenAccountIdempotent(
      provider.connection,
      admin,
      mindMint,
      user.publicKey
    );

    await program.methods
      .buyContract(2, new BN(0))
      .accounts({
        owner: user.publicKey,
        config: configPda,
        userProfile: profilePda(user.publicKey),
        position: positionPda(user.publicKey, 0),
        stakingRewardVault,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const profileBefore = await program.account.userMiningProfile.fetch(
      profilePda(user.publicKey)
    );
    const lastTs = profileBefore.lastXpUpdateTs.toNumber();

    await warpForwardSeconds(36000);

    await program.methods
      .claimMind()
      .accounts({
        owner: user.publicKey,
        config: configPda,
        userProfile: profilePda(user.publicKey),
        position: positionPda(user.publicKey, 0),
        vaultAuthority,
        mindMint,
        userMindAta: userMindAta(user.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const profileAfter = await program.account.userMiningProfile.fetch(
      profilePda(user.publicKey)
    );
    const delta = profileAfter.lastXpUpdateTs.toNumber() - lastTs;
    const expectedXp = Math.floor((7 * delta) / 36000);
    expect(profileAfter.xp.toNumber()).to.eq(expectedXp);
  });

  it("rejects level up without enough XP", async () => {
    const user = Keypair.generate();
    await airdrop(user.publicKey, 50);
    await createAssociatedTokenAccountIdempotent(
      provider.connection,
      admin,
      mindMint,
      user.publicKey
    );

    await program.methods
      .buyContract(0, new BN(0))
      .accounts({
        owner: user.publicKey,
        config: configPda,
        userProfile: profilePda(user.publicKey),
        position: positionPda(user.publicKey, 0),
        stakingRewardVault,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    try {
      await program.methods
        .levelUp()
        .accounts({
          owner: user.publicKey,
          config: configPda,
          levelConfig: levelConfigPda,
          userProfile: profilePda(user.publicKey),
          ownerMindAta: userMindAta(user.publicKey),
          burnMindVault: mindBurnVault,
          treasuryMindVault: mindTreasuryVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          {
            pubkey: positionPda(user.publicKey, 0),
            isSigner: false,
            isWritable: true,
          },
        ])
        .signers([user])
        .rpc();
      expect.fail("Expected level up to fail without XP");
    } catch (err) {
      expect(`${err}`).to.include("Insufficient XP");
    }
  });

  it("rejects level up without enough MIND", async () => {
    const user = Keypair.generate();
    await airdrop(user.publicKey, 50);
    await createAssociatedTokenAccountIdempotent(
      provider.connection,
      admin,
      mindMint,
      user.publicKey
    );

    await program.methods
      .buyContract(1, new BN(0))
      .accounts({
        owner: user.publicKey,
        config: configPda,
        userProfile: profilePda(user.publicKey),
        position: positionPda(user.publicKey, 0),
        stakingRewardVault,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    await warpForwardSeconds(1_200_000);

    await program.methods
      .deactivatePosition()
      .accounts({
        owner: user.publicKey,
        config: configPda,
        position: positionPda(user.publicKey, 0),
        userProfile: profilePda(user.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    await program.methods
      .buyContract(2, new BN(1))
      .accounts({
        owner: user.publicKey,
        config: configPda,
        userProfile: profilePda(user.publicKey),
        position: positionPda(user.publicKey, 1),
        stakingRewardVault,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    try {
      await program.methods
      .levelUp()
      .accounts({
        owner: user.publicKey,
        config: configPda,
        levelConfig: levelConfigPda,
        userProfile: profilePda(user.publicKey),
        ownerMindAta: userMindAta(user.publicKey),
        burnMindVault: mindBurnVault,
        treasuryMindVault: mindTreasuryVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        {
          pubkey: positionPda(user.publicKey, 1),
          isSigner: false,
          isWritable: true,
        },
      ])
        .signers([user])
        .rpc();
      expect.fail("Expected level up to fail without MIND");
    } catch (err) {
      expect(`${err}`).to.include("Insufficient MIND");
    }
  });

  it("levels up with enough XP + MIND and applies rig buffs on top of level bonus", async () => {
    const levelUser = Keypair.generate();
    await airdrop(levelUser.publicKey, 2000);
    await createAssociatedTokenAccountIdempotent(
      provider.connection,
      admin,
      mindMint,
      levelUser.publicKey
    );

    await program.methods
      .buyContract(2, new BN(0))
      .accounts({
        owner: levelUser.publicKey,
        config: configPda,
        userProfile: profilePda(levelUser.publicKey),
        position: positionPda(levelUser.publicKey, 0),
        stakingRewardVault,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([levelUser])
      .rpc();

    await warpForwardSeconds(1_200_000);
    await program.methods
      .claimMind()
      .accounts({
        owner: levelUser.publicKey,
        config: configPda,
        userProfile: profilePda(levelUser.publicKey),
        position: positionPda(levelUser.publicKey, 0),
        vaultAuthority,
        mindMint,
        userMindAta: userMindAta(levelUser.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([levelUser])
      .rpc();

    await program.methods
      .buyContract(2, new BN(1))
      .accounts({
        owner: levelUser.publicKey,
        config: configPda,
        userProfile: profilePda(levelUser.publicKey),
        position: positionPda(levelUser.publicKey, 1),
        stakingRewardVault,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([levelUser])
      .rpc();

    await program.methods
      .levelUp()
      .accounts({
        owner: levelUser.publicKey,
        config: configPda,
        levelConfig: levelConfigPda,
        userProfile: profilePda(levelUser.publicKey),
        ownerMindAta: userMindAta(levelUser.publicKey),
        burnMindVault: mindBurnVault,
        treasuryMindVault: mindTreasuryVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        {
          pubkey: positionPda(levelUser.publicKey, 1),
          isSigner: false,
          isWritable: true,
        },
      ])
      .signers([levelUser])
      .rpc();

    const leveledProfile = await program.account.userMiningProfile.fetch(
      profilePda(levelUser.publicKey)
    );
    expect(leveledProfile.level).to.eq(2);

    const cfgBefore = await program.account.config.fetch(configPda);

    await warpForwardSeconds(29);
    await program.methods
      .claimMind()
      .accounts({
        owner: levelUser.publicKey,
        config: configPda,
        userProfile: profilePda(levelUser.publicKey),
        position: positionPda(levelUser.publicKey, 1),
        vaultAuthority,
        mindMint,
        userMindAta: userMindAta(levelUser.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([levelUser])
      .rpc();

    await program.methods
      .renewRigWithBuff()
      .accounts({
        owner: levelUser.publicKey,
        config: configPda,
        rigBuffConfig: rigBuffConfigPda,
        userProfile: profilePda(levelUser.publicKey),
        position: positionPda(levelUser.publicKey, 1),
        stakingRewardVault,
        treasuryVault,
        mindMint,
        ownerMindAta: userMindAta(levelUser.publicKey),
        burnMindVault: mindBurnVault,
        treasuryMindVault: mindTreasuryVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([levelUser])
      .rpc();

    const cfgAfter = await program.account.config.fetch(configPda);
    const beforeHp = new BN(cfgBefore.networkHpActive.toString());
    const afterHp = new BN(cfgAfter.networkHpActive.toString());

    const bps = new BN(10_000);
    const levelBonusBps = new BN(160);
    const buffBps = new BN(150);
    const effectiveBefore = INDUSTRIAL_HP.mul(bps.add(levelBonusBps)).div(bps);
    const effectiveAfter = INDUSTRIAL_HP
      .mul(bps.add(buffBps))
      .div(bps)
      .mul(bps.add(levelBonusBps))
      .div(bps);
    const expectedDelta = effectiveAfter.sub(effectiveBefore);
    expect(afterHp.sub(beforeHp).toString()).to.eq(expectedDelta.toString());
  });

  it("renews starter rig in grace and keeps buff behavior consistent", async () => {
    const user = Keypair.generate();
    await airdrop(user.publicKey, 50);
    await createAssociatedTokenAccountIdempotent(
      provider.connection,
      admin,
      mindMint,
      user.publicKey
    );

    await program.methods
      .buyContract(0, new BN(0))
      .accounts({
        owner: user.publicKey,
        config: configPda,
        userProfile: profilePda(user.publicKey),
        position: positionPda(user.publicKey, 0),
        stakingRewardVault,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    await warpForwardSeconds(8);
    await program.methods
      .claimMind()
      .accounts({
        owner: user.publicKey,
        config: configPda,
        userProfile: profilePda(user.publicKey),
        position: positionPda(user.publicKey, 0),
        vaultAuthority,
        mindMint,
        userMindAta: userMindAta(user.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    await program.methods
      .renewRig()
      .accounts({
        owner: user.publicKey,
        config: configPda,
        userProfile: profilePda(user.publicKey),
        position: positionPda(user.publicKey, 0),
        stakingRewardVault,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    let position = await program.account.minerPosition.fetch(
      positionPda(user.publicKey, 0)
    );
    expect(position.buffLevel).to.eq(1);

    await warpForwardSeconds(8);
    await program.methods
      .claimMind()
      .accounts({
        owner: user.publicKey,
        config: configPda,
        userProfile: profilePda(user.publicKey),
        position: positionPda(user.publicKey, 0),
        vaultAuthority,
        mindMint,
        userMindAta: userMindAta(user.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const burnBefore = await getTokenAmount(mindBurnVault);
    const treasuryBefore = await getTokenAmount(mindTreasuryVault);

    await program.methods
      .renewRigWithBuff()
      .accounts({
        owner: user.publicKey,
        config: configPda,
        rigBuffConfig: rigBuffConfigPda,
        userProfile: profilePda(user.publicKey),
        position: positionPda(user.publicKey, 0),
        stakingRewardVault,
        treasuryVault,
        mindMint,
        ownerMindAta: userMindAta(user.publicKey),
        burnMindVault: mindBurnVault,
        treasuryMindVault: mindTreasuryVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    position = await program.account.minerPosition.fetch(positionPda(user.publicKey, 0));
    expect(position.buffLevel).to.eq(1);
    expect(position.buffAppliedFromCycle.toNumber()).to.eq(0);

    const burnAfter = await getTokenAmount(mindBurnVault);
    const treasuryAfter = await getTokenAmount(mindTreasuryVault);

    const rewardBase = STARTER_HP.mul(MIND_PER_HP_PER_DAY).mul(new BN(7)).div(HP_SCALE);
    const buffCost = rewardBase.mul(new BN(150)).div(new BN(10_000));
    expect(burnAfter.sub(burnBefore).toString()).to.eq(buffCost.toString());
    expect(treasuryAfter.sub(treasuryBefore).toString()).to.eq("0");
  });

  it("allows early renewal within window and defers buff to next cycle", async () => {
    const user = Keypair.generate();
    await airdrop(user.publicKey, 50);
    await createAssociatedTokenAccountIdempotent(
      provider.connection,
      admin,
      mindMint,
      user.publicKey
    );

    await program.methods
      .buyContract(0, new BN(0))
      .accounts({
        owner: user.publicKey,
        config: configPda,
        userProfile: profilePda(user.publicKey),
        position: positionPda(user.publicKey, 0),
        stakingRewardVault,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const positionKey = positionPda(user.publicKey, 0);
    const before = await program.account.minerPosition.fetch(positionKey);
    const startBefore = before.startTs.toNumber();
    const endBefore = before.endTs.toNumber();

    await warpForwardSeconds(2);
    try {
      await program.methods
        .renewRig()
        .accounts({
          owner: user.publicKey,
          config: configPda,
          userProfile: profilePda(user.publicKey),
          position: positionKey,
          stakingRewardVault,
          treasuryVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      expect.fail("Expected early renewal to fail before window");
    } catch (err) {
      expect(`${err}`).to.include("PositionRenewTooEarly");
    }

    await warpForwardSeconds(3);
    try {
      await program.methods
        .renewRig()
        .accounts({
          owner: user.publicKey,
          config: configPda,
          userProfile: profilePda(user.publicKey),
          position: positionKey,
          stakingRewardVault,
          treasuryVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      expect.fail("Expected renewal to fail before expiry (grace only)");
    } catch (err) {
      expect(`${err}`).to.include("PositionRenewTooEarly");
    }
    await program.methods
      .claimMind()
      .accounts({
        owner: user.publicKey,
        config: configPda,
        userProfile: profilePda(user.publicKey),
        position: positionKey,
        vaultAuthority,
        mindMint,
        userMindAta: userMindAta(user.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    await program.methods
      .renewRigWithBuff()
      .accounts({
        owner: user.publicKey,
        config: configPda,
        rigBuffConfig: rigBuffConfigPda,
        userProfile: profilePda(user.publicKey),
        position: positionKey,
        stakingRewardVault,
        treasuryVault,
        mindMint,
        ownerMindAta: userMindAta(user.publicKey),
        burnMindVault: mindBurnVault,
        treasuryMindVault: mindTreasuryVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const after = await program.account.minerPosition.fetch(positionKey);
    expect(after.startTs.toNumber()).to.eq(startBefore);
    expect(after.endTs.toNumber()).to.eq(endBefore + 7);
    expect(after.buffLevel).to.eq(1);
    expect(after.buffAppliedFromCycle.toNumber()).to.eq(endBefore);
  });

  it("buff progression caps for pro and industrial rigs", async () => {
    const proUser = Keypair.generate();
    await airdrop(proUser.publicKey, 100);
    await createAssociatedTokenAccountIdempotent(
      provider.connection,
      admin,
      mindMint,
      proUser.publicKey
    );

    await program.methods
      .buyContract(1, new BN(0))
      .accounts({
        owner: proUser.publicKey,
        config: configPda,
        userProfile: profilePda(proUser.publicKey),
        position: positionPda(proUser.publicKey, 0),
        stakingRewardVault,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([proUser])
      .rpc();

    const proLevels: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      await warpForwardSeconds(15);
      await program.methods
        .claimMind()
        .accounts({
          owner: proUser.publicKey,
          config: configPda,
          userProfile: profilePda(proUser.publicKey),
          position: positionPda(proUser.publicKey, 0),
          vaultAuthority,
          mindMint,
          userMindAta: userMindAta(proUser.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([proUser])
        .rpc();
      await program.methods
        .renewRigWithBuff()
        .accounts({
          owner: proUser.publicKey,
          config: configPda,
          rigBuffConfig: rigBuffConfigPda,
          userProfile: profilePda(proUser.publicKey),
          position: positionPda(proUser.publicKey, 0),
          stakingRewardVault,
          treasuryVault,
          mindMint,
          ownerMindAta: userMindAta(proUser.publicKey),
          burnMindVault: mindBurnVault,
          treasuryMindVault: mindTreasuryVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([proUser])
        .rpc();
      const position = await program.account.minerPosition.fetch(
        positionPda(proUser.publicKey, 0)
      );
      proLevels.push(position.buffLevel);
    }
    expect(proLevels).to.deep.eq([1, 2, 3, 3]);

    const indUser = Keypair.generate();
    await airdrop(indUser.publicKey, 150);
    await createAssociatedTokenAccountIdempotent(
      provider.connection,
      admin,
      mindMint,
      indUser.publicKey
    );

    await program.methods
      .buyContract(2, new BN(0))
      .accounts({
        owner: indUser.publicKey,
        config: configPda,
        userProfile: profilePda(indUser.publicKey),
        position: positionPda(indUser.publicKey, 0),
        stakingRewardVault,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([indUser])
      .rpc();

    const indLevels: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      await warpForwardSeconds(29);
      await program.methods
        .claimMind()
        .accounts({
          owner: indUser.publicKey,
          config: configPda,
          userProfile: profilePda(indUser.publicKey),
          position: positionPda(indUser.publicKey, 0),
          vaultAuthority,
          mindMint,
          userMindAta: userMindAta(indUser.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([indUser])
        .rpc();
      await program.methods
        .renewRigWithBuff()
        .accounts({
          owner: indUser.publicKey,
          config: configPda,
          rigBuffConfig: rigBuffConfigPda,
          userProfile: profilePda(indUser.publicKey),
          position: positionPda(indUser.publicKey, 0),
          stakingRewardVault,
          treasuryVault,
          mindMint,
          ownerMindAta: userMindAta(indUser.publicKey),
          burnMindVault: mindBurnVault,
          treasuryMindVault: mindTreasuryVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([indUser])
        .rpc();
      const position = await program.account.minerPosition.fetch(
        positionPda(indUser.publicKey, 0)
      );
      indLevels.push(position.buffLevel);
    }
    expect(indLevels).to.deep.eq([1, 2, 3, 3]);
  });

  it("rejects renewals after grace period", async () => {
    const user = Keypair.generate();
    await airdrop(user.publicKey, 50);
    await createAssociatedTokenAccountIdempotent(
      provider.connection,
      admin,
      mindMint,
      user.publicKey
    );

    await program.methods
      .buyContract(0, new BN(0))
      .accounts({
        owner: user.publicKey,
        config: configPda,
        userProfile: profilePda(user.publicKey),
        position: positionPda(user.publicKey, 0),
        stakingRewardVault,
        treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    await warpForwardSeconds(10);

    try {
      await program.methods
        .renewRig()
        .accounts({
          owner: user.publicKey,
          config: configPda,
          userProfile: profilePda(user.publicKey),
          position: positionPda(user.publicKey, 0),
          stakingRewardVault,
          treasuryVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      expect.fail("Expected renewal to fail after grace");
    } catch (err) {
      expect(`${err}`).to.include("PositionGraceExpired");
    }

    await program.methods
      .deactivatePosition()
      .accounts({
        owner: user.publicKey,
        config: configPda,
        position: positionPda(user.publicKey, 0),
        userProfile: profilePda(user.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const position = await program.account.minerPosition.fetch(
      positionPda(user.publicKey, 0)
    );
    expect(position.deactivated).to.eq(true);
  });
});
