"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Transaction } from "@solana/web3.js";
import Link from "next/link";

const MIND_DECIMALS = 9;
const XNT_DECIMALS = 9;
const SWAP_URL = "/api/swap/prepare";
const QUOTE_URL = "/api/panel/swap/quote";

type Direction = "mind_to_xnt" | "xnt_to_mind";

interface Quote {
  estimatedOut: string;
  ourFee: string;
  priceImpactBps: number;
  poolXnt: string;
  poolMind: string;
}

function fmtTokens(raw: string | bigint, decimals: number, dp = 4): string {
  const n = Number(BigInt(raw)) / Math.pow(10, decimals);
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

function parseTokens(input: string, decimals: number): bigint {
  const trimmed = input.trim().replace(/,/g, "");
  if (!trimmed || isNaN(Number(trimmed))) return 0n;
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = frac.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole || "0") * BigInt(10 ** decimals) + BigInt(fracPadded);
}

export default function SwapPage() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected, connecting, wallet } = useWallet();
  const { setVisible } = useWalletModal();

  const [direction, setDirection] = useState<Direction>("mind_to_xnt");
  const [amountIn, setAmountIn] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [status, setStatus] = useState<{ type: "idle" | "loading" | "success" | "error"; msg?: string }>({ type: "idle" });
  const quoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const inDecimals = MIND_DECIMALS;
  const outDecimals = direction === "mind_to_xnt" ? XNT_DECIMALS : MIND_DECIMALS;
  const inSymbol = direction === "mind_to_xnt" ? "MIND" : "XNT";
  const outSymbol = direction === "mind_to_xnt" ? "XNT" : "MIND";

  const loadQuote = useCallback(async (amt: string, dir: Direction) => {
    const raw = parseTokens(amt, MIND_DECIMALS);
    if (raw <= 0n) { setQuote(null); return; }
    setQuoteLoading(true);
    try {
      const res = await fetch(`${QUOTE_URL}?amountIn=${raw}&direction=${dir}`);
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

  const handleSwap = async () => {
    if (!publicKey || !connected) { setVisible(true); return; }
    const raw = parseTokens(amountIn, inDecimals);
    if (raw <= 0n) return;

    setStatus({ type: "loading", msg: "Preparing transaction…" });
    try {
      const res = await fetch(SWAP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: publicKey.toBase58(), amountIn: raw.toString(), direction }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Prepare failed");

      setStatus({ type: "loading", msg: "Waiting for wallet approval…" });
      const tx = Transaction.from(Buffer.from(data.transaction, "base64"));
      const sig = await sendTransaction(tx, connection, { skipPreflight: false });

      setStatus({ type: "loading", msg: "Confirming…" });
      await connection.confirmTransaction({ signature: sig, lastValidBlockHeight: data.lastValidBlockHeight, blockhash: tx.recentBlockhash! }, "confirmed");

      setStatus({ type: "success", msg: `Swapped! ${fmtTokens(data.estimatedOut, outDecimals)} ${outSymbol} received.` });
      setAmountIn("");
      setQuote(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Swap failed";
      setStatus({ type: "error", msg: msg.includes("rejected") ? "Transaction rejected by wallet." : msg });
    }
  };

  const toggleDirection = () => {
    setDirection(d => d === "mind_to_xnt" ? "xnt_to_mind" : "mind_to_xnt");
    setAmountIn("");
    setQuote(null);
  };

  const estimatedOut = quote ? fmtTokens(quote.estimatedOut, outDecimals) : "—";
  const canSwap = connected && parseTokens(amountIn, inDecimals) > 0n && status.type !== "loading";

  return (
    <div className="min-h-screen bg-night text-zinc-100 font-sans flex flex-col items-center px-4 py-10">

      {/* Header */}
      <div className="mb-8 text-center">
        <Link href="/" className="text-zinc-500 text-sm hover:text-neon transition mb-4 block">← X1Factory</Link>
        <h1 className="text-3xl font-bold tracking-tight text-neon">MIND / XNT Swap</h1>
        <p className="text-zinc-400 mt-1 text-sm">Powered by xDEX on X1 Network</p>
      </div>

      {/* Swap Card */}
      <div className="w-full max-w-md bg-ink border border-zinc-800 rounded-2xl p-6 shadow-glow">

        {/* Direction tabs */}
        <div className="flex gap-2 mb-5">
          <button
            onClick={() => { setDirection("mind_to_xnt"); setAmountIn(""); setQuote(null); }}
            className={`flex-1 py-2 rounded-lg text-sm font-bold transition ${direction === "mind_to_xnt" ? "bg-neon/20 text-neon border border-neon/40" : "bg-zinc-800 text-zinc-400 border border-transparent hover:border-zinc-600"}`}
          >
            MIND → XNT
          </button>
          <button
            onClick={() => { setDirection("xnt_to_mind"); setAmountIn(""); setQuote(null); }}
            className={`flex-1 py-2 rounded-lg text-sm font-bold transition ${direction === "xnt_to_mind" ? "bg-neon/20 text-neon border border-neon/40" : "bg-zinc-800 text-zinc-400 border border-transparent hover:border-zinc-600"}`}
          >
            XNT → MIND
          </button>
        </div>

        {/* Input */}
        <div className="bg-zinc-900 rounded-xl p-4 mb-1">
          <div className="text-xs text-zinc-500 mb-1">You pay</div>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min="0"
              step="any"
              placeholder="0"
              value={amountIn}
              onChange={e => setAmountIn(e.target.value)}
              className="flex-1 bg-transparent text-xl font-bold outline-none text-zinc-100 placeholder:text-zinc-600"
            />
            <span className="font-mono font-bold text-neon text-sm px-2 py-1 bg-neon/10 rounded-lg">{inSymbol}</span>
          </div>
        </div>

        {/* Swap arrow */}
        <div className="flex justify-center my-2">
          <button onClick={toggleDirection} className="text-zinc-500 hover:text-neon transition p-1 rounded-lg hover:bg-zinc-800">
            ⇅
          </button>
        </div>

        {/* Output */}
        <div className="bg-zinc-900 rounded-xl p-4 mb-4">
          <div className="text-xs text-zinc-500 mb-1">You receive (est.)</div>
          <div className="flex items-center gap-3">
            <span className={`flex-1 text-xl font-bold ${quoteLoading ? "text-zinc-500" : "text-zinc-100"}`}>
              {quoteLoading ? "…" : estimatedOut}
            </span>
            <span className="font-mono font-bold text-neon text-sm px-2 py-1 bg-neon/10 rounded-lg">{outSymbol}</span>
          </div>
        </div>

        {/* Fee info */}
        {quote && (
          <div className="text-xs text-zinc-500 mb-4 space-y-0.5">
            <div className="flex justify-between">
              <span>Platform fee (0.4%)</span>
              <span>{fmtTokens(quote.ourFee, inDecimals)} {inSymbol}</span>
            </div>
            <div className="flex justify-between">
              <span>Price impact</span>
              <span className={quote.priceImpactBps > 100 ? "text-yellow-400" : ""}>{(quote.priceImpactBps / 100).toFixed(2)}%</span>
            </div>
          </div>
        )}

        {/* Status */}
        {status.type !== "idle" && (
          <div className={`mb-4 text-sm rounded-lg px-3 py-2 ${
            status.type === "success" ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" :
            status.type === "error"   ? "bg-red-500/10 text-red-400 border border-red-500/20" :
                                        "bg-neon/5 text-neon/80 border border-neon/10"
          }`}>
            {status.type === "loading" && <span className="mr-2">⟳</span>}
            {status.msg}
            {status.type !== "loading" && (
              <button onClick={() => setStatus({ type: "idle" })} className="ml-2 opacity-60 hover:opacity-100">✕</button>
            )}
          </div>
        )}

        {/* Action button */}
        {!connected ? (
          <button
            onClick={() => setVisible(true)}
            disabled={connecting}
            className="w-full py-3 rounded-xl font-bold text-base bg-neon text-night hover:bg-neon/90 transition disabled:opacity-60"
          >
            {connecting ? "Connecting…" : "Connect Wallet"}
          </button>
        ) : (
          <button
            onClick={handleSwap}
            disabled={!canSwap}
            className="w-full py-3 rounded-xl font-bold text-base bg-neon text-night hover:bg-neon/90 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {status.type === "loading" ? "Processing…" : `Swap ${inSymbol} → ${outSymbol}`}
          </button>
        )}

        {/* Connected wallet info */}
        {connected && publicKey && (
          <div className="mt-3 text-center text-xs text-zinc-600">
            {wallet?.adapter.name} · {publicKey.toBase58().slice(0, 4)}…{publicKey.toBase58().slice(-4)}
          </div>
        )}
      </div>

      {/* Pool stats */}
      {quote && (
        <div className="w-full max-w-md mt-4 bg-ink border border-zinc-800 rounded-xl p-4 flex gap-4 text-center">
          <div className="flex-1">
            <div className="text-xs text-zinc-500 mb-1">Pool XNT</div>
            <div className="font-mono text-sm text-zinc-200">{fmtTokens(quote.poolXnt, XNT_DECIMALS, 0)}</div>
          </div>
          <div className="w-px bg-zinc-800"/>
          <div className="flex-1">
            <div className="text-xs text-zinc-500 mb-1">Pool MIND</div>
            <div className="font-mono text-sm text-zinc-200">{fmtTokens(quote.poolMind, MIND_DECIMALS, 0)}</div>
          </div>
        </div>
      )}

      {/* Info section */}
      <div className="w-full max-w-md mt-8 space-y-4">
        <h2 className="text-lg font-bold text-zinc-200">Supported Wallets</h2>
        <div className="grid grid-cols-3 gap-3">
          <a href="https://chromewebstore.google.com/detail/x1-wallet/kcfmcpdmlchhbikbogddmgopmjbflnae"
            target="_blank" rel="noopener"
            className="bg-ink border border-zinc-800 rounded-xl p-3 text-center hover:border-tide/40 transition group">
            <div className="text-2xl mb-1">🔷</div>
            <div className="text-xs font-bold text-zinc-300 group-hover:text-tide">X1 Wallet</div>
            <div className="text-[10px] text-zinc-600 mt-0.5">Native X1</div>
          </a>
          <a href="https://backpack.exchange" target="_blank" rel="noopener"
            className="bg-ink border border-zinc-800 rounded-xl p-3 text-center hover:border-orange-400/40 transition group">
            <div className="text-2xl mb-1">🎒</div>
            <div className="text-xs font-bold text-zinc-300 group-hover:text-orange-400">Backpack</div>
            <div className="text-[10px] text-zinc-600 mt-0.5">Desktop + Mobile</div>
          </a>
          <a href="https://phantom.app" target="_blank" rel="noopener"
            className="bg-ink border border-zinc-800 rounded-xl p-3 text-center hover:border-purple-400/40 transition group">
            <div className="text-2xl mb-1">👻</div>
            <div className="text-xs font-bold text-zinc-300 group-hover:text-purple-400">Phantom</div>
            <div className="text-[10px] text-zinc-600 mt-0.5">+ custom RPC</div>
          </a>
        </div>

        <div className="bg-ink border border-zinc-800 rounded-xl p-4 space-y-2 text-sm text-zinc-400">
          <div className="font-bold text-zinc-200 text-base mb-3">How to swap</div>
          <div className="flex gap-2"><span className="text-neon font-bold">1.</span> Install X1 Wallet or Backpack extension</div>
          <div className="flex gap-2"><span className="text-neon font-bold">2.</span> Connect your wallet (button above)</div>
          <div className="flex gap-2"><span className="text-neon font-bold">3.</span> Enter the amount and confirm in your wallet</div>
          <div className="flex gap-2"><span className="text-neon font-bold">4.</span> Earn Season Points for every swap via X1Factory bot</div>
        </div>

        <div className="bg-neon/5 border border-neon/20 rounded-xl p-4 text-sm text-zinc-400">
          <div className="font-bold text-neon mb-1">Earn Points</div>
          Swapping MIND → XNT through X1Factory earns <span className="text-neon font-bold">Season Points</span> automatically detected by the scanner. Points count toward leaderboard ranks and season rewards.
        </div>
      </div>

    </div>
  );
}
