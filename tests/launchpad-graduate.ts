import anchorPkg, * as anchor from "@coral-xyz/anchor";
const { BN, Program } = anchorPkg;
import * as splTokenPkg from "@solana/spl-token";
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} = splTokenPkg;
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import type { Launchpad } from "../target/types/launchpad";
import launchpadIdl from "../target/idl/launchpad.json" with { type: "json" };
import { createHash } from "crypto";

// Same IDL shim as tests/launchpad.ts.
const normalizeIdl = (raw: anchor.Idl): anchor.Idl => {
  const clone = JSON.parse(JSON.stringify(raw)) as anchor.Idl;
  const toSnakeCase = (value: string) =>
    value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
  const discriminator = (namespace: string, name: string) =>
    Buffer.from(createHash("sha256").update(`${namespace}:${name}`).digest().slice(0, 8));
  const fixDefined = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(fixDefined);
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.defined === "string") record.defined = { name: record.defined, generics: [] };
      for (const key of Object.keys(record)) record[key] = fixDefined(record[key]);
      return record;
    }
    if (typeof value === "string") return value === "publicKey" ? "pubkey" : value;
    return value;
  };
  const idl = fixDefined(clone) as anchor.Idl;
  const normalizeAccounts = (items: Array<Record<string, unknown>>) => {
    for (const item of items) {
      if (Array.isArray(item.accounts)) normalizeAccounts(item.accounts as Array<Record<string, unknown>>);
      if (Object.prototype.hasOwnProperty.call(item, "isMut")) { item.writable = item.isMut; delete item.isMut; }
      if (Object.prototype.hasOwnProperty.call(item, "isSigner")) { item.signer = item.isSigner; delete item.isSigner; }
    }
  };
  if (Array.isArray((idl as any).instructions)) {
    for (const ix of (idl as any).instructions) if (Array.isArray(ix.accounts)) normalizeAccounts(ix.accounts);
  }
  for (const ix of (idl as any).instructions ?? []) {
    if (!ix.discriminator) ix.discriminator = discriminator("global", toSnakeCase(ix.name));
  }
  for (const acc of (idl as any).accounts ?? []) {
    if (!acc.discriminator) acc.discriminator = discriminator("account", acc.name);
  }
  const types = ((idl as any).types ?? []) as Array<{ name: string; type: unknown }>;
  (idl as any).types = types;
  for (const acc of (idl as any).accounts ?? []) {
    if (acc.type && !types.some((ty) => ty.name === acc.name)) types.push({ name: acc.name, type: acc.type });
  }
  for (const evt of (idl as any).events ?? []) {
    if (!evt.discriminator) evt.discriminator = discriminator("event", evt.name);
    if (evt.fields && !types.some((ty) => ty.name === evt.name)) {
      types.push({ name: evt.name, type: { kind: "struct", fields: evt.fields } });
    }
  }
  return idl;
};

