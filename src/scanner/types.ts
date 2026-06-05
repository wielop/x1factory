export type RigType = "starter" | "pro" | "industrial";

export type ScannerEventType =
  | "starter_rig_purchase"
  | "pro_rig_purchase"
  | "industrial_rig_purchase"
  | "starter_renewal"
  | "pro_renewal"
  | "industrial_renewal"
  | "claim_mind_daily"
  | "stake_snapshot"
  | "daily_active_starter"
  | "daily_active_pro"
  | "daily_active_industrial";

export type UserFactoryPosition = {
  index: number;
  rigType: RigType;
  hp: number;
  startTs: number;
  active: boolean;
  deactivated: boolean;
  expired: boolean;
  endTs: number;
};

export type UserFactoryState = {
  wallet: string;
  activeRigs: number;
  activeStarterCount: number;
  activeProCount: number;
  activeIndustrialCount: number;
  totalActiveHp: number;
  stakedMindAmount: number;
  pendingClaimableMind: number | null;
  lastUpdatedSlot: number;
  positions: UserFactoryPosition[];
};

export type X1FactoryEvent = {
  wallet: string;
  eventType: ScannerEventType;
  txHash: string;
  slot: number;
  blockTime: Date | null;
  amount: number | null;
  rigType: RigType | null;
  raw: Record<string, unknown>;
};

export type ScannerDiagnosticCandidate = {
  txHash: string;
  slot: number;
  blockTime: Date | null;
  instructionNames: string[];
  eventNames: string[];
  rawSummary: string;
  reason?: string;
};

export type ScannerDiagnostics = {
  wallet: string;
  parserConfirmed: boolean;
  parserMessage: string;
  candidates: ScannerDiagnosticCandidate[];
};

export interface IX1FactoryAdapter {
  getUserFactoryState(wallet: string): Promise<UserFactoryState | null>;
  getRecentUserEvents(wallet: string, sinceSlot?: number): Promise<X1FactoryEvent[]>;
  getCurrentSlot(): Promise<number>;
}

export type ScannerCursorSnapshot = {
  seasonId?: number | null;
  state: UserFactoryState | null;
  claimDailyTotals: Record<string, number>;
  awardedDailyActiveKeys: Record<string, string[]>;
  stakeBaselineAmount?: number | null;
};

export type ScannerWalletResult = {
  wallet: string;
  parserConfirmed: boolean;
  parserMessage: string;
  state: UserFactoryState | null;
  events: X1FactoryEvent[];
  diagnostics: ScannerDiagnosticCandidate[];
  currentSlot: number | null;
};

export type ScannerRunSummary = {
  startedAt: Date;
  finishedAt: Date;
  seasonId: number | null;
  walletsScanned: number;
  eventsDetected: number;
  pointsAwarded: number;
  clickerTopUpsDetected: number;
  clickerClaimsSettled: number;
  errors: number;
  message: string;
};
