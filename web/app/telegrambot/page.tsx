import type { Metadata } from "next";
import { TelegramBotPanel } from "@/components/telegrambot/TelegramBotPanel";

export const metadata: Metadata = {
  title: "MIND FACTORY // Telegram Clicker",
  description: "Telegram Mini App route for the MIND FACTORY factory clicker.",
};

export default function TelegramBotPage() {
  return <TelegramBotPanel />;
}
