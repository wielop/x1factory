/**
 * GigaSwap off-chain simulation — mirrors Rust logic 1:1
 * Run: npx ts-node scripts/gigaswap-sim.ts [seed]
 */

// ── Config (mirrors Rust constants) ─────────────────────────────────────────

const FEE_BPS        = 100;    // 1%
const BPS_DENOM      = 10_000;
const GIGA_MIN_USD   = 500;    // $5.00 in cents
const GIGA_BASE_DENOM = 100;

// Pool starting state
const XNT_USD_CENTS  = 50;     // $0.50 per XNT
const MIND_PER_XNT   = 21.0;   // pool ratio: 1 XNT = 21 MIND (from vaults)

// Convert: $100 in XNT = 200 XNT = 200 * 1e9 lamports (9 decimals)
// Convert: $100 in MIND = 200 XNT worth = 200 * 21 = 4200 MIND = 4200 * 1e9
const DECIMALS       = 1e9;
const INIT_XNT_USD   = 100;    // $100 starting pool XNT
const INIT_MIND_USD  = 100;    // $100 starting pool MIND

// ── Types ────────────────────────────────────────────────────────────────────

interface PoolState {
  mindLamports: number;  // reward pool MIND balance (lamports)
  xntLamports:  number;  // reward pool XNT balance (lamports)
}

interface TxResult {
  feeTotal:    number;
  poolFee:     number;
  usdCents:    number;
  gigaWon:     boolean;
  multiplier:  number;
  payout:      number;  // in lamports of dominant token
  paidMind:    boolean;
}

interface UserStats {
  name:        string;
  profile:     string;
  swaps:       number;
  totalFeeUsd: number;
  gigaWins:    number;
  payoutUsd:   number;
  netUsd:      number;
}

// ── Deterministic RNG (seeded) ───────────────────────────────────────────────

let rngState: number;

function seedRng(seed: number) { rngState = seed >>> 0; }

function nextRng(): number {
  // xorshift32
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) / 0xFFFFFFFF;
}

function rngInt(n: number): number {
  return Math.floor(nextRng() * n);
}

// ── Rust logic mirrors ────────────────────────────────────────────────────────

function gigaProbability(usdCents: number): number {
  if (usdCents < 500)     return 0;
  if (usdCents < 2_000)   return 3;   // $5–$20
  if (usdCents < 10_000)  return 7;   // $20–$100
  if (usdCents < 50_000)  return 15;  // $100–$500
  return 20;                           // $500+
}

function pickMultiplier(rng100: number): number {
  if (rng100 < 30) return 1;   // 30%: 1×
  if (rng100 < 60) return 2;   // 30%: 2×
  if (rng100 < 80) return 3;   // 20%: 3×
  if (rng100 < 93) return 5;   // 13%: 5×
  if (rng100 < 99) return 8;   //  6%: 8×
  return 15;                    //  1%: 15× jackpot
}

function computeUsdCents(amountLamports: number, isMind: boolean): number {
  if (isMind) {
    // MIND price = XNT_price × xnt_vault / mind_vault
    // simplified: 1 MIND = XNT_USD_CENTS / MIND_PER_XNT cents
    return (amountLamports / DECIMALS) * (XNT_USD_CENTS / MIND_PER_XNT);
  } else {
    return (amountLamports / DECIMALS) * XNT_USD_CENTS;
  }
}

function poolUsdValue(pool: PoolState): { mindUsd: number; xntUsd: number } {
  const xntUsd  = (pool.xntLamports  / DECIMALS) * (XNT_USD_CENTS / 100);
  const mindUsd = (pool.mindLamports / DECIMALS) * (XNT_USD_CENTS / 100) / MIND_PER_XNT;
  return { mindUsd, xntUsd };
}

