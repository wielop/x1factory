import { PublicKey } from "@solana/web3.js";

// Bedrock (nastepca X1Factory) - ODREBNY program od mining_v2/lib/solana.ts,
// wciaz na X1 TESTNET (Bedrock jeszcze nie jest na mainnecie). Adresy z
// ~/x1gold/scripts/deployed-addresses.json (repo Anchor), zsynchronizowane
// recznie - jesli claims_v1 zostanie ponownie zainicjalizowany/zmigrowany,
// zaktualizuj ten plik.
export const BEDROCK_RPC_URL = "https://rpc.testnet.x1.xyz";

export const CLAIMS_V1_PROGRAM_ID = new PublicKey("6Rr5UgziR3aPkq9XbTGPoxY7eR38bVLmL5G8kZvg8gQJ");
export const MELT_ROUND_V2_PROGRAM_ID = new PublicKey("8gfT33DcGptWwk2c22FcXqiyTiW9RUU58PTQQHsy6FJf");

export const ORE_MINT = new PublicKey("GrFXxKjgG8X8E93scUZsYzBNyHWU6HEWvBT8UzzmY1Yf");
export const CONFIG_PDA = new PublicKey("EHP4qsDNdaaZejpbLG6H7u3vcVcGBiZjfLch1AhtGHkG");
export const VEIN0_PDA = new PublicKey("8T5J6hVaXETc2zSnbrGCZRuhdzTJeAYFaSCBFW42jD3b");
export const MELT_CONFIG_PDA = new PublicKey("EyVmYgk3gho38uzGwgMKWnnnp1kyWx9ZWDiQZvuGzgrR");
export const MELT_ROUND0_PDA = new PublicKey("3i9zoZnUeeQfNKu3Z5Wi6G1YLYbSuNsCrsgcJjT8mFXN");
export const MELT_POT_VAULT = new PublicKey("74NBP8YNHLrfXYUvVsVvFjnDPPyTqtQkZaJyRvPMRpLt");

// Vaulty jako PDA (patrz claims_v1 migrate_vaults_to_pda, 2026-08-20) - stale
// adresy wklejone wprost (zgodne z deployed-addresses.json) zamiast liczenia
// findProgramAddressSync na module-scope, zeby ominac crash Next.js podczas
// "Collecting page data" (build-time execution modulu bez pelnych natywnych
// bigint bindingow). Jesli claims_v1 zostanie zmigrowany ponownie, zaktualizuj
// recznie razem z reszta tego pliku.
export const STAKING_REWARD_VAULT_PDA = new PublicKey("HcbJbpKMRBRXtFgo9SwWNTRAi5ypmSebuC59Rv9SpugB");
export const TREASURY_VAULT_PDA = new PublicKey("DBAufDGtRi1FAGbMhiwbyKaAi7yU1b89BEN4Gq3Kka4T");
export const POL_TREASURY_PDA = new PublicKey("4ko73eLpzDyJj2a9Z5RfwMZhCL9Z3UQv7RjF4D6qoN4g");

export const deriveProfilePda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("profile"), owner.toBuffer()], CLAIMS_V1_PROGRAM_ID)[0];

export const derivePositionPda = (owner: PublicKey, positionIndex: bigint) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(positionIndex);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), owner.toBuffer(), buf],
    CLAIMS_V1_PROGRAM_ID
  )[0];
};

// Tiery Roszczen (VII.A, claims_v1::math::claim_terms) - [tier index, nazwa,
// duration_days, reference_cost XNT, reference_hp = jednoczesnie MINIMUM HP
// tego tieru]. Ceny w lamportach liczone jako requested_hp * ref_cost / ref_hp.
export const CLAIM_TIERS = [
  { index: 0, name: "Placer", durationDays: 7, refCostXnt: 1, refHp: 1 },
  { index: 1, name: "Bench", durationDays: 14, refCostXnt: 4, refHp: 6 },
  { index: 2, name: "Deep Vein", durationDays: 28, refCostXnt: 12, refHp: 20 },
  { index: 3, name: "Bedrock", durationDays: 45, refCostXnt: 30, refHp: 55 },
] as const;

export const LAMPORTS_PER_XNT = 1_000_000_000n;

export function costForHpLamports(tierIndex: number, requestedHp: bigint): bigint {
  const tier = CLAIM_TIERS[tierIndex];
  const refCostLamports = BigInt(tier.refCostXnt) * LAMPORTS_PER_XNT;
  return (requestedHp * refCostLamports) / BigInt(tier.refHp);
}

// Miekki limit wielorybow (VII.A.1) - liczony od sumy active_hp PRZED zakupem.
export const WHALE_THRESHOLDS = [
  { maxHp: 280, decayBps: 10_000 },
  { maxHp: 580, decayBps: 9_000 },
  { maxHp: 980, decayBps: 8_000 },
  { maxHp: Infinity, decayBps: 7_000 },
];

export function whaleDecayBps(activeHpBefore: bigint): number {
  const n = Number(activeHpBefore);
  for (const t of WHALE_THRESHOLDS) {
    if (n <= t.maxHp) return t.decayBps;
  }
  return 7_000;
}
