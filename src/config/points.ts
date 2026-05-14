export const POINTS_CONFIG = {
  wallet_registration: 50,
  starter_rig_purchase: 20,
  pro_rig_purchase: 75,
  industrial_rig_purchase: 150,
  rig_renewal: 50,
  mind_claim: 10,
  first_stake: 50,
  mind_burn_per_100: 25,
  daily_active_rig: 10
} as const;

export type PointCategory = keyof typeof POINTS_CONFIG;
