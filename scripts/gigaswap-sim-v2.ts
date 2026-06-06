#!/usr/bin/env ts-node
/**
 * GigaSwap Multi-Scenario Mega-Test v2
 *
 * ~35 kombinacji:
 *   6 formuł wypłaty (A/A2/B/C/D/E + hybrydy)
 *   5 presetów szans wygranej
 *   7 rozmiarów puli właściciela
 *   z/bez dzienny cap
 *   różne progi minSwap
 *
 * Metryki: % userów na plusie, win rate, drenaż puli, bot ROI, avg P/L
 */

const SEED = Number(process.argv[2] ?? 42);

// ══ Stałe ekonomiczne ═══════════════════════════════════════════════════════
const XNT_USD      = 0.50;
const MIND_PER_XNT = 21.0;
const MIND_USD     = XNT_USD / MIND_PER_XNT;   // ~$0.02381
const FEE_BPS      = 100;                        // 1%
const SWAPS_PER_DAY = 150;                       // umowna "doba" dla cap

// ══ RNG ════════════════════════════════════════════════════════════════════
function xorshift32(s: number): number {
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
  return s >>> 0;
}
class RNG {
  private s: number;
  constructor(seed: number) { this.s = (seed >>> 0) || 1; }
  next(): number { this.s = xorshift32(this.s); return this.s; }
  frac(): number { return this.next() / 0x100000000; }
  range(lo: number, hi: number): number { return lo + this.frac() * (hi - lo); }
}

// ══ Typy ════════════════════════════════════════════════════════════════════
type Formula   = "A"|"A2"|"B"|"B2"|"C"|"C2"|"D"|"E"|"F";
type WinPreset = "ULOW"|"LOW"|"MED"|"HIGH"|"UHIGH";

interface ScenarioCfg {
  id:          string;
  formula:     Formula;
  winPreset:   WinPreset;
  ownerUsd:    number;
  minSwapUsd:  number;
  dailyCapPct: number | null;   // null = bez limitu; np. 10 = max 10% puli/dobę
  label:       string;
}

interface UserProfile {
  name:     string;
  type:     string;
  swaps:    number;
  usdRange: [number, number];
}

// ══ 25 profili użytkowników ════════════════════════════════════════════════
const USERS: UserProfile[] = [
  // Mikro-boty — spam małych transakcji
  ...Array.from({length:5}, (_,i) => ({ name:`bot-micro-${i+1}`, type:"Bot",    swaps:250, usdRange:[0.3,1.5] as [number,number] })),
  // Medi-bot — bot średnich transakcji
  ...Array.from({length:3}, (_,i) => ({ name:`bot-mid-${i+1}`,   type:"BotMid", swaps:80,  usdRange:[3,8]     as [number,number] })),
  // Zwykli użytkownicy — małe kwoty
  ...Array.from({length:5}, (_,i) => ({ name:`small-${i+1}`,     type:"Mały",   swaps:25+i*5, usdRange:[1,12]  as [number,number] })),
  // Traderzy
  ...Array.from({length:5}, (_,i) => ({ name:`trader-${i+1}`,    type:"Trader", swaps:8+i*2,  usdRange:[15,120] as [number,number] })),
  // Whale
  ...Array.from({length:4}, (_,i) => ({ name:`whale-${i+1}`,     type:"Whale",  swaps:4+i,    usdRange:[150,1000] as [number,number] })),
  // Mix (DeFi power user)
  ...Array.from({length:3}, (_,i) => ({ name:`power-${i+1}`,     type:"Power",  swaps:30,     usdRange:[5,400] as [number,number] })),
];

const TOTAL_USERS = USERS.length; // 25

// ══ Szanse wygranej ════════════════════════════════════════════════════════
//  [minUsd, probability]
const WIN_PROB: Record<WinPreset, Array<[number,number]>> = {
  ULOW:  [[0.3,0.02],[2,0.04],[5,0.06],[20,0.09],[100,0.13]],
  LOW:   [[0.3,0.04],[2,0.07],[5,0.10],[20,0.15],[100,0.20]],
  MED:   [[0.3,0.08],[2,0.15],[5,0.22],[20,0.35],[100,0.50]],
  HIGH:  [[0.3,0.18],[2,0.28],[5,0.38],[20,0.55],[100,0.68]],
  UHIGH: [[0.3,0.30],[2,0.45],[5,0.60],[20,0.75],[100,0.85]],
};

