#!/usr/bin/env ts-node
/**
 * GigaSwap Detail — szczegółowy raport per-user dla wybranych scenariuszy
 *
 * Uruchom: npx ts-node scripts/gigaswap-sim-detail.ts [seed]
 */

const SEED = Number(process.argv[2] ?? 42);

// ══ Stałe ════════════════════════════════════════════════════════════════
const XNT_USD      = 0.50;
const MIND_PER_XNT = 21.0;
const MIND_USD     = XNT_USD / MIND_PER_XNT;
const FEE_BPS      = 100;
const SWAPS_PER_DAY = 150;

// ══ RNG ══════════════════════════════════════════════════════════════════
function xorshift32(s: number): number {
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0;
}
class RNG {
  private s: number;
  constructor(seed: number) { this.s = (seed >>> 0) || 1; }
  next(): number { this.s = xorshift32(this.s); return this.s; }
  frac(): number { return this.next() / 0x100000000; }
  range(lo: number, hi: number): number { return lo + this.frac() * (hi - lo); }
}

type WinPreset = "ULOW"|"LOW"|"MED"|"HIGH"|"UHIGH";
type Formula   = "A"|"A2"|"B"|"B2"|"C"|"C2"|"D"|"E"|"F";

// ══ Użytkownicy ══════════════════════════════════════════════════════════
interface UserProfile {
  name:     string;
  type:     string;
  swaps:    number;
  usdRange: [number, number];
}

const USERS: UserProfile[] = [
  ...Array.from({length:5}, (_,i) => ({ name:`bot-micro-${i+1}`, type:"Bot",    swaps:250, usdRange:[0.3,1.5] as [number,number] })),
  ...Array.from({length:3}, (_,i) => ({ name:`bot-mid-${i+1}`,   type:"BotMid", swaps:80,  usdRange:[3,8]     as [number,number] })),
  ...Array.from({length:5}, (_,i) => ({ name:`small-${i+1}`,     type:"Mały",   swaps:25+i*5, usdRange:[1,12]  as [number,number] })),
  ...Array.from({length:5}, (_,i) => ({ name:`trader-${i+1}`,    type:"Trader", swaps:8+i*2,  usdRange:[15,120] as [number,number] })),
  ...Array.from({length:4}, (_,i) => ({ name:`whale-${i+1}`,     type:"Whale",  swaps:4+i,    usdRange:[150,1000] as [number,number] })),
  ...Array.from({length:3}, (_,i) => ({ name:`power-${i+1}`,     type:"Power",  swaps:30,     usdRange:[5,400] as [number,number] })),
];

// ══ Szanse wygranej ══════════════════════════════════════════════════════
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

function pickMult(rng: RNG): number {
  const r = rng.frac();
  if (r < 0.35) return 1;
  if (r < 0.60) return 2;
  if (r < 0.77) return 3;
  if (r < 0.90) return 5;
  if (r < 0.97) return 8;
  return 15;
}

// ══ Pula ════════════════════════════════════════════════════════════════
interface Pool { mind: number; xnt: number; }
const poolUsd = (p: Pool) => p.mind * MIND_USD + p.xnt * XNT_USD;
function addToPool(pool: Pool, usd: number) {
  pool.mind += (usd/2) / MIND_USD;
  pool.xnt  += (usd/2) / XNT_USD;
}
function drainPool(pool: Pool, usd: number): number {
  const actual = Math.min(usd, poolUsd(pool));
  if (pool.mind * MIND_USD >= pool.xnt * XNT_USD)
    pool.mind -= Math.min(actual / MIND_USD, pool.mind);
  else
    pool.xnt -= Math.min(actual / XNT_USD, pool.xnt);
  return actual;
}

