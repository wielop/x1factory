export const LEVELS = [2, 3, 4, 5, 6] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_WEIGHTS: Record<Level, number> = {
  2: 67,
  3: 134,
  4: 300,
  5: 670,
  6: 1340,
};

export const DEFAULT_WEEKLY_POOL_XNT = 50;

export type CountsByLevel = Partial<Record<Level, number>>;

export type YieldSummary = {
  poolXnt: number;
  nextPoolXnt: number;
  epochEndTs: number | null;
  totalWeight: number;
  countsByLevel: CountsByLevel;
  updatedAt: number;
};

export function getWeeklyPoolXnt() {
  const raw = process.env.NEXT_PUBLIC_WEEKLY_YIELD_POOL_XNT;
  const parsed = raw ? Number(raw) : DEFAULT_WEEKLY_POOL_XNT;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WEEKLY_POOL_XNT;
  }
  return parsed;
}

export function computeTotalWeight(countsByLevel: CountsByLevel) {
  let total = 0;
  for (const level of LEVELS) {
    const count = countsByLevel[level] ?? 0;
    total += count * LEVEL_WEIGHTS[level];
  }
  return total;
}

export function computeEstWeeklyXnt(
  level: number,
  totalWeight: number,
  weeklyPoolXnt: number,
  countAtLevel?: number
) {
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) return null;
  if (!Number.isFinite(weeklyPoolXnt) || weeklyPoolXnt <= 0) return null;
  const weight = LEVEL_WEIGHTS[level as Level] ?? 0;
  if (!weight) return null;
  const adjustedTotal = countAtLevel === 0 ? totalWeight + weight : totalWeight;
  return (weight / adjustedTotal) * weeklyPoolXnt;
}