function simulateTx(
  amountLamports: number,
  isMind: boolean,
  pool: PoolState,
): TxResult {
  const feeTotal  = Math.floor(amountLamports * FEE_BPS / BPS_DENOM);
  const treasury  = Math.floor(feeTotal / 2);
  const poolFee   = feeTotal - treasury;
  const swapAmt   = amountLamports - feeTotal;

  // Update pool tracking
  if (isMind) pool.mindLamports += poolFee;
  else         pool.xntLamports  += poolFee;

  // USD value of swap
  const usdCents = computeUsdCents(swapAmt, isMind);

  // GigaSwap check
  const prob = gigaProbability(usdCents);
  const roll1 = rngInt(GIGA_BASE_DENOM);
  const won   = prob > 0 && roll1 < prob;

  let multiplier = 0;
  let payout     = 0;
  let paidMind   = false;

  if (won) {
    const roll2 = rngInt(100);
    multiplier   = pickMultiplier(roll2);

    const { mindUsd, xntUsd } = poolUsdValue(pool);
    const dominantMind = mindUsd > xntUsd;
    paidMind           = dominantMind;

    const dominantBal = dominantMind ? pool.mindLamports : pool.xntLamports;
    payout = Math.min(feeTotal * multiplier, dominantBal);

    if (dominantMind) pool.mindLamports -= payout;
    else               pool.xntLamports  -= payout;
  }

  return { feeTotal, poolFee, usdCents, gigaWon: won, multiplier, payout, paidMind };
}

// ── User profiles ─────────────────────────────────────────────────────────────

interface UserProfile {
  name:      string;
  label:     string;
  swaps:     number;
  minUsd:    number;   // swap size in USD
  maxUsd:    number;
  isMind:    boolean;  // which token they swap
}

const PROFILES: UserProfile[] = [
  // Mikro-boty — spam $5
  { name: "mikro-bot-1",  label: "MikroBot", swaps: 200, minUsd:  5, maxUsd:   5, isMind: false },
  { name: "mikro-bot-2",  label: "MikroBot", swaps: 200, minUsd:  5, maxUsd:   5, isMind: true  },
  { name: "mikro-bot-3",  label: "MikroBot", swaps: 200, minUsd:  5, maxUsd:   5, isMind: false },
  { name: "mikro-bot-4",  label: "MikroBot", swaps: 150, minUsd:  5, maxUsd:  10, isMind: true  },
  { name: "mikro-bot-5",  label: "MikroBot", swaps: 150, minUsd:  5, maxUsd:  10, isMind: false },

  // Małe swapy — $10–$50
  { name: "small-1",      label: "Mały",     swaps:  40, minUsd: 15, maxUsd:  30, isMind: false },
  { name: "small-2",      label: "Mały",     swaps:  40, minUsd: 20, maxUsd:  50, isMind: true  },
  { name: "small-3",      label: "Mały",     swaps:  40, minUsd: 10, maxUsd:  25, isMind: false },
  { name: "small-4",      label: "Mały",     swaps:  50, minUsd: 20, maxUsd:  40, isMind: true  },
  { name: "small-5",      label: "Mały",     swaps:  30, minUsd: 25, maxUsd:  50, isMind: false },

  // Normalni traderzy — $50–$200
  { name: "trader-1",     label: "Trader",   swaps:  15, minUsd: 80, maxUsd: 150, isMind: false },
  { name: "trader-2",     label: "Trader",   swaps:  15, minUsd: 60, maxUsd: 120, isMind: true  },
  { name: "trader-3",     label: "Trader",   swaps:  10, minUsd:100, maxUsd: 200, isMind: false },
  { name: "trader-4",     label: "Trader",   swaps:  12, minUsd: 75, maxUsd: 180, isMind: true  },
  { name: "trader-5",     label: "Trader",   swaps:  10, minUsd: 90, maxUsd: 160, isMind: false },

  // Whale — $300–$1000
  { name: "whale-1",      label: "Whale",    swaps:   5, minUsd:400, maxUsd: 800, isMind: false },
  { name: "whale-2",      label: "Whale",    swaps:   5, minUsd:500, maxUsd:1000, isMind: true  },
  { name: "whale-3",      label: "Whale",    swaps:   4, minUsd:300, maxUsd: 600, isMind: false },

  // Mix — losowe kwoty
  { name: "mix-1",        label: "Mix",      swaps:  20, minUsd:  5, maxUsd: 500, isMind: false },
  { name: "mix-2",        label: "Mix",      swaps:  20, minUsd:  5, maxUsd: 300, isMind: true  },
];

// ── Main simulation ───────────────────────────────────────────────────────────

function usdToLamports(usd: number, isMind: boolean): number {
  if (isMind) {
    // 1 MIND = XNT_USD_CENTS/MIND_PER_XNT cents → MIND per dollar = 100*MIND_PER_XNT/XNT_USD_CENTS
    const mindPerDollar = (100 * MIND_PER_XNT) / XNT_USD_CENTS;
    return Math.floor(usd * mindPerDollar * DECIMALS);
  } else {
    // 1 XNT = XNT_USD_CENTS/100 $ → XNT per dollar = 100/XNT_USD_CENTS
    const xntPerDollar = 100 / XNT_USD_CENTS;
    return Math.floor(usd * xntPerDollar * DECIMALS);
  }
}

