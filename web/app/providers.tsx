"use client";

import { Buffer } from "buffer";
import type { ReactNode } from "react";
import { useEffect } from "react";

if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer;
}

export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => {
    console.log("[providers] Buffer present:", !!globalThis.Buffer);
  }, []);
  return <>{children}</>;
}
