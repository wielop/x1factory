const pendingWalletRegistrations = new Set<number>();

export function startWalletRegistration(telegramUserId: number): void {
  pendingWalletRegistrations.add(telegramUserId);
}

export function clearWalletRegistration(telegramUserId: number): void {
  pendingWalletRegistrations.delete(telegramUserId);
}

export function isWalletRegistrationPending(telegramUserId: number): boolean {
  return pendingWalletRegistrations.has(telegramUserId);
}
