export function formatEventCategory(category: string): string {
  switch (category) {
    case "claim_mind_daily":
      return "Daily MIND claim";
    case "stake_snapshot":
      return "Stake milestone";
    case "wallet_registration":
      return "Wallet registration";
    case "starter_rig_purchase":
      return "Starter rig purchase";
    case "pro_rig_purchase":
      return "Pro rig purchase";
    case "industrial_rig_purchase":
      return "Industrial rig purchase";
    case "starter_renewal":
      return "Starter renewal";
    case "pro_renewal":
      return "Pro renewal";
    case "industrial_renewal":
      return "Industrial renewal";
    case "daily_active_starter":
      return "Starter daily active";
    case "daily_active_pro":
      return "Pro daily active";
    case "daily_active_industrial":
      return "Industrial daily active";
    case "daily_checkin":
      return "Daily check-in";
    default:
      return category.replaceAll("_", " ");
  }
}
