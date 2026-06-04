import { createHmac, timingSafeEqual } from "crypto";

export type TelegramWebAppUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
};

const MAX_AGE_SECONDS = 24 * 60 * 60;

export function parseTelegramWebAppAuth(
  initData: string,
  botToken: string
): { user: TelegramWebAppUser } | null {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDateRaw = params.get("auth_date");
  const userRaw = params.get("user");

  if (!hash || !authDateRaw || !userRaw) return null;

  const authDate = Number(authDateRaw);
  if (!Number.isFinite(authDate) || authDate <= 0) return null;

  const age = Math.floor(Date.now() / 1000) - authDate;
  if (age < 0 || age > MAX_AGE_SECONDS) return null;

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const dataCheckString = [...params.entries()]
    .filter(([k]) => k !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const computed = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (
    computed.length !== hash.length ||
    !timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(hash, "hex"))
  ) {
    return null;
  }

  try {
    const user = JSON.parse(userRaw) as TelegramWebAppUser;
    if (typeof user?.id !== "number") return null;
    return { user };
  } catch {
    return null;
  }
}
