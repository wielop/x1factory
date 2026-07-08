"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Keypair, Transaction } from "@solana/web3.js";
import Link from "next/link";

const CREATE_URL = "/api/launchpad/create/prepare";

export default function CreateLaunchpadTokenPage() {
  const router = useRouter();
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const { setVisible } = useWalletModal();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [uri, setUri] = useState("");
  const [initialRewardPoolXnt, setInitialRewardPoolXnt] = useState("");
  const [status, setStatus] = useState<{ type: "idle" | "loading" | "success" | "error"; msg?: string }>({
    type: "idle",
  });

  const canSubmit =
    connected && name.trim().length > 0 && symbol.trim().length > 0 && status.type !== "loading";

  const handleCreate = async () => {
    if (!publicKey || !connected) {
      setVisible(true);
      return;
    }
    if (!name.trim() || !symbol.trim()) return;

    const mintKeypair = Keypair.generate();
    const initialSeedRaw = initialRewardPoolXnt
      ? BigInt(Math.round(Number(initialRewardPoolXnt) * 1_000_000_000))
      : 0n;

    setStatus({ type: "loading", msg: "Preparing transaction…" });
    try {
      const res = await fetch(CREATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: publicKey.toBase58(),
          mintAddress: mintKeypair.publicKey.toBase58(),
          name: name.trim(),
          symbol: symbol.trim(),
          uri: uri.trim(),
          initialRewardPoolXnt: initialSeedRaw.toString(),
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Prepare failed");

      setStatus({ type: "loading", msg: "Waiting for wallet approval…" });
      const tx = Transaction.from(Buffer.from(data.transaction, "base64"));
      const sig = await sendTransaction(tx, connection, {
        signers: [mintKeypair],
        skipPreflight: false,
      });

      setStatus({ type: "loading", msg: "Confirming…" });
      for (let i = 0; i < 40; i++) {
        const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        const val = st?.value;
        if (val?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(val.err)}`);
        if (val?.confirmationStatus === "confirmed" || val?.confirmationStatus === "finalized") break;
        if (i === 39) throw new Error("Confirmation timeout — check explorer for tx status.");
        await new Promise((r) => setTimeout(r, 1500));
      }

      setStatus({ type: "success", msg: "Token created!" });
      setTimeout(() => router.push(`/launchpad/${mintKeypair.publicKey.toBase58()}`), 1200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Creation failed";
      setStatus({ type: "error", msg: msg.includes("rejected") ? "Transaction rejected by wallet." : msg });
    }
  };

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
        <h1 className="text-2xl font-bold tracking-tight lowercase mb-1">create token</h1>
        <p className="text-sm text-zinc-500 mb-6">
          Fixed supply 1,000,000,000 tokens. 80% na krzywej, 10% w puli GigaSwap, 5%
          zarezerwowane, 5% dla Ciebie (bez blokady). Handel startuje natychmiast po utworzeniu.
        </p>

        <div className="bg-[#0d1117] border border-zinc-800 rounded-2xl p-4 space-y-4">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-600 mb-1">Name</div>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 32))}
              placeholder="My Memecoin"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-neon/50"
            />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-600 mb-1">Symbol</div>
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase().slice(0, 10))}
              placeholder="MEME"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-neon/50"
            />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-600 mb-1">
              Image / metadata URI (optional)
            </div>
            <input
              type="text"
              value={uri}
              onChange={(e) => setUri(e.target.value.slice(0, 200))}
              placeholder="https://…"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-neon/50"
            />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-600 mb-1">
              Extra GigaSwap pool seed (optional, XNT)
            </div>
            <input
              type="text"
              inputMode="decimal"
              value={initialRewardPoolXnt}
              onChange={(e) => setInitialRewardPoolXnt(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="0"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-neon/50"
            />
          </div>

          <button
            onClick={handleCreate}
            disabled={!canSubmit && connected}
            className="w-full py-3 rounded-xl font-bold text-sm uppercase tracking-wide bg-neon text-black disabled:bg-zinc-800 disabled:text-zinc-600 transition"
          >
            {!connected ? "Connect Wallet" : status.type === "loading" ? status.msg : "Create Token"}
          </button>

          {status.type === "error" && <div className="text-xs text-red-400">{status.msg}</div>}
          {status.type === "success" && <div className="text-xs text-neon">{status.msg}</div>}
        </div>
      </div>
    </div>
  );
}
