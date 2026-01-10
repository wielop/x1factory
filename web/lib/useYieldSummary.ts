"use client";

import { useCallback, useEffect, useState } from "react";
import type { YieldSummary } from "@/lib/yieldMath";

type YieldState = {
  data: YieldSummary | null;
  error: string | null;
  loading: boolean;
};

export function useYieldSummary() {
  const [state, setState] = useState<YieldState>({
    data: null,
    error: null,
    loading: true,
  });
  const [refreshToken, setRefreshToken] = useState(0);

  const reload = useCallback(() => {
    setRefreshToken((value) => value + 1);
  }, []);

  const load = useCallback(async (signal: AbortSignal) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetch("/api/yield", { signal });
      if (!res.ok) {
        throw new Error("fetch failed");
      }
      const json = (await res.json()) as YieldSummary;
      if (!signal.aborted) {
        setState({ data: json, error: null, loading: false });
      }
    } catch (err) {
      if (!signal.aborted) {
        setState({ data: null, error: "Unable to load yield estimates", loading: false });
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load, refreshToken]);

  return { ...state, reload };
}
