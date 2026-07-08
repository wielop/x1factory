"use client";

/** Small filling-vial progress indicator — same visual language as the melt page's charge
 * vial (rounded pill, bottom-anchored gradient fill, glow when "hot"/near-complete). Used here
 * for bonding-curve % sold, since the curve shape itself isn't the main chart anymore. */
export function Vial({
  pct,
  hot = false,
  label,
  sublabel,
}: {
  pct: number;
  hot?: boolean;
  label?: string;
  sublabel?: string;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={`relative h-24 w-9 overflow-hidden rounded-full border bg-black/40 ${
          hot ? "border-cyan-200/70 shadow-[0_0_28px_rgba(34,211,238,0.45)]" : "border-cyan-400/30"
        }`}
      >
        <div
          className={`absolute bottom-0 left-0 right-0 transition-all duration-700 ${
            hot ? "bg-gradient-to-t from-cyan-300 via-cyan-200 to-white animate-pulse" : "bg-gradient-to-t from-cyan-500 to-cyan-200"
          }`}
          style={{ height: `${Math.max(2, clamped)}%` }}
        />
      </div>
      {label && <div className="text-[10px] font-bold text-zinc-300">{label}</div>}
      {sublabel && <div className="text-[9px] text-zinc-600 text-center leading-tight max-w-[70px]">{sublabel}</div>}
    </div>
  );
}
