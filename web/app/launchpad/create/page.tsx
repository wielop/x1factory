"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Keypair, Transaction } from "@solana/web3.js";
import Link from "next/link";
import { Button } from "@/components/ui/button";

const CREATE_URL = "/api/launchpad/create/prepare";

function ImagePreview({ url }: { url: string }) {
  const [broken, setBroken] = useState(false);
  const valid = /^https?:\/\/.+/i.test(url.trim());
  if (!valid) {
    return (
      <div className="w-16 h-16 rounded-2xl bg-white/5 border border-dashed border-white/15 flex items-center justify-center text-2xl flex-shrink-0">
        🖼️
      </div>
    );
  }
  if (broken) {
    return (
      <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-[10px] text-red-300 text-center px-1 flex-shrink-0">
        can&apos;t load
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url.trim()}
      alt="preview"
      onError={() => setBroken(true)}
      className="w-16 h-16 rounded-2xl object-cover border border-cyan-400/20 flex-shrink-0"
    />
  );
}

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
    <div className="min-h-screen bg-[#050810] text-zinc-100 font-sans">
      <div
        className="pointer-events-none fixed inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(ellipse 90% 50% at 50% -10%, rgba(34,242,255,0.10) 0%, transparent 60%)",
        }}
      />
      <div className="sticky top-0 z-10 backdrop-blur-xl bg-[#050810]/85 border-b border-cyan-400/10">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <span className="text-[11px] font-mono font-bold text-neon tracking-widest">
            LAUNCHPAD
          </span>
          <Link href="/launchpad" className="text-[11px] text-zinc-500 hover:text-zinc-300 transition">
            ← All tokens
          </Link>
        </div>
      </div>

      <div className="relative max-w-lg mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold tracking-tight mb-1.5">Create a token</h1>
        <p className="text-sm text-zinc-500 mb-6 leading-relaxed">
          Fixed supply 1,000,000,000 — 80% na krzywej, 10% w puli GigaSwap, 5% zarezerwowane na
          graduację, 5% dla Ciebie (bez blokady czasu). Handel startuje natychmiast.
        </p>

        <div className="rounded-3xl border border-cyan-400/10 bg-white/[0.02] p-5 space-y-4">
          <div className="flex items-center gap-3">
            <ImagePreview url={uri} />
            <div className="min-w-0 flex-1">
              <div className="font-bold text-sm truncate">{name.trim() || "Your token name"}</div>
              <div className="text-xs text-zinc-500 font-mono">${symbol.trim() || "SYMBOL"}</div>
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">Name</div>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 32))}
              placeholder="My Memecoin"
              className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-cyan-300/50 focus:ring-2 focus:ring-cyan-300/10 transition"
            />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">Symbol</div>
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase().slice(0, 10))}
              placeholder="MEME"
              className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-cyan-300/50 focus:ring-2 focus:ring-cyan-300/10 transition"
            />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">
              Image URL
            </div>
            <input
              type="text"
              value={uri}
              onChange={(e) => setUri(e.target.value.slice(0, 200))}
              placeholder="https://…  (imgur, x.com media, any direct image link)"
              className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-cyan-300/50 focus:ring-2 focus:ring-cyan-300/10 transition"
            />
            <div className="text-[10px] text-zinc-600 mt-1">
              Link musi kończyć się bezpośrednio obrazkiem (.png/.jpg/.gif). Bez linku token
              dostanie domyślną ikonę.
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">
              Extra GigaSwap pool seed (optional, XNT)
            </div>
            <input
              type="text"
              inputMode="decimal"
              value={initialRewardPoolXnt}
              onChange={(e) => setInitialRewardPoolXnt(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="0"
              className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-cyan-300/50 focus:ring-2 focus:ring-cyan-300/10 transition"
            />
          </div>

          <Button
            onClick={handleCreate}
            disabled={!canSubmit && connected}
            size="lg"
            className="w-full"
          >
            {!connected ? "Connect Wallet" : status.type === "loading" ? status.msg : "Create Token"}
          </Button>

          {status.type === "error" && <div className="text-xs text-red-400">{status.msg}</div>}
          {status.type === "success" && <div className="text-xs text-neon">{status.msg}</div>}
        </div>
      </div>
    </div>
  );
}