function getWinProb(usd: number, preset: WinPreset): number {
  let p = 0;
  for (const [min,prob] of WIN_PROB[preset]) { if (usd >= min) p = prob; }
  return p;
}

// ══ Mnożniki ════════════════════════════════════════════════════════════════
function pickMult(rng: RNG): number {
  const r = rng.frac();
  if (r < 0.35) return 1;
  if (r < 0.60) return 2;
  if (r < 0.77) return 3;
  if (r < 0.90) return 5;
  if (r < 0.97) return 8;
  return 15;
}

// ══ Pula nagród ════════════════════════════════════════════════════════════
interface Pool { mind: number; xnt: number; }
const poolUsd  = (p: Pool) => p.mind * MIND_USD + p.xnt * XNT_USD;
function addToPool(pool: Pool, usd: number) {
  pool.mind += (usd/2) / MIND_USD;
  pool.xnt  += (usd/2) / XNT_USD;
}
function drainPool(pool: Pool, usd: number): number {
  const actual = Math.min(usd, poolUsd(pool));
  if (pool.mind * MIND_USD >= pool.xnt * XNT_USD) {
    pool.mind -= Math.min(actual / MIND_USD, pool.mind);
  } else {
    pool.xnt -= Math.min(actual / XNT_USD, pool.xnt);
  }
  return actual;
}

// ══ Formuły wypłaty ════════════════════════════════════════════════════════
function calcPayout(formula: Formula, feeUsd: number, mult: number, pool: Pool): number {
  const pUsd = poolUsd(pool);
  if (pUsd <= 0) return 0;

  switch (formula) {
    case "A":  // % puli × mnożnik (0.5% puli, max 5% puli)
      return Math.min(pUsd * 0.005 * mult, pUsd * 0.05);

    case "A2": // Agresywny % puli (1% puli, max 8% puli)
      return Math.min(pUsd * 0.010 * mult, pUsd * 0.08);

    case "B":  // Fee-base + mały bonus z puli
      return feeUsd * mult + Math.min(pUsd * 0.002, feeUsd * 4);

    case "B2": // Fee-base + większy bonus z puli
      return feeUsd * mult + Math.min(pUsd * 0.005, feeUsd * 8);

    case "C":  // Fee × mnożnik × liniowy czynnik puli
      return feeUsd * mult * (1 + pUsd / 400);

    case "C2": // Fee × mnożnik × silniejszy czynnik puli
      return feeUsd * mult * (1 + pUsd / 150);

    case "D":  // Sqrt scaling — łagodny wzrost z pulą
      return feeUsd * mult * (1 + Math.sqrt(pUsd / 100));

    case "E":  // Hybryda A+B: średnia arytmetyczna obu formuł
      const payA = Math.min(pUsd * 0.005 * mult, pUsd * 0.05);
      const payB = feeUsd * mult + Math.min(pUsd * 0.002, feeUsd * 4);
      return (payA + payB) / 2;

    case "F":  // Conditional: big pool → use A, small pool → use B
      if (pUsd >= 300) {
        return Math.min(pUsd * 0.005 * mult, pUsd * 0.05);
      } else {
        return feeUsd * mult + Math.min(pUsd * 0.002, feeUsd * 4);
      }
  }
}

// ══ Wynik ══════════════════════════════════════════════════════════════════
interface ScenarioResult {
  cfg:           ScenarioCfg;
  totalSwaps:    number;
  totalFeeUsd:   number;
  totalPayout:   number;
  totalWins:     number;
  winRatePct:    number;
  usersProfit:   number;
  totalVolume:   number;
  avgNetPl:      number;
  startPoolUsd:  number;
  endPoolUsd:    number;
  poolChangePct: number;
  botRoi:        number;
  botMidRoi:     number;
  byType:        Record<string,{fee:number,payout:number,count:number}>;
  winBuckets:    [number,number,number,number,number]; // <$0.5 / $0.5-2 / $2-10 / $10-50 / $50+
}