function calcPayout(formula: Formula, feeUsd: number, mult: number, pool: Pool): number {
  const pUsd = poolUsd(pool);
  if (pUsd <= 0) return 0;
  switch (formula) {
    case "A":  return Math.min(pUsd * 0.005 * mult, pUsd * 0.05);
    case "A2": return Math.min(pUsd * 0.010 * mult, pUsd * 0.08);
    case "B":  return feeUsd * mult + Math.min(pUsd * 0.002, feeUsd * 4);
    case "B2": return feeUsd * mult + Math.min(pUsd * 0.005, feeUsd * 8);
    case "C":  return feeUsd * mult * (1 + pUsd / 400);
    case "C2": return feeUsd * mult * (1 + pUsd / 150);
    case "D":  return feeUsd * mult * (1 + Math.sqrt(pUsd / 100));
    case "E": {
      const pA = Math.min(pUsd*0.005*mult, pUsd*0.05);
      const pB = feeUsd*mult + Math.min(pUsd*0.002, feeUsd*4);
      return (pA+pB)/2;
    }
    case "F":  return pUsd >= 300
      ? Math.min(pUsd*0.005*mult, pUsd*0.05)
      : feeUsd*mult + Math.min(pUsd*0.002, feeUsd*4);
  }
}

// ══ Per-user dane ════════════════════════════════════════════════════════
interface UserWin {
  swapUsd:   number;
  feeUsd:    number;
  mult:      number;
  payoutUsd: number;
}

interface UserResult {
  user:       UserProfile;
  totalFee:   number;
  totalPayout:number;
  wins:       UserWin[];
  swapCount:  number;
  maxWin:     number;
  avgWinUsd:  number;
  volumeUsd:  number;
}

// ══ Główna symulacja z per-user detalami ════════════════════════════════
function runDetailed(
  formula:    Formula,
  winPreset:  WinPreset,
  ownerUsd:   number,
  minSwapUsd: number,
  dailyCapPct: number | null
): { users: UserResult[]; poolStart: number; poolEnd: number; totalFee: number; totalPayout: number; totalWins: number } {

  const rng = new RNG(SEED);
  const pool: Pool = {
    mind: (ownerUsd/2)/MIND_USD,
    xnt:  (ownerUsd/2)/XNT_USD,
  };
  const poolStart = poolUsd(pool);

  let totalFee=0, totalPayout=0, totalWins=0;
  let daySwapCount=0, dayPayout=0;

  const userResults: UserResult[] = [];

  for (const user of USERS) {
    const ur: UserResult = {
      user,
      totalFee: 0,
      totalPayout: 0,
      wins: [],
      swapCount: user.swaps,
      maxWin: 0,
      avgWinUsd: 0,
      volumeUsd: 0,
    };

    for (let i=0; i<user.swaps; i++) {
      const swapUsd = rng.range(user.usdRange[0], user.usdRange[1]);
      const feeUsd  = swapUsd * FEE_BPS / 10_000;

      addToPool(pool, feeUsd);
      ur.totalFee += feeUsd;
      ur.volumeUsd += swapUsd;
      totalFee    += feeUsd;

      daySwapCount++;
      if (daySwapCount >= SWAPS_PER_DAY) { daySwapCount=0; dayPayout=0; }

      if (swapUsd < minSwapUsd) continue;

      const prob = getWinProb(swapUsd, winPreset);
      if (rng.frac() >= prob) continue;

      const mult = pickMult(rng);
      let payoutUsd = calcPayout(formula, feeUsd, mult, pool);

      if (dailyCapPct !== null) {
        const cap = poolUsd(pool) * dailyCapPct / 100;
        if (dayPayout + payoutUsd > cap)
          payoutUsd = Math.max(0, cap - dayPayout);
      }

      payoutUsd = Math.min(payoutUsd, poolUsd(pool));

      if (payoutUsd > 0.001) {
        drainPool(pool, payoutUsd);
        dayPayout      += payoutUsd;
        ur.totalPayout += payoutUsd;
        ur.wins.push({ swapUsd, feeUsd, mult, payoutUsd });
        if (payoutUsd > ur.maxWin) ur.maxWin = payoutUsd;
        totalPayout += payoutUsd;
        totalWins++;
      }
    }

    ur.avgWinUsd = ur.wins.length > 0
      ? ur.wins.reduce((s,w)=>s+w.payoutUsd,0) / ur.wins.length
      : 0;

    userResults.push(ur);
  }

  return {
    users: userResults,
    poolStart,
    poolEnd: poolUsd(pool),
    totalFee,
    totalPayout,
    totalWins,
  };
}

