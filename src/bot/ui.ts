import { Markup } from "telegraf";

export const FACTORY_XP = "Season Points";

export const MENU_LABELS = {
  connectWallet: "Connect Wallet",
  howItWorks: "How It Works",
  dailyCheckin: "Daily Check-in ✅",
} as const;

export function mainMenuKeyboard(miniAppUrl?: string) {
  const rows = miniAppUrl
    ? [
        [Markup.button.webApp("Season Panel", miniAppUrl), MENU_LABELS.connectWallet],
        [MENU_LABELS.dailyCheckin, MENU_LABELS.howItWorks]
      ]
    : [
        [MENU_LABELS.connectWallet, MENU_LABELS.howItWorks],
        [MENU_LABELS.dailyCheckin]
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