// ══ Symulacja jednego scenariusza ══════════════════════════════════════════
function runScenario(cfg: ScenarioCfg): ScenarioResult {
  const rng = new RNG(SEED);

  const pool: Pool = {
    mind: (cfg.ownerUsd / 2) / MIND_USD,
    xnt:  (cfg.ownerUsd / 2) / XNT_USD,
  };
  const startPoolUsd = poolUsd(pool);

  let totalSwaps=0, totalFeeUsd=0, totalPayout=0, totalWins=0, totalVolume=0;
  const winBuckets: [number,number,number,number,number] = [0,0,0,0,0];

  const typeMap: Record<string,{fee:number,payout:number,count:number}> = {};
  ["Bot","BotMid","Mały","Trader","Whale","Power"].forEach(t => typeMap[t]={fee:0,payout:0,count:0});

  interface UR { type:string; fee:number; payout:number; }
  const userRows: UR[] = [];

  // Daily cap tracking
  let daySwapCount = 0;
  let dayPayout    = 0;

  for (const user of USERS) {
    let uFee=0, uPayout=0;
    typeMap[user.type].count++;

    for (let i=0; i<user.swaps; i++) {
      const swapUsd = rng.range(user.usdRange[0], user.usdRange[1]);
      const feeUsd  = swapUsd * FEE_BPS / 10_000;

      addToPool(pool, feeUsd);

      uFee        += feeUsd;
      totalFeeUsd += feeUsd;
      totalVolume += swapUsd;
      totalSwaps++;

      daySwapCount++;
      if (daySwapCount >= SWAPS_PER_DAY) {
        daySwapCount = 0;
        dayPayout    = 0;
      }

      if (swapUsd < cfg.minSwapUsd) continue;

      const prob = getWinProb(swapUsd, cfg.winPreset);
      if (rng.frac() >= prob) continue;

      const mult = pickMult(rng);
      let payoutUsd = calcPayout(cfg.formula, feeUsd, mult, pool);

      // Daily cap
      if (cfg.dailyCapPct !== null) {
        const dayCapUsd = poolUsd(pool) * cfg.dailyCapPct / 100;
        if (dayPayout + payoutUsd > dayCapUsd) {
          payoutUsd = Math.max(0, dayCapUsd - dayPayout);
        }
      }

      payoutUsd = Math.min(payoutUsd, poolUsd(pool));

      if (payoutUsd > 0.001) {
        drainPool(pool, payoutUsd);
        dayPayout   += payoutUsd;
        uPayout     += payoutUsd;
        totalPayout += payoutUsd;
        totalWins++;

        if      (payoutUsd < 0.5)  winBuckets[0]++;
        else if (payoutUsd < 2)    winBuckets[1]++;
        else if (payoutUsd < 10)   winBuckets[2]++;
        else if (payoutUsd < 50)   winBuckets[3]++;
        else                       winBuckets[4]++;
      }
    }

    userRows.push({ type: user.type, fee: uFee, payout: uPayout });
    typeMap[user.type].fee     += uFee;
    typeMap[user.type].payout  += uPayout;
  }

  const endPoolUsd   = poolUsd(pool);
  const usersProfit  = userRows.filter(u => u.payout > u.fee).length;
  const avgNetPl     = userRows.reduce((s,u) => s + (u.payout - u.fee), 0) / TOTAL_USERS;
  const poolChangePct = startPoolUsd > 0
    ? (endPoolUsd - startPoolUsd) / startPoolUsd * 100
    : (endPoolUsd > 0 ? 999 : 0);

  const bots    = userRows.filter(u => u.type === "Bot");
  const botFee  = bots.reduce((s,u)=>s+u.fee,0);
  const botPout = bots.reduce((s,u)=>s+u.payout,0);
  const botRoi  = botFee > 0 ? botPout/botFee*100 : 0;

  const mids       = userRows.filter(u => u.type === "BotMid");
  const midFee     = mids.reduce((s,u)=>s+u.fee,0);
  const midPout    = mids.reduce((s,u)=>s+u.payout,0);
  const botMidRoi  = midFee > 0 ? midPout/midFee*100 : 0;

  return {
    cfg, totalSwaps, totalFeeUsd, totalPayout, totalWins,
    winRatePct: totalWins/totalSwaps*100,
    usersProfit, totalVolume, avgNetPl,
    startPoolUsd, endPoolUsd, poolChangePct,
    botRoi, botMidRoi, byType: typeMap, winBuckets,
  };
}

