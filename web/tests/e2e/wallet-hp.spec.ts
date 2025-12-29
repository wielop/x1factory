import { expect, test } from "@playwright/test";
import { parseFirstNumber, fromHundredths } from "./helpers/parse";
import { fetchWalletHp } from "./helpers/onchain";

const expectClose = (actual: number, expected: number, tolerance = 0.02) => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
};

const wallet =
  process.env.E2E_WALLET?.trim() ?? process.env.NEXT_PUBLIC_E2E_WALLET?.trim();

test.skip(!wallet, "E2E_WALLET is not set");

test("your HP and share match on-chain", async ({ page }) => {
  if (!wallet) return;
  const snapshot = await fetchWalletHp(wallet);

  await page.goto(`/?view=${wallet}`);
  await expect(page.getByTestId("your-hp")).toContainText("HP");
  await expect(page.getByTestId("your-base-hp")).not.toHaveText("-");

  const uiYourHp = parseFirstNumber(await page.getByTestId("your-hp").innerText());
  const uiBaseHp = parseFirstNumber(await page.getByTestId("your-base-hp").innerText());
  const uiRigBuff = parseFirstNumber(await page.getByTestId("your-rig-buffs").innerText());
  const uiAccountBonus = parseFirstNumber(
    await page.getByTestId("your-account-bonus").innerText()
  );
  const uiShare = parseFirstNumber(await page.getByTestId("your-share").innerText());

  const baseHp = fromHundredths(snapshot.baseHp);
  const buffedHp = fromHundredths(snapshot.buffedHp);
  const accountBonus = fromHundredths(snapshot.accountBonusHp);
  const effectiveHp = fromHundredths(snapshot.effectiveHp);
  const networkHp = fromHundredths(snapshot.networkHp);
  const rigBuffBonus = Math.max(0, buffedHp - baseHp);
  const expectedShare = networkHp > 0 ? (effectiveHp / networkHp) * 100 : 0;

  expectClose(uiYourHp, effectiveHp);
  expectClose(uiBaseHp, baseHp);
  expectClose(uiRigBuff, rigBuffBonus);
  expectClose(uiAccountBonus, accountBonus);
  expectClose(uiShare, expectedShare, 0.05);
});
