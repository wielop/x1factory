"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Transaction, PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/shared/CopyButton";
import { Vial } from "@/components/shared/Vial";

const TOKEN_DECIMALS = 6;
const XNT_DECIMALS = 9;
const TRADE_URL = "/api/launchpad/trade/prepare";
const HISTORY_URL_BASE = "/api/launchpad";

// Same GigaSwap odds tables as web/app/swap/page.tsx — the formulas are copied 1:1 from
// swap_router into programs/launchpad/src/lib.rs, so the numbers are identical.
const GIGA_WIN_CHANCE: Array<[string, string]> = [
  ["$5–$15", "38%"], ["$16–$29", "40%"], ["$30–$46", "42%"],
  ["$47–$65", "44%"], ["$66–$86", "46%"], ["$87–$110", "48%"], ["$111+", "50%"],
];
const GIGA_TIER_ODDS: Array<[string, string, string, string, string]> = [
  ["1%", "60%", "35%", "20%", "10%"],
  ["2.5%", "25%", "25%", "20%", "15%"],
  ["5%", "12%", "22%", "22%", "20%"],
  ["9%", "3%", "12%", "20%", "20%"],
  ["15%", "—", "5%", "12%", "20%"],
  ["25%", "—", "1%", "6%", "15%"],
];

function gigaWinPct(usdCents: number): string {
  if (usdCents >= 11_100) return "50%";
  if (usdCents >= 8_700) return "48%";
  if (usdCents >= 6_600) return "46%";
  if (usdCents >= 4_700) return "44%";
  if (usdCents >= 3_000) return "42%";
  if (usdCents >= 1_600) return "40%";
  if (usdCents >= 500) return "38%";
  return "0%";
}

// LaunchpadGigaEvent discriminator: sha256("event:LaunchpadGigaEvent")[..8]
const GIGA_DISC = [180, 236, 8, 205, 94, 219, 255, 48];

function parseGigaEvent(b64: string): { payout: bigint; tierBps: number; paidInToken: boolean } | null {
  try {
    const buf = Buffer.from(b64, "base64");
    if (buf.length < 73) return null;
    for (let i = 0; i < 8; i++) if (buf[i] !== GIGA_DISC[i]) return null;
    const payout = buf.readBigUInt64LE(64);
    if (payout === 0n) return null;
    return { payout, tierBps: Number(buf.readBigUInt64LE(56)), paidInToken: buf[72] !== 0 };
  } catch {
    return null;
  }
}