// ══ Wszystkie scenariusze ══════════════════════════════════════════════════
const SCENARIOS: ScenarioCfg[] = [
  // ── Baseline ──
  { id:"00-BASELINE",   formula:"B",  winPreset:"LOW",   ownerUsd:0,    minSwapUsd:5,   dailyCapPct:null, label:"Baseline (stary model)"         },

  // ── Formula A (0.5% puli) — 5 rozmiarów puli × 3 presety ──
  { id:"A-ULOW-0",      formula:"A",  winPreset:"ULOW",  ownerUsd:0,    minSwapUsd:1,   dailyCapPct:null, label:"A / ULOW  / $0"                  },
  { id:"A-LOW-100",     formula:"A",  winPreset:"LOW",   ownerUsd:100,  minSwapUsd:1,   dailyCapPct:null, label:"A / LOW   / $100"                },
  { id:"A-LOW-500",     formula:"A",  winPreset:"LOW",   ownerUsd:500,  minSwapUsd:1,   dailyCapPct:null, label:"A / LOW   / $500"                },
  { id:"A-MED-100",     formula:"A",  winPreset:"MED",   ownerUsd:100,  minSwapUsd:1,   dailyCapPct:null, label:"A / MED   / $100"                },
  { id:"A-MED-500",     formula:"A",  winPreset:"MED",   ownerUsd:500,  minSwapUsd:1,   dailyCapPct:null, label:"A / MED   / $500"                },
  { id:"A-MED-2000",    formula:"A",  winPreset:"MED",   ownerUsd:2000, minSwapUsd:1,   dailyCapPct:null, label:"A / MED   / $2000"               },
  { id:"A-HIGH-200",    formula:"A",  winPreset:"HIGH",  ownerUsd:200,  minSwapUsd:1,   dailyCapPct:null, label:"A / HIGH  / $200"                },
  { id:"A-HIGH-500",    formula:"A",  winPreset:"HIGH",  ownerUsd:500,  minSwapUsd:1,   dailyCapPct:null, label:"A / HIGH  / $500"                },
  { id:"A-HIGH-2000",   formula:"A",  winPreset:"HIGH",  ownerUsd:2000, minSwapUsd:1,   dailyCapPct:null, label:"A / HIGH  / $2000"               },
  { id:"A-UHIGH-2000",  formula:"A",  winPreset:"UHIGH", ownerUsd:2000, minSwapUsd:1,   dailyCapPct:null, label:"A / UHIGH / $2000"               },
  { id:"A-UHIGH-5000",  formula:"A",  winPreset:"UHIGH", ownerUsd:5000, minSwapUsd:1,   dailyCapPct:null, label:"A / UHIGH / $5000"               },

  // ── Formula A2 (agresywna 1% puli) ──
  { id:"A2-MED-500",    formula:"A2", winPreset:"MED",   ownerUsd:500,  minSwapUsd:1,   dailyCapPct:null, label:"A2/ MED   / $500  (agresywna)"   },
  { id:"A2-HIGH-500",   formula:"A2", winPreset:"HIGH",  ownerUsd:500,  minSwapUsd:1,   dailyCapPct:null, label:"A2/ HIGH  / $500  (agresywna)"   },
  { id:"A2-HIGH-2000",  formula:"A2", winPreset:"HIGH",  ownerUsd:2000, minSwapUsd:1,   dailyCapPct:null, label:"A2/ HIGH  / $2000 (agresywna)"   },

  // ── Formula B (fee-base + bonus) ──
  { id:"B-LOW-0",       formula:"B",  winPreset:"LOW",   ownerUsd:0,    minSwapUsd:1,   dailyCapPct:null, label:"B / LOW   / $0    (bez puli)"    },
  { id:"B-MED-0",       formula:"B",  winPreset:"MED",   ownerUsd:0,    minSwapUsd:1,   dailyCapPct:null, label:"B / MED   / $0"                  },
  { id:"B-MED-500",     formula:"B",  winPreset:"MED",   ownerUsd:500,  minSwapUsd:1,   dailyCapPct:null, label:"B / MED   / $500"                },
  { id:"B-HIGH-500",    formula:"B",  winPreset:"HIGH",  ownerUsd:500,  minSwapUsd:1,   dailyCapPct:null, label:"B / HIGH  / $500"                },
  { id:"B-HIGH-2000",   formula:"B",  winPreset:"HIGH",  ownerUsd:2000, minSwapUsd:1,   dailyCapPct:null, label:"B / HIGH  / $2000"               },

  // ── Formula B2 (fee + duży bonus) ──
  { id:"B2-MED-500",    formula:"B2", winPreset:"MED",   ownerUsd:500,  minSwapUsd:1,   dailyCapPct:null, label:"B2/ MED   / $500  (duży bonus)"  },
  { id:"B2-HIGH-2000",  formula:"B2", winPreset:"HIGH",  ownerUsd:2000, minSwapUsd:1,   dailyCapPct:null, label:"B2/ HIGH  / $2000 (duży bonus)"  },

  // ── Formula C (fee × pool_factor liniowy) ──
  { id:"C-MED-500",     formula:"C",  winPreset:"MED",   ownerUsd:500,  minSwapUsd:1,   dailyCapPct:null, label:"C / MED   / $500  (liniowy)"     },
  { id:"C-HIGH-500",    formula:"C",  winPreset:"HIGH",  ownerUsd:500,  minSwapUsd:1,   dailyCapPct:null, label:"C / HIGH  / $500"                },
  { id:"C-HIGH-2000",   formula:"C",  winPreset:"HIGH",  ownerUsd:2000, minSwapUsd:1,   dailyCapPct:null, label:"C / HIGH  / $2000"               },

  // ── Formula C2 (silny czynnik puli) ──
  { id:"C2-MED-500",    formula:"C2", winPreset:"MED",   ownerUsd:500,  minSwapUsd:1,   dailyCapPct:null, label:"C2/ MED   / $500  (silny)"       },
  { id:"C2-HIGH-2000",  formula:"C2", winPreset:"HIGH",  ownerUsd:2000, minSwapUsd:1,   dailyCapPct:null, label:"C2/ HIGH  / $2000 (silny)"       },

  // ── Formula D (sqrt scaling) ──
  { id:"D-MED-500",     formula:"D",  winPreset:"MED",   ownerUsd:500,  minSwapUsd:1,   dailyCapPct:null, label:"D / MED   / $500  (sqrt)"        },
  { id:"D-HIGH-2000",   formula:"D",  winPreset:"HIGH",  ownerUsd:2000, minSwapUsd:1,   dailyCapPct:null, label:"D / HIGH  / $2000 (sqrt)"        },

  // ── Formula E (hybryda A+B / 2) ──
  { id:"E-MED-500",     formula:"E",  winPreset:"MED",   ownerUsd:500,  minSwapUsd:1,   dailyCapPct:null, label:"E / MED   / $500  (hybryd A+B)"  },
  { id:"E-HIGH-2000",   formula:"E",  winPreset:"HIGH",  ownerUsd:2000, minSwapUsd:1,   dailyCapPct:null, label:"E / HIGH  / $2000 (hybryd A+B)"  },

  // ── Formula F (conditional A/B) ──
  { id:"F-HIGH-500",    formula:"F",  winPreset:"HIGH",  ownerUsd:500,  minSwapUsd:1,   dailyCapPct:null, label:"F / HIGH  / $500  (cond A/B)"    },
  { id:"F-HIGH-2000",   formula:"F",  winPreset:"HIGH",  ownerUsd:2000, minSwapUsd:1,   dailyCapPct:null, label:"F / HIGH  / $2000 (cond A/B)"    },

  // ── Z daily cap ──
  { id:"A-HIGH-500-C10",  formula:"A", winPreset:"HIGH", ownerUsd:500,  minSwapUsd:1, dailyCapPct:10, label:"A / HIGH  / $500  +cap10%/dobę"  },
  { id:"A-HIGH-2000-C5",  formula:"A", winPreset:"HIGH", ownerUsd:2000, minSwapUsd:1, dailyCapPct:5,  label:"A / HIGH  / $2000 +cap5%/dobę"   },
  { id:"A-UHIGH-2000-C10",formula:"A", winPreset:"UHIGH",ownerUsd:2000, minSwapUsd:1, dailyCapPct:10, label:"A / UHIGH / $2000 +cap10%/dobę"  },

  // ── Różne progi minSwap ──
  { id:"A-MED-500-min5",  formula:"A", winPreset:"MED",  ownerUsd:500,  minSwapUsd:5,   dailyCapPct:null, label:"A / MED   / $500  min$5"         },
  { id:"A-HIGH-500-min5", formula:"A", winPreset:"HIGH", ownerUsd:500,  minSwapUsd:5,   dailyCapPct:null, label:"A / HIGH  / $500  min$5"         },
];

