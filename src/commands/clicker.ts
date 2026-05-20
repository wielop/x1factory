import type { BotContext, BotInstance } from "../bot/types.js";
import { env } from "../config/env.js";
import { clickerKeyboard, factoryHeader, formatTestingNotice, mainMenuKeyboard } from "../bot/ui.js";
import { getSeasonTestingNotice } from "../services/seasonService.js";
import {
  cancelPendingClaim,
  createClaimCheckout,
  getClickerDashboard,
  renderClickerScreen,
  runFactoryTap
} from "../services/clickerService.js";
import {
  buyHashRushBoost,
  buyHashRushUpgrade,
  collectHashRush,
  getHashRushDashboard,
  getHashRushLeaderboard,
  mineHashRush,
  renderHashRushBoosts,
  renderHashRushDashboard,
  renderHashRushUpgrades
} from "../services/hashRushService.js";

function buildClickerDisconnectedMessage() {
  return [
    factoryHeader("FACTORY CLICKER"),
    "",
    "Connect your season wallet first.",
    "The clicker will create a separate funding wallet for XNT top-ups.",
    "",
    "Once the wallet is connected, open the Mini App from the button below."
  ].join("\n");
}

export async function showClicker(ctx: BotContext): Promise<void> {
  const from = ctx.from;

  if (!from) {
    await ctx.reply("MIND FACTORY could not read your Telegram profile.");
    return;
  }

  const dashboard = await getClickerDashboard(from);
  const testingNotice = getSeasonTestingNotice(dashboard.seasonName);

  if (!dashboard.payoutWallet) {
    await ctx.reply(
      [
        buildClickerDisconnectedMessage(),
        env.miniAppUrl ? "" : "Mini App URL is not configured yet.",
        ...formatTestingNotice(testingNotice)
      ].join("\n"),
      clickerKeyboard(false, env.miniAppUrl)
    );
    return;
  }

  await ctx.reply(
    [
      renderClickerScreen(dashboard),
      ...formatTestingNotice(testingNotice)
    ].join("\n"),
    clickerKeyboard(Boolean(dashboard.pendingClaim), env.miniAppUrl)
  );
}

export async function showFactory(ctx: BotContext): Promise<void> {
  if (!ctx.from) {
    await ctx.reply("Hash Rush could not read your Telegram profile.");
    return;
  }

  try {
    const dashboard = await getHashRushDashboard(ctx.from);
    const testingNotice = getSeasonTestingNotice(dashboard.season.name);

    await ctx.reply(
      [
        renderHashRushDashboard(dashboard),
        ...formatTestingNotice(testingNotice)
      ].join("\n")
    );
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : "Hash Rush factory could not load.");
  }
}

export async function showMine(ctx: BotContext): Promise<void> {
  if (!ctx.from) {
    await ctx.reply("Hash Rush could not read your Telegram profile.");
    return;
  }

  try {
    const result = await mineHashRush(ctx.from);
    const seasonLine = result.seasonPointsAwarded ? `Season Points: +${result.seasonPointsAwarded}` : "Season Points: +0";

    await ctx.reply([result.message, seasonLine, "", renderHashRushDashboard(result)].join("\n"));
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : "Mine action failed.");
  }
}

export async function showCollect(ctx: BotContext): Promise<void> {
  if (!ctx.from) {
    await ctx.reply("Hash Rush could not read your Telegram profile.");
    return;
  }

  try {
    const result = await collectHashRush(ctx.from);
    const seasonLine = result.seasonPointsAwarded ? `Season Points: +${result.seasonPointsAwarded}` : "Season Points: +0";

    await ctx.reply([result.message, seasonLine, "", renderHashRushDashboard(result)].join("\n"));
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : "Collect action failed.");
  }
}

export async function showHashRushUpgrades(ctx: BotContext): Promise<void> {
  if (!ctx.from) {
    await ctx.reply("Hash Rush could not read your Telegram profile.");
    return;
  }

  try {
    const dashboard = await getHashRushDashboard(ctx.from);
    await ctx.reply(renderHashRushUpgrades(dashboard));
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : "Upgrades could not load.");
  }
}

export async function showBuyHashRushUpgrade(ctx: BotContext): Promise<void> {
  if (!ctx.from || !ctx.message || !("text" in ctx.message)) {
    await ctx.reply("Usage: /buy_upgrade <upgradeId>");
    return;
  }

  const upgradeId = ctx.message.text.replace(/^\/buy_upgrade(?:@\S+)?\s*/i, "").trim();

  if (!upgradeId) {
    await ctx.reply("Usage: /buy_upgrade <upgradeId>");
    return;
  }

  try {
    const result = await buyHashRushUpgrade(ctx.from, upgradeId);
    const seasonLine = result.seasonPointsAwarded ? `Season Points: +${result.seasonPointsAwarded}` : "Season Points: +0";
    await ctx.reply([result.message, seasonLine, "", renderHashRushDashboard(result)].join("\n"));
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : "Upgrade purchase failed.");
  }
}

export async function showHashRushBoosts(ctx: BotContext): Promise<void> {
  if (!ctx.from) {
    await ctx.reply("Hash Rush could not read your Telegram profile.");
    return;
  }

  try {
    const dashboard = await getHashRushDashboard(ctx.from);
    await ctx.reply(renderHashRushBoosts(dashboard));
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : "Boosts could not load.");
  }
}