function parseTokens(amt: string, decimals: number): bigint {
  if (!amt || Number.isNaN(Number(amt))) return 0n;
  const [whole, frac = ""] = amt.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  try {
    return BigInt(whole || "0") * BigInt(10 ** decimals) + BigInt(fracPadded || "0");
  } catch {
    return 0n;
  }
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function fmtTokens(raw: string | bigint, decimals: number, dp = 4): string {
  const n = Number(BigInt(raw)) / Math.pow(10, decimals);
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

function fmtUsd(n: number) {
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(6)}`;
}

interface Quote {
  ok: boolean;
  name?: string | null;
  symbol?: string | null;
  image?: string | null;
  xntUsdCents?: number;
  priceUsd?: number;
  fdvUsd?: number;
  progressPct?: number;
  complete?: boolean;
  realXntReserves?: string;
  virtualTokenReserves?: string;
  virtualXntReserves?: string;
  rewardPoolXntBalance?: string;
  rewardPoolTokenBalance?: string;
  gigaHits?: string;
  tradeCounter?: string;
  estimatedOut?: string;
  feeTotal?: string;
  soldOut?: boolean;
  insufficientLiquidity?: boolean;
}

function TokenTile({ image, symbol }: { image?: string | null; symbol?: string | null }) {
  const [broken, setBroken] = useState(false);
  const initial = (symbol ?? "?").slice(0, 1).toUpperCase();
  if (!image || broken) {
    return (
      <div className="w-full h-full rounded-2xl bg-gradient-to-br from-cyan-400/25 via-emerald-400/10 to-transparent border border-white/10 flex items-center justify-center">
        <span className="text-4xl font-black text-cyan-100/70">{initial}</span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={image}
      alt={symbol ?? "token"}
      onError={() => setBroken(true)}
      className="w-full h-full rounded-2xl object-cover border border-white/10"
    />
  );
}

interface PricePoint {
  t: number;
  priceUsd: number;
}

interface Candle {
  time: number; // seconds, lightweight-charts convention
  open: number;
  high: number;
  low: number;
  close: number;
}

const TIMEFRAMES = [
  { key: "5m", label: "5m", bucketMs: 5 * 60_000, sinceHours: 24 },
  { key: "15m", label: "15m", bucketMs: 15 * 60_000, sinceHours: 3 * 24 },
  { key: "1h", label: "1h", bucketMs: 60 * 60_000, sinceHours: 14 * 24 },
  { key: "4h", label: "4h", bucketMs: 4 * 60 * 60_000, sinceHours: 30 * 24 },
  { key: "1d", label: "1D", bucketMs: 24 * 60 * 60_000, sinceHours: 90 * 24 },
] as const;

/** Buckets raw (roughly 1-per-minute) price samples into OHLC candles — our sampling is
 * periodic, not per-trade, so a candle's open/close are just the first/last sample seen in
 * that window rather than the true first/last trade, but high/low/close are otherwise exact. */
function toCandles(points: PricePoint[], bucketMs: number): Candle[] {
  const buckets = new Map<number, PricePoint[]>();
  for (const p of points) {
    const bucket = Math.floor(p.t / bucketMs) * bucketMs;
    const arr = buckets.get(bucket);
    if (arr) arr.push(p);
    else buckets.set(bucket, [p]);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([bucket, pts]) => {
      const prices = pts.map((p) => p.priceUsd);
      return {
        time: Math.floor(bucket / 1000),
        open: prices[0],
        high: Math.max(...prices),
        low: Math.min(...prices),
        close: prices[prices.length - 1],
      };
    });
}

/** Real price-over-time candlestick chart (lightweight-charts), fed by scripts/
 * launchpad-keeper.ts sampling every ~60s into Postgres — actual trade-adjacent history, not
 * the theoretical bonding-curve shape. */
function PriceChart({ mint }: { mint: string }) {
  const [rawPoints, setRawPoints] = useState<PricePoint[] | null>(null);
  const [timeframe, setTimeframe] = useState<(typeof TIMEFRAMES)[number]>(TIMEFRAMES[0]);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<import("lightweight-charts").IChartApi | null>(null);
  const seriesRef = useRef<import("lightweight-charts").ISeriesApi<"Candlestick"> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${HISTORY_URL_BASE}/${mint}/history?sinceHours=${timeframe.sinceHours}`);
        const data = await res.json();
        if (!cancelled && data.ok) setRawPoints(data.points);
      } catch {
        // ignore
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [mint, timeframe]);

  const candles = rawPoints ? toCandles(rawPoints, timeframe.bucketMs) : [];

  useEffect(() => {
    if (!containerRef.current || candles.length < 2) return;
    let disposed = false;

    (async () => {
      const { createChart, CandlestickSeries, ColorType } = await import("lightweight-charts");
      if (disposed || !containerRef.current) return;

      if (!chartRef.current) {
        const chart = createChart(containerRef.current, {
          layout: {
            background: { type: ColorType.Solid, color: "transparent" },
            textColor: "rgb(148,163,184)",
            fontSize: 10,
          },
          grid: {
            vertLines: { color: "rgba(255,255,255,0.04)" },
            horzLines: { color: "rgba(255,255,255,0.04)" },
          },
          rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
          timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true },
          crosshair: { mode: 0 },
          height: 220,
        });
        chartRef.current = chart;
        seriesRef.current = chart.addSeries(CandlestickSeries, {
          upColor: "rgb(52,211,153)",
          downColor: "rgb(248,113,113)",
          borderVisible: false,
          wickUpColor: "rgb(52,211,153)",
          wickDownColor: "rgb(248,113,113)",
          priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
        });
      }
      seriesRef.current?.setData(candles as never);
      chartRef.current?.timeScale().fitContent();
    })();

    return () => {
      disposed = true;
    };
  }, [candles]);

  // Resize + teardown the chart instance when the component itself unmounts.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      chartRef.current?.applyOptions({ width: container.clientWidth });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      chartRef.current?.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  const last = candles[candles.length - 1];
  const first = candles[0];
  const changePct = first && first.open > 0 ? ((last.close - first.open) / first.open) * 100 : 0;
  const up = changePct >= 0;

  return (
    <div className="rounded-2xl border border-cyan-400/10 bg-white/[0.02] p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1 bg-black/30 rounded-lg p-0.5">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.key}
              onClick={() => setTimeframe(tf)}
              className={`px-2 py-1 rounded-md text-[10px] font-bold transition ${
                timeframe.key === tf.key ? "bg-neon text-black" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>
        {candles.length >= 2 && (
          <span className={`text-[11px] font-mono font-bold ${up ? "text-emerald-400" : "text-red-400"}`}>
            {up ? "▲" : "▼"} {Math.abs(changePct).toFixed(1)}%
          </span>
        )}
      </div>

      {rawPoints === null && (
        <div className="h-[220px] flex items-center justify-center text-xs text-zinc-600 animate-pulse">Loading…</div>
      )}
      {rawPoints !== null && candles.length < 2 && (
        <div className="h-[220px] flex flex-col items-center justify-center gap-1 text-center px-4">
          <span className="text-xs text-zinc-500">Building price history…</span>
          <span className="text-[10px] text-zinc-700">
            Sampled every ~60s once trading starts. Try a shorter timeframe or check back shortly.
          </span>
        </div>
      )}
      <div ref={containerRef} className={candles.length < 2 ? "hidden" : ""} />
    </div>
  );
}

export default function LaunchpadTokenPage() {
  const params = useParams<{ mint: string }>();
  const mint = params.mint;
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const { setVisible } = useWalletModal();

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [status, setStatus] = useState<{ type: "idle" | "loading" | "success" | "error"; msg?: string }>({
    type: "idle",
  });
  const [gigaWin, setGigaWin] = useState<{ payout: bigint; tierBps: number; paidInToken: boolean } | null>(
    null
  );
  const [xntBalance, setXntBalance] = useState<bigint>(0n);
  const [tokenBalance, setTokenBalance] = useState<bigint>(0n);
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);
  const quoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadBalances = useCallback(async () => {
    if (!publicKey || !connected) return;
    try {
      const [lamports, tokenAccs] = await Promise.all([
        connection.getBalance(publicKey),
        connection.getTokenAccountsByOwner(publicKey, { mint: new PublicKey(mint) }),
      ]);
      setXntBalance(BigInt(lamports));
      setTokenBalance(tokenAccs.value.length > 0 ? tokenAccs.value[0].account.data.readBigUInt64LE(64) : 0n);
    } catch {
      // ignore
    }
  }, [publicKey, connected, connection, mint]);

  useEffect(() => {
    loadBalances();
  }, [loadBalances]);

  const loadQuote = useCallback(async (amt: string, s: "buy" | "sell") => {
    const decimals = s === "buy" ? XNT_DECIMALS : TOKEN_DECIMALS;
    const raw = parseTokens(amt, decimals);
    setQuoteLoading(true);
    try {
      const qs = raw > 0n ? `?side=${s}&amount=${raw}` : "";
      const res = await fetch(`/api/launchpad/${mint}/quote${qs}`);
      const data = await res.json();
      setQuote(data);
    } catch {
      // ignore
    } finally {
      setQuoteLoading(false);
    }
  }, [mint]);

  useEffect(() => {
    if (quoteTimer.current) clearTimeout(quoteTimer.current);
    quoteTimer.current = setTimeout(() => loadQuote(amount, side), 400);
    return () => {
      if (quoteTimer.current) clearTimeout(quoteTimer.current);
    };
  }, [amount, side, loadQuote]);

  useEffect(() => {
    const id = setInterval(() => loadQuote(amount, side), 15000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTrade = async () => {
    if (!publicKey || !connected) {
      setVisible(true);
      return;
    }
    const decimals = side === "buy" ? XNT_DECIMALS : TOKEN_DECIMALS;
    const raw = parseTokens(amount, decimals);
    if (raw <= 0n) return;

    setStatus({ type: "loading", msg: "Preparing transaction…" });
    setGigaWin(null);
    try {
      const res = await fetch(TRADE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: publicKey.toBase58(),
          mint,
          side,
          amount: raw.toString(),
          slippageBps: 100,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Prepare failed");

      setStatus({ type: "loading", msg: "Waiting for wallet approval…" });
      const tx = Transaction.from(Buffer.from(data.transaction, "base64"));
      const sig = await sendTransaction(tx, connection, { skipPreflight: false });

      setStatus({ type: "loading", msg: "Confirming…" });
      for (let i = 0; i < 40; i++) {
        const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        const val = st?.value;
        if (val?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(val.err)}`);
        if (val?.confirmationStatus === "confirmed" || val?.confirmationStatus === "finalized") break;
        if (i === 39) throw new Error("Confirmation timeout — check explorer for tx status.");
        await new Promise((r) => setTimeout(r, 1500));
      }

      const outDecimals = side === "buy" ? TOKEN_DECIMALS : XNT_DECIMALS;
      const outSymbol = side === "buy" ? "tokens" : "XNT";
      setStatus({
        type: "success",
        msg: `${side === "buy" ? "Bought" : "Sold"}! ~${fmtTokens(data.estimatedOut, outDecimals)} ${outSymbol}.`,
      });
      setAmount("");
      setTimeout(() => {
        loadQuote("", side);
        loadBalances();
      }, 2000);

      try {
        const txInfo = await connection.getTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        for (const log of txInfo?.meta?.logMessages ?? []) {
          const m = log.match(/^Program data: (.+)$/);
          if (m) {
            const win = parseGigaEvent(m[1]);
            if (win) {
              setGigaWin(win);
              break;
            }
          }
        }
      } catch {
        // ignore
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Trade failed";
      setStatus({ type: "error", msg: msg.includes("rejected") ? "Transaction rejected by wallet." : msg });
    }
  };

  const setPercent = (pct: number) => {
    const balance = side === "buy" ? xntBalance : tokenBalance;
    if (balance <= 0n) return;
    let amt = (balance * BigInt(pct)) / 100n;
    if (side === "buy" && pct === 100) {
      const gas = BigInt(2_000_000); // leave ~0.002 XNT for fees
      amt = amt > gas ? amt - gas : 0n;
    }
    const decimals = side === "buy" ? XNT_DECIMALS : TOKEN_DECIMALS;
    const n = Number(amt) / Math.pow(10, decimals);
    setAmount(n.toFixed(decimals).replace(/\.?0+$/, "") || "0");
  };

  const canTrade =
    connected &&
    parseTokens(amount, side === "buy" ? XNT_DECIMALS : TOKEN_DECIMALS) > 0n &&
    status.type !== "loading" &&
    !quoteLoading &&
    !quote?.complete;

  // Rate: tokens per 1 XNT, derived from the curve's own virtual reserves (no external oracle).
  const rateTokensPerXnt = (() => {
    if (!quote?.virtualTokenReserves || !quote?.virtualXntReserves) return null;
    const vt = Number(quote.virtualTokenReserves) / 10 ** TOKEN_DECIMALS;
    const vx = Number(quote.virtualXntReserves) / 10 ** XNT_DECIMALS;
    return vx > 0 ? vt / vx : null;
  })();

  const inputAmountRaw = parseTokens(amount, side === "buy" ? XNT_DECIMALS : TOKEN_DECIMALS);
  const usdValue = (() => {
    if (inputAmountRaw <= 0n || !quote?.priceUsd || quote.xntUsdCents === undefined) return null;
    const xntUsd = quote.xntUsdCents / 100;
    if (side === "buy") return (Number(inputAmountRaw) / 10 ** XNT_DECIMALS) * xntUsd;
    return (Number(inputAmountRaw) / 10 ** TOKEN_DECIMALS) * quote.priceUsd;
  })();
  const gigaQualifies = usdValue !== null && usdValue >= 5;

  // Dominant-pool GigaSwap prize estimate — mirrors try_giga_swap()'s dominant-pool check.
  const gigaPrize = (() => {
    if (!quote?.rewardPoolTokenBalance || !quote?.rewardPoolXntBalance || !quote?.virtualTokenReserves || !quote?.virtualXntReserves) {
      return null;
    }
    const rewardToken = BigInt(quote.rewardPoolTokenBalance);
    const rewardXnt = BigInt(quote.rewardPoolXntBalance);
    const vt = BigInt(quote.virtualTokenReserves);
    const vx = BigInt(quote.virtualXntReserves);
    const tokenPoolXntEquiv = vt > 0n ? (rewardToken * vx) / vt : 0n;
    const dominantIsToken = tokenPoolXntEquiv > rewardXnt;
    const dominantBal = dominantIsToken ? rewardToken : rewardXnt;
    if (dominantBal === 0n) return null;
    const minWin = (dominantBal * 100n) / 10_000n;
    const maxWin = (dominantBal * 2500n) / 10_000n;
    const decimals = dominantIsToken ? TOKEN_DECIMALS : XNT_DECIMALS;
    const symbol = dominantIsToken ? quote.symbol ?? "tokens" : "XNT";
    const xntUsd = (quote.xntUsdCents ?? 0) / 100;
    const toUsd = (amt: bigint) => {
      const n = Number(amt) / 10 ** decimals;
      if (dominantIsToken) return n * (quote.priceUsd ?? 0);
      return n * xntUsd;
    };
    return { minWin, maxWin, decimals, symbol, minUsd: toUsd(minWin), maxUsd: toUsd(maxWin) };
  })();

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
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <span className="text-[11px] font-mono font-bold text-neon tracking-widest">LAUNCHPAD</span>
          <Link href="/launchpad" className="text-[11px] text-zinc-500 hover:text-zinc-300 transition">
            ← All tokens
          </Link>
        </div>
      </div>

      <div className="relative max-w-4xl mx-auto px-4 py-6 grid grid-cols-1 md:grid-cols-[1fr_360px] gap-6 items-start">
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="w-24 h-24 flex-shrink-0">
              <TokenTile image={quote?.image} symbol={quote?.symbol} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-extrabold truncate">{quote?.name ?? shortAddr(mint)}</h1>
                {quote?.complete && <Badge variant="success">🎓 graduated</Badge>}
              </div>
              <div className="flex items-center gap-1.5 text-xs text-zinc-500 mt-1">
                {quote?.symbol && <span className="font-mono text-sm text-cyan-200/80">${quote.symbol}</span>}
                <span className="font-mono">{shortAddr(mint)}</span>
                <CopyButton text={mint} label="Copy" />
              </div>
            </div>
          </div>

          <div className="flex items-stretch gap-3">
            <div className="grid grid-cols-3 gap-2 flex-1">
              <div className="rounded-2xl border border-cyan-400/10 bg-white/[0.02] p-3">
                <div className="text-[9px] uppercase text-zinc-500 mb-1">Price</div>
                <div className="text-sm font-mono font-bold">{quote?.priceUsd !== undefined ? fmtUsd(quote.priceUsd) : "—"}</div>
              </div>
              <div className="rounded-2xl border border-cyan-400/10 bg-white/[0.02] p-3">
                <div className="text-[9px] uppercase text-zinc-500 mb-1">Market Cap</div>
                <div className="text-sm font-mono font-bold">{quote?.fdvUsd !== undefined ? fmtUsd(quote.fdvUsd) : "—"}</div>
              </div>
              <div className="rounded-2xl border border-cyan-400/10 bg-white/[0.02] p-3">
                <div className="text-[9px] uppercase text-zinc-500 mb-1">Giga Hits</div>
                <div className="text-sm font-mono font-bold text-neon">⚡{quote?.gigaHits ?? "—"}</div>
              </div>
            </div>
            {quote?.progressPct !== undefined && (
              <div className="rounded-2xl border border-cyan-400/10 bg-white/[0.02] px-3 py-2 flex-shrink-0">
                <Vial
                  pct={quote.progressPct}
                  hot={!quote.complete && quote.progressPct > 90}
                  label={quote.complete ? "🎓" : `${quote.progressPct.toFixed(quote.progressPct < 1 ? 3 : 0)}%`}
                  sublabel={quote.complete ? "graduated" : "sold"}
                />
              </div>
            )}
          </div>

          <PriceChart mint={mint} />

          {quote?.complete && (
            <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.04] p-3 text-xs text-emerald-200/80 text-center">
              🎓 Ta krzywa zgraduowała — token handluje się teraz na xdex.
            </div>
          )}

          {gigaWin && (
            <div className="bg-neon/10 border border-neon/40 rounded-2xl p-6 text-center">
              <div className="text-xs uppercase tracking-widest text-neon mb-2">GigaSwap Jackpot!</div>
              <div className="text-2xl font-bold font-mono text-neon">
                +{gigaWin.paidInToken
                  ? fmtTokens(gigaWin.payout, TOKEN_DECIMALS)
                  : fmtTokens(gigaWin.payout, XNT_DECIMALS)}{" "}
                {gigaWin.paidInToken ? "tokens" : "XNT"}
              </div>
              <div className="text-[11px] text-zinc-500 mt-1">tier: {(gigaWin.tierBps / 100).toString()}% of pool</div>
            </div>
          )}

          {/* How it works */}
          <div>
            <button
              onClick={() => setHowItWorksOpen((o) => !o)}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-neon/5 border border-neon/20 hover:bg-neon/10 hover:border-neon/40 transition text-sm font-bold text-neon tracking-widest"
            >
              <span>⚡ HOW IT WORKS</span>
              <span
                className="text-neon/60 text-xs transition-transform duration-200"
                style={{ display: "inline-block", transform: howItWorksOpen ? "rotate(180deg)" : "rotate(0deg)" }}
              >
                ▼
              </span>
            </button>

            {howItWorksOpen && (
              <div className="mt-2 bg-[#0d1117] border border-neon/20 rounded-2xl p-5 space-y-5 text-sm">
                <div>
                  <div className="text-neon font-bold mb-2 text-xs uppercase tracking-widest">What is this?</div>
                  <p className="text-zinc-400 text-xs leading-relaxed">
                    A fixed-supply memecoin (1,000,000,000 tokens) trading on a bonding curve from
                    the second it's created — no presale, no waiting. Price is set purely by the
                    curve's formula (constant product, same shape pump.fun uses): the more people
                    buy, the higher the next price. Every launchpad token also has its own{" "}
                    <span className="text-neon font-semibold">GigaSwap</span> jackpot pool, seeded
                    with 10% of supply plus a share of every trade's fee.
                  </p>
                </div>

                <div>
                  <div className="text-neon font-bold mb-2 text-xs uppercase tracking-widest">Supply breakdown</div>
                  <div className="space-y-1.5 text-xs text-zinc-500">
                    <div className="flex justify-between"><span className="text-zinc-400">Bonding curve (buy/sell)</span><span className="font-mono text-zinc-300">80%</span></div>
                    <div className="flex justify-between"><span className="text-zinc-400">GigaSwap reward pool</span><span className="font-mono text-zinc-300">1%</span></div>
                    <div className="flex justify-between"><span className="text-zinc-400">Graduation reserve (→ xdex pool)</span><span className="font-mono text-zinc-300">14%</span></div>
                    <div className="flex justify-between"><span className="text-zinc-400">Creator allocation</span><span className="font-mono text-zinc-300">5%</span></div>
                  </div>
                </div>

                <div>
                  <div className="text-neon font-bold mb-2 text-xs uppercase tracking-widest">Graduation</div>
                  <p className="text-zinc-400 text-xs leading-relaxed">
                    Once the curve is fully sold, it migrates automatically to a real, permanent
                    pool on xdex — the raised XNT and the 5% reserve become real liquidity, and
                    the LP tokens are burned immediately. Nobody, including us, can ever withdraw
                    that liquidity.
                  </p>
                </div>

                <div>
                  <div className="text-neon font-bold mb-2 text-xs uppercase tracking-widest">⚡ GigaSwap — win rewards</div>
                  <div className="space-y-3 text-xs text-zinc-400">
                    <p className="leading-relaxed">
                      Every buy or sell worth <span className="text-neon font-semibold">$5 or more</span> automatically
                      enters GigaSwap. A provably fair on-chain random roll decides if you win —
                      no extra action needed.
                    </p>
                    <div>
                      <div className="text-zinc-300 font-semibold mb-1.5">Win chance by trade value:</div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
                        {GIGA_WIN_CHANCE.map(([r, p]) => (
                          <div key={r} className="flex justify-between gap-2">
                            <span className="text-zinc-500">{r}</span>
                            <span className="text-neon">{p}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-300 font-semibold mb-1.5">Pool reward tiers — odds by trade size:</div>
                      <div className="overflow-x-auto rounded-lg border border-zinc-800">
                        <table className="w-full text-[10px]">
                          <thead>
                            <tr className="text-zinc-500 border-b border-zinc-800 bg-zinc-900/60">
                              <th className="text-left py-1.5 px-2">Tier</th>
                              <th className="text-right py-1.5 px-2">$5–$29</th>
                              <th className="text-right py-1.5 px-2">$30–$99</th>
                              <th className="text-right py-1.5 px-2">$100–$299</th>
                              <th className="text-right py-1.5 px-2">$300+</th>
                            </tr>
                          </thead>
                          <tbody>
                            {GIGA_TIER_ODDS.map(([tier, ...odds]) => (
                              <tr key={tier} className="border-b border-zinc-800/40 last:border-0">
                                <td className="py-1.5 px-2 font-mono font-bold text-neon">{tier}</td>
                                {odds.map((o, i) => (
                                  <td key={i} className={`text-right py-1.5 px-2 ${o === "—" ? "text-zinc-700" : "text-zinc-400"}`}>{o}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <p className="text-zinc-500 leading-relaxed">
                      Prize pays out from whichever side of the pool (tokens or XNT) is worth more
                      in USD right now — shown live in the panel on the right whenever your trade
                      qualifies.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="rounded-3xl border border-cyan-400/10 bg-white/[0.02] p-4 md:sticky md:top-20 space-y-3">
          <div className="flex gap-1 bg-black/30 rounded-xl p-1">
            <button
              onClick={() => { setSide("buy"); setAmount(""); }}
              className={`flex-1 py-2 rounded-lg text-sm font-bold transition ${side === "buy" ? "bg-neon text-black" : "text-zinc-400 hover:text-zinc-200"}`}
            >
              Buy
            </button>
            <button
              onClick={() => { setSide("sell"); setAmount(""); }}
              className={`flex-1 py-2 rounded-lg text-sm font-bold transition ${side === "sell" ? "bg-neon text-black" : "text-zinc-400 hover:text-zinc-200"}`}
            >
              Sell
            </button>
          </div>

          {/* You Pay */}
          <div className="bg-black/20 border border-white/5 rounded-2xl p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase tracking-widest text-zinc-500">You Pay</span>
              {connected && (
                <span className="text-[10px] text-zinc-500">
                  Balance: <span className="text-zinc-300">
                    {side === "buy" ? fmtTokens(xntBalance, XNT_DECIMALS, 4) : fmtTokens(tokenBalance, TOKEN_DECIMALS, 4)}
                  </span>
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="0.0"
                className="flex-1 min-w-0 bg-transparent text-2xl font-mono font-bold outline-none placeholder:text-zinc-700"
              />
              <span className="flex-shrink-0 text-xs font-bold text-zinc-400 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5">
                {side === "buy" ? "XNT" : `$${quote?.symbol ?? "TOKEN"}`}
              </span>
            </div>
            <div className="mt-1 text-[10px] text-zinc-600">{usdValue !== null ? `≈ $${usdValue.toFixed(2)}` : "—"}</div>
            {connected && (
              <div className="grid grid-cols-4 gap-1.5 mt-2">
                {[25, 50, 75, 100].map((p) => (
                  <button
                    key={p}
                    onClick={() => setPercent(p)}
                    className="py-1 rounded-lg text-[10px] font-bold border border-white/10 text-zinc-400 hover:border-neon/40 hover:text-neon transition"
                  >
                    {p === 100 ? "MAX" : `${p}%`}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* You Receive */}
          <div className="bg-black/20 border border-white/5 rounded-2xl p-3">
            <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2">You Receive</div>
            <div className="flex items-center gap-2">
              <span className={`flex-1 min-w-0 text-2xl font-mono font-bold truncate ${quoteLoading ? "text-zinc-600 animate-pulse" : "text-zinc-100"}`}>
                {quoteLoading ? "…" : quote?.estimatedOut ? fmtTokens(quote.estimatedOut, side === "buy" ? TOKEN_DECIMALS : XNT_DECIMALS) : "0.00"}
              </span>
              <span className="flex-shrink-0 text-xs font-bold text-zinc-400 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5">
                {side === "buy" ? `$${quote?.symbol ?? "TOKEN"}` : "XNT"}
              </span>
            </div>
          </div>

          {(quote?.soldOut || quote?.insufficientLiquidity) && (
            <div className="text-xs text-red-400">
              {quote.soldOut ? "Not enough tokens left on the curve." : "Not enough XNT liquidity on the curve."}
            </div>
          )}

          {/* Rate / Fee / Gas */}
          <div className="rounded-2xl border border-cyan-400/10 bg-white/[0.02] overflow-hidden">
            <div className="grid grid-cols-3 divide-x divide-white/5">
              <div className="px-2 py-2.5 text-center">
                <div className="text-[9px] text-zinc-500 mb-1 uppercase tracking-wider">Rate</div>
                <div className="text-[10px] font-bold text-zinc-300">
                  {rateTokensPerXnt !== null ? `${rateTokensPerXnt.toLocaleString("en-US", { maximumFractionDigits: 0 })}/XNT` : "—"}
                </div>
              </div>
              <div className="px-2 py-2.5 text-center">
                <div className="text-[9px] text-zinc-500 mb-1 uppercase tracking-wider">Fee</div>
                <div className="text-[10px] font-bold text-zinc-300">1.0%</div>
              </div>
              <div className="px-2 py-2.5 text-center">
                <div className="text-[9px] text-zinc-500 mb-1 uppercase tracking-wider">Est. Gas</div>
                <div className="text-[10px] font-bold text-zinc-300">~0.0002 XNT</div>
              </div>
            </div>
          </div>

          {/* GigaSwap indicator */}
          <div className={`rounded-2xl px-3 py-3 transition-all duration-500 ${
            gigaQualifies
              ? "bg-neon/10 border border-neon/40 shadow-[0_0_20px_rgba(34,242,255,0.15)]"
              : "bg-black/20 border border-white/5"
          }`}>
            <div className="flex items-center justify-between">
              <span className={`text-sm font-black tracking-widest ${gigaQualifies ? "text-neon animate-pulse" : "text-zinc-600"}`}>
                ⚡ GIGA
              </span>
              <div className="text-right">
                {gigaQualifies ? (
                  <div className="text-xs font-bold text-neon">{gigaWinPct((usdValue ?? 0) * 100)} win chance!</div>
                ) : (
                  <div className="text-[10px] text-zinc-600">{usdValue !== null ? `$${usdValue.toFixed(2)} — need ≥ $5` : "Enter amount"}</div>
                )}
              </div>
            </div>
            {gigaQualifies && gigaPrize && (
              <div className="mt-2 pt-2 border-t border-neon/20 flex items-stretch gap-2">
                <div className="flex-1 bg-neon/5 border border-neon/20 rounded-xl px-2 py-1.5 text-center">
                  <div className="text-[8px] text-neon/40 uppercase tracking-wider">Min win</div>
                  <div className="text-xs font-bold text-neon/80">{fmtTokens(gigaPrize.minWin, gigaPrize.decimals, 2)} {gigaPrize.symbol}</div>
                  <div className="text-[8px] text-neon/40">≈ ${gigaPrize.minUsd.toFixed(2)}</div>
                </div>
                <div className="flex-1 bg-neon/10 border border-neon/40 rounded-xl px-2 py-1.5 text-center">
                  <div className="text-[8px] text-neon/60 uppercase tracking-wider">🎰 Jackpot</div>
                  <div className="text-xs font-bold text-neon">{fmtTokens(gigaPrize.maxWin, gigaPrize.decimals, 2)} {gigaPrize.symbol}</div>
                  <div className="text-[8px] text-neon/60">≈ ${gigaPrize.maxUsd.toFixed(2)}</div>
                </div>
              </div>
            )}
          </div>

          <Button
            onClick={handleTrade}
            disabled={!canTrade && connected}
            size="lg"
            className="w-full"
          >
            {!connected ? "Connect Wallet" : status.type === "loading" ? status.msg : side === "buy" ? "Buy" : "Sell"}
          </Button>

          {status.type === "success" && <div className="text-xs text-neon">{status.msg}</div>}
          {status.type === "error" && <div className="text-xs text-red-400">{status.msg}</div>}
        </div>
      </div>
    </div>
  );
}
