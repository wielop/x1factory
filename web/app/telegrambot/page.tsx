import type { Metadata } from "next";
import { ReactorTapPanel } from "@/components/telegrambot/ReactorTapPanel";

export const metadata: Metadata = {
  title: "MIND FACTORY // Telegram Clicker",
  description: "Telegram Mini App route for the MIND FACTORY reactor tap clicker.",
};

export default function TelegramBotPage() {
  return <ReactorTapPanel />;
}
