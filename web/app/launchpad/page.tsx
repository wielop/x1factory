"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

interface LaunchpadToken {
  curve: string;
  mint: string;
  creator: string;
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

export default function LaunchpadPage() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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

  const tokens = data?.tokens ?? [];
  const xntBase = data?.xntBase ?? 1_000_000_000;
  const totalGigaHits = tokens.reduce((sum, t) => sum + Number(t.gigaHits), 0);
  const totalTrades = tokens.reduce((sum, t) => sum + Number(t.tradeCounter), 0);

  return (
    <div className="min-h-screen bg-[#07090e] text-zinc-100 font-sans">
      <div className="sticky top-0 z-10 backdrop-blur bg-[#07090e]/90 border-b border-zinc-900">
        <div className="max-w-4xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono font-bold text-neon">LAUNCHPAD</span>
            <span className="text-zinc-700 text-[10px]">·</span>
            <span className="text-[11px] text-zinc-600">bonding curve + GigaSwap</span>
          </div>
          <Link href="/" className="text-[11px] text-zinc-600 hover:text-zinc-400 transition flex-shrink-0">
            ← X1Factory
          </Link>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <h1 className="text-2xl font-bold tracking-tight lowercase">launchpad</h1>
          <Link
            href="/launchpad/create"
            className="text-xs font-bold uppercase tracking-wide px-4 py-2 rounded-lg bg-neon text-black hover:bg-neon/90 transition"
          >
            Create Token
          </Link>
        </div>

        <p className="text-sm text-zinc-500 mb-6">
          Stwórz własny memecoin na X1 — tokeny handlują się od razu na bonding curve, a każdy
          większy trade ma szansę trafić jackpot GigaSwap wypłacany z puli tego tokena.
        </p>

        <div className="grid grid-cols-3 gap-3 mb-6">
          <div className="bg-[#0d1117] border border-zinc-800 rounded-2xl p-4">
            <div className="text-[10px] uppercase tracking-widest text-zinc-600 mb-1">Tokens</div>
            <div className="text-xl font-bold font-mono">{tokens.length}</div>
          </div>
          <div className="bg-[#0d1117] border border-zinc-800 rounded-2xl p-4">
            <div className="text-[10px] uppercase tracking-widest text-zinc-600 mb-1">Trades</div>
            <div className="text-xl font-bold font-mono">{totalTrades}</div>
          </div>
          <div className="bg-[#0d1117] border border-zinc-800 rounded-2xl p-4">
            <div className="text-[10px] uppercase tracking-widest text-zinc-600 mb-1">
              Giga Hits
            </div>
            <div className="text-xl font-bold font-mono text-neon">{totalGigaHits}</div>
          </div>
        </div>

        {loading && <div className="text-sm text-zinc-600 animate-pulse">Loading tokens…</div>}

        {errorMsg && (
          <div className="bg-red-950/40 border border-red-900 text-red-300 text-sm rounded-xl p-4">
            Failed to load: {errorMsg}
          </div>
        )}

        {!loading && !errorMsg && tokens.length === 0 && (
          <div className="bg-[#0d1117] border border-zinc-800 rounded-2xl p-8 text-center text-zinc-500 text-sm">
            Żaden token nie został jeszcze utworzony na launchpadzie.
          </div>
        )}

        <div className="space-y-2">
          {tokens.map((t) => (
            <Link
              key={t.mint}
              href={`/launchpad/${t.mint}`}
              className="block bg-[#0d1117] border border-zinc-800 rounded-2xl p-4 hover:border-zinc-700 transition"
            >
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-sm font-bold text-zinc-100 truncate">
                    {shortAddr(t.mint)}
                  </span>
                  {t.complete && (
                    <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-neon/10 text-neon">
                      graduated
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-zinc-600 flex-shrink-0">
                  {fmtAgo(t.createdAt)}
                </span>
              </div>

              <div className="grid grid-cols-4 gap-2 text-center mb-3">
                <div>
                  <div className="text-[9px] uppercase text-zinc-600">Price</div>
                  <div className="text-xs font-mono font-bold">{fmtUsd(t.priceUsd)}</div>
                </div>
                <div>
                  <div className="text-[9px] uppercase text-zinc-600">FDV</div>
                  <div className="text-xs font-mono font-bold">{fmtUsd(t.fdvUsd)}</div>
                </div>
                <div>
                  <div className="text-[9px] uppercase text-zinc-600">Raised</div>
                  <div className="text-xs font-mono font-bold">
                    {fmtXnt(t.realXntReserves, xntBase)} XNT
                  </div>
                </div>
                <div>
                  <div className="text-[9px] uppercase text-zinc-600">Giga Hits</div>
                  <div className="text-xs font-mono font-bold text-neon">{t.gigaHits}</div>
                </div>
              </div>

              <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden mb-1">
                <div
                  className="h-full bg-neon transition-all"
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