function lamportsToUsd(lamports: number, isMind: boolean): number {
  if (isMind) return (lamports / DECIMALS) * (XNT_USD_CENTS / 100) / MIND_PER_XNT;
  else         return (lamports / DECIMALS) * (XNT_USD_CENTS / 100);
}

function fmt$(n: number): string {
  return `$${n.toFixed(2).padStart(8)}`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function run(seed: number) {
  seedRng(seed);

  const pool: PoolState = {
    mindLamports: usdToLamports(INIT_MIND_USD, true),
    xntLamports:  usdToLamports(INIT_XNT_USD,  false),
  };

  const poolHistory: { mindUsd: number; xntUsd: number }[] = [];
  const allStats: UserStats[] = [];
  let totalSwaps    = 0;
  let totalFeeUsd   = 0;
  let totalPayoutUsd= 0;
  let totalGigaWins = 0;
  let jackpotCount  = 0;

  const poolStart = poolUsdValue(pool);

  console.log("═".repeat(90));
  console.log(` GigaSwap Simulation  |  seed=${seed}  |  pool start: MIND $${poolStart.mindUsd.toFixed(2)} + XNT $${poolStart.xntUsd.toFixed(2)}`);
  console.log("═".repeat(90));
  console.log();

  // Run each user
  for (const profile of PROFILES) {
    let feePaid   = 0;
    let payoutWon = 0;
    let wins      = 0;
    const winLog: string[] = [];

    for (let i = 0; i < profile.swaps; i++) {
      const swapUsd = profile.minUsd === profile.maxUsd
        ? profile.minUsd
        : profile.minUsd + nextRng() * (profile.maxUsd - profile.minUsd);

      const lamports = usdToLamports(swapUsd, profile.isMind);
      const result   = simulateTx(lamports, profile.isMind, pool);

      feePaid += lamportsToUsd(result.feeTotal, profile.isMind);

      if (result.gigaWon) {
        wins++;
        totalGigaWins++;
        const payUsd = result.paidMind
          ? lamportsToUsd(result.payout, true)
          : lamportsToUsd(result.payout, false);
        payoutWon += payUsd;
        if (result.multiplier >= 15) jackpotCount++;
        winLog.push(`${result.multiplier}×`);
      }

      poolHistory.push(poolUsdValue(pool));
    }

    totalSwaps     += profile.swaps;
    totalFeeUsd    += feePaid;
    totalPayoutUsd += payoutWon;

    const netUsd = payoutWon - feePaid;
    allStats.push({
      name:        profile.name,
      profile:     profile.label,
      swaps:       profile.swaps,
      totalFeeUsd: feePaid,
      gigaWins:    wins,
      payoutUsd:   payoutWon,
      netUsd,
    });
  }

  // ── Print user table ────────────────────────────────────────────────────────

  const header = `${pad("USER", 14)} ${pad("PROFIL", 8)} ${"SWAPS".padStart(5)} ${"FEE_PAID".padStart(10)} ${"WYGRANE".padStart(7)} ${"PAYOUT".padStart(10)} ${"NET P/L".padStart(10)}`;
  console.log(header);
  console.log("─".repeat(90));

  for (const s of allStats) {
    const net = s.netUsd >= 0
      ? `+$${s.netUsd.toFixed(2)}`.padStart(10)
      : `-$${Math.abs(s.netUsd).toFixed(2)}`.padStart(10);
    const row = [
      pad(s.name,    14),
      pad(s.profile,  8),
      s.swaps.toString().padStart(5),
      fmt$(s.totalFeeUsd).padStart(10),
      s.gigaWins.toString().padStart(7),
      fmt$(s.payoutUsd).padStart(10),
      net,
    ].join(" ");
    const marker = s.netUsd > 0 ? " ◄ PROFIT" : "";
    console.log(row + marker);
  }

  // ── Pool summary ────────────────────────────────────────────────────────────

  const poolEnd = poolUsdValue(pool);
  const poolStartTotal = poolStart.mindUsd + poolStart.xntUsd;
  const poolEndTotal   = poolEnd.mindUsd   + poolEnd.xntUsd;

  console.log();
  console.log("═".repeat(90));
  console.log(" PODSUMOWANIE");
  console.log("═".repeat(90));
  console.log(`  Łączna liczba swapów       : ${totalSwaps}`);
  console.log(`  Łączne fee zebrane         : $${totalFeeUsd.toFixed(2)}`);
  console.log(`  Łączne GigaSwap wygrane    : ${totalGigaWins} (${(totalGigaWins/totalSwaps*100).toFixed(2)}% swapów)`);
  console.log(`  Jackpoty 15×               : ${jackpotCount}`);
  console.log(`  Łączny payout              : $${totalPayoutUsd.toFixed(2)}`);
  console.log(`  Pula zatrzymała (fee-payout): $${(totalFeeUsd - totalPayoutUsd).toFixed(2)}`);
  console.log();
  console.log(`  PULA START  : MIND $${poolStart.mindUsd.toFixed(2)} + XNT $${poolStart.xntUsd.toFixed(2)} = $${poolStartTotal.toFixed(2)}`);
  console.log(`  PULA KONIEC : MIND $${poolEnd.mindUsd.toFixed(2)} + XNT $${poolEnd.xntUsd.toFixed(2)} = $${poolEndTotal.toFixed(2)}`);
  const poolDelta = poolEndTotal - poolStartTotal;
  const poolPct   = (poolDelta / poolStartTotal * 100);
  console.log(`  ZMIANA PULI : ${poolDelta >= 0 ? "+" : ""}$${poolDelta.toFixed(2)} (${poolDelta >= 0 ? "+" : ""}${poolPct.toFixed(1)}%)`);

  // ── Bot analysis ────────────────────────────────────────────────────────────

  console.log();
  console.log("─".repeat(90));
  console.log(" ANALIZA BOT-PROOF");
  console.log("─".repeat(90));
  const botProfiles = allStats.filter(s => s.profile === "MikroBot");
  const botFee     = botProfiles.reduce((a, s) => a + s.totalFeeUsd, 0);
  const botPayout  = botProfiles.reduce((a, s) => a + s.payoutUsd,   0);
  const botNet     = botPayout - botFee;
  console.log(`  Mikro-boty łącznie: fee $${botFee.toFixed(2)}, payout $${botPayout.toFixed(2)}, net ${botNet >= 0 ? "+" : ""}$${botNet.toFixed(2)}`);
  console.log(`  ROI botów: ${(botPayout / botFee * 100).toFixed(1)}% (< 100% = bot traci)`);

  // ── Pool growth chart (ASCII, 60 steps) ────────────────────────────────────

  console.log();
  console.log("─".repeat(90));
  console.log(" SALDO PULI W CZASIE (łączna wartość USD)");
  console.log("─".repeat(90));

  const steps   = 60;
  const step    = Math.max(1, Math.floor(poolHistory.length / steps));
  const vals    = poolHistory.filter((_, i) => i % step === 0).map(p => p.mindUsd + p.xntUsd);
  const maxVal  = Math.max(...vals, poolStartTotal);
  const minVal  = Math.min(...vals, poolStartTotal);
  const range   = maxVal - minVal || 1;
  const rows    = 12;

  for (let row = rows; row >= 0; row--) {
    const threshold = minVal + (range * row / rows);
    let line = row % 3 === 0 ? `$${threshold.toFixed(0).padStart(5)} |` : "       |";
    for (const v of vals) {
      line += v >= threshold ? "█" : " ";
    }
    console.log(line);
  }
  console.log("       └" + "─".repeat(steps));
  console.log(`        0 tx${" ".repeat(steps - 16)}${totalSwaps} tx total`);

  // ── Winner board ────────────────────────────────────────────────────────────

  console.log();
  console.log("─".repeat(90));
  console.log(" TOP WYGRYWAJĄCY");
  console.log("─".repeat(90));
  const sorted = [...allStats].sort((a, b) => b.payoutUsd - a.payoutUsd).slice(0, 5);
  for (const s of sorted) {
    if (s.gigaWins === 0) break;
    console.log(`  ${pad(s.name, 14)}  ${s.gigaWins} wygr.  payout $${s.payoutUsd.toFixed(2)}  net ${s.netUsd >= 0 ? "+" : ""}$${s.netUsd.toFixed(2)}`);
  }
  console.log();
  console.log("═".repeat(90));
}

// ── Entry point ───────────────────────────────────────────────────────────────

const seed = parseInt(process.argv[2] ?? "42");
run(seed);