// ══ Scoring (ranking) ══════════════════════════════════════════════════════
function score(r: ScenarioResult): number {
  const profitScore   = (r.usersProfit / TOTAL_USERS) * 45;            // max 45 pkt
  const winRateScore  = Math.min(r.winRatePct / 25, 1) * 25;          // max 25 pkt (cap 25%)
  const sustainScore  = r.endPoolUsd >= r.startPoolUsd * 0.2 ? 20 : 0; // pula nie wyparowała >80%
  const noBotScore    = r.botRoi <= 80 ? 10 : Math.max(0, 10 - (r.botRoi-80)/5); // max 10 pkt
  return profitScore + winRateScore + sustainScore + noBotScore;
}

// ══ Formatowanie ══════════════════════════════════════════════════════════
const pad   = (s: string, w: number) => s.padEnd(w);
const lpad  = (s: string, w: number) => s.padStart(w);
const $     = (n: number, d=1) => `$${n.toFixed(d)}`;
const pct   = (n: number) => `${n.toFixed(1)}%`;
const sign  = (n: number) => n >= 0 ? "+" : "";
const bar16 = (v: number, max: number) =>
  "█".repeat(Math.round(Math.max(0,v)/Math.max(max,0.001)*14)).padEnd(14);

// ══ Opis formuł ════════════════════════════════════════════════════════════
function printHeader() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════════════╗
║          GigaSwap Mega-Test — ${SCENARIOS.length} scenariuszy — seed=${SEED} — 25 userów            ║
╠═══════════════════════════════════════════════════════════════════════════════════════╣
║  FORMUŁY WYPŁATY                                                                     ║
║  A  │ payout = pool×0.5%×mult       (max 5% puli)  — skaluje 1:1 z pulą             ║
║  A2 │ payout = pool×1.0%×mult       (max 8% puli)  — agresywna wersja A             ║
║  B  │ payout = fee×mult + pool×0.2% (max fee×4)    — fee-base, bonus z puli         ║
║  B2 │ payout = fee×mult + pool×0.5% (max fee×8)    — większy bonus z puli           ║
║  C  │ payout = fee×mult×(1+pool/400)               — liniowy czynnik puli           ║
║  C2 │ payout = fee×mult×(1+pool/150)               — silniejszy czynnik             ║
║  D  │ payout = fee×mult×(1+√(pool/100))            — łagodny (sqrt) czynnik         ║
║  E  │ payout = (A + B) / 2                         — hybryda A+B                    ║
║  F  │ if pool≥$300: A, else B                      — conditional A/B                ║
╠═══════════════════════════════════════════════════════════════════════════════════════╣
║  SZANSE WYGRANEJ (wg USD wartości swapa)                                             ║
║  ULOW  │ $0.3:2%  $2:4%  $5:6%  $20:9%  $100:13%                                  ║
║  LOW   │ $0.3:4%  $2:7%  $5:10% $20:15% $100:20%                                  ║
║  MED   │ $0.3:8%  $2:15% $5:22% $20:35% $100:50%                                  ║
║  HIGH  │ $0.3:18% $2:28% $5:38% $20:55% $100:68%                                  ║
║  UHIGH │ $0.3:30% $2:45% $5:60% $20:75% $100:85%                                  ║
╚═══════════════════════════════════════════════════════════════════════════════════════╝`);
}

// ══ Główna tabela ══════════════════════════════════════════════════════════
function printMainTable(results: ScenarioResult[]) {
  console.log(`
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  #   ID                  LABEL                             │ PULA START │ FEE    │ PAYOUT │ WYGR │WIN%  │PROF │AVG P/L │BOT ROI│ PULA END  │SCORE│
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤`);

  const sorted = [...results].sort((a,b) => score(b) - score(a));

  sorted.forEach((r,i) => {
    const sc        = score(r);
    const poolEnd   = r.endPoolUsd < 0.5 ? "WYCZERPANA" : `${$(r.endPoolUsd,0)}(${sign(r.poolChangePct)}${r.poolChangePct.toFixed(0)}%)`;
    const profitStr = `${r.usersProfit}/${TOTAL_USERS}`;
    const medal     = i===0?"🥇":i===1?"🥈":i===2?"🥉":" ";
    console.log(
      `│${medal} ${String(i+1).padStart(2)}  ${pad(r.cfg.id,20)}  ${pad(r.cfg.label,38)}│` +
      ` ${lpad($(r.startPoolUsd,0),6)}     │` +
      ` ${lpad($(r.totalFeeUsd),6)} │` +
      ` ${lpad($(r.totalPayout),6)} │` +
      ` ${lpad(String(r.totalWins),4)} │` +
      `${lpad(pct(r.winRatePct),5)} │` +
      ` ${lpad(profitStr,5)}│` +
      ` ${lpad((sign(r.avgNetPl)+$(r.avgNetPl)),7)} │` +
      `${lpad(pct(r.botRoi),6)} │` +
      ` ${lpad(poolEnd,12)}│` +
      ` ${lpad(String(Math.round(sc)),4)}│`
    );
  });
  console.log("└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘");
}

// ══ Per-typ per-formuła breakdown ══════════════════════════════════════════
function printTypeBreakdown(results: ScenarioResult[]) {
  console.log(`
