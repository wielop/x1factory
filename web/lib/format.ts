import { rpcUrl } from "@/lib/solana";

export function shortPk(pk: string, chars = 4) {
  if (pk.length <= chars * 2 + 3) return pk;
  return `${pk.slice(0, chars)}…${pk.slice(-chars)}`;
}

export function formatDurationSeconds(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(" ");
}

export function formatCountdownHms(totalSeconds: number | null | undefined, endedLabel = "Ended") {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return endedLabel;
  const s = Math.floor(totalSeconds);
  if (s <= 0) return endedLabel;
  const hours = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return `${hours}h ${mins.toString().padStart(2, "0")}m ${secs.toString().padStart(2, "0")}s`;
}

export function formatUnixTs(ts: number | null | undefined) {
  if (!ts && ts !== 0) return "-";
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return String(ts);
  }
}

export function formatTokenAmount(amountBase: bigint, decimals: number, maxFrac = 6) {
  const base = 10n ** BigInt(decimals);
  const whole = amountBase / base;
  const frac = amountBase % base;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
}

export function parseUiAmountToBase(amountUi: string, decimals: number): bigint {
  const trimmed = amountUi.trim();
  if (!trimmed) throw new Error("Amount is required");
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error("Invalid amount format");
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}

export function explorerTxUrl(sig: string) {
  const url = rpcUrl();
  return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(url)}`;
}
