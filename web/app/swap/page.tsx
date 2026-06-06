"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Transaction, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import Link from "next/link";

const MIND_DECIMALS = 9;
const XNT_DECIMALS = 9;
const SWAP_URL = "/api/swap/prepare";
const QUOTE_URL = "/api/panel/swap/quote";
const MIND_MINT = new PublicKey("DohWBfvXER6qs8zFGtdZRDpgbHmm97ZZwgCUTCdtHQNT");

type Direction = "xnt_to_mind" | "mind_to_xnt";

interface Quote {
  estimatedOut: string;
  ourFee: string;
  priceImpactBps: number;
  poolXnt: string;
  poolMind: string;
  mindPerXnt?: string;
  gigaQualified?: boolean;
  usdCents?: string;
  xntUsdCents?: string;
  rewardPoolMind?: string;
  rewardPoolXnt?: string;
  rewardPoolUsdCents?: string;
  swapCounter?: string;
  gigaHits?: string;
}

function fmtTokens(raw: string | bigint, decimals: number, dp = 4): string {
  const n = Number(BigInt(raw)) / Math.pow(10, decimals);
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

function fmtShort(raw: bigint, decimals: number): string {
  const n = Number(raw) / Math.pow(10, decimals);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(2);
}

function parseTokens(input: string, decimals: number): bigint {
  const trimmed = input.trim().replace(/,/g, "");
  if (!trimmed || isNaN(Number(trimmed))) return 0n;
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = frac.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole || "0") * BigInt(10 ** decimals) + BigInt(fracPadded);
}

function shortAddr(addr: string) {
  return addr.slice(0, 4) + "..." + addr.slice(-4);
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={spinning ? "animate-spin" : ""}>
      <polyline points="23 4 23 10 17 10"/>
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  );
}