══════════════════════════════════════════════════════════════════════════════════
 ŚREDNI NET P/L PER TYP UŻYTKOWNIKA — TOP 6 SCENARIUSZY
══════════════════════════════════════════════════════════════════════════════════`);

  const sorted = [...results].sort((a,b) => score(b)-score(a)).slice(0,6);
  const types  = ["Bot","BotMid","Mały","Trader","Whale","Power"];
  const counts: Record<string,number> = { Bot:5, BotMid:3, Mały:5, Trader:5, Whale:4, Power:3 };

  // Header
  console.log("  TYP    " + sorted.map(r=>`  ${pad(r.cfg.id,13)}`).join(""));
  console.log("  " + "─".repeat(8) + sorted.map(_=>"  "+"─".repeat(13)).join(""));

  types.forEach(t => {
    const cells = sorted.map(r => {
      const bt = r.byType[t];
      if (!bt || bt.count === 0) return lpad("n/a",13);
      const avg = (bt.payout - bt.fee) / bt.count;
      const s   = sign(avg) + $(avg);
      return lpad(s,13);
    });
    console.log(`  ${pad(t,6)}   ` + cells.map(c=>"  "+c).join(""));
  });
}

// ══ Rozkład wygranych ══════════════════════════════════════════════════════
function printWinDistribution(results: ScenarioResult[]) {
  console.log(`
