import { DEFAULT_WEEKLY_POOL_XNT } from "@/lib/yieldMath";

type YieldPoolOverride = {
  currentPoolXnt: number;
  nextPoolXnt: number;
  updatedAt: number;
};

export type YieldPoolConfig = {
  currentPoolXnt: number;
  nextPoolXnt: number;
  updatedAt: number | null;
  source: "env" | "admin";
};

let override: YieldPoolOverride | null = null;

const parsePoolValue = (raw: string | undefined, fallback: number) => {
  const parsed = raw != null && raw.trim() ? Number(raw) : fallback;
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
};

export const getYieldPoolConfig = (): YieldPoolConfig => {
  if (override) {
    return {
      currentPoolXnt: override.currentPoolXnt,
      nextPoolXnt: override.nextPoolXnt,
      updatedAt: override.updatedAt,
      source: "admin",
    };
  }
  const currentPoolXnt = parsePoolValue(
    process.env.NEXT_PUBLIC_WEEKLY_YIELD_POOL_XNT,
    DEFAULT_WEEKLY_POOL_XNT
  );
  const nextPoolXnt = parsePoolValue(
    process.env.NEXT_PUBLIC_NEXT_WEEKLY_YIELD_POOL_XNT,
    currentPoolXnt
  );
  return { currentPoolXnt, nextPoolXnt, updatedAt: null, source: "env" };
};

export const setYieldPoolConfig = (currentPoolXnt: number, nextPoolXnt: number) => {
  override = {
    currentPoolXnt,
    nextPoolXnt,
    updatedAt: Date.now(),
  };
};
