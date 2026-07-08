"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Keypair, Transaction } from "@solana/web3.js";
import Link from "next/link";
import { Button } from "@/components/ui/button";

const CREATE_URL = "/api/launchpad/create/prepare";
const UPLOAD_URL = "/api/launchpad/upload";
const OUTPUT_SIZE = 512;

/** Center-crops a File to a square and re-encodes it as a JPEG (keeps upload small/consistent
 * regardless of the source image's aspect ratio or format) — done client-side so the server
 * never has to deal with arbitrary dimensions. */
function cropToSquare(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      const canvas = document.createElement("canvas");
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Canvas not supported"));
      ctx.drawImage(img, sx, sy, side, side, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Crop failed"))), "image/jpeg", 0.9);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not read image"));
    };
    img.src = objectUrl;
  });
}

export default function CreateLaunchpadTokenPage() {
  const router = useRouter();
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [uri, setUri] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [initialRewardPoolXnt, setInitialRewardPoolXnt] = useState("");
  const [status, setStatus] = useState<{ type: "idle" | "loading" | "success" | "error"; msg?: string }>({
    type: "idle",
  });

  const canSubmit =
    connected && name.trim().length > 0 && symbol.trim().length > 0 && status.type !== "loading" && !uploading;

  const handleFile = async (file: File | undefined | null) => {
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const cropped = await cropToSquare(file);
      setPreviewUrl(URL.createObjectURL(cropped));

      const form = new FormData();
      form.append("file", cropped, "token-image.jpg");
      const res = await fetch(UPLOAD_URL, { method: "POST", body: form });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Upload failed");
      setUri(data.url);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
      setPreviewUrl(null);
      setUri("");
    } finally {
      setUploading(false);
    }
  };

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
          Fixed supply 1,000,000,000 — 80% na krzywej, 1% w puli GigaSwap, 14% zarezerwowane na
          graduację, 5% dla Ciebie (bez blokady czasu). Handel startuje natychmiast.
        </p>

        <div className="rounded-3xl border border-cyan-400/10 bg-white/[0.02] p-5 space-y-4">
          <div className="flex items-center gap-3">
            <div className="font-extrabold text-lg truncate">{name.trim() || "Your token name"}</div>
          </div>
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-cyan-200/70 font-mono">${symbol.trim() || "SYMBOL"}</div>
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">Image</div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                handleFile(e.dataTransfer.files?.[0]);
              }}
              className={`flex items-center gap-4 rounded-2xl border-2 border-dashed p-4 cursor-pointer transition ${
                dragOver ? "border-cyan-300/60 bg-cyan-400/5" : "border-white/15 hover:border-cyan-300/40"
              }`}
            >
              <div className="w-20 h-20 rounded-2xl bg-black/30 border border-white/10 flex items-center justify-center flex-shrink-0 overflow-hidden">
                {uploading ? (
                  <span className="text-xs text-zinc-500 animate-pulse">…</span>
                ) : previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewUrl} alt="preview" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-3xl">🖼️</span>
                )}
              </div>
              <div className="min-w-0 flex-1 text-sm">
                <div className="font-bold text-zinc-200">
                  {previewUrl ? "Change image" : "Click or drag an image here"}
                </div>
                <div className="text-xs text-zinc-500 mt-0.5">
                  PNG, JPG, GIF or WebP · max 5MB · auto-cropped to a square
                </div>
              </div>
            </div>
            {uploadError && <div className="text-[11px] text-red-400 mt-1.5">{uploadError}</div>}
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">Name</div>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 32))}
              placeholder="My Memecoin"
              className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-300/50 focus:ring-2 focus:ring-cyan-300/10 transition"
            />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">Symbol</div>
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase().slice(0, 10))}
              placeholder="MEME"
              className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-300/50 focus:ring-2 focus:ring-cyan-300/10 transition"
            />
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
              className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-300/50 focus:ring-2 focus:ring-cyan-300/10 transition"
            />
          </div>

          <Button
            onClick={handleCreate}
            disabled={!canSubmit && connected}
            size="lg"
            className="w-full"
          >
            {!connected ? "Connect Wallet" : status.type === "loading" ? status.msg : uploading ? "Uploading image…" : "Create Token"}
          </Button>

          {connected && status.type === "idle" && !uploading && (!name.trim() || !symbol.trim()) && (
            <div className="text-[11px] text-amber-400/80">
              {!name.trim() && !symbol.trim()
                ? "Fill in a name and symbol to continue."
                : !name.trim()
                ? "Fill in a name to continue."
                : "Fill in a symbol to continue."}
            </div>
          )}
          {status.type === "error" && <div className="text-xs text-red-400">{status.msg}</div>}
          {status.type === "success" && <div className="text-xs text-neon">{status.msg}</div>}
        </div>
      </div>
    </div>
  );
}
