"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface LaunchpadToken {
  curve: string;
  mint: string;
  creator: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  realXntReserves: string;
  rewardPoolXntBalance: string;
  rewardPoolTokenBalance: string;
  tradeCounter: string;
  gigaHits: string;
  complete: boolean;
  createdAt: number;
  priceUsd: number;
  fdvUsd: number;
  progressPct: number;
}

interface ListResponse {
  ok: boolean;
  error?: string;
  xntUsdCents?: number;
  totalSupplyDisplay?: number;
  curveAllocationDisplay?: number;
  xntBase?: number;
  tokens?: LaunchpadToken[];
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function fmtUsd(n: number) {
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(6)}`;
}

function fmtXnt(raw: string, xntBase: number) {
  const n = Number(BigInt(raw)) / xntBase;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtAgo(ts: number) {
  if (!ts) return "—";
  const diffMs = Date.now() - ts * 1000;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function TokenAvatar({ image, symbol, size = 44 }: { image: string | null; symbol: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const initial = (symbol ?? "?").slice(0, 1).toUpperCase();
  if (!image || broken) {
    return (
      <div
        className="flex-shrink-0 rounded-full bg-gradient-to-br from-cyan-400/30 to-emerald-400/20 border border-cyan-400/20 flex items-center justify-center font-bold text-cyan-100"
        style={{ width: size, height: size, fontSize: size * 0.4 }}
      >
        {initial}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={image}
      alt={symbol ?? "token"}
      onError={() => setBroken(true)}
      className="flex-shrink-0 rounded-full object-cover border border-cyan-400/20"
      style={{ width: size, height: size }}
    />
  );
}

export default function LaunchpadPage() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sort, setSort] = useState<"new" | "mcap" | "progress">("new");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/launchpad/list", { cache: "no-store" });
      const json: ListResponse = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Unknown error");
      setData(json);
      setErrorMsg(null);
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  const xntBase = data?.xntBase ?? 1_000_000_000;
  const tokens = [...(data?.tokens ?? [])].sort((a, b) => {
    if (sort === "mcap") return b.fdvUsd - a.fdvUsd;
    if (sort === "progress") return b.progressPct - a.progressPct;
    return b.createdAt - a.createdAt;
  });
  const totalGigaHits = tokens.reduce((sum, t) => sum + Number(t.gigaHits), 0);
  const totalTrades = tokens.reduce((sum, t) => sum + Number(t.tradeCounter), 0);
  const king = [...tokens].sort((a, b) => b.fdvUsd - a.fdvUsd)[0];

  return (
    <div className="min-h-screen bg-[#050810] text-zinc-100 font-sans">
      <div
        className="pointer-events-none fixed inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(ellipse 90% 50% at 50% -10%, rgba(34,242,255,0.10) 0%, transparent 60%)",
        }}
      />
      <div className="sticky top-0 z-10 backdrop-blur-xl bg-[#050810]/85 border-b border-cyan-400/10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono font-bold text-neon tracking-widest">
              LAUNCHPAD
            </span>
            <span className="text-zinc-700 text-[10px]">·</span>
            <span className="text-[11px] text-zinc-500">bonding curve + GigaSwap jackpot</span>
          </div>
          <Link
            href="/"
            className="text-[11px] text-zinc-500 hover:text-zinc-300 transition flex-shrink-0"
          >
            ← X1Factory
          </Link>
        </div>
      </div>

      <div className="relative max-w-5xl mx-auto px-4 py-8">
        <div className="flex items-start justify-between mb-2 flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-cyan-200 bg-clip-text text-transparent">
              Launchpad
            </h1>
            <p className="text-sm text-zinc-500 mt-1.5 max-w-md">
              Stwórz własny memecoin — handel startuje natychmiast, a każdy większy trade ma
              szansę na jackpot GigaSwap z puli tego tokena.
            </p>
          </div>
          <Link href="/launchpad/create">
            <Button size="lg" className="whitespace-nowrap">
              + Create Token
            </Button>
          </Link>
        </div>

        <div className="grid grid-cols-3 gap-3 my-6">
          <div className="rounded-2xl border border-cyan-400/10 bg-white/[0.02] p-4">
            <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">Tokens</div>
            <div className="text-xl font-bold font-mono">{tokens.length}</div>
          </div>
          <div className="rounded-2xl border border-cyan-400/10 bg-white/[0.02] p-4">
            <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">Trades</div>
            <div className="text-xl font-bold font-mono">{totalTrades}</div>
          </div>
          <div className="rounded-2xl border border-cyan-400/10 bg-white/[0.02] p-4">
            <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">
              Giga Hits
            </div>
            <div className="text-xl font-bold font-mono text-neon">{totalGigaHits}</div>
          </div>
        </div>

        {king && !loading && (
          <Link href={`/launchpad/${king.mint}`} className="block mb-6 group">
            <div className="relative overflow-hidden rounded-3xl border border-amber-400/25 bg-gradient-to-br from-amber-400/[0.06] via-white/[0.02] to-transparent p-4 transition hover:border-amber-300/40">
              <div className="flex items-center gap-3">
                <TokenAvatar image={king.image} symbol={king.symbol} size={52} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="warning">👑 king of the hill</Badge>
                  </div>
                  <div className="mt-1 flex items-baseline gap-2 min-w-0">
                    <span className="font-bold text-zinc-100 truncate">
                      {king.name ?? shortAddr(king.mint)}
                    </span>
                    {king.symbol && (
                      <span className="text-xs text-zinc-500 font-mono flex-shrink-0">
                        ${king.symbol}
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-[10px] uppercase text-zinc-500">Market Cap</div>
                  <div className="font-mono font-bold text-amber-200">{fmtUsd(king.fdvUsd)}</div>
                </div>
              </div>
            </div>
          </Link>
        )}

        <div className="flex items-center gap-1 mb-4 bg-white/[0.02] border border-white/5 rounded-xl p-1 w-fit">
          {([
            ["new", "New"],
            ["mcap", "Market Cap"],
            ["progress", "Bonding %"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSort(key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                sort === key ? "bg-neon text-black" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {loading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-[132px] rounded-2xl border border-white/5 bg-white/[0.02] animate-pulse" />
            ))}
          </div>
        )}

        {errorMsg && (
          <div className="bg-red-950/40 border border-red-900 text-red-300 text-sm rounded-xl p-4">
            Failed to load: {errorMsg}
          </div>
        )}

        {!loading && !errorMsg && tokens.length === 0 && (
          <div className="border border-dashed border-white/10 rounded-2xl p-10 text-center">
            <div className="text-3xl mb-2">🚀</div>
            <div className="text-sm text-zinc-400 mb-4">
              Żaden token nie został jeszcze utworzony na launchpadzie.
            </div>
            <Link href="/launchpad/create">
              <Button>Bądź pierwszy — stwórz token</Button>
            </Link>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {tokens.map((t) => (
            <Link
              key={t.mint}
              href={`/launchpad/${t.mint}`}
              className="group block rounded-2xl border border-white/5 bg-white/[0.02] p-4 transition hover:border-cyan-300/30 hover:bg-white/[0.04] hover:shadow-[0_0_24px_rgba(34,242,255,0.10)]"
            >
              <div className="flex items-center gap-3 mb-3">
                <TokenAvatar image={t.image} symbol={t.symbol} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-sm text-zinc-100 truncate">
                      {t.name ?? shortAddr(t.mint)}
                    </span>
                    {t.complete && <Badge variant="success">graduated</Badge>}
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                    {t.symbol && <span className="font-mono">${t.symbol}</span>}
                    <span>·</span>
                    <span>{fmtAgo(t.createdAt)}</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-2 text-center mb-3">
                <div>
                  <div className="text-[9px] uppercase text-zinc-600">Price</div>
                  <div className="text-xs font-mono font-bold">{fmtUsd(t.priceUsd)}</div>
                </div>
                <div>
                  <div className="text-[9px] uppercase text-zinc-600">MCap</div>
                  <div className="text-xs font-mono font-bold">{fmtUsd(t.fdvUsd)}</div>
                </div>
                <div>
                  <div className="text-[9px] uppercase text-zinc-600">Raised</div>
                  <div className="text-xs font-mono font-bold">
                    {fmtXnt(t.realXntReserves, xntBase)}
                  </div>
                </div>
                <div>
                  <div className="text-[9px] uppercase text-zinc-600">Giga</div>
                  <div className="text-xs font-mono font-bold text-neon">{t.gigaHits}</div>
                </div>
              </div>

              <div className="h-1.5 rounded-full bg-white/5 overflow-hidden mb-1">
                <div
                  className="h-full bg-gradient-to-r from-cyan-400 to-emerald-300 transition-all"
                  style={{ width: `${t.progressPct.toFixed(1)}%` }}
                />
              </div>
              <div className="text-[10px] text-zinc-600 text-right">
                {t.progressPct.toFixed(1)}% sold on curve
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
