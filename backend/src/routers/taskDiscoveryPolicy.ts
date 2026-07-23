const TIER_PRICE_LIMITS: Record<number, number> = {
  0: 2000,
  1: 5000,
  2: 20000,
  3: 9999900,
  4: 9999900,
};

export function canUserAcceptTask(userTrustTier: number, taskPrice: number): boolean {
  const priceLimit = TIER_PRICE_LIMITS[userTrustTier] ?? TIER_PRICE_LIMITS[0];
  return taskPrice <= priceLimit;
}

export function getRequiredTierForTask(taskPrice: number): number {
  if (taskPrice <= 2000) return 0;
  if (taskPrice <= 5000) return 1;
  if (taskPrice <= 20000) return 2;
  return 3;
}
