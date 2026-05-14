const SOLANA_BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidWalletAddress(address: string): boolean {
  return SOLANA_BASE58_REGEX.test(address.trim());
}
