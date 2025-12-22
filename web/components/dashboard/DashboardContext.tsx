"use client";

import { createContext, useContext } from "react";
import type { ReactNode } from "react";

// Legacy dashboard context kept minimal for V2 cleanup.
export type DashboardContextValue = Record<string, never>;

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useDashboard must be used within DashboardContext");
  return ctx;
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  return <DashboardContext.Provider value={{}}>{children}</DashboardContext.Provider>;
}
