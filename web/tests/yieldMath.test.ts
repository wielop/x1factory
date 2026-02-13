import assert from "node:assert/strict";
import { test } from "node:test";
import { computeEstWeeklyXnt, computeTotalWeight, getWeeklyPoolXnt } from "../lib/yieldMath";

test("computeTotalWeight sums counts using level weights", () => {
  const total = computeTotalWeight({ 2: 1, 3: 2 });
  assert.equal(total, 335);
});

test("computeEstWeeklyXnt returns proportional estimate", () => {
  const totalWeight = computeTotalWeight({ 2: 1, 3: 2 });
  const estimate = computeEstWeeklyXnt(3, totalWeight, 50);
  assert.ok(estimate != null);
  assert.equal(estimate.toFixed(2), "20.00");
});

test("computeEstWeeklyXnt adjusts when no holders at level", () => {
  const totalWeight = computeTotalWeight({ 2: 1 });
  const estimate = computeEstWeeklyXnt(6, totalWeight, 50, 0);
  assert.ok(estimate != null);
  assert.equal(estimate.toFixed(2), "47.62");
});

test("computeEstWeeklyXnt returns full pool for first holder", () => {
  const estimate = computeEstWeeklyXnt(2, 0, 50, 0);
  assert.ok(estimate != null);
  assert.equal(estimate.toFixed(2), "50.00");
});

test("computeEstWeeklyXnt returns null for empty totals or LVL1", () => {
  assert.equal(computeEstWeeklyXnt(2, 0, 50), null);
  assert.equal(computeEstWeeklyXnt(1, 100, 50), null);
});

test("getWeeklyPoolXnt falls back to default on invalid input", () => {
  const original = process.env.NEXT_PUBLIC_WEEKLY_YIELD_POOL_XNT;
  process.env.NEXT_PUBLIC_WEEKLY_YIELD_POOL_XNT = "not-a-number";
  assert.equal(getWeeklyPoolXnt(), 50);
  process.env.NEXT_PUBLIC_WEEKLY_YIELD_POOL_XNT = "75";
  assert.equal(getWeeklyPoolXnt(), 75);
  if (original == null) {
    delete process.env.NEXT_PUBLIC_WEEKLY_YIELD_POOL_XNT;
  } else {
    process.env.NEXT_PUBLIC_WEEKLY_YIELD_POOL_XNT = original;
  }
});