══════════════════════════════════════════════════════════════════════════════════
 ROZKŁAD WARTOŚCI WYGRANYCH — TOP 6 SCENARIUSZY
 (kolumny: <$0.5 │ $0.5-2 │ $2-10 │ $10-50 │ $50+)
══════════════════════════════════════════════════════════════════════════════════`);

  const sorted = [...results].sort((a,b) => score(b)-score(a)).slice(0,6);
  sorted.forEach(r => {
    const total = r.totalWins || 1;
    const pcts  = r.winBuckets.map(b => `${(b/total*100).toFixed(0)}%`.padStart(6));
    console.log(`  ${pad(r.cfg.id,20)} │ ${pcts.join(" │ ")} │  (${r.totalWins} wygranych)`);
  });
}

// ══ Drenaż puli ═══════════════════════════════════════════════════════════
function printPoolDrain(results: ScenarioResult[]) {
  console.log(`
══════════════════════════════════════════════════════════════════════════════════
 DRENAŻ PULI — słupki (start vs koniec)
══════════════════════════════════════════════════════════════════════════════════`);

  const maxP = Math.max(...results.map(r=>Math.max(r.startPoolUsd,r.endPoolUsd,1)));
  [...results].sort((a,b)=>b.startPoolUsd-a.startPoolUsd).forEach(r => {
    const icon = r.endPoolUsd > r.startPoolUsd*1.05 ? "✓" :
                 r.endPoolUsd < r.startPoolUsd*0.3  ? "!" : "~";
    console.log(`  ${icon} ${pad(r.cfg.id,20)} start ${bar16(r.startPoolUsd,maxP)} ${lpad($(r.startPoolUsd,0),6)}`);
    console.log(`    ${"".padEnd(20)} koniec${bar16(r.endPoolUsd,maxP)} ${lpad($(r.endPoolUsd,0),6)}  ${sign(r.poolChangePct)}${pct(r.poolChangePct)}`);
    console.log();
  });
}

// ══ TOP 3 szczegółowe rekomendacje ════════════════════════════════════════
function printTop3(results: ScenarioResult[]) {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════════════╗
║  TOP 3 REKOMENDACJE (posortowane wg score)                                           ║
╚═══════════════════════════════════════════════════════════════════════════════════════╝`);

  const sorted = [...results].sort((a,b) => score(b)-score(a)).slice(0,3);
  const medals = ["🥇","🥈","🥉"];

  sorted.forEach((r,i) => {
    const sc = score(r);
    console.log(`
  ${medals[i]}  ${r.cfg.id} — ${r.cfg.label}
     Score: ${Math.round(sc)}/100
     ┌ Pula start:    ${$(r.startPoolUsd,0)}  →  koniec: ${$(r.endPoolUsd,0)}  (${sign(r.poolChangePct)}${pct(r.poolChangePct)})
     │ Fee zebrane:   ${$(r.totalFeeUsd)}
     │ Payout:        ${$(r.totalPayout)}
     │ Wygranych:     ${r.totalWins} (win rate: ${pct(r.winRatePct)})
     │ Userów profit: ${r.usersProfit}/${TOTAL_USERS}
     │ Avg net P/L:   ${sign(r.avgNetPl)}${$(r.avgNetPl)}
     │ Bot ROI:       ${pct(r.botRoi)}  |  BotMid ROI: ${pct(r.botMidRoi)}
     └ Wygrane: <$0.5: ${r.winBuckets[0]}x  $0.5-2: ${r.winBuckets[1]}x  $2-10: ${r.winBuckets[2]}x  $10-50: ${r.winBuckets[3]}x  $50+: ${r.winBuckets[4]}x`);
  });
}

