"use client";

import { Buffer } from "buffer";
import type { ReactNode } from "react";

if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer;
}

export function Providers({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
