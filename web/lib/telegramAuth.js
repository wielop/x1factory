import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;

function buildDataCheckString(params) {
  return [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export function parseTelegramAuth(initData, botToken) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDateRaw = params.get('auth_date');
  const userRaw = params.get('user');

  if (!hash || !authDateRaw || !userRaw) return null;

  const authDate = Number(authDateRaw);
  if (!Number.isFinite(authDate) || authDate <= 0) return null;

  const age = Math.floor(Date.now() / 1000) - authDate;
  if (age < 0 || age > MAX_AUTH_AGE_SECONDS) return null;

  const secret = createHash('sha256').update(botToken).digest();
  const computed = createHmac('sha256', secret).update(buildDataCheckString(params)).digest('hex');

  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const user = JSON.parse(userRaw);
    if (typeof user?.id !== 'number') return null;
    return user;
  } catch {
    return null;
  }
}
