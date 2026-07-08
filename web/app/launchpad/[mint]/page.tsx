"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Transaction, PublicKey } from "@solana/web3.js";
import Link from "next/link";

const TOKEN_DECIMALS = 6;
const XNT_DECIMALS = 9;
const TRADE_URL = "/api/launchpad/trade/prepare";

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
  priceUsd?: number;
  fdvUsd?: number;
  progressPct?: number;
  complete?: boolean;
  realXntReserves?: string;
  gigaHits?: string;
  tradeCounter?: string;
  estimatedOut?: string;
  feeTotal?: string;
  soldOut?: boolean;
  insufficientLiquidity?: boolean;
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
  const quoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      setTimeout(() => loadQuote("", side), 2000);

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

  const canTrade =
    connected &&
    parseTokens(amount, side === "buy" ? XNT_DECIMALS : TOKEN_DECIMALS) > 0n &&
    status.type !== "loading" &&
    !quoteLoading &&
    !quote?.complete;

  return (
    <div className="min-h-screen bg-[#07090e] text-zinc-100 font-sans">
      <div className="sticky top-0 z-10 backdrop-blur bg-[#07090e]/90 border-b border-zinc-900">
        <div className="max-w-lg mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
          <span className="text-[11px] font-mono font-bold text-neon">LAUNCHPAD</span>
          <Link href="/launchpad" className="text-[11px] text-zinc-600 hover:text-zinc-400 transition">
            ← All tokens
          </Link>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-6">
        <div className="mb-4">
          <h1 className="text-lg font-bold font-mono truncate">{mint}</h1>
          {quote?.complete && (
            <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-neon/10 text-neon">
              graduated
            </span>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2 mb-4">
          <div className="bg-[#0d1117] border border-zinc-800 rounded-2xl p-3">
            <div className="text-[9px] uppercase text-zinc-600 mb-1">Price</div>
            <div className="text-sm font-mono font-bold">{quote?.priceUsd !== undefined ? fmtUsd(quote.priceUsd) : "—"}</div>
          </div>
          <div className="bg-[#0d1117] border border-zinc-800 rounded-2xl p-3">
            <div className="text-[9px] uppercase text-zinc-600 mb-1">FDV</div>
            <div className="text-sm font-mono font-bold">{quote?.fdvUsd !== undefined ? fmtUsd(quote.fdvUsd) : "—"}</div>
          </div>
          <div className="bg-[#0d1117] border border-zinc-800 rounded-2xl p-3">
            <div className="text-[9px] uppercase text-zinc-600 mb-1">Giga Hits</div>
            <div className="text-sm font-mono font-bold text-neon">{quote?.gigaHits ?? "—"}</div>
          </div>
        </div>

        {quote?.progressPct !== undefined && (
          <div className="mb-6">
            <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden mb-1">
              <div className="h-full bg-neon transition-all" style={{ width: `${quote.progressPct.toFixed(1)}%` }} />
            </div>
            <div className="text-[10px] text-zinc-600 text-right">{quote.progressPct.toFixed(1)}% sold on curve</div>
          </div>
        )}

        <div className="bg-[#0d1117] border border-zinc-800 rounded-2xl p-4">
          <div className="flex gap-1 mb-4 bg-zinc-900 rounded-xl p-1">
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

          <div className="mb-3">
            <div className="text-[10px] uppercase tracking-widest text-zinc-600 mb-1">
              {side === "buy" ? "XNT in" : "Tokens in"}
            </div>
            <input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="0.0"
              className="w-full bg-transparent text-2xl font-mono font-bold outline-none placeholder:text-zinc-700"
            />
          </div>

          {quote?.estimatedOut && (
            <div className="text-xs text-zinc-500 mb-3">
              ≈ {fmtTokens(quote.estimatedOut, side === "buy" ? TOKEN_DECIMALS : XNT_DECIMALS)}{" "}
              {side === "buy" ? "tokens" : "XNT"} (1% fee included)
            </div>
          )}
          {(quote?.soldOut || quote?.insufficientLiquidity) && (
            <div className="text-xs text-red-400 mb-3">
              {quote.soldOut ? "Not enough tokens left on the curve." : "Not enough XNT liquidity on the curve."}
            </div>
          )}

          <button
            onClick={handleTrade}
            disabled={!canTrade && connected}
            className="w-full py-3 rounded-xl font-bold text-sm uppercase tracking-wide bg-neon text-black disabled:bg-zinc-800 disabled:text-zinc-600 transition"
          >
            {!connected ? "Connect Wallet" : status.type === "loading" ? status.msg : side === "buy" ? "Buy" : "Sell"}
          </button>

          {status.type === "success" && <div className="text-xs text-neon mt-3">{status.msg}</div>}
          {status.type === "error" && <div className="text-xs text-red-400 mt-3">{status.msg}</div>}
        </div>

        {gigaWin && (
          <div className="mt-6 bg-neon/10 border border-neon/40 rounded-2xl p-6 text-center">
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
      </div>
    </div>
  );
}