// ══ Formatowanie ════════════════════════════════════════════════════════
const $d  = (n: number, d=2) => `$${n.toFixed(d)}`;
const pct = (n: number) => `${n.toFixed(1)}%`;
const sign= (n: number) => n >= 0 ? "+" : "";
const pad = (s: string, w: number) => s.padEnd(w);
const lp  = (s: string, w: number) => s.padStart(w);
const bar = (v: number, max: number, w=10) =>
  "█".repeat(Math.max(0,Math.round(v/Math.max(max,0.001)*w))).padEnd(w);

// ══ Drukuj per-user tabelę ═══════════════════════════════════════════════
function printUserTable(label: string, data: ReturnType<typeof runDetailed>) {
  const { users, poolStart, poolEnd, totalFee, totalPayout, totalWins } = data;
  const maxPayout = Math.max(...users.map(u=>u.totalPayout), 1);

  console.log(`
╔══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗
║  ${pad(label, 86)}                  ║
║  Pula start: ${$d(poolStart,0).padEnd(8)} │ Pula koniec: ${$d(poolEnd,0).padEnd(8)} │ Fee: ${$d(totalFee).padEnd(10)} │ Payout: ${$d(totalPayout).padEnd(10)} │ Wygranych: ${totalWins}    ║
╠══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╣
║  USER           TYP     SWAPY  VOLUME     FEE ZAPŁ.  PAYOUT   NET P/L  ROI     WYGR  MAX_WIN  ŚR.WYGRANA  PAYOUT BAR   ║
╠══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╣`);

  // Sortuj: najpierw po typie, potem po payoucie malejąco
  const typeOrder = ["Bot","BotMid","Mały","Trader","Whale","Power"];
  const sorted = [...users].sort((a,b) => {
    const ta = typeOrder.indexOf(a.user.type);
    const tb = typeOrder.indexOf(b.user.type);
    if (ta !== tb) return ta - tb;
    return b.totalPayout - a.totalPayout;
  });

  let prevType = "";
  for (const ur of sorted) {
    if (ur.user.type !== prevType) {
      if (prevType !== "") console.log("║" + "─".repeat(118) + "║");
      prevType = ur.user.type;
    }

    const netPl   = ur.totalPayout - ur.totalFee;
    const roi     = ur.totalFee > 0 ? ur.totalPayout / ur.totalFee * 100 : 0;
    const profitIcon = netPl > 0 ? "✓" : netPl === 0 ? "~" : "✗";
    const barStr  = bar(ur.totalPayout, maxPayout);

    console.log(
      `║ ${profitIcon} ${pad(ur.user.name,14)} ${pad(ur.user.type,7)} ${lp(String(ur.swapCount),5)}` +
      `  ${lp($d(ur.volumeUsd,1),9)}` +
      `  ${lp($d(ur.totalFee),9)}` +
      `  ${lp($d(ur.totalPayout),8)}` +
      `  ${lp(sign(netPl)+$d(netPl),8)}` +
      `  ${lp(pct(roi),6)}` +
      `  ${lp(String(ur.wins.length),4)}` +
      `  ${lp($d(ur.maxWin),8)}` +
      `  ${lp($d(ur.avgWinUsd),9)}` +
      `  ${barStr}   ║`
    );
  }

  // Sumy per typ
  console.log("╠══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╣");
  for (const type of typeOrder) {
    const group = sorted.filter(u => u.user.type === type);
    if (group.length === 0) continue;
    const fee   = group.reduce((s,u)=>s+u.totalFee,0);
    const pout  = group.reduce((s,u)=>s+u.totalPayout,0);
    const net   = pout - fee;
    const roi   = fee > 0 ? pout/fee*100 : 0;
    const wins  = group.reduce((s,u)=>s+u.wins.length,0);
    const inProfit = group.filter(u=>u.totalPayout>u.totalFee).length;
    console.log(
      `║   ${"ΣΣΣΣ "+type}       ${lp(String(group.length),2)}u` +
      `  ${"".padEnd(9)}` +
      `  ${lp($d(fee),9)}` +
      `  ${lp($d(pout),8)}` +
      `  ${lp(sign(net)+$d(net),8)}` +
      `  ${lp(pct(roi),6)}` +
      `  ${lp(String(wins),4)}` +
      `  profit: ${inProfit}/${group.length}${"".padEnd(22)}║`
    );
  }

  // Total
  console.log("╠══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╣");
  const allFee  = users.reduce((s,u)=>s+u.totalFee,0);
  const allPout = users.reduce((s,u)=>s+u.totalPayout,0);
  const allNet  = allPout - allFee;
  const allRoi  = allFee > 0 ? allPout/allFee*100 : 0;
  const allWins = users.reduce((s,u)=>s+u.wins.length,0);
  const allProfit = users.filter(u=>u.totalPayout>u.totalFee).length;
  console.log(
    `║   ΣΣΣΣΣ ŁĄCZNIE    ${lp(String(users.length),2)}u` +
    `  ${"".padEnd(9)}` +
    `  ${lp($d(allFee),9)}` +
    `  ${lp($d(allPout),8)}` +
    `  ${lp(sign(allNet)+$d(allNet),8)}` +
    `  ${lp(pct(allRoi),6)}` +
    `  ${lp(String(allWins),4)}` +
    `  profit: ${allProfit}/${users.length}${"".padEnd(22)}║`
  );
  console.log("╚══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝");
}

