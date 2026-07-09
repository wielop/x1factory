import anchorPkg, * as anchor from "@coral-xyz/anchor";
const { BN, Program } = anchorPkg;
import * as splTokenPkg from "@solana/spl-token";
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} = splTokenPkg;
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import type { Launchpad } from "../target/types/launchpad";
import launchpadIdl from "../target/idl/launchpad.json" with { type: "json" };
import { createHash } from "crypto";

// Same IDL shim as tests/mining_v2.ts — anchor-lang 0.28 emits an older IDL shape
// (isMut/isSigner, `defined: string`, missing discriminators) than @coral-xyz/anchor
// 0.30.1's Program class expects.
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

describe("launchpad", () => {
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);
  const programId = new PublicKey("AGAdJKoLhrGrdFwrZZDEWsoR1Tq8kMcXGRKxX2wa2jfm");
  const idl = normalizeIdl(launchpadIdl as anchor.Idl);
  idl.address = programId.toBase58();
  const program = new Program(idl, provider) as Program<Launchpad>;

  const upgradeableLoaderId = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const [programData] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    upgradeableLoaderId
  );

  const admin = (provider.wallet as anchor.Wallet & { payer: Keypair }).payer;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("launchpad_config")],
    program.programId
  );
  const [treasuryVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("launchpad_treasury")],
    program.programId
  );

  const curvePda = (mint: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("curve"), mint.toBuffer()], program.programId)[0];
  const curveXntVaultPda = (mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("curve_xnt_vault"), mint.toBuffer()],
      program.programId
    )[0];
  const rewardPoolXntVaultPda = (mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("reward_pool_xnt"), mint.toBuffer()],
      program.programId
    )[0];
  const curveTokenVaultPda = (mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("curve_token_vault"), mint.toBuffer()],
      program.programId
    )[0];
  const rewardPoolTokenVaultPda = (mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("reward_pool_token"), mint.toBuffer()],
      program.programId
    )[0];
  const gradReserveVaultPda = (mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("grad_reserve"), mint.toBuffer()],
      program.programId
    )[0];

  const DECIMALS_MULTIPLIER = 1_000_000;
  const TOTAL_SUPPLY = new BN(1_000_000_000).mul(new BN(DECIMALS_MULTIPLIER));
  const CURVE_ALLOCATION = new BN(800_000_000).mul(new BN(DECIMALS_MULTIPLIER));
  const REWARD_POOL_TOKEN_ALLOCATION = new BN(50_000_000).mul(new BN(DECIMALS_MULTIPLIER));
  const GRAD_RESERVE_ALLOCATION = new BN(140_000_000).mul(new BN(DECIMALS_MULTIPLIER));
  const CREATOR_ALLOCATION = new BN(10_000_000).mul(new BN(DECIMALS_MULTIPLIER));
  const XNT_USD_CENTS = 50; // $0.50 / XNT

  const airdrop = async (pubkey: PublicKey, sol = 5) => {
    const sig = await provider.connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
  };

  before(async () => {
    // init_global_config is a no-op if it already ran in a prior test invocation against the
    // same local validator state; guard with a try/catch since `init` fails on a second call.
    try {
      await program.methods
        .initGlobalConfig(admin.publicKey, new BN(XNT_USD_CENTS), new BN(0))
        .accounts({
          config: configPda,
          treasuryVault: treasuryVaultPda,
          payer: admin.publicKey,
          programData,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .signers([admin])
        .rpc();
    } catch (e: any) {
      if (!String(e?.message ?? e).includes("already in use")) {
        throw e;
      }
    }
  });

  async function createToken(creator: Keypair) {
    const mint = Keypair.generate();
    const curve = curvePda(mint.publicKey);
    const curveXntVault = curveXntVaultPda(mint.publicKey);
    const rewardPoolXntVault = rewardPoolXntVaultPda(mint.publicKey);
    const curveTokenVault = curveTokenVaultPda(mint.publicKey);
    const rewardPoolTokenVault = rewardPoolTokenVaultPda(mint.publicKey);
    const gradReserveVault = gradReserveVaultPda(mint.publicKey);
    const creatorTokenAccount = getAssociatedTokenAddressSync(mint.publicKey, creator.publicKey);

    const tx = new anchor.web3.Transaction();
    tx.add(
      await program.methods
        .createMint("Test Meme", "TEST", "https://example.com/test.json")
        .accounts({
          config: configPda,
          treasuryVault: treasuryVaultPda,
          creator: creator.publicKey,
          mint: mint.publicKey,
          creatorTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        } as any)
        .instruction()
    );
    tx.add(
      await program.methods
        .initCurve()
        .accounts({
          creator: creator.publicKey,
          mint: mint.publicKey,
          curve,
          curveXntVault,
          rewardPoolXntVault,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .instruction()
    );
    tx.add(
      await program.methods
        .initCurveTokenVault()
        .accounts({
          creator: creator.publicKey,
          mint: mint.publicKey,
          curve,
          curveTokenVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        } as any)
        .instruction()
    );
    tx.add(
      await program.methods
        .initRewardPoolTokenVault()
        .accounts({
          creator: creator.publicKey,
          mint: mint.publicKey,
          curve,
          rewardPoolTokenVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        } as any)
        .instruction()
    );
    tx.add(
      await program.methods
        .initGradReserveVault()
        .accounts({
          creator: creator.publicKey,
          mint: mint.publicKey,
          curve,
          gradReserveVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        } as any)
        .instruction()
    );
    tx.add(
      await program.methods
        .finalizeToken(new BN(0))
        .accounts({
          config: configPda,
          creator: creator.publicKey,
          mint: mint.publicKey,
          curve,
          curveTokenVault,
          rewardPoolTokenVault,
          gradReserveVault,
          rewardPoolXntVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .instruction()
    );

    await provider.sendAndConfirm(tx, [creator, mint]);

    return {
      mint: mint.publicKey,
      curve,
      curveXntVault,
      rewardPoolXntVault,
      curveTokenVault,
      rewardPoolTokenVault,
      gradReserveVault,
      creatorTokenAccount,
    };
  }

  it("creates a token with the correct fixed supply and allocations", async () => {
    const creator = Keypair.generate();
    await airdrop(creator.publicKey);

    const t = await createToken(creator);

    const mintInfo = await getMint(provider.connection, t.mint);
    expect(mintInfo.decimals).to.equal(6);
    expect(mintInfo.mintAuthority).to.be.null; // revoked in finalize_token
    expect(BigInt(mintInfo.supply.toString())).to.equal(BigInt(TOTAL_SUPPLY.toString()));

    const curveTokenBal = await getAccount(provider.connection, t.curveTokenVault);
    expect(curveTokenBal.amount.toString()).to.equal(CURVE_ALLOCATION.toString());

    const rewardPoolTokenBal = await getAccount(provider.connection, t.rewardPoolTokenVault);
    expect(rewardPoolTokenBal.amount.toString()).to.equal(REWARD_POOL_TOKEN_ALLOCATION.toString());

    const gradReserveBal = await getAccount(provider.connection, t.gradReserveVault);
    expect(gradReserveBal.amount.toString()).to.equal(GRAD_RESERVE_ALLOCATION.toString());

    const creatorBal = await getAccount(provider.connection, t.creatorTokenAccount);
    expect(creatorBal.amount.toString()).to.equal(CREATOR_ALLOCATION.toString());

    const curveAccount = await (program.account as any).bondingCurve.fetch(t.curve);
    expect(curveAccount.mint.toBase58()).to.equal(t.mint.toBase58());
    expect(curveAccount.realTokenReserves.toString()).to.equal(CURVE_ALLOCATION.toString());
    expect(curveAccount.rewardPoolTokenBalance.toString()).to.equal(
      REWARD_POOL_TOKEN_ALLOCATION.toString()
    );
    expect(curveAccount.complete).to.equal(false);
  });

  it("buys tokens off the curve, moving reserves and paying fees", async () => {
    const creator = Keypair.generate();
    await airdrop(creator.publicKey);
    const t = await createToken(creator);

    const user = Keypair.generate();
    await airdrop(user.publicKey, 10);
    const userTokenAccount = await createAssociatedTokenAccountIdempotent(
      provider.connection,
      user,
      t.mint,
      user.publicKey
    );

    const before = await (program.account as any).bondingCurve.fetch(t.curve);
    const xntIn = new BN(2).mul(new BN(LAMPORTS_PER_SOL)); // 2 XNT

    await program.methods
      .buy(xntIn, new BN(0))
      .accounts({
        config: configPda,
        treasuryVault: treasuryVaultPda,
        curve: t.curve,
        curveXntVault: t.curveXntVault,
        rewardPoolXntVault: t.rewardPoolXntVault,
        curveTokenVault: t.curveTokenVault,
        rewardPoolTokenVault: t.rewardPoolTokenVault,
        mint: t.mint,
        user: user.publicKey,
        userTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([user])
      .rpc();

    const after = await (program.account as any).bondingCurve.fetch(t.curve);
    const userBal = await getAccount(provider.connection, userTokenAccount);

    expect(userBal.amount > 0n).to.equal(true);
    expect(after.realTokenReserves.lt(before.realTokenReserves)).to.equal(true);
    expect(after.realXntReserves.gt(before.realXntReserves)).to.equal(true);
    // 1% fee: 0.5% treasury + 0.5% reward pool — reward pool XNT balance should have grown.
    expect(after.rewardPoolXntBalance.gt(before.rewardPoolXntBalance)).to.equal(true);

    const curveXntVaultBal = await provider.connection.getBalance(t.curveXntVault);
    expect(curveXntVaultBal).to.be.greaterThan(0);
  });

  it("sells tokens back into the curve for XNT", async () => {
    const creator = Keypair.generate();
    await airdrop(creator.publicKey);
    const t = await createToken(creator);

    const user = Keypair.generate();
    await airdrop(user.publicKey, 10);
    const userTokenAccount = await createAssociatedTokenAccountIdempotent(
      provider.connection,
      user,
      t.mint,
      user.publicKey
    );

    await program.methods
      .buy(new BN(3).mul(new BN(LAMPORTS_PER_SOL)), new BN(0))
      .accounts({
        config: configPda,
        treasuryVault: treasuryVaultPda,
        curve: t.curve,
        curveXntVault: t.curveXntVault,
        rewardPoolXntVault: t.rewardPoolXntVault,
        curveTokenVault: t.curveTokenVault,
        rewardPoolTokenVault: t.rewardPoolTokenVault,
        mint: t.mint,
        user: user.publicKey,
        userTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([user])
      .rpc();

    const afterBuy = await getAccount(provider.connection, userTokenAccount);
    const curveBeforeSell = await (program.account as any).bondingCurve.fetch(t.curve);
    const sellAmount = new BN(afterBuy.amount.toString()).div(new BN(2));

    const userLamportsBefore = await provider.connection.getBalance(user.publicKey);

    await program.methods
      .sell(sellAmount, new BN(0))
      .accounts({
        config: configPda,
        treasuryVault: treasuryVaultPda,
        curve: t.curve,
        curveXntVault: t.curveXntVault,
        rewardPoolXntVault: t.rewardPoolXntVault,
        curveTokenVault: t.curveTokenVault,
        rewardPoolTokenVault: t.rewardPoolTokenVault,
        mint: t.mint,
        user: user.publicKey,
        userTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([user])
      .rpc();

    const userLamportsAfter = await provider.connection.getBalance(user.publicKey);
    const curveAfterSell = await (program.account as any).bondingCurve.fetch(t.curve);
    const afterSellTokenBal = await getAccount(provider.connection, userTokenAccount);

    // Net of the tx fee (~5000 lamports), the user should have received XNT back.
    expect(userLamportsAfter).to.be.greaterThan(userLamportsBefore);
    expect(curveAfterSell.realTokenReserves.gt(curveBeforeSell.realTokenReserves)).to.equal(true);
    expect(curveAfterSell.realXntReserves.lt(curveBeforeSell.realXntReserves)).to.equal(true);
    expect(afterSellTokenBal.amount.toString()).to.equal(
      (BigInt(afterBuy.amount.toString()) - BigInt(sellAmount.toString())).toString()
    );
  });

  it("rejects a buy when slippage tolerance is not met", async () => {
    const creator = Keypair.generate();
    await airdrop(creator.publicKey);
    const t = await createToken(creator);

    const user = Keypair.generate();
    await airdrop(user.publicKey, 10);
    const userTokenAccount = await createAssociatedTokenAccountIdempotent(
      provider.connection,
      user,
      t.mint,
      user.publicKey
    );

    let threw = false;
    try {
      await program.methods
        .buy(new BN(1).mul(new BN(LAMPORTS_PER_SOL)), new BN(TOTAL_SUPPLY)) // impossible min_tokens_out
        .accounts({
          config: configPda,
          treasuryVault: treasuryVaultPda,
          curve: t.curve,
          curveXntVault: t.curveXntVault,
          rewardPoolXntVault: t.rewardPoolXntVault,
          curveTokenVault: t.curveTokenVault,
          rewardPoolTokenVault: t.rewardPoolTokenVault,
          mint: t.mint,
          user: user.publicKey,
          userTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .signers([user])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(String(e?.message ?? e)).to.match(/Slippage|0x/i);
    }
    expect(threw).to.equal(true);
  });

  it("hits at least one GigaSwap jackpot across enough qualifying buys (statistical)", async function () {
    this.timeout(120_000);
    const creator = Keypair.generate();
    await airdrop(creator.publicKey);
    const t = await createToken(creator);

    // Seed the token-side reward pool with extra XNT too, so both sides of the dominant-pool
    // check have a chance to be picked across many trades (token side starts big at 10% of
    // supply; this just exercises the codepath without asserting on exact tier distribution).
    const user = Keypair.generate();
    // Curve is small now (virtual_xnt_reserves = 200 XNT, ~586 XNT to fully sell out) — keep
    // per-buy size well under that so the loop can't accidentally hit SoldOut mid-run.
    await airdrop(user.publicKey, 600); // 40 iterations × 12 XNT + fees, comfortably under sellout
    const userTokenAccount = await createAssociatedTokenAccountIdempotent(
      provider.connection,
      user,
      t.mint,
      user.publicKey
    );

    let sawGigaHit = false;
    for (let i = 0; i < 40 && !sawGigaHit; i++) {
      await program.methods
        .buy(new BN(12).mul(new BN(LAMPORTS_PER_SOL)), new BN(0)) // 12 XNT ≈ $6, above $5 threshold
        .accounts({
          config: configPda,
          treasuryVault: treasuryVaultPda,
          curve: t.curve,
          curveXntVault: t.curveXntVault,
          rewardPoolXntVault: t.rewardPoolXntVault,
          curveTokenVault: t.curveTokenVault,
          rewardPoolTokenVault: t.rewardPoolTokenVault,
          mint: t.mint,
          user: user.publicKey,
          userTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .signers([user])
        .rpc();

      const curve = await (program.account as any).bondingCurve.fetch(t.curve);
      if (curve.gigaHits.toNumber() > 0) {
        sawGigaHit = true;
      }
    }

    expect(sawGigaHit).to.equal(true);
  });
});
