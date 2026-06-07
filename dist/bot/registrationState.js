const pendingWalletRegistrations = new Set();
export function startWalletRegistration(telegramUserId) {
    pendingWalletRegistrations.add(telegramUserId);
}
export function clearWalletRegistration(telegramUserId) {
    pendingWalletRegistrations.delete(telegramUserId);
}
export function isWalletRegistrationPending(telegramUserId) {
    return pendingWalletRegistrations.has(telegramUserId);
}
