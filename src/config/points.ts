export const POINT_VALUES = {
  wallet_registration: 50,
  starter_rig_purchase: 20,
  pro_rig_purchase: 75,
  industrial_rig_purchase: 150,
  starter_renewal: 10,
  pro_renewal: 40,
  industrial_renewal: 80,
  daily_active_starter: 2,
  daily_active_pro: 8,
  daily_active_industrial: 20,
  daily_checkin: 10
} as const;

export const CLAIM_MIND_DAILY_THRESHOLDS = [
  { minAmount: 500, points: 150 },
  { minAmount: 250, points: 80 },
  { minAmount: 100, points: 30 },
  { minAmount: 50, points: 15 },
  { minAmount: 0.000000001, points: 5 }
] as const;

export const CLAIM_MIND_DAILY_CAP = 150;

export const STAKE_THRESHOLDS = [
  { minAmount: 5000, points: 1200 },
  { minAmount: 2500, points: 600 },
  { minAmount: 1000, points: 250 },
  { minAmount: 500, points: 100 },
  { minAmount: 100, points: 25 }
] as const;

export const STREAK_BONUSES = [
  { days: 3, points: 50 },
  { days: 7, points: 150 },
  { days: 14, points: 350 },
  { days: 21, points: 700 }
] as const;

export const FIXED_EVENT_TYPES = Object.keys(POINT_VALUES) as Array<keyof typeof POINT_VALUES>;

export const SUPPORTED_EVENT_TYPES = [
  ...FIXED_EVENT_TYPES,
  "claim_mind_daily",
  "stake_snapshot"
] as const;

export type SupportedEventType = (typeof SUPPORTED_EVENT_TYPES)[number];
