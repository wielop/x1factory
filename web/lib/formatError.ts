export function formatError(e: unknown) {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error) {
    const anyErr = e as any;
    const parts: string[] = [];
    parts.push(anyErr?.message ? String(anyErr.message) : e.name);
    if (anyErr?.code != null) parts.push(`code=${anyErr.code}`);
    if (anyErr?.signature) parts.push(`sig=${anyErr.signature}`);
    const logs =
      (Array.isArray(anyErr?.logs) && anyErr.logs.length && anyErr.logs) ||
      (Array.isArray(anyErr?.transactionLogs) &&
        anyErr.transactionLogs.length &&
        anyErr.transactionLogs) ||
      null;
    if (logs) parts.push(`logs:\n${logs.join("\n")}`);
    if (!logs && anyErr?.data) parts.push(`data=${JSON.stringify(anyErr.data)}`);
    return parts.join("\n");
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