// ══ Wydrukuj największe wygrane ══════════════════════════════════════════
function printTopWins(label: string, data: ReturnType<typeof runDetailed>, topN=15) {
  console.log(`\n  TOP ${topN} NAJWIĘKSZYCH WYGRANYCH — ${label}`);
  console.log("  " + "─".repeat(65));

  const allWins: Array<{name:string; type:string} & UserWin> = [];
  for (const ur of data.users) {
    for (const w of ur.wins) {
      allWins.push({ name: ur.user.name, type: ur.user.type, ...w });
    }
  }
  allWins.sort((a,b) => b.payoutUsd - a.payoutUsd);

  allWins.slice(0, topN).forEach((w,i) => {
    console.log(
      `  ${lp(String(i+1),2)}. ${pad(w.name,15)} ${pad(w.type,7)}` +
      `  swap ${lp($d(w.swapUsd,1),7)}` +
      `  fee ${lp($d(w.feeUsd,3),7)}` +
      `  mult ${lp(String(w.mult)+"×",4)}` +
      `  → PAYOUT ${lp($d(w.payoutUsd),9)}`
    );
  });
}

// ══ Scenariusze do pokazania ════════════════════════════════════════════
interface ScenToShow {
  label:       string;
  formula:     Formula;
  winPreset:   WinPreset;
  ownerUsd:    number;
  minSwapUsd:  number;
  dailyCapPct: number | null;
}

const SCENARIOS_TO_SHOW: ScenToShow[] = [
  {
    label:       "🥇 SCENARIUSZ 1 — Formula B / HIGH / $500 (REKOMENDOWANY)",
    formula:     "B",
    winPreset:   "HIGH",
    ownerUsd:    500,
    minSwapUsd:  1,
    dailyCapPct: null,
  },
  {
    label:       "🥈 SCENARIUSZ 2 — Formula B / HIGH / $2000 (duża pula)",
    formula:     "B",
    winPreset:   "HIGH",
    ownerUsd:    2000,
    minSwapUsd:  1,
    dailyCapPct: null,
  },
  {
    label:       "🥉 SCENARIUSZ 3 — Formula B2 / HIGH / $2000 (25/25 profit)",
    formula:     "B2",
    winPreset:   "HIGH",
    ownerUsd:    2000,
    minSwapUsd:  1,
    dailyCapPct: null,
  },
];

// ══ MAIN ════════════════════════════════════════════════════════════════
function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗
║  GigaSwap Detail — szczegółowy raport per-user │ seed=${SEED} │ 25 użytkowników                                        ║
║  Legenda: ✓ profit │ ✗ strata │ ROI=payout/fee × 100%                                                                  ║
╚══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝`);

  for (const scen of SCENARIOS_TO_SHOW) {
    const data = runDetailed(
      scen.formula, scen.winPreset, scen.ownerUsd,
      scen.minSwapUsd, scen.dailyCapPct
    );
    printUserTable(scen.label, data);
    printTopWins(scen.label, data, 10);
    console.log();
  }
}

main();