export default function SwapPage() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected, connecting } = useWallet();
  const { setVisible } = useWalletModal();

  const [direction, setDirection] = useState<Direction>("xnt_to_mind");
  const [amountIn, setAmountIn] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [status, setStatus] = useState<{ type: "idle" | "loading" | "success" | "error"; msg?: string }>({ type: "idle" });
  const [xntBalance, setXntBalance] = useState<bigint>(0n);
  const [mindBalance, setMindBalance] = useState<bigint>(0n);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [slippage, setSlippage] = useState(0.5);
  const [showSettings, setShowSettings] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const quoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const inDecimals = direction === "xnt_to_mind" ? XNT_DECIMALS : MIND_DECIMALS;
  const outDecimals = direction === "xnt_to_mind" ? MIND_DECIMALS : XNT_DECIMALS;
  const inSymbol = direction === "xnt_to_mind" ? "XNT" : "MIND";
  const outSymbol = direction === "xnt_to_mind" ? "MIND" : "XNT";
  const inBalance = direction === "xnt_to_mind" ? xntBalance : mindBalance;
  const outBalance = direction === "xnt_to_mind" ? mindBalance : xntBalance;

  const loadBalances = useCallback(async () => {
    if (!publicKey || !connected) return;
    setBalancesLoading(true);
    try {
      const [lamports, tokenAccs] = await Promise.all([
        connection.getBalance(publicKey),
        connection.getTokenAccountsByOwner(publicKey, { mint: MIND_MINT }),
      ]);
      setXntBalance(BigInt(lamports));
      if (tokenAccs.value.length > 0) {
        const data = tokenAccs.value[0].account.data;
        const amount = data.readBigUInt64LE(64);
        setMindBalance(amount);
      } else {
        setMindBalance(0n);
      }
    } catch {
      // ignore
    } finally {
      setBalancesLoading(false);
    }
  }, [publicKey, connected, connection]);

  useEffect(() => { loadBalances(); }, [loadBalances]);

  const loadQuote = useCallback(async (amt: string, dir: Direction) => {
    const decimals = dir === "xnt_to_mind" ? XNT_DECIMALS : MIND_DECIMALS;
    const raw = parseTokens(amt, decimals);
    if (raw <= 0n) { setQuote(null); return; }
    setQuoteLoading(true);
    try {
      const apiDir = dir === "xnt_to_mind" ? "xnt_to_mind" : "mind_to_xnt";
      const res = await fetch(`${QUOTE_URL}?amountIn=${raw}&direction=${apiDir}`);
      const data = await res.json();
      if (data.ok) setQuote(data);
    } catch {
      // ignore
    } finally {
      setQuoteLoading(false);
    }
  }, []);

  useEffect(() => {
    if (quoteTimer.current) clearTimeout(quoteTimer.current);
    quoteTimer.current = setTimeout(() => loadQuote(amountIn, direction), 400);
    return () => { if (quoteTimer.current) clearTimeout(quoteTimer.current); };
  }, [amountIn, direction, loadQuote]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadBalances(), loadQuote(amountIn, direction)]);
    setRefreshing(false);
  };

  const handleSwap = async () => {
    if (!publicKey || !connected) { setVisible(true); return; }
    const raw = parseTokens(amountIn, inDecimals);
    if (raw <= 0n) return;

    setStatus({ type: "loading", msg: "Preparing transaction…" });
    try {
      const apiDir = direction === "xnt_to_mind" ? "xnt_to_mind" : "mind_to_xnt";
      const res = await fetch(SWAP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: publicKey.toBase58(), amountIn: raw.toString(), direction: apiDir }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Prepare failed");

      setStatus({ type: "loading", msg: "Waiting for wallet approval…" });
      const tx = Transaction.from(Buffer.from(data.transaction, "base64"));
      const sig = await sendTransaction(tx, connection, { skipPreflight: false });

      setStatus({ type: "loading", msg: "Confirming…" });
      await connection.confirmTransaction(
        { signature: sig, lastValidBlockHeight: data.lastValidBlockHeight, blockhash: tx.recentBlockhash! },
        "confirmed"
      );

      setStatus({ type: "success", msg: `Swapped! ${fmtTokens(data.estimatedOut, outDecimals)} ${outSymbol} received.` });
      setAmountIn("");
      setQuote(null);
      setTimeout(() => loadBalances(), 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Swap failed";
      setStatus({ type: "error", msg: msg.includes("rejected") ? "Transaction rejected by wallet." : msg });
    }
  };

  const toggleDirection = () => {
    setDirection(d => d === "xnt_to_mind" ? "mind_to_xnt" : "xnt_to_mind");
    setAmountIn("");
    setQuote(null);
  };

  const setPercent = (pct: number) => {
    if (inBalance <= 0n) return;
    let amt = inBalance * BigInt(pct) / 100n;
    // XNT: leave ~0.001 for gas if MAX
    if (direction === "xnt_to_mind" && pct === 100) {
      const gas = BigInt(100_000); // 0.0001 XNT
      amt = amt > gas ? amt - gas : 0n;
    }
    const n = Number(amt) / Math.pow(10, inDecimals);
    setAmountIn(n.toFixed(inDecimals).replace(/\.?0+$/, "") || "0");
  };

  const copyAddr = () => {
    if (!publicKey) return;
    navigator.clipboard.writeText(publicKey.toBase58());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const estimatedOut = quote ? fmtTokens(quote.estimatedOut, outDecimals) : "0.00";
  const canSwap = connected && parseTokens(amountIn, inDecimals) > 0n && status.type !== "loading" && !quoteLoading;

  const poolXnt = quote ? BigInt(quote.poolXnt) : 0n;
  const poolMind = quote ? BigInt(quote.poolMind) : 0n;
  const rate = poolXnt > 0n && poolMind > 0n
    ? Number(poolMind) / Number(poolXnt)
    : 0;

  const rewardPoolActive = !!(quote?.rewardPoolMind && BigInt(quote.rewardPoolMind) > 0n);

  // Swap USD value for display
  const swapUsdStr = quote?.usdCents
    ? `≈ $${(Number(quote.usdCents) / 100).toFixed(2)}`
    : "—";

  // GigaSwap win probability display based on swap USD value
  function gigaWinPct(usdCents: number): string {
    if (usdCents >= 10_000) return "68%";
    if (usdCents >= 2_000)  return "55%";
    if (usdCents >= 500)    return "38%";
    return "0%";
  }

  const inUsd = quote?.usdCents ? `≈ $${(Number(quote.usdCents) / 100).toFixed(2)}` : "—";
  const outUsd = "—";

  return (
    <div className="min-h-screen bg-[#07090e] text-zinc-100 font-sans">

      {/* Pool Rewards Banner */}
      <div className="w-full border-b border-zinc-800/60 bg-[#0a0d14]">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${rewardPoolActive ? "bg-neon animate-pulse" : "bg-zinc-600"}`} />
            <span className="text-xs font-bold text-neon tracking-wide">REWARD POOL</span>
          </div>
          <div className="flex items-center gap-4 text-xs text-zinc-400 flex-wrap">
            {rewardPoolActive ? (
              <>
                <span>
                  <span className="text-zinc-500">MIND:</span>{" "}
                  <span className="text-zinc-200 font-mono">{fmtShort(BigInt(quote!.rewardPoolMind!), MIND_DECIMALS)}</span>
                </span>
                <span className="text-zinc-700">|</span>
                <span>
                  <span className="text-zinc-500">XNT:</span>{" "}
                  <span className="text-zinc-200 font-mono">{fmtShort(BigInt(quote!.rewardPoolXnt!), XNT_DECIMALS)}</span>
                </span>
                <span className="text-zinc-700">|</span>
                <span className="text-neon/80">
                  ≈ <span className="font-bold text-neon">${(Number(quote!.rewardPoolUsdCents!) / 100).toFixed(1)}</span> w nagrodach
                </span>
              </>
            ) : (
              <span className="text-zinc-600">
                {quote ? "Pula w trakcie zasilania…" : "Swap ≥$5 → GigaSwap aktywny"}
              </span>
            )}
          </div>
          <Link href="/" className="text-xs text-zinc-600 hover:text-zinc-400 transition hidden sm:block">← X1Factory</Link>
        </div>
      </div>

      {/* Main content */}
      <div className="max-w-lg mx-auto px-4 py-6">

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold tracking-tight lowercase">swap</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              className="p-2 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60 transition"
            >
              <RefreshIcon spinning={refreshing} />
            </button>
            <button
              onClick={() => setShowSettings(s => !s)}
              className={`p-2 rounded-lg transition ${showSettings ? "text-neon bg-neon/10" : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60"}`}
            >
              <SettingsIcon />
            </button>
          </div>
        </div>

        {/* Settings panel */}
        {showSettings && (
          <div className="mb-3 bg-[#0d1117] border border-zinc-800 rounded-2xl p-4">
            <div className="text-xs text-zinc-500 mb-3 font-bold uppercase tracking-widest">Settings</div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-400">Slippage tolerance</span>
              <div className="flex items-center gap-2">
                {[0.1, 0.5, 1.0].map(s => (
                  <button
                    key={s}
                    onClick={() => setSlippage(s)}
                    className={`px-3 py-1 rounded-lg text-xs font-bold transition ${slippage === s ? "bg-neon/20 text-neon border border-neon/40" : "bg-zinc-800 text-zinc-400 border border-transparent hover:border-zinc-600"}`}
                  >
                    {s}%
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Status */}
        {status.type !== "idle" && (
          <div className={`mb-3 text-sm rounded-xl px-4 py-3 flex items-center gap-2 ${
            status.type === "success" ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" :
            status.type === "error"   ? "bg-red-500/10 text-red-400 border border-red-500/20" :
                                        "bg-neon/5 text-neon/80 border border-neon/10"
          }`}>
            {status.type === "loading" && <span className="text-lg leading-none animate-spin">⟳</span>}
            <span className="flex-1">{status.msg}</span>
            {status.type !== "loading" && (
              <button onClick={() => setStatus({ type: "idle" })} className="opacity-50 hover:opacity-100 ml-1">✕</button>
            )}
          </div>
        )}

        {/* YOU PAY */}
        <div className="bg-[#0d1117] border border-zinc-800 rounded-2xl p-4 mb-1">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-zinc-500">You Pay</span>
            {connected && publicKey ? (
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <span>Balance: <span className="text-zinc-300">{balancesLoading ? "…" : fmtTokens(inBalance, inDecimals, 4)}</span></span>
                <span className="text-zinc-700">|</span>
                <span className="text-zinc-600 font-mono">{shortAddr(publicKey.toBase58())}</span>
                <button onClick={copyAddr} className="text-zinc-600 hover:text-neon transition">
                  {copied ? <span className="text-neon">✓</span> : <CopyIcon />}
                </button>
              </div>
            ) : (
              <span className="text-xs text-zinc-600">Balance: —</span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <input
              type="number"
              min="0"
              step="any"
              placeholder="0.00"
              value={amountIn}
              onChange={e => setAmountIn(e.target.value)}
              className="flex-1 bg-transparent text-3xl font-bold outline-none text-zinc-100 placeholder:text-zinc-700 min-w-0"
            />
            <button
              onClick={toggleDirection}
              className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-xl px-3 py-2 transition min-w-[100px] justify-between"
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">{inSymbol === "XNT" ? "⬡" : "⚙"}</span>
                <span className="font-bold text-sm">{inSymbol}</span>
              </div>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" className="text-zinc-500">
                <path d="M5 7L1 3h8z"/>
              </svg>
            </button>
          </div>

          <div className="mt-2 text-xs text-zinc-600">≈ {inUsd} USD</div>

          {/* Percent buttons */}
          <div className="grid grid-cols-4 gap-2 mt-3">
            {[25, 50, 75, 100].map(p => (
              <button
                key={p}
                onClick={() => setPercent(p)}
                className="py-1.5 rounded-lg text-xs font-bold border border-zinc-700 text-zinc-400 hover:border-neon/40 hover:text-neon transition bg-zinc-900"
              >
                {p === 100 ? "MAX" : `${p}%`}
              </button>
            ))}
          </div>
        </div>

        {/* Swap arrow */}
        <div className="flex justify-center -my-0.5 relative z-10">
          <button
            onClick={toggleDirection}
            className="w-9 h-9 rounded-full bg-[#0d1117] border border-zinc-700 hover:border-neon/50 flex items-center justify-center text-zinc-400 hover:text-neon transition shadow-lg"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <polyline points="5 12 12 19 19 12"/>
            </svg>
          </button>
        </div>

        {/* YOU RECEIVE */}
        <div className="bg-[#0d1117] border border-zinc-800 rounded-2xl p-4 mb-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-zinc-500">You Receive</span>
            {connected && publicKey ? (
              <span className="text-xs text-zinc-500">
                Balance: <span className="text-zinc-300">{balancesLoading ? "…" : fmtTokens(outBalance, outDecimals, 4)}</span>
                <span className="text-zinc-700 mx-2">|</span>
                <span className="text-zinc-600 font-mono">{shortAddr(publicKey.toBase58())}</span>
              </span>
            ) : (
              <span className="text-xs text-zinc-600">Balance: —</span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <span className={`flex-1 text-3xl font-bold min-w-0 ${quoteLoading ? "text-zinc-600 animate-pulse" : "text-zinc-100"}`}>
              {quoteLoading ? "…" : estimatedOut}
            </span>
            <div className="flex items-center gap-2 bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 min-w-[100px] justify-between">
              <div className="flex items-center gap-2">
                <span className="text-lg">{outSymbol === "XNT" ? "⬡" : "⚙"}</span>
                <span className="font-bold text-sm">{outSymbol}</span>
              </div>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" className="text-zinc-500">
                <path d="M5 7L1 3h8z"/>
              </svg>
            </div>
          </div>

          <div className="mt-2 text-xs text-zinc-600">≈ {outUsd} USD</div>
        </div>

        {/* Chart & Info bar */}
        <div className="bg-[#0d1117] border border-zinc-800 rounded-2xl px-4 py-3 mb-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-zinc-300">Chart & Info</span>
            <span className="flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/30 rounded-full px-2 py-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[10px] font-bold text-emerald-400 tracking-wide">LIVE</span>
            </span>
          </div>
          {rate > 0 ? (
            <div className="flex items-center gap-4 text-xs text-zinc-400">
              <span>Vol: <span className="text-zinc-200 font-mono font-bold">${fmtShort(poolXnt, 0)} XNT</span></span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-600">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </div>
          ) : (
            <span className="text-xs text-zinc-600">Enter amount for quote</span>
          )}
        </div>

        {/* Rate / Price Impact / Gas / Slippage */}
        <div className="bg-[#0d1117] border border-zinc-800 rounded-2xl mb-3 overflow-hidden">
          <div className="grid grid-cols-4 divide-x divide-zinc-800">
            <div className="px-3 py-3 text-center">
              <div className="text-[10px] text-zinc-500 mb-1.5 uppercase tracking-wider">Rate</div>
              {rate > 0 ? (
                <div className="text-[10px] text-zinc-300 leading-relaxed">
                  <div>1 XNT ≈ {rate.toFixed(2)} MIND</div>
                  <div>1 MIND ≈ {(1/rate).toFixed(4)} XNT</div>
                </div>
              ) : (
                <div className="text-xs text-zinc-600">—</div>
              )}
            </div>
            <div className="px-3 py-3 text-center">
              <div className="text-[10px] text-zinc-500 mb-1.5 uppercase tracking-wider">Price Impact</div>
              <div className={`text-sm font-bold ${quote && quote.priceImpactBps > 100 ? "text-yellow-400" : "text-neon"}`}>
                {quote ? `${(quote.priceImpactBps / 100).toFixed(2)}%` : "—"}
              </div>
            </div>
            <div className="px-3 py-3 text-center">
              <div className="text-[10px] text-zinc-500 mb-1.5 uppercase tracking-wider">Est. Gas</div>
              <div className="text-xs font-bold text-zinc-300">~0.0002 XNT</div>
            </div>
            <div className="px-3 py-3 text-center">
              <div className="text-[10px] text-zinc-500 mb-1.5 uppercase tracking-wider">Slippage</div>
              <div className="text-sm font-bold text-zinc-300">{slippage}%</div>
            </div>
          </div>
          {quote && (
            <div className="border-t border-zinc-800 px-4 py-2 flex items-center justify-between text-xs text-zinc-500">
              <span>Platform fee (1.0%)</span>
              <span className="text-zinc-400 font-mono">{fmtTokens(quote.ourFee, inDecimals, 4)} {inSymbol}</span>
            </div>
          )}
        </div>

        {/* GigaSwap Indicator */}
        <div className={`mb-3 rounded-2xl px-4 py-3 transition-all duration-500 ${
          quote?.gigaQualified
            ? "bg-neon/10 border border-neon/40 shadow-[0_0_20px_rgba(34,242,255,0.15)]"
            : "bg-zinc-900/60 border border-zinc-800"
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`text-lg font-black tracking-widest transition-all ${
                quote?.gigaQualified
                  ? "text-neon animate-pulse drop-shadow-[0_0_8px_rgba(34,242,255,0.8)]"
                  : "text-zinc-600"
              }`}>
                ⚡ GIGA SWAP
              </span>
              {quote?.gigaQualified && (
                <span className="text-[10px] font-bold text-neon/70 bg-neon/10 border border-neon/30 rounded-full px-2 py-0.5 animate-pulse">
                  ACTIVE
                </span>
              )}
            </div>
            <div className="text-right">
              {quote?.gigaQualified ? (
                <div>
                  <div className="text-xs font-bold text-neon">
                    {gigaWinPct(Number(quote.usdCents ?? 0))} szans!
                  </div>
                  <div className="text-[10px] text-neon/60">fee × mult + bonus z puli</div>
                </div>
              ) : (
                <div>
                  <div className="text-xs text-zinc-600">
                    {quote ? `${swapUsdStr} — za mało` : "Wprowadź kwotę"}
                  </div>
                  <div className="text-[10px] text-zinc-700">Wymagane ≥ $5</div>
                </div>
              )}
            </div>
          </div>
          {quote?.gigaQualified && rewardPoolActive && (
            <div className="mt-2 pt-2 border-t border-neon/20 flex items-center justify-between text-[10px] text-neon/50">
              <span>Pula nagród aktywna</span>
              <span className="font-bold text-neon/70">
                ≈ ${(Number(quote.rewardPoolUsdCents!) / 100).toFixed(1)} dostępne
              </span>
            </div>
          )}
        </div>

        {/* Route */}
        <div className="flex items-center justify-center gap-3 mb-4 py-2">
          <div className="w-8 h-8 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-sm">
            {inSymbol === "XNT" ? "⬡" : "⚙"}
          </div>
          <div className="flex items-center gap-1 text-zinc-600">
            <div className="w-8 h-px bg-zinc-700"/>
            <svg width="6" height="6" viewBox="0 0 6 6" fill="currentColor" className="text-zinc-600"><path d="M0 3h4M2 1l2 2-2 2"/></svg>
          </div>
          <div className="px-3 py-1 rounded-lg bg-zinc-800 border border-zinc-700 text-xs font-bold text-zinc-400">
            xDEX Pool
          </div>
          <div className="flex items-center gap-1 text-zinc-600">
            <div className="w-8 h-px bg-zinc-700"/>
            <svg width="6" height="6" viewBox="0 0 6 6" fill="currentColor" className="text-zinc-600"><path d="M0 3h4M2 1l2 2-2 2"/></svg>
          </div>
          <div className="w-8 h-8 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-sm">
            {outSymbol === "XNT" ? "⬡" : "⚙"}
          </div>
        </div>

        {/* Connect wallet info */}
        {!connected && (
          <div className="mb-3 flex items-center gap-3 bg-neon/5 border border-neon/20 rounded-xl px-4 py-3 text-sm text-zinc-400">
            <span className="text-neon"><AlertIcon /></span>
            <span>Connect wallet to swap</span>
          </div>
        )}

        {/* Action button */}
        {!connected ? (
          <button
            onClick={() => setVisible(true)}
            disabled={connecting}
            className="w-full py-4 rounded-xl font-bold text-base bg-zinc-800 border border-zinc-700 text-zinc-200 hover:bg-zinc-700 hover:border-neon/30 transition disabled:opacity-60"
          >
            {connecting ? "Connecting…" : "Connect"}
          </button>
        ) : (
          <button
            onClick={handleSwap}
            disabled={!canSwap}
            className="w-full py-4 rounded-xl font-bold text-base transition disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: canSwap ? "linear-gradient(135deg, #22f2ff 0%, #12f4c9 100%)" : undefined,
              color: canSwap ? "#07090e" : undefined,
              backgroundColor: !canSwap ? "#1c1f26" : undefined,
            }}
          >
            {status.type === "loading"
              ? "Processing…"
              : !connected
              ? "Connect Wallet"
              : parseTokens(amountIn, inDecimals) <= 0n
              ? `Enter amount`
              : `Swap ${inSymbol} → ${outSymbol}`}
          </button>
        )}

        {connected && publicKey && (
          <div className="mt-2 text-center text-xs text-zinc-700">
            {publicKey.toBase58().slice(0, 6)}…{publicKey.toBase58().slice(-6)}
          </div>
        )}

        {/* Info cards */}
        <div className="mt-8 space-y-3">

          {/* Pool rewards info */}
          <div className="bg-[#0d1117] border border-neon/20 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className={`w-2 h-2 rounded-full ${rewardPoolActive ? "bg-neon animate-pulse" : "bg-zinc-600"}`} />
              <span className="text-sm font-bold text-neon">Pool Rewards</span>
              {rewardPoolActive && quote?.rewardPoolUsdCents && (
                <span className="ml-auto text-xs font-bold text-neon bg-neon/10 border border-neon/30 rounded-full px-2 py-0.5">
                  ${(Number(quote.rewardPoolUsdCents) / 100).toFixed(1)} dostępne
                </span>
              )}
            </div>
            <div className="space-y-2 text-sm text-zinc-400">
              <div className="flex justify-between">
                <span>Opłata protokołu</span>
                <span className="text-zinc-300 font-mono">1.0%</span>
              </div>
              <div className="flex justify-between">
                <span>Treasury</span>
                <span className="text-zinc-300 font-mono">0.5%</span>
              </div>
              <div className="flex justify-between pl-4 text-xs text-zinc-600">
                <span>operacje & buy-back</span>
              </div>
              <div className="flex justify-between">
                <span>Pula nagród</span>
                <span className="text-zinc-300 font-mono">0.5%</span>
              </div>
              <div className="flex justify-between pl-4 text-xs text-zinc-600">
                <span>nagrody GigaSwap dla userów</span>
              </div>
              <div className="mt-3 pt-3 border-t border-zinc-800/60">
                <div className="text-xs text-neon/80 font-bold mb-2">⚡ GigaSwap — jak to działa?</div>
                <div className="space-y-1.5 text-xs text-zinc-500">
                  <div className="flex justify-between">
                    <span>Kwalifikacja</span>
                    <span className="text-zinc-300">swap ≥ $5</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Szansa wygranej</span>
                    <span className="text-zinc-300">38–68% w zależności od kwoty</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Nagroda</span>
                    <span className="text-zinc-300">fee × mnożnik + bonus z puli</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Mnożnik</span>
                    <span className="text-zinc-300">1× / 2× / 3× / 5× / 8× / 15×</span>
                  </div>
                </div>
                {!rewardPoolActive && (
                  <div className="mt-2 text-[10px] text-zinc-600 italic">
                    Podstawowe nagrody (z fee) zawsze dostępne. Duże nagrody gdy właściciel zasila pulę.
                  </div>
                )}
              </div>
              {quote?.swapCounter && (
                <div className="mt-2 pt-2 border-t border-zinc-800/60 flex justify-between text-xs text-zinc-600">
                  <span>Łącznie swapów</span>
                  <span className="font-mono">{Number(quote.swapCounter).toLocaleString()}</span>
                </div>
              )}
              {quote?.gigaHits && Number(quote.gigaHits) > 0 && (
                <div className="flex justify-between text-xs text-zinc-600">
                  <span>GigaSwap wygranych</span>
                  <span className="font-mono text-neon/50">{Number(quote.gigaHits).toLocaleString()}</span>
                </div>
              )}
            </div>
          </div>

          {/* Wallets */}
          <div className="bg-[#0d1117] border border-zinc-800 rounded-2xl p-4">
            <div className="text-sm font-bold text-zinc-300 mb-3">Supported Wallets</div>
            <div className="grid grid-cols-3 gap-2">
              <a href="https://chromewebstore.google.com/detail/x1-wallet/kcfmcpdmlchhbikbogddmgopmjbflnae"
                target="_blank" rel="noopener"
                className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-center hover:border-neon/30 transition group">
                <div className="text-xl mb-1">🔷</div>
                <div className="text-xs font-bold text-zinc-300 group-hover:text-neon">X1 Wallet</div>
                <div className="text-[10px] text-zinc-600 mt-0.5">Native X1</div>
              </a>
              <a href="https://backpack.exchange" target="_blank" rel="noopener"
                className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-center hover:border-orange-400/30 transition group">
                <div className="text-xl mb-1">🎒</div>
                <div className="text-xs font-bold text-zinc-300 group-hover:text-orange-400">Backpack</div>
                <div className="text-[10px] text-zinc-600 mt-0.5">Desktop + Mobile</div>
              </a>
              <a href="https://phantom.app" target="_blank" rel="noopener"
                className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-center hover:border-purple-400/30 transition group">
                <div className="text-xl mb-1">👻</div>
                <div className="text-xs font-bold text-zinc-300 group-hover:text-purple-400">Phantom</div>
                <div className="text-[10px] text-zinc-600 mt-0.5">+ custom RPC</div>
              </a>
            </div>
          </div>

          {/* Earn points */}
          <div className="bg-[#0d1117] border border-zinc-800 rounded-2xl p-4 text-sm text-zinc-400">
            <div className="font-bold text-zinc-200 mb-2">Earn Season Points</div>
            <div className="space-y-1.5 text-xs">
              <div className="flex gap-2"><span className="text-neon font-bold">1.</span> Install X1 Wallet or Backpack</div>
              <div className="flex gap-2"><span className="text-neon font-bold">2.</span> Connect your wallet above</div>
              <div className="flex gap-2"><span className="text-neon font-bold">3.</span> Swap and confirm in wallet</div>
              <div className="flex gap-2"><span className="text-neon font-bold">4.</span> Points auto-detected by X1Factory scanner</div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
