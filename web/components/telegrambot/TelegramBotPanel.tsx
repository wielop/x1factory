"use client";

import { useEffect, useMemo, useState } from "react";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready: () => void;
        expand: () => void;
        close: () => void;
        MainButton: {
          setText: (text: string) => void;
          onClick: (callback: () => void) => void;
          show: () => void;
          hide: () => void;
        };
        BackButton?: {
          onClick: (callback: () => void) => void;
          show: () => void;
          hide: () => void;
        };
      };
    };
  }
}

type FeedEntry = {
  title: string;
  detail: string;
};

const RATE = "1 MIND = 0.015 XNT";
const DAILY_CAP = 50;
const CLAIM_LIMIT = 1.6;

export function TelegramBotPanel() {
  const [claimableMind, setClaimableMind] = useState(0.04);
  const [tapsLeft, setTapsLeft] = useState(48);
  const [pendingClaim, setPendingClaim] = useState(false);
  const [feed, setFeed] = useState<FeedEntry[]>([
    {
      title: "Factory online",
      detail: "The Telegram surface is ready for taps and claims."
    }
  ]);

  const tg = typeof window !== "undefined" ? window.Telegram?.WebApp : undefined;
  const payoutWallet = "AHrS...6VZS";
  const clickerWallet = "Er1H...pxK";

  useEffect(() => {
    if (!tg) {
      return;
    }

    tg.ready();
    tg.expand();
    tg.MainButton.setText("Close");
    tg.MainButton.onClick(() => tg.close());
    tg.MainButton.show();

    tg.BackButton?.show();
    tg.BackButton?.onClick(() => tg.close());

    return () => {
      tg.MainButton.hide();
      tg.BackButton?.hide();
    };
  }, [tg]);

  const tapProgress = useMemo(() => {
    const used = DAILY_CAP - tapsLeft;
    return Math.max(0, Math.min(100, (used / DAILY_CAP) * 100));
  }, [tapsLeft]);

  const claimText = pendingClaim ? "Claim pending" : claimableMind > 0 ? "Claim MIND" : "Claim locked";

  function pushFeed(title: string, detail: string) {
    setFeed((current) => [{ title, detail }, ...current].slice(0, 5));
  }

  function handleTap() {
    if (tapsLeft <= 0) {
      pushFeed("Daily cap reached", "Come back tomorrow for another shift.");
      return;
    }

    setTapsLeft((current) => current - 1);
    setClaimableMind((current) => Number((current + 0.02).toFixed(2)));
    pushFeed("Factory tap", "+0.02 MIND added to claimable balance.");
  }

  function handleClaim() {
    if (claimableMind <= 0 || pendingClaim) {
      pushFeed("Claim unavailable", "Build some balance first.");
      return;
    }

    setPendingClaim(true);
    pushFeed("Claim created", `Top up the funding wallet to release ${claimableMind.toFixed(2)} MIND.`);
  }

  function handleCancel() {
    if (!pendingClaim) {
      pushFeed("No pending claim", "Nothing to cancel yet.");
      return;
    }

    setPendingClaim(false);
    pushFeed("Claim cancelled", "You can keep tapping and try again later.");
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-5 px-4 py-4 md:px-6 md:py-6">
      <header className="rounded-3xl border border-cyan-400/15 bg-slate-950/80 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.32)] backdrop-blur-xl">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-cyan-200/60">MIND FACTORY</p>
            <h1 className="mt-2 text-3xl font-semibold text-zinc-50 md:text-4xl">Telegram Clicker</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-300/80">
              Tap the factory, build claimable MIND, and move it to the registered season wallet when the funding wallet is topped up.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-zinc-200/80">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-400">Claim rate</div>
            <div className="mt-1 font-mono text-base text-cyan-200">{RATE}</div>
          </div>
        </div>
      </header>

      <section className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
        <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-5 shadow-[0_20px_60px_rgba(0,0,0,0.25)] backdrop-blur-xl">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Claimable MIND</p>
              <div className="mt-2 text-5xl font-semibold text-cyan-300 md:text-6xl">{claimableMind.toFixed(2)}</div>
            </div>
            <div className="rounded-2xl border border-cyan-400/15 bg-cyan-400/10 px-4 py-3 text-right text-sm text-cyan-100/90">
              <div className="text-xs uppercase tracking-[0.2em] text-cyan-100/50">Season</div>
              <div className="mt-1">Season 0</div>
              <div className="mt-1 text-xs text-cyan-100/60">Test factory line</div>
            </div>
          </div>

          <div className="mt-5">
            <div className="h-3 overflow-hidden rounded-full border border-white/10 bg-slate-900">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-teal-300 to-emerald-300 transition-all duration-200"
                style={{ width: `${tapProgress}%` }}
              />
            </div>
            <div className="mt-2 flex justify-between text-xs text-zinc-400">
              <span>{tapsLeft} taps left today</span>
              <span>{DAILY_CAP - tapsLeft}/{DAILY_CAP} used</span>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={handleTap}
              className="rounded-2xl border border-cyan-400/25 bg-cyan-400/15 px-5 py-3 text-sm font-semibold text-cyan-50 transition hover:bg-cyan-400/20"
            >
              Run Factory
            </button>
            <button
              type="button"
              onClick={handleClaim}
              className="rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-zinc-50 transition hover:bg-white/10"
            >
              {claimText}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-zinc-50 transition hover:bg-white/10"
            >
              Cancel Claim
            </button>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-zinc-400">Payout wallet</div>
              <div className="mt-2 font-mono text-sm text-zinc-100">{payoutWallet}</div>
              <div className="mt-2 text-xs text-zinc-400">Season-registered destination for MIND.</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-zinc-400">Funding wallet</div>
              <div className="mt-2 font-mono text-sm text-zinc-100">{clickerWallet}</div>
              <div className="mt-2 text-xs text-zinc-400">Top up this wallet with XNT to unlock claims.</div>
            </div>
          </div>
        </div>

        <aside className="rounded-3xl border border-white/10 bg-slate-950/80 p-5 shadow-[0_20px_60px_rgba(0,0,0,0.25)] backdrop-blur-xl">
          <p className="text-xs uppercase tracking-[0.22em] text-zinc-400">Factory status</p>
          <ul className="mt-4 space-y-3 text-sm text-zinc-200/85">
            <li className="rounded-2xl border border-white/10 bg-white/5 p-3">
              <div className="text-xs uppercase tracking-[0.18em] text-zinc-400">Wallet mode</div>
              <div className="mt-1">Payout wallet and funding wallet are separate.</div>
            </li>
            <li className="rounded-2xl border border-white/10 bg-white/5 p-3">
              <div className="text-xs uppercase tracking-[0.18em] text-zinc-400">Claim status</div>
              <div className="mt-1">{pendingClaim ? "Waiting for XNT top-up" : "No claim pending"}</div>
            </li>
            <li className="rounded-2xl border border-white/10 bg-white/5 p-3">
              <div className="text-xs uppercase tracking-[0.18em] text-zinc-400">Treasury reserve</div>
              <div className="mt-1">5,000 MIND safety floor</div>
            </li>
          </ul>
        </aside>
      </section>

      <section className="rounded-3xl border border-white/10 bg-slate-950/80 p-5 shadow-[0_20px_60px_rgba(0,0,0,0.25)] backdrop-blur-xl">
        <p className="text-xs uppercase tracking-[0.22em] text-zinc-400">Factory feed</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {feed.map((entry) => (
            <article key={`${entry.title}-${entry.detail}`} className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="text-sm font-semibold text-zinc-100">{entry.title}</div>
              <p className="mt-2 text-sm leading-6 text-zinc-300/80">{entry.detail}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
