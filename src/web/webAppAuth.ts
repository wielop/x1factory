import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type TelegramWebAppUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
};

export type TelegramWebAppAuth = {
  user: TelegramWebAppUser;
  authDate: number;
};

const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;

function buildDataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function parseTelegramWebAppAuth(initData: string, botToken: string): TelegramWebAppAuth | null {
  if (!initData) {
    return null;
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDateRaw = params.get("auth_date");
  const userRaw = params.get("user");

  if (!hash || !authDateRaw || !userRaw) {
    return null;
  }

  const authDate = Number(authDateRaw);

  if (!Number.isFinite(authDate) || authDate <= 0) {
    return null;
  }

  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;

  if (ageSeconds < 0 || ageSeconds > MAX_AUTH_AGE_SECONDS) {
    return null;
  }

  const secretKey = createHash("sha256").update(botToken).digest();
  const dataCheckString = buildDataCheckString(params);
  const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash.length !== hash.length) {
    return null;
  }

  const computedBuffer = Buffer.from(computedHash, "hex");
  const providedBuffer = Buffer.from(hash, "hex");

  if (computedBuffer.length !== providedBuffer.length) {
    return null;
  }

  if (!timingSafeEqual(computedBuffer, providedBuffer)) {
    return null;
  }

  try {
    const user = JSON.parse(userRaw) as TelegramWebAppUser;
    if (typeof user?.id !== "number") {
      return null;
    }

    return {
      user,
      authDate
    };
  } catch {
    return null;
  }
}
