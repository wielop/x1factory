import { BN } from "@coral-xyz/anchor";
import dotenv from "dotenv";
import { fetchConfig } from "../web/lib/solana";
import { deriveConfigPda, getProgram, getProvider } from "./common";

dotenv.config();

const DEFAULT_XP_7D = "100";
const DEFAULT_XP_14D = "1200";
const DEFAULT_XP_30D = "7000";
const DEFAULT_XP_TIER_SILVER = "1000";
const DEFAULT_XP_TIER_GOLD = "5000";
const DEFAULT_XP_TIER_DIAMOND = "15000";
const DEFAULT_XP_BOOST_SILVER = "200";
const DEFAULT_XP_BOOST_GOLD = "500";
const DEFAULT_XP_BOOST_DIAMOND = "1000";

const main = async () => {
  const program = getProgram();
  const provider = getProvider();

  const config = await fetchConfig(provider.connection);
  const configPda = deriveConfigPda();

  const xpPer7d = new BN(process.env.XP_PER_7D ?? DEFAULT_XP_7D);
  const xpPer14d = new BN(process.env.XP_PER_14D ?? DEFAULT_XP_14D);
  const xpPer30d = new BN(process.env.XP_PER_30D ?? DEFAULT_XP_30D);
  const xpTierSilver = new BN(process.env.XP_TIER_SILVER ?? DEFAULT_XP_TIER_SILVER);
  const xpTierGold = new BN(process.env.XP_TIER_GOLD ?? DEFAULT_XP_TIER_GOLD);
  const xpTierDiamond = new BN(
    process.env.XP_TIER_DIAMOND ?? DEFAULT_XP_TIER_DIAMOND
  );
  const xpBoostSilverBps = Number(
    process.env.XP_BOOST_SILVER_BPS ?? DEFAULT_XP_BOOST_SILVER
  );
  const xpBoostGoldBps = Number(
    process.env.XP_BOOST_GOLD_BPS ?? DEFAULT_XP_BOOST_GOLD
  );
  const xpBoostDiamondBps = Number(
    process.env.XP_BOOST_DIAMOND_BPS ?? DEFAULT_XP_BOOST_DIAMOND
  );

  console.log("[xp] config:", configPda.toBase58());
  console.log("[xp] xp_per_7d:", xpPer7d.toString());
  console.log("[xp] xp_per_14d:", xpPer14d.toString());
  console.log("[xp] xp_per_30d:", xpPer30d.toString());
  console.log("[xp] tiers:", {
    silver: xpTierSilver.toString(),
    gold: xpTierGold.toString(),
    diamond: xpTierDiamond.toString(),
  });
  console.log("[xp] boosts bps:", {
    silver: xpBoostSilverBps,
    gold: xpBoostGoldBps,
    diamond: xpBoostDiamondBps,
  });

  const tx = await program.methods
    .adminUpdateConfig({
      th1: config.th1,
      th2: config.th2,
      mpCapBpsPerWallet: config.mpCapBpsPerWallet,
      updateEpochSeconds: false,
      epochSeconds: config.epochSeconds,
      updateXpConfig: true,
      xpPer7d,
      xpPer14d,
      xpPer30d,
      xpTierSilver,
      xpTierGold,
      xpTierDiamond,
      xpBoostSilverBps,
      xpBoostGoldBps,
      xpBoostDiamondBps,
    })
    .accounts({
      admin: program.provider.publicKey,
      config: configPda,
    })
    .rpc();

  console.log("[xp] tx:", tx);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
