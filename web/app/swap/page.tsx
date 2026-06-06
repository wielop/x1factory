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
  const [poolInfo, setPoolInfo] = useState<{ rewardPoolMind: string; rewardPoolXnt: string; rewardPoolUsdCents: string } | null>(null);
  const [gigaWin, setGigaWin] = useState<{ payout: bigint; multiplier: number; paidMind: boolean } | null>(null);
  const quoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // GigaSwapEvent discriminator: sha256("event:GigaSwapEvent")[..8] = 7a31e873d069b9c1
  const GIGA_DISC = [0x7a,0x31,0xe8,0x73,0xd0,0x69,0xb9,0xc1];
  function parseGigaEvent(b64: string): { payout: bigint; multiplier: number; paidMind: boolean } | null {
    try {
      const buf = Buffer.from(b64, "base64");
      if (buf.length < 73) return null;
      for (let i = 0; i < 8; i++) if (buf[i] !== GIGA_DISC[i]) return null;
      const payout = buf.readBigUInt64LE(64);
      if (payout === 0n) return null;
      return { payout, multiplier: Number(buf.readBigUInt64LE(56)), paidMind: buf[72] !== 0 };
    } catch { return null; }
  }

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

  const loadPoolInfo = useCallback(async () => {
    try {
      const res = await fetch(`${QUOTE_URL}?amountIn=1000000000&direction=xnt_to_mind`);
      const data = await res.json();
      if (data.ok) setPoolInfo({ rewardPoolMind: data.rewardPoolMind, rewardPoolXnt: data.rewardPoolXnt, rewardPoolUsdCents: data.rewardPoolUsdCents });
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadPoolInfo();
    const id = setInterval(loadPoolInfo, 30_000);
    return () => clearInterval(id);
  }, [loadPoolInfo]);

  const loadQuote = useCallback(async (amt: string, dir: Direction) => {
    const decimals = dir === "xnt_to_mind" ? XNT_DECIMALS : MIND_DECIMALS;
    const raw = parseTokens(amt, decimals);
    if (raw <= 0n) { setQuote(null); return; }
    setQuoteLoading(true);
    try {
      const apiDir = dir === "xnt_to_mind" ? "xnt_to_mind" : "mind_to_xnt";
      const res = await fetch(`${QUOTE_URL}?amountIn=${raw}&direction=${apiDir}`);
      const data = await res.json();
      if (data.ok) {
        setQuote(data);
        setPoolInfo({ rewardPoolMind: data.rewardPoolMind, rewardPoolXnt: data.rewardPoolXnt, rewardPoolUsdCents: data.rewardPoolUsdCents });
      }
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

      // Parse GigaSwap win from transaction logs
      try {
        const txInfo = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        for (const log of txInfo?.meta?.logMessages ?? []) {
          const m = log.match(/^Program data: (.+)$/);
          if (m) { const win = parseGigaEvent(m[1]); if (win) { setGigaWin(win); break; } }
        }
      } catch { /* ignore */ }
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

  const activePool = poolInfo ?? (quote ? { rewardPoolMind: quote.rewardPoolMind ?? "0", rewardPoolXnt: quote.rewardPoolXnt ?? "0", rewardPoolUsdCents: quote.rewardPoolUsdCents ?? "0" } : null);
  const rewardPoolActive = !!(activePool?.rewardPoolMind && BigInt(activePool.rewardPoolMind) > 0n);

  // Swap USD value for display
  const swapUsdStr = quote?.usdCents
    ? `≈ $${(Number(quote.usdCents) / 100).toFixed(2)}`
    : "—";

  // GigaSwap win probability display based on swap USD value
  function gigaWinPct(usdCents: number): string {
    if (usdCents >= 11_100) return "50%";
    if (usdCents >= 8_700)  return "48%";
    if (usdCents >= 6_600)  return "46%";
    if (usdCents >= 4_700)  return "44%";
    if (usdCents >= 3_000)  return "42%";
    if (usdCents >= 1_600)  return "40%";
    if (usdCents >= 500)    return "38%";
    return "0%";
  }

  // GigaSwap prize range: payout = fee × mult + min(pool/500, fee×4), capped by dominant pool
  const gigaPrize = (() => {
    if (!quote?.gigaQualified || !quote.ourFee) return null;
    const fee = BigInt(quote.ourFee);
    const rPoolMind = BigInt(quote.rewardPoolMind ?? "0");
    const rPoolXnt  = BigInt(quote.rewardPoolXnt  ?? "0");
    const dominantBal = rPoolMind >= rPoolXnt ? rPoolMind : rPoolXnt;
    const isDominantMind = rPoolMind >= rPoolXnt;
    const poolBonus = dominantBal > 0n ? (dominantBal / 500n < fee * 4n ? dominantBal / 500n : fee * 4n) : 0n;
    const cap = (v: bigint) => dominantBal > 0n && v > dominantBal ? dominantBal : v;
    const minWin = cap(fee + poolBonus);
    const maxWin = cap(fee * 15n + poolBonus);
    const symbol = isDominantMind ? "MIND" : "XNT";
    // USD conversion
    const xntUsd = BigInt(quote.xntUsdCents ?? "0");
    const DECS = 1_000_000_000n;
    function toUsd(amount: bigint): number {
      if (isDominantMind) {
        const pXnt = BigInt(quote!.poolXnt ?? "0");
        const pMind = BigInt(quote!.poolMind ?? "1");
        return pMind > 0n ? Number((amount * xntUsd * pXnt) / (pMind * DECS)) / 100 : 0;
      }
      return Number((amount * xntUsd) / DECS) / 100;
    }
    return { minWin, maxWin, symbol, minUsd: toUsd(minWin), maxUsd: toUsd(maxWin) };
  })();

  const inUsd = quote?.usdCents ? `$${(Number(quote.usdCents) / 100).toFixed(2)}` : "—";

  const outUsdValue = (() => {
    if (!quote?.estimatedOut || !quote?.xntUsdCents) return null;
    const out = BigInt(quote.estimatedOut);
    const xntUsdCents = BigInt(quote.xntUsdCents);
    const DECIMALS = 1_000_000_000n;
    let cents: bigint;
    if (direction === "xnt_to_mind") {
      const pXnt = BigInt(quote.poolXnt ?? "0");
      const pMind = BigInt(quote.poolMind ?? "1");
      cents = pMind > 0n ? (out * xntUsdCents * pXnt) / (pMind * DECIMALS) : 0n;
    } else {
      cents = (out * xntUsdCents) / DECIMALS;
    }
    return Number(cents) / 100;
  })();
  const outUsd = outUsdValue && outUsdValue > 0 ? `$${outUsdValue.toFixed(2)}` : "—";

  return (
    <div className="min-h-screen bg-[#07090e] text-zinc-100 font-sans">

      {/* Pool Rewards Banner */}
      <div className={`w-full border-b transition-colors duration-700 ${rewardPoolActive ? "border-neon/20 bg-[#060d0e]" : "border-zinc-800/60 bg-[#0a0d14]"}`}>
        <div className="max-w-lg mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${rewardPoolActive ? "bg-neon animate-pulse" : "bg-zinc-700"}`} />
            {activePool ? (
              rewardPoolActive ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-mono font-bold text-neon">
                    {fmtShort(BigInt(activePool.rewardPoolMind), MIND_DECIMALS)} MIND
                  </span>
                  <span className="text-zinc-700 text-[10px]">+</span>
                  <span className="text-[11px] font-mono font-bold text-neon/80">
                    {fmtShort(BigInt(activePool.rewardPoolXnt), XNT_DECIMALS)} XNT
                  </span>
                  <span className="text-zinc-700 text-[10px]">·</span>
                  <span className="text-[11px] font-bold text-neon/60">
                    ≈ ${(Number(activePool.rewardPoolUsdCents) / 100).toFixed(1)} in prizes
                  </span>
                </div>
              ) : (
                <span className="text-[11px] text-zinc-600">GigaSwap pool · base rewards always active</span>
              )
            ) : (
              <span className="text-[11px] text-zinc-700 animate-pulse">Loading pool…</span>
            )}
          </div>
          <Link href="/" className="text-[11px] text-zinc-600 hover:text-zinc-400 transition flex-shrink-0">← X1Factory</Link>
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
                    {gigaWinPct(Number(quote.usdCents ?? 0))} win chance!
                  </div>
                  <div className="text-[10px] text-neon/60">fee × mult + pool bonus</div>
                </div>
              ) : (
                <div>
                  <div className="text-xs text-zinc-600">
                    {quote ? `${swapUsdStr} — too low` : "Enter amount"}
                  </div>
                  <div className="text-[10px] text-zinc-700">Required ≥ $5</div>
                </div>
              )}
            </div>
          </div>
          {quote?.gigaQualified && gigaPrize && (
            <div className="mt-2 pt-2 border-t border-neon/20 space-y-2">
              {/* Prize range bar */}
              <div className="flex items-stretch gap-2">
                <div className="flex-1 bg-neon/5 border border-neon/20 rounded-xl px-3 py-2 text-center">
                  <div className="text-[9px] text-neon/40 uppercase tracking-wider mb-0.5">Min win</div>
                  <div className="text-sm font-bold text-neon/80">{fmtTokens(gigaPrize.minWin, 9, 2)} {gigaPrize.symbol}</div>
                  <div className="text-[9px] text-neon/40">≈ ${gigaPrize.minUsd.toFixed(2)}</div>
                </div>
                <div className="flex flex-col items-center justify-center text-neon/30 text-xs px-1">
                  <span>1×→15×</span>
                  <span className="text-[8px] mt-0.5">mult</span>
                </div>
                <div className="flex-1 bg-neon/10 border border-neon/40 rounded-xl px-3 py-2 text-center shadow-[0_0_12px_rgba(34,242,255,0.1)]">
                  <div className="text-[9px] text-neon/60 uppercase tracking-wider mb-0.5">🎰 Jackpot</div>
                  <div className="text-sm font-bold text-neon">{fmtTokens(gigaPrize.maxWin, 9, 2)} {gigaPrize.symbol}</div>
                  <div className="text-[9px] text-neon/60">≈ ${gigaPrize.maxUsd.toFixed(2)}</div>
                </div>
              </div>
              {/* Multiplier odds row */}
              <div className="flex items-center justify-between text-[9px] text-neon/30 px-1">
                <span>1× <span className="text-zinc-700">35%</span></span>
                <span>2× <span className="text-zinc-700">25%</span></span>
                <span>3× <span className="text-zinc-700">17%</span></span>
                <span>5× <span className="text-zinc-700">12%</span></span>
                <span>8× <span className="text-zinc-700">7%</span></span>
                <span className="text-neon/60">15× <span className="text-neon/40">5%</span></span>
              </div>
              {rewardPoolActive && (
                <div className="flex items-center justify-between text-[10px] text-neon/40 pt-1 border-t border-neon/10">
                  <span>Reward pool active</span>
                  <span className="font-bold text-neon/60">
                    ≈ ${(Number(quote!.rewardPoolUsdCents!) / 100).toFixed(1)} available
                  </span>
                </div>
              )}
            </div>
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
                  ${(Number(quote.rewardPoolUsdCents) / 100).toFixed(1)} available
                </span>
              )}
            </div>
            <div className="space-y-2 text-sm text-zinc-400">
              <div className="flex justify-between">
                <span>Protocol fee</span>
                <span className="text-zinc-300 font-mono">1.0%</span>
              </div>
              <div className="flex justify-between">
                <span>Treasury</span>
                <span className="text-zinc-300 font-mono">0.5%</span>
              </div>
              <div className="flex justify-between pl-4 text-xs text-zinc-600">
                <span>operations & buy-back</span>
              </div>
              <div className="flex justify-between">
                <span>Reward Pool</span>
                <span className="text-zinc-300 font-mono">0.5%</span>
              </div>
              <div className="flex justify-between pl-4 text-xs text-zinc-600">
                <span>GigaSwap prizes for users</span>
              </div>
              <div className="mt-3 pt-3 border-t border-zinc-800/60">
                <div className="text-xs text-neon/80 font-bold mb-2">⚡ GigaSwap — how it works?</div>
                <div className="space-y-1.5 text-xs text-zinc-500">
                  <div className="flex justify-between">
                    <span>Qualification</span>
                    <span className="text-zinc-300">swap ≥ $5</span>
                  </div>
                  <div className="flex justify-between items-start">
                    <span>Win chance</span>
                    <div className="text-right text-zinc-400 space-y-0.5">
                      {[
                        ["$5–$15","38%"],["$16–$29","40%"],["$30–$46","42%"],
                        ["$47–$65","44%"],["$66–$86","46%"],["$87–$110","48%"],["$111+","50%"],
                      ].map(([r,p]) => (
                        <div key={r} className="flex justify-between gap-4">
                          <span className="text-zinc-600">{r}</span>
                          <span className="text-zinc-300 font-mono">{p}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex justify-between">
                    <span>Payout</span>
                    <span className="text-zinc-300">fee × multiplier + pool bonus</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Multiplier</span>
                    <span className="text-zinc-300">1× / 2× / 3× / 5× / 8× / 15×</span>
                  </div>
                </div>
                {!rewardPoolActive && (
                  <div className="mt-2 text-[10px] text-zinc-600 italic">
                    Base rewards (from fee) always available. Big prizes when owner funds the pool.
                  </div>
                )}
              </div>
              {quote?.swapCounter && (
                <div className="mt-2 pt-2 border-t border-zinc-800/60 flex justify-between text-xs text-zinc-600">
                  <span>Total swaps</span>
                  <span className="font-mono">{Number(quote.swapCounter).toLocaleString()}</span>
                </div>
              )}
              {quote?.gigaHits && Number(quote.gigaHits) > 0 && (
                <div className="flex justify-between text-xs text-zinc-600">
                  <span>GigaSwap wins</span>
                  <span className="font-mono text-neon/50">{Number(quote.gigaHits).toLocaleString()}</span>
                </div>
              )}
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
      {/* GigaSwap Win Overlay */}
      {gigaWin && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setGigaWin(null)}
        >
          <div
            className="relative mx-4 w-full max-w-sm rounded-2xl bg-neon/10 border border-neon/40 shadow-[0_0_60px_rgba(34,242,255,0.3)] p-6"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center gap-3 mb-5">
              <span className="text-3xl font-black tracking-widest text-neon animate-pulse drop-shadow-[0_0_12px_rgba(34,242,255,0.9)]">
                ⚡ GIGA SWAP
              </span>
              <span className="text-[11px] font-bold text-neon/70 bg-neon/10 border border-neon/30 rounded-full px-2 py-0.5 animate-pulse">
                WIN!
              </span>
            </div>

            {/* Payout */}
            <div className="bg-neon/5 border border-neon/20 rounded-xl px-5 py-4 mb-4 text-center">
              <div className="text-[11px] text-neon/50 uppercase tracking-widest mb-1">You won</div>
              <div className="text-4xl font-black text-neon drop-shadow-[0_0_16px_rgba(34,242,255,0.7)]">
                {fmtTokens(gigaWin.payout, 9, 4)}
              </div>
              <div className="text-lg font-bold text-neon/70 mt-0.5">
                {gigaWin.paidMind ? "MIND" : "XNT"}
              </div>
            </div>

            {/* Multiplier */}
            <div className="flex items-center justify-between mb-5">
              <div className="text-center flex-1">
                <div className="text-[10px] text-neon/40 uppercase tracking-wider mb-1">Multiplier</div>
                <div className="text-2xl font-black text-neon">{gigaWin.multiplier}×</div>
              </div>
              <div className="w-px h-10 bg-neon/20" />
              <div className="text-center flex-1">
                <div className="text-[10px] text-neon/40 uppercase tracking-wider mb-1">Pool bonus</div>
                <div className="text-sm font-bold text-neon/70">included</div>
              </div>
              <div className="w-px h-10 bg-neon/20" />
              <div className="text-center flex-1">
                <div className="text-[10px] text-neon/40 uppercase tracking-wider mb-1">Token</div>
                <div className="text-sm font-bold text-neon/70">{gigaWin.paidMind ? "MIND" : "XNT"}</div>
              </div>
            </div>

            {/* Multiplier odds row */}
            <div className="flex items-center justify-between text-[9px] text-neon/30 px-1 mb-5">
              {([1,2,3,5,8,15] as const).map(m => (
                <span key={m} className={m === gigaWin.multiplier ? "text-neon font-black text-[11px]" : ""}>
                  {m}×
                </span>
              ))}
            </div>

            <button
              onClick={() => setGigaWin(null)}
              className="w-full py-3 rounded-xl font-bold text-sm border border-neon/30 text-neon hover:bg-neon/10 transition"
            >
              Claim & Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