// ══ Analiza wrażliwości formuł na rozmiar puli ════════════════════════════
function printFormulaSensitivity(results: ScenarioResult[]) {
  console.log(`
══════════════════════════════════════════════════════════════════════════════════
 WRAŻLIWOŚĆ NA ROZMIAR PULI — jak zmienia się usersProfit (MED win rate)
══════════════════════════════════════════════════════════════════════════════════`);

  const formulas: Formula[] = ["A","B","C","D","E"];
  const pools = [0,100,500,2000];

  console.log("  FORMULA" + pools.map(p=>`   $${String(p).padStart(4)}`).join(""));
  console.log("  " + "─".repeat(8) + pools.map(_=>"  "+ "─".repeat(7)).join(""));

  formulas.forEach(f => {
    const cells = pools.map(p => {
      const r = results.find(r => r.cfg.formula === f && r.cfg.ownerUsd === p && r.cfg.winPreset === "MED");
      if (!r) return lpad("n/a",7);
      return lpad(`${r.usersProfit}/${TOTAL_USERS}`,7);
    });
    console.log(`  ${pad(f,8)}` + cells.map(c=>"  "+c).join(""));
  });
}

// ══ MAIN ══════════════════════════════════════════════════════════════════
function main() {
  printHeader();
  process.stdout.write(`\nUruchamiam ${SCENARIOS.length} scenariuszy...`);

  const results = SCENARIOS.map(cfg => {
    process.stdout.write(".");
    return runScenario(cfg);
  });

  console.log(" gotowe!\n");

  printMainTable(results);
  printPoolDrain(results);
  printTypeBreakdown(results);
  printWinDistribution(results);
  printFormulaSensitivity(results);
  printTop3(results);

  console.log(`
══════════════════════════════════════════════════════════════════
 LEGENDA
══════════════════════════════════════════════════════════════════
  PROF    = ilu z ${TOTAL_USERS} userów skończyło z payout > fee
  WIN%    = % transakcji które wygrały GigaSwap
  BOT ROI = zwrot mikro-botów (fee=100% = bot wychodzi na 0)
  SCORE   = ranking: profit(45) + win rate(25) + pula(20) + bot(10)
  ✓ pula  = pula urosła lub jest stabilna
  ~ pula  = pula zmalała umiarkowanie (<80% drenażu)
  ! pula  = pula silnie zdrenowana (>80%)
══════════════════════════════════════════════════════════════════
`);
}

main();
