import { Markup } from "telegraf";

export const FACTORY_XP = "Factory XP";
const MINI_APP_CACHE_BUST = "reactor-1";

export const MENU_LABELS = {
  factoryClicker: "Reactor Rush",
  connectWallet: "Connect Wallet",
  myFactory: "My Factory",
  season: "Season",
  leaderboard: "Leaderboard",
  howItWorks: "How It Works",
  runFactory: "Tap Reactor",
  claimMind: "Claim MIND",
  cancelClaim: "Cancel Claim",
  backToMenu: "Back to Menu"
} as const;

export function mainMenuKeyboard(miniAppUrl?: string) {
  const rows = miniAppUrl
    ? [
        [Markup.button.webApp("Play Reactor Rush", addMiniAppCacheBust(miniAppUrl)), MENU_LABELS.connectWallet],
        [MENU_LABELS.myFactory, MENU_LABELS.season],
        [MENU_LABELS.leaderboard, MENU_LABELS.howItWorks]
      ]
    : [
        [MENU_LABELS.connectWallet, MENU_LABELS.factoryClicker],
        [MENU_LABELS.myFactory, MENU_LABELS.season],
        [MENU_LABELS.leaderboard, MENU_LABELS.howItWorks]
      ];

  return Markup.keyboard(rows).resize();
}

export function clickerKeyboard(hasPendingClaim = false, miniAppUrl?: string) {
  const rows = miniAppUrl
    ? [
        [Markup.button.webApp("Play Reactor Rush", addMiniAppCacheBust(miniAppUrl))],
        [MENU_LABELS.runFactory, hasPendingClaim ? MENU_LABELS.cancelClaim : MENU_LABELS.claimMind],
        [MENU_LABELS.myFactory, MENU_LABELS.backToMenu]
      ]
    : [
        [MENU_LABELS.runFactory, hasPendingClaim ? MENU_LABELS.cancelClaim : MENU_LABELS.claimMind],
        [MENU_LABELS.myFactory, MENU_LABELS.backToMenu]
      ];

  return Markup.keyboard(rows).resize();
}

export function walletInputKeyboard() {
  return Markup.keyboard([
    ["Cancel"],
    [MENU_LABELS.howItWorks]
  ]).resize();
}

export function shortWallet(address?: string | null): string {
  if (!address) {
    return "not connected";
  }

  if (address.length <= 12) {
    return address;
  }

  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

export function formatTestingNotice(notice?: string | null): string[] {
  return notice ? ["", `Test mode: ${notice}`] : [];
}

export function factoryHeader(title?: string): string {
  return title ? `MIND FACTORY // ${title}` : "MIND FACTORY";
}

function addMiniAppCacheBust(miniAppUrl: string): string {
  try {
    const url = new URL(miniAppUrl);
    url.searchParams.set("v", MINI_APP_CACHE_BUST);
    return url.toString();
  } catch {
    return miniAppUrl;
  }
}
