import "./globals.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import type { Metadata } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { WalletProviders } from "@/components/WalletProviders";
import { ToastProvider } from "@/components/shared/ToastProvider";
import { Providers } from "./providers";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "Mining V2",
  description: "Mining + staking V2 on X1 testnet",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} font-sans`}>
        <WalletProviders>
          <Providers>
            <ToastProvider>{children}</ToastProvider>
          </Providers>
        </WalletProviders>
      </body>
    </html>
  );
}