describe("launchpad graduate()", function () {
  this.timeout(180_000);

  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);
  const programId = new PublicKey("AGAdJKoLhrGrdFwrZZDEWsoR1Tq8kMcXGRKxX2wa2jfm");
  const idl = normalizeIdl(launchpadIdl as anchor.Idl);
  idl.address = programId.toBase58();
  const program = new Program(idl, provider) as Program<Launchpad>;

  const upgradeableLoaderId = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], upgradeableLoaderId);
  const admin = (provider.wallet as anchor.Wallet & { payer: Keypair }).payer;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("launchpad_config")], programId);
  const [treasuryVaultPda] = PublicKey.findProgramAddressSync([Buffer.from("launchpad_treasury")], programId);

  const curvePda = (mint: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("curve"), mint.toBuffer()], programId)[0];
  const curveXntVaultPda = (mint: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("curve_xnt_vault"), mint.toBuffer()], programId)[0];
  const rewardPoolXntVaultPda = (mint: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("reward_pool_xnt"), mint.toBuffer()], programId)[0];
  const curveTokenVaultPda = (mint: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("curve_token_vault"), mint.toBuffer()], programId)[0];
  const rewardPoolTokenVaultPda = (mint: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("reward_pool_token"), mint.toBuffer()], programId)[0];
  const gradReserveVaultPda = (mint: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("grad_reserve"), mint.toBuffer()], programId)[0];

  // xdex (Raydium CP-Swap fork) — cloned onto this local validator from X1 mainnet.
  const XDEX_PROGRAM_ID = new PublicKey("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
  const XDEX_AMM_CONFIG = new PublicKey("2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c");
  const XDEX_CREATE_POOL_FEE_RECEIVER = new PublicKey("SKc6b6zAv2kkB9EtitjppbzPVR48bCMfRtE5B8KDuF1");
  const WXNT_MINT = new PublicKey("So11111111111111111111111111111111111111112");

  const [xdexAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_and_lp_mint_auth_seed")],
    XDEX_PROGRAM_ID
  );
  const xdexPoolState = (mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), XDEX_AMM_CONFIG.toBuffer(), WXNT_MINT.toBuffer(), mint.toBuffer()],
      XDEX_PROGRAM_ID
    )[0];
  const xdexLpMint = (poolState: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("pool_lp_mint"), poolState.toBuffer()], XDEX_PROGRAM_ID)[0];
  const xdexVault = (poolState: PublicKey, mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("pool_vault"), poolState.toBuffer(), mint.toBuffer()],
      XDEX_PROGRAM_ID
    )[0];
  const xdexObservationState = (poolState: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("observation"), poolState.toBuffer()], XDEX_PROGRAM_ID)[0];

  const airdrop = async (pubkey: PublicKey, sol: number) => {
    // solana-test-validator's default faucet request cap is well under 700 SOL per call —
    // split into chunks.
    const chunk = 100;
    for (let sent = 0; sent < sol; sent += chunk) {
      const amount = Math.min(chunk, sol - sent);
      const sig = await provider.connection.requestAirdrop(pubkey, amount * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }
  };

  function errCode(err: any): string | undefined {
    return err?.error?.errorCode?.code ?? err?.errorCode?.code;
  }

  before(async () => {
    try {
      await program.methods
        .initGlobalConfig(admin.publicKey, new BN(50), new BN(0))
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
      if (!String(e?.message ?? e).includes("already in use")) throw e;
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
        .createMint("Graduate Test", "GRADT", "")
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

  // The constant-product curve only reaches an *exact* real_token_reserves == 0 if a buy lands
  // precisely on the remaining balance — buy() hard-reverts (SoldOut) rather than partial-
  // filling an oversized request, so a fixed-size chunk loop always leaves nonzero dust.
  // Mirror the on-chain integer math exactly (BigInt, same floor-division semantics as the
  // Rust u128 arithmetic) to compute the one buy that drains the remainder to precisely 0.
  function simulateTokensOut(virtualToken: bigint, virtualXnt: bigint, xntToCurve: bigint): bigint {
    const k = virtualToken * virtualXnt;
    const newVirtualXnt = virtualXnt + xntToCurve;
    const newVirtualToken = k / newVirtualXnt;
    return virtualToken - newVirtualToken;
  }

  // Below this, no lamport-sized buy can move the curve further (its local granularity near
  // full sellout is coarser than 1 raw token unit) — matches GRADUATION_DUST_THRESHOLD on-chain.
  const DUST_THRESHOLD = 1_000n;

  // Constant-product floor division only lands on an *exact* target token amount for roughly
  // 1-in-N integer inputs (N ~ derivative of the curve at that point) — hunting for an exact
  // match in one shot is unreliable. Instead repeatedly take the largest *safe* buy (the one
  // guaranteed not to exceed the remaining balance); each application shrinks the remainder
  // sharply, converging to a dust amount too small for any further lamport-sized buy to touch.
  async function buyExactRemainder(user: Keypair, t: any, feeBps: bigint) {
    for (let attempt = 0; attempt < 25; attempt++) {
      const curve = await (program.account as any).bondingCurve.fetch(t.curve);
      const remaining = BigInt(curve.realTokenReserves.toString());
      if (remaining <= DUST_THRESHOLD) return;
      const virtualToken = BigInt(curve.virtualTokenReserves.toString());
      const virtualXnt = BigInt(curve.virtualXntReserves.toString());
      const k = virtualToken * virtualXnt;
      const target = virtualToken - remaining;

      // Largest xnt_to_curve whose floor-division new_virtual_token is still >= target, i.e.
      // tokens_out <= remaining (never reverts with SoldOut).
      let xntToCurve = k / target - virtualXnt;
      if (xntToCurve <= 0n) continue;
      while (simulateTokensOut(virtualToken, virtualXnt, xntToCurve) > remaining) xntToCurve -= 1n;

      // Invert xnt_to_curve = xnt_in - floor(xnt_in * feeBps / 10000), then back off by 1 at a
      // time if fee rounding pushed the actual on-chain xnt_to_curve past our safe target.
      const denom = 10000n - feeBps;
      let xntIn = (xntToCurve * 10000n + denom - 1n) / denom;
      while (xntIn - (xntIn * feeBps) / 10000n > xntToCurve) xntIn -= 1n;
      if (xntIn <= 0n) continue;

      await program.methods
        .buy(new BN(xntIn.toString()), new BN(0))
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
          userTokenAccount: t.creatorTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .signers([user])
        .rpc();

    }
    const final = await (program.account as any).bondingCurve.fetch(t.curve);
    if (BigInt(final.realTokenReserves.toString()) > DUST_THRESHOLD) {
      throw new Error("buyExactRemainder did not converge below the dust threshold");
    }
  }

  it("sells the curve fully out, then graduates it to a new xdex pool with LP burned", async () => {
    const creator = Keypair.generate();
    await airdrop(creator.publicKey, 700);
    const t = await createToken(creator);

    // Buy in large chunks first, stopping well short of SoldOut...
    const buyChunk = new BN(35).mul(new BN(LAMPORTS_PER_SOL));
    let buys = 0;
    for (let i = 0; i < 40; i++) {
      const curve = await (program.account as any).bondingCurve.fetch(t.curve);
      if (BigInt(curve.realTokenReserves.toString()) < 20_000_000_000_000n) break; // ~20M tokens left
      await program.methods
        .buy(buyChunk, new BN(0))
        .accounts({
          config: configPda,
          treasuryVault: treasuryVaultPda,
          curve: t.curve,
          curveXntVault: t.curveXntVault,
          rewardPoolXntVault: t.rewardPoolXntVault,
          curveTokenVault: t.curveTokenVault,
          rewardPoolTokenVault: t.rewardPoolTokenVault,
          mint: t.mint,
          user: creator.publicKey,
          userTokenAccount: t.creatorTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .signers([creator])
        .rpc();
      buys++;
    }
    // ...then repeated precisely-sized buys that drain it below the graduation dust threshold.
    await buyExactRemainder(creator, t, 100n);
    console.log(`      drained to dust after ${buys} bulk buys + precise final buys`);

    const curveBefore = await (program.account as any).bondingCurve.fetch(t.curve);
    expect(curveBefore.realTokenReserves.toNumber()).to.be.at.most(1000);
    expect(curveBefore.complete).to.equal(false);
    const xntToMigrate = curveBefore.realXntReserves as InstanceType<typeof BN>;
    console.log(`      real_xnt_reserves to migrate: ${xntToMigrate.toString()}`);
    console.log(`      dust left unsold on the curve: ${curveBefore.realTokenReserves.toString()} raw units`);

    const [xdexCreator] = PublicKey.findProgramAddressSync(
      [Buffer.from("xdex_creator"), t.mint.toBuffer()],
      programId
    );
    const poolState = xdexPoolState(t.mint);
    const lpMint = xdexLpMint(poolState);
    const vault0 = xdexVault(poolState, WXNT_MINT);
    const vault1 = xdexVault(poolState, t.mint);
    const observationState = xdexObservationState(poolState);
    const curveWxntAta = getAssociatedTokenAddressSync(WXNT_MINT, xdexCreator, true);
    const curveMintAta = getAssociatedTokenAddressSync(t.mint, xdexCreator, true);
    const curveLpAta = getAssociatedTokenAddressSync(lpMint, xdexCreator, true);

    const payer = Keypair.generate();
    await airdrop(payer.publicKey, 2);

    let sig: string;
    try {
      await program.methods
        .graduatePrepare()
        .accounts({
          payer: payer.publicKey,
          mint: t.mint,
          curve: t.curve,
          curveXntVault: t.curveXntVault,
          gradReserveVault: t.gradReserveVault,
          wxntMint: WXNT_MINT,
          xdexCreator,
          curveWxntAta,
          curveMintAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        } as any)
        .signers([payer])
        .rpc();

      sig = await program.methods
        .graduateFinalize()
        .preInstructions([
          anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ])
        .accounts({
          mint: t.mint,
          curve: t.curve,
          xdexCreator,
          curveWxntAta,
          curveMintAta,
          wxntMint: WXNT_MINT,
          xdexAmmConfig: XDEX_AMM_CONFIG,
          xdexAuthority,
          xdexPoolState: poolState,
          xdexLpMint: lpMint,
          curveLpAta,
          xdexVault0: vault0,
          xdexVault1: vault1,
          xdexCreatePoolFeeReceiver: XDEX_CREATE_POOL_FEE_RECEIVER,
          xdexObservationState: observationState,
          xdexProgram: XDEX_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();
    } catch (e: any) {
      console.log("      graduate FAILED, full logs:");
      console.log((e?.logs ?? e?.transactionLogs ?? []).join("\n"));
      throw e;
    }
    console.log(`      graduate_finalize() tx: ${sig}`);

    const curveAfter = await (program.account as any).bondingCurve.fetch(t.curve);
    expect(curveAfter.complete).to.equal(true);
    expect(curveAfter.realXntReserves.toNumber()).to.equal(0);

    const poolStateInfo = await provider.connection.getAccountInfo(poolState);
    expect(poolStateInfo).to.not.equal(null);
    expect(poolStateInfo!.owner.toBase58()).to.equal(XDEX_PROGRAM_ID.toBase58());

    // Every LP token minted to us got burned immediately (see graduate_finalize) — total
    // supply should be back to 0 (or whatever tiny dust the AMM's own internal minimum-
    // liquidity lock accounts for without minting real circulating supply), proving nobody,
    // including us, holds any claim on the new pool's liquidity.
    const lpMintInfo = await getMint(provider.connection, lpMint);
    expect(lpMintInfo.supply).to.equal(0n);

    const vault0Bal = await getAccount(provider.connection, vault0);
    const vault1Bal = await getAccount(provider.connection, vault1);
    expect(vault0Bal.amount > 0n).to.equal(true);
    expect(vault1Bal.amount > 0n).to.equal(true);
    console.log(`      new pool vaults: WXNT=${vault0Bal.amount} token=${vault1Bal.amount}`);

    // LP tokens must be burned to zero — nobody, including us, can pull liquidity back out.
    const curveLpAtaBal = await getAccount(provider.connection, curveLpAta);
    expect(curveLpAtaBal.amount).to.equal(0n);

    console.log(`      pool_state: ${poolState.toBase58()}`);
    console.log(`      lp_mint:    ${lpMint.toBase58()} (supply ${lpMintInfo.supply}, all burned back to curve)`);

    // sweep_reward_pool: burns whatever's left in the token-side reward pool, sends the
    // XNT-side to the global treasury vault — verify both actually happen and the on-chain
    // balance fields zero out.
    const rewardTokenVault = rewardPoolTokenVaultPda(t.mint);
    const rewardXntVault = rewardPoolXntVaultPda(t.mint);
    const curveBeforeSweep = await (program.account as any).bondingCurve.fetch(t.curve);
    const rewardTokenBefore = curveBeforeSweep.rewardPoolTokenBalance.toNumber();
    const rewardXntBefore = curveBeforeSweep.rewardPoolXntBalance.toNumber();
    expect(rewardTokenBefore > 0).to.equal(true);
    expect(rewardXntBefore > 0).to.equal(true);

    const treasuryBefore = await provider.connection.getBalance(treasuryVaultPda);
    const mintInfoBefore = await getMint(provider.connection, t.mint);

    await program.methods
      .sweepRewardPool()
      .accounts({
        config: configPda,
        treasuryVault: treasuryVaultPda,
        mint: t.mint,
        curve: t.curve,
        rewardPoolXntVault: rewardXntVault,
        rewardPoolTokenVault: rewardTokenVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const curveAfterSweep = await (program.account as any).bondingCurve.fetch(t.curve);
    expect(curveAfterSweep.rewardPoolTokenBalance.toNumber()).to.equal(0);
    expect(curveAfterSweep.rewardPoolXntBalance.toNumber()).to.equal(0);

    const mintInfoAfter = await getMint(provider.connection, t.mint);
    expect(Number(mintInfoBefore.supply - mintInfoAfter.supply)).to.equal(rewardTokenBefore);

    const treasuryAfter = await provider.connection.getBalance(treasuryVaultPda);
    expect(treasuryAfter - treasuryBefore).to.equal(rewardXntBefore);

    console.log(`      sweep_reward_pool: burned ${rewardTokenBefore} tokens, sent ${rewardXntBefore} lamports to treasury`);
  });
});
