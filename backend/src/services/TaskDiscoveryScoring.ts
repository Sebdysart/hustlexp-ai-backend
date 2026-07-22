import type { ExplanationContext, MatchingScoreComponents } from './TaskDiscoveryTypes.js';

export function compositeMatchingScore(components: MatchingScoreComponents): number {
  const score = (
    components.trust_multiplier * 0.30
    + components.distance_score * 0.25
    + components.category_match * 0.20
    + components.price_attractiveness * 0.15
    + components.time_match * 0.10
  );
  return Math.max(0, Math.min(1, score));
}

export function trustMultiplier(
  trustTier: number,
  completionRate: number,
  approvalRate: number,
): number {
  return (trustTier / 4) * 0.60
    + (completionRate / 100) * 0.30
    + (approvalRate / 100) * 0.10;
}

export function distanceScore(distanceMiles: number): number {
  if (distanceMiles <= 1) return 1;
  if (distanceMiles <= 3) return 1 - ((distanceMiles - 1) / 2) * 0.3;
  if (distanceMiles <= 5) return 0.7 - ((distanceMiles - 3) / 2) * 0.4;
  if (distanceMiles <= 10) return 0.3 - ((distanceMiles - 5) / 5) * 0.2;
  return 0;
}

export function categoryMatch(
  taskCategory: string,
  preferredCategories: string[],
  categoryExperienceCount: Record<string, number>,
): number {
  const preferred = preferredCategories.includes(taskCategory) ? 1 : 0.6;
  const experience = Math.min((categoryExperienceCount[taskCategory] || 0) / 10, 1);
  return preferred * 0.70 + experience * 0.30;
}

export function priceAttractiveness(
  taskPrice: number,
  preferredMinPrice: number,
  marketAverage: number,
): number {
  const meetsMinimum = taskPrice >= preferredMinPrice ? 1 : 0.5;
  const aboveMarket = taskPrice >= marketAverage ? 1 : 0.7;
  return meetsMinimum * 0.60 + aboveMarket * 0.40;
}

export function timeMatch(deadline: Date | null, availableWindowHours: number): number {
  if (!deadline) return 0.5;
  const hours = (deadline.getTime() - Date.now()) / (1000 * 60 * 60);
  if (hours >= availableWindowHours) return 1;
  if (hours >= availableWindowHours * 0.5) return 0.7;
  return 0.3;
}

export function relevanceScore(
  matchingScore: number,
  createdAt: Date,
  deadline: Date | null,
): number {
  const ageHours = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);
  const freshnessFactor = Math.max(0.5, 1 - (ageHours / (7 * 24)) * 0.5);
  let urgencyFactor = 1;
  if (deadline) {
    const hours = (deadline.getTime() - Date.now()) / (1000 * 60 * 60);
    if (hours < 24 && hours > 0) urgencyFactor = 1.2;
  }
  return matchingScore * freshnessFactor * urgencyFactor;
}

export function generateExplanation(context: ExplanationContext): string {
  if (context.matching_score >= 0.80) {
    return 'Perfect match: High trust, close distance, preferred category.';
  }
  if (context.matching_score >= 0.60) {
    return 'Great match: Good alignment with your profile and preferences.';
  }
  if (context.matching_score >= 0.40) {
    return 'Good match: Reasonable fit for your skills and location.';
  }
  return 'Possible match: May require extra effort, but could be worth it.';
}
