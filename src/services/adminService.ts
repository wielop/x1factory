import { addPoints } from "./pointsService.js";
import { getCurrentSeason } from "./seasonService.js";
import { findUserByTelegramId, findUserByUsername } from "../db/userRepository.js";

function parseUserTarget(input: string): { telegramId?: bigint; username?: string } {
  const normalized = input.trim();

  if (/^\d+$/.test(normalized)) {
    return {
      telegramId: BigInt(normalized)
    };
  }

  return {
    username: normalized.replace(/^@/, "")
  };
}

export async function resolveUserByTelegramUsernameOrId(input: string) {
  const target = parseUserTarget(input);

  if (target.telegramId) {
    return findUserByTelegramId(target.telegramId);
  }

  if (target.username) {
    return findUserByUsername(target.username);
  }

  return null;
}

export async function addManualSeasonPoints(params: {
  telegramUsernameOrId: string;
  points: number;
  reason: string;
}) {
  const activeSeason = await getCurrentSeason();

  if (!activeSeason) {
    throw new Error("No active season found.");
  }

  const user = await resolveUserByTelegramUsernameOrId(params.telegramUsernameOrId);

  if (!user) {
    throw new Error("User not found.");
  }

  const result = await addPoints(
    user.id,
    activeSeason.id,
    params.points,
    params.points >= 0 ? "manual_admin" : "manual_admin_correction",
    params.reason
  );

  return {
    season: activeSeason,
    user,
    result
  };
}