export async function showBuyHashRushBoost(ctx: BotContext): Promise<void> {
  if (!ctx.from || !ctx.message || !("text" in ctx.message)) {
    await ctx.reply("Usage: /buy_boost <boostId>");
    return;
  }

  const boostId = ctx.message.text.replace(/^\/buy_boost(?:@\S+)?\s*/i, "").trim();

  if (!boostId) {
    await ctx.reply("Usage: /buy_boost <boostId>");
    return;
  }

  try {
    const result = await buyHashRushBoost(ctx.from, boostId);
    await ctx.reply([result.message, "", renderHashRushDashboard(result)].join("\n"));
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : "Boost purchase failed.");
  }
}

export async function showHashRushEnergy(ctx: BotContext): Promise<void> {
  if (!ctx.from) {
    await ctx.reply("Hash Rush could not read your Telegram profile.");
    return;
  }

  try {
    const dashboard = await getHashRushDashboard(ctx.from);
    await ctx.reply(
      [
        "Reactor Energy",
        "",
        `Balance: ${dashboard.energyBalance.balance}`,
        `Total earned: ${dashboard.energyBalance.totalEarned}`,
        `Total spent: ${dashboard.energyBalance.totalSpent}`,
        "",
        "MVP deposits are credited by admin with /admin_credit_energy."
      ].join("\n")
    );
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : "Energy balance could not load.");
  }
}

export async function showHashRushLeaderboard(ctx: BotContext): Promise<void> {
  try {
    const leaderboard = await getHashRushLeaderboard(10);
    const rows = leaderboard.profiles.map((profile, index) => {
      const name = profile.user.username ? `@${profile.user.username}` : profile.user.telegramId.toString();
      return `#${index + 1} ${name} - ${profile.totalHashPoints.toLocaleString("en-US")} HP`;
    });

    await ctx.reply(
      [
        `Hash Rush Leaderboard - ${leaderboard.season.name}`,
        "",
        ...(rows.length ? rows : ["No miners yet."])
      ].join("\n")
    );
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : "Clicker leaderboard could not load.");
  }
}

export async function showRunFactory(ctx: BotContext): Promise<void> {
  const from = ctx.from;

  if (!from) {
    await ctx.reply("MIND FACTORY could not read your Telegram profile.");
    return;
  }

  try {
    const result = await runFactoryTap(from);
    const testingNotice = getSeasonTestingNotice(result.seasonName);

    await ctx.reply(
      [
        factoryHeader("FACTORY LINE"),
        "",
        result.message,
        "",
        renderClickerScreen(result),
        ...formatTestingNotice(testingNotice)
      ].join("\n"),
      clickerKeyboard(Boolean(result.pendingClaim), env.miniAppUrl)
    );
  } catch (error) {
    await ctx.reply(
      [
        factoryHeader("FACTORY LINE"),
        "",
        error instanceof Error ? error.message : "The factory line could not start.",
        "",
        "Connect your wallet and try again."
      ].join("\n"),
      mainMenuKeyboard()
    );
  }
}

export async function showClaimMind(ctx: BotContext): Promise<void> {
  const from = ctx.from;

  if (!from) {
    await ctx.reply("MIND FACTORY could not read your Telegram profile.");
    return;
  }

  try {
    const result = await createClaimCheckout(from);
    const testingNotice = getSeasonTestingNotice(result.seasonName);

    await ctx.reply(
      [
        factoryHeader("CLAIM CHECKOUT"),
        "",
        result.message,
        "",
        renderClickerScreen(result),
        "",
        env.miniAppUrl
          ? "Open the Mini App for the full-screen tap loop."
          : "Configure MINI_APP_URL to open the Mini App from Telegram.",
        ...formatTestingNotice(testingNotice)
      ].join("\n"),
      clickerKeyboard(true, env.miniAppUrl)
    );
  } catch (error) {
    await ctx.reply(
      [
        factoryHeader("CLAIM CHECKOUT"),
        "",
        error instanceof Error ? error.message : "The claim could not be created.",
        "",
        "Keep tapping until you reach the minimum claim size."
      ].join("\n"),
      mainMenuKeyboard()
    );
  }
}

export async function showCancelClaim(ctx: BotContext): Promise<void> {
  const from = ctx.from;

  if (!from) {
    await ctx.reply("MIND FACTORY could not read your Telegram profile.");
    return;
  }

  try {
    const result = await cancelPendingClaim(from);

    await ctx.reply(
      [
        factoryHeader("CLAIM CANCELLED"),
        "",
        result.message,
        "",
        renderClickerScreen(result)
      ].join("\n"),
      clickerKeyboard(Boolean(result.pendingClaim), env.miniAppUrl)
    );
  } catch (error) {
    await ctx.reply(
      [
        factoryHeader("CLAIM CANCELLED"),
        "",
        error instanceof Error ? error.message : "The pending claim could not be cancelled."
      ].join("\n"),
      mainMenuKeyboard()
    );
  }
}

export function registerClickerCommand(bot: BotInstance): void {
  bot.command("clicker", showClicker);
  bot.command("factory", showFactory);
  bot.command("mine", showMine);
  bot.command("collect", showCollect);
  bot.command("upgrades", showHashRushUpgrades);
  bot.command("buy_upgrade", showBuyHashRushUpgrade);
  bot.command("boosts", showHashRushBoosts);
  bot.command("buy_boost", showBuyHashRushBoost);
  bot.command("energy", showHashRushEnergy);
  bot.command("clicker_leaderboard", showHashRushLeaderboard);
}
