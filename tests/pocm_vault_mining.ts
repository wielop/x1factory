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
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { expect } from "chai";
import { PocmVaultMining } from "../target/types/pocm_vault_mining";
import pocmVaultMiningIdl from "../target/idl/pocm_vault_mining.json";
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

describe.skip("pocm_vault_mining", () => {
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);
  const programId = new PublicKey("2oJ68QPvNqvdegxPczqGYz7bmTyBSW9D6ZYs4w1HSpL9");
  const idl = normalizeIdl(pocmVaultMiningIdl as anchor.Idl);
  idl.address = programId.toBase58();
  const program = new Program(idl, provider) as Program<PocmVaultMining>;

  const admin = (provider.wallet as anchor.Wallet & { payer: Keypair }).payer;
  const user = Keypair.generate();
  const whale = Keypair.generate();

  const TEST_EPOCH_SECONDS = 1; // fast epochs for local tests; production uses 86_400
  const XNT_DECIMALS = 9;
  const MIND_DECIMALS = 9;
  const TH1 = new BN(1_000_000_000); // 1 XNT (in base units)
  const TH2 = new BN(4_000_000_000); // next 4 XNT at 50%
  const TOTAL_SUPPLY_MIND = new BN("1000000000000000"); // 1e15 base units
  const MINED_CAP_BPS = 7000; // 70%
  const SCALE = new BN(10).pow(new BN(XNT_DECIMALS));

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config_v2")],
    program.programId
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId
  );
  const profilePda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("profile"), owner.toBuffer()],
      program.programId
    )[0];
  const positionPda = (owner: PublicKey, idx: number) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("position"),
        owner.toBuffer(),
        new BN(idx).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];
  const epochPda = (idx: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("epoch"), new BN(idx).toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
  const userEpochPda = (owner: PublicKey, idx: number) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_epoch"),
        owner.toBuffer(),
        new BN(idx).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

  let xntMint: PublicKey;
  const mindMint = Keypair.generate();
  let vaultXntAta: PublicKey;
  let stakingVaultXntAta: PublicKey;
  let stakingVaultMindAta: PublicKey;
  let userXntAta: PublicKey;
  let whaleXntAta: PublicKey;
  const userMindAta = () =>
    getAssociatedTokenAddressSync(
      mindMint.publicKey,
      user.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  const whaleMindAta = () =>
    getAssociatedTokenAddressSync(
      mindMint.publicKey,
      whale.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const isInvalidEpochIndexError = (e: unknown) => {
    const err: any = e;
    const msg = String(err?.message ?? e);
    const logs = Array.isArray(err?.logs) ? err.logs.join("\n") : "";
    const haystack = `${msg}\n${logs}`;
    return (
      haystack.includes("InvalidEpochIndex") ||
      haystack.includes("Error Number: 6012") ||
      haystack.includes("Custom\":6012") ||
      haystack.includes("custom program error: 0x177c") ||
      haystack.includes("custom program error: 0x177c")
    );
  };
  const getTokenAmount = async (label: string, address: PublicKey) => {
    try {
      return new BN((await getAccount(provider.connection, address)).amount.toString());
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      throw new Error(`${label} not found: ${address.toBase58()}: ${msg}`);
    }
  };

  const airdrop = async (pubkey: PublicKey, sol = 2) => {
    const sig = await provider.connection.requestAirdrop(
      pubkey,
      sol * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);
  };

  const getClusterTime = async () => {
    const info = await provider.connection.getAccountInfo(
      anchor.web3.SYSVAR_CLOCK_PUBKEY
    );
    if (!info) {
      throw new Error("Clock sysvar unavailable");
    }
    // Clock sysvar layout (little-endian):
    // slot: u64, epoch_start_timestamp: i64, epoch: u64, leader_schedule_epoch: u64, unix_timestamp: i64
    const unixTs = Number(info.data.readBigInt64LE(32));
    return unixTs;
  };

  const currentEpoch = async () => {
    const cfg = await program.account.config.fetch(configPda);
    const now = await getClusterTime();
    return Math.floor(
      (now - cfg.emissionStartTs.toNumber()) / cfg.epochSeconds.toNumber()
    );
  };

  const computeReward = (
    emission: BN,
    totalMp: BN,
    userMp: BN,
    mpCapBps: number
  ) => {
    const capPortion = totalMp.muln(mpCapBps).divn(10_000);
    const capped = userMp.gt(capPortion) ? capPortion : userMp;
    return emission.mul(capped).div(totalMp);
  };

  it("initializes, distributes rewards, enforces caps, and unlocks", async () => {
    await airdrop(admin.publicKey, 4);
    await airdrop(user.publicKey, 2);
    await airdrop(whale.publicKey, 2);

    // Bootstrap XNT mint and vault ATA
    xntMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      XNT_DECIMALS
    );
    vaultXntAta = await createAccount(
      provider.connection,
      admin,
      xntMint,
      vaultAuthority,
      Keypair.generate()
    );
    stakingVaultXntAta = await createAccount(
      provider.connection,
      admin,
      xntMint,
      vaultAuthority,
      Keypair.generate()
    );

    await createMint(
      provider.connection,
      admin,
      vaultAuthority,
      null,
      MIND_DECIMALS,
      mindMint
    );
    stakingVaultMindAta = await createAccount(
      provider.connection,
      admin,
      mindMint.publicKey,
      vaultAuthority,
      Keypair.generate()
    );

    // Initialize protocol
    await program.methods
      .initialize({
        xntMint,
        mindDecimals: MIND_DECIMALS,
        xntDecimals: XNT_DECIMALS,
        totalSupplyMind: TOTAL_SUPPLY_MIND,
        minedCapPctBps: MINED_CAP_BPS,
        th1: TH1,
        th2: TH2,
        allowEpochSecondsEdit: true,
        epochSeconds: new BN(TEST_EPOCH_SECONDS),
      })
      .accounts({
        payer: admin.publicKey,
        admin: admin.publicKey,
        vaultAuthority,
        config: configPda,
        mindMint: mindMint.publicKey,
        xntMint,
        vaultXntAta,
        stakingVaultXntAta,
        stakingVaultMindAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    // Create positions
    await program.methods
      .createPosition(14, new BN(0))
      .accounts({
        owner: user.publicKey,
        config: configPda,
        position: positionPda(user.publicKey, 0),
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    await program.methods
      .createPosition(14, new BN(0))
      .accounts({
        owner: whale.publicKey,
        config: configPda,
        position: positionPda(whale.publicKey, 0),
        systemProgram: SystemProgram.programId,
      })
      .signers([whale])
      .rpc();

    // Fund users with XNT
    userXntAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        xntMint,
        user.publicKey
      )
    ).address;
    whaleXntAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        xntMint,
        whale.publicKey
      )
    ).address;

    const userDeposit = new BN(10).mul(SCALE); // 10 XNT
    const whaleDeposit = new BN(5_000).mul(SCALE); // whale deposit

    await mintTo(
      provider.connection,
      admin,
      xntMint,
      userXntAta,
      admin.publicKey,
      BigInt(userDeposit.toString())
    );
    await mintTo(
      provider.connection,
      admin,
      xntMint,
      whaleXntAta,
      admin.publicKey,
      BigInt(whaleDeposit.toString())
    );

    await program.methods
      .deposit(userDeposit)
      .accounts({
        owner: user.publicKey,
        config: configPda,
        position: positionPda(user.publicKey, 0),
        vaultAuthority,
        xntMint,
        vaultXntAta,
        ownerXntAta: userXntAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();
    await program.methods
      .deposit(whaleDeposit)
      .accounts({
        owner: whale.publicKey,
        config: configPda,
        position: positionPda(whale.publicKey, 0),
        vaultAuthority,
        xntMint,
        vaultXntAta,
        ownerXntAta: whaleXntAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([whale])
      .rpc();

    let epoch0 = 0;
    let epochState0: PublicKey | null = null;
    let userEpoch0: PublicKey | null = null;
    let lastEpoch0Err: unknown = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      epoch0 = await currentEpoch();
      epochState0 = epochPda(epoch0);
      userEpoch0 = userEpochPda(user.publicKey, epoch0);
      try {
        await program.methods
          .heartbeat(new BN(epoch0))
          .accounts({
            owner: user.publicKey,
            config: configPda,
            position: positionPda(user.publicKey, 0),
            epochState: epochState0,
            userEpoch: userEpoch0,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
        lastEpoch0Err = null;
        break;
      } catch (e) {
        lastEpoch0Err = e;
        if (!isInvalidEpochIndexError(e)) {
          throw e;
        }
        await sleep(250);
      }
    }
    if (lastEpoch0Err || !epochState0 || !userEpoch0) {
      throw lastEpoch0Err;
    }

    const fetchedEpoch0 = await program.account.epochState.fetch(epochState0);
    const config = await program.account.config.fetch(configPda);
    const totalMp0 = new BN(fetchedEpoch0.totalEffectiveMp.toString());
    const userMp0 = new BN(
      (await program.account.userEpoch.fetch(userEpoch0)).userMp.toString()
    );
    const expectedReward0 = computeReward(
      new BN(fetchedEpoch0.dailyEmission),
      totalMp0,
      userMp0,
      config.mpCapBpsPerWallet
    );

    await createAssociatedTokenAccountIdempotent(
      provider.connection,
      admin,
      mindMint.publicKey,
      user.publicKey,
      undefined,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    await program.methods
      .claim()
      .accounts({
        owner: user.publicKey,
        config: configPda,
        vaultAuthority,
        position: positionPda(user.publicKey, 0),
        epochState: epochState0,
        userEpoch: userEpoch0,
        mindMint: mindMint.publicKey,
        userMindAta: userMindAta(),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const userMindBalance0 = await getTokenAmount("userMindAta", userMindAta());
    expect(userMindBalance0.toString()).to.equal(expectedReward0.toString());

    // Miss heartbeat in epoch 1; claim should fail
    await sleep((TEST_EPOCH_SECONDS + 1) * 1000);
    const epoch1 = await currentEpoch();
    const userEpoch1 = userEpochPda(user.publicKey, epoch1);
    const epochState1 = epochPda(epoch1);
    let claimFailed = false;
    try {
      await program.methods
        .claim()
        .accounts({
          owner: user.publicKey,
          config: configPda,
          vaultAuthority,
          position: positionPda(user.publicKey, 0),
          epochState: epochState1,
          userEpoch: userEpoch1,
          mindMint: mindMint.publicKey,
          userMindAta: userMindAta(),
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
    } catch (e) {
      claimFailed = true;
    }
    expect(claimFailed).to.be.true;

    // Next epoch: both users heartbeat; whale is capped
    await sleep((TEST_EPOCH_SECONDS + 1) * 1000);
    let epoch2 = 0;
    let epochState2: PublicKey | null = null;
    let userEpoch2: PublicKey | null = null;
    let whaleEpoch2: PublicKey | null = null;
    let lastEpoch2Err: unknown = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      epoch2 = await currentEpoch();
      epochState2 = epochPda(epoch2);
      userEpoch2 = userEpochPda(user.publicKey, epoch2);
      whaleEpoch2 = userEpochPda(whale.publicKey, epoch2);
      try {
        const userHeartbeatIx = await program.methods
          .heartbeat(new BN(epoch2))
          .accounts({
            owner: user.publicKey,
            config: configPda,
            position: positionPda(user.publicKey, 0),
            epochState: epochState2,
            userEpoch: userEpoch2,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .instruction();
        const whaleHeartbeatIx = await program.methods
          .heartbeat(new BN(epoch2))
          .accounts({
            owner: whale.publicKey,
            config: configPda,
            position: positionPda(whale.publicKey, 0),
            epochState: epochState2,
            userEpoch: whaleEpoch2,
            systemProgram: SystemProgram.programId,
          })
          .signers([whale])
          .instruction();
        const heartbeatTx = new anchor.web3.Transaction().add(
          userHeartbeatIx,
          whaleHeartbeatIx
        );
        await provider.sendAndConfirm(heartbeatTx, [user, whale]);
        lastEpoch2Err = null;
        break;
      } catch (e) {
        lastEpoch2Err = e;
        if (!isInvalidEpochIndexError(e)) {
          throw e;
        }
        await sleep(250);
      }
    }
    if (lastEpoch2Err || !epochState2 || !userEpoch2 || !whaleEpoch2) {
      throw lastEpoch2Err;
    }

    const epoch2State = await program.account.epochState.fetch(epochState2);
    const totalMp2 = new BN(epoch2State.totalEffectiveMp.toString());
    const userMp2 = new BN(
      (await program.account.userEpoch.fetch(userEpoch2)).userMp.toString()
    );
    const whaleMp2 = new BN(
      (await program.account.userEpoch.fetch(whaleEpoch2)).userMp.toString()
    );
    const emission2 = new BN(epoch2State.dailyEmission);
    const expectedUserReward2 = computeReward(
      emission2,
      totalMp2,
      userMp2,
      config.mpCapBpsPerWallet
    );
    const expectedWhaleReward2 = computeReward(
      emission2,
      totalMp2,
      whaleMp2,
      config.mpCapBpsPerWallet
    );

    const userMindBefore = await getTokenAmount("userMindAta", userMindAta());
    await program.methods
      .claim()
      .accounts({
        owner: user.publicKey,
        config: configPda,
        vaultAuthority,
        position: positionPda(user.publicKey, 0),
        epochState: epochState2,
        userEpoch: userEpoch2,
        mindMint: mindMint.publicKey,
        userMindAta: userMindAta(),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    const userMindAfter = await getTokenAmount("userMindAta", userMindAta());
    const userReward2 = userMindAfter.sub(userMindBefore);
    expect(userReward2.toString()).to.equal(expectedUserReward2.toString());

    await createAssociatedTokenAccountIdempotent(
      provider.connection,
      admin,
      mindMint.publicKey,
      whale.publicKey,
      undefined,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const whaleMindBefore = await getTokenAmount("whaleMindAta", whaleMindAta());
    await program.methods
      .claim()
      .accounts({
        owner: whale.publicKey,
        config: configPda,
        vaultAuthority,
        position: positionPda(whale.publicKey, 0),
        epochState: epochState2,
        userEpoch: whaleEpoch2,
        mindMint: mindMint.publicKey,
        userMindAta: whaleMindAta(),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([whale])
      .rpc();
    const whaleMindAfter = await getTokenAmount("whaleMindAta", whaleMindAta());
    const whaleReward2 = whaleMindAfter.sub(whaleMindBefore);

    // Whale reward must be capped and close to the computed expectation
    expect(
      whaleReward2.lte(expectedWhaleReward2),
      "whale reward should not exceed cap"
    ).to.be.true;
    expect(whaleReward2.toString()).to.equal(expectedWhaleReward2.toString());

    // Wait until lock expires (duration scaled by epoch_seconds under test flag)
    const userPosition = await program.account.userPosition.fetch(
      positionPda(user.publicKey, 0)
    );
    const now = await getClusterTime();
    const waitMs = Math.max(
      0,
      userPosition.lockEndTs.toNumber() - now + 1
    ) * 1000;
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    await program.methods
      .withdraw()
      .accounts({
        owner: user.publicKey,
        config: configPda,
        position: positionPda(user.publicKey, 0),
        vaultAuthority,
        xntMint,
        vaultXntAta,
        ownerXntAta: userXntAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const userXntBalance = await getTokenAmount("userXntAta", userXntAta);
    expect(userXntBalance.toString()).to.equal(userDeposit.toString());
  });
});
