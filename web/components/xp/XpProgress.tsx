"use client";

import { cn } from "@/components/ui/cn";

export function XpProgress({
  value,
  label,
  sublabel,
  progress,
  className,
}: {
  value: string;
  label: string;
  sublabel?: string;
  progress: number;
  className?: string;
}) {
  return (
    <div className={cn("rounded-3xl border border-white/5 bg-white/5 p-4", className)}>
      <div className="text-3xl font-semibold text-white">{value}</div>
      <div className="mt-2 text-xs text-zinc-400">{label}</div>
      {sublabel ? <div className="mt-1 text-xs text-zinc-500">{sublabel}</div> : null}
      <div className="mt-4 h-2 w-full rounded-full bg-white/5">
        <div className="h-2 rounded-full bg-cyan-300/70" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}
