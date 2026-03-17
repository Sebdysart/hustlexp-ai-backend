// backend/src/services/TaskTemplateRegistry.ts

export const TEMPLATE_SLUGS = {
  STANDARD_PHYSICAL:    'standard_physical',
  IN_HOME:              'in_home',
  CARE:                 'care',
  CONTENT_CREATOR:      'content_creator',
  EVENT_APPEARANCE:     'event_appearance',
  CREATIVE_PRODUCTION:  'creative_production',
  SPECIALIZED_LICENSED: 'specialized_licensed',
  WILDCARD_BIZARRE:     'wildcard_bizarre',
} as const;

export type TemplateSlug = typeof TEMPLATE_SLUGS[keyof typeof TEMPLATE_SLUGS];

export type CompletionCriteriaType =
  | 'photo_proof'
  | 'check_in_check_out'
  | 'session_completion'
  | 'hybrid';

export interface TaskTemplate {
  slug: TemplateSlug;
  displayName: string;
  one_line_desc: string;
  defaultRiskTier: 0 | 1 | 2 | 3;
  requiredTrustTier: 'rookie' | 'verified' | 'trusted';
  completionCriteriaType: CompletionCriteriaType;
  autoReleaseHours: number;
  lateCancelPct: number;
  requiresMutualConsent: boolean;
  requiresContentRelease: boolean;
  scoperContext: string;
  wildcardMultipliers?: Record<string, number>;
}

export const WILDCARD_MULTIPLIERS: Record<string, number> = {
  private_location_flag:    0.15,
  props_required_flag:      0.10,
  performance_element_flag: 0.20,
  audience_present_flag:    0.10,
  costume_or_attire_flag:   0.10,
  travel_over_30min_flag:   0.20,
};

export const MAX_WILDCARD_PREMIUM = 0.50;

export const TaskTemplateRegistry: Record<TemplateSlug, TaskTemplate> = {
  standard_physical: {
    slug: 'standard_physical',
    displayName: 'Standard Physical',
    one_line_desc: 'Help moving, delivery, or muscle work out in the world',
    defaultRiskTier: 0,
    requiredTrustTier: 'rookie',
    completionCriteriaType: 'photo_proof',
    autoReleaseHours: 24,
    lateCancelPct: 0,
    requiresMutualConsent: false,
    requiresContentRelease: false,
    scoperContext: `TEMPLATE: standard_physical
Market rate: light labor $15–$30/hr, moderate $25–$50/hr, heavy $40–$75/hr.
Vehicle premium: +$10–$20 flat if required. Multi-person: multiply by count.
$15 floor for any task under 30 min.
Flag "heavy_lifting" if moving furniture, appliances, or heavy boxes.
Flag "vehicle_required" if delivery >2 miles or items too large to carry.`,
  },

  in_home: {
    slug: 'in_home',
    displayName: 'In-Home',
    one_line_desc: 'Cleaning, repairs, or handyman work inside someone\'s home',
    defaultRiskTier: 2,
    requiredTrustTier: 'verified',
    completionCriteriaType: 'photo_proof',
    autoReleaseHours: 24,
    lateCancelPct: 0,
    requiresMutualConsent: false,
    requiresContentRelease: false,
    scoperContext: `TEMPLATE: in_home
Market rate: apartment cleaning $60–$100, house $100–$180, deep clean 1.5–2x.
Handyman: $40–$75/hr. Painting per room: $150–$300.
Never price below $40 for any in-home task.
Flag "licensed_required" if electrical, plumbing, or structural work described.
Always flag "inside_home" — minimum TIER_2 risk.`,
  },

  care: {
    slug: 'care',
    displayName: 'Care',
    one_line_desc: 'Childcare, pet care, elder care, or personal assistance',
    defaultRiskTier: 3,
    requiredTrustTier: 'verified',
    completionCriteriaType: 'check_in_check_out',
    autoReleaseHours: 0,
    lateCancelPct: 0,
    requiresMutualConsent: false,
    requiresContentRelease: false,
    scoperContext: `TEMPLATE: care
Market rate: babysitting 1 child $18–$25/hr, +$5/hr each additional.
Pet sitting 8hr: $40–$80. Dog walk 30min: $20–$35.
Elder care companion: $20–$30/hr. Personal assistant: $18–$28/hr.
ALWAYS TIER_3. Minimum 2-hour duration (30-min pet walks excepted).
Flag "caregiving" always.`,
  },

  content_creator: {
    slug: 'content_creator',
    displayName: 'Content & Creator',
    one_line_desc: 'You appear in someone\'s stream, video, or podcast in person',
    defaultRiskTier: 1,
    requiredTrustTier: 'verified',
    completionCriteriaType: 'hybrid',
    autoReleaseHours: 0,
    lateCancelPct: 75,
    requiresMutualConsent: true,
    requiresContentRelease: true,
    scoperContext: `TEMPLATE: content_creator
IMPORTANT: IRL in-person talent work. NOT digital labor.
Market rate by audience: <1K $20–$50/hr, 1K–10K $40–$80/hr, 10K–100K $75–$150/hr, 100K+ $150–$400/hr.
Minimum 1-hour billing floor. Travel >30min: +$15–$30 flat.
Specialization premium: competitive gaming +20%, music +30%, subject expertise +25%.
DO NOT price like physical labor. Price like talent.`,
  },

  event_appearance: {
    slug: 'event_appearance',
    displayName: 'Event & Appearance',
    one_line_desc: 'Brand promo, party hosting, or crowd work at an event',
    defaultRiskTier: 1,
    requiredTrustTier: 'verified',
    completionCriteriaType: 'check_in_check_out',
    autoReleaseHours: 0,
    lateCancelPct: 100,
    requiresMutualConsent: false,
    requiresContentRelease: false,
    scoperContext: `TEMPLATE: event_appearance
Market rate: general staff $18–$28/hr, brand ambassador $22–$35/hr.
Promo model $30–$60/hr. Party host $40–$80/hr. Product demo $28–$45/hr.
Minimum 3-hour booking. Weekend/evening: +15%.
Hustler-sourced professional attire: +$10–$15 flat.`,
  },

  creative_production: {
    slug: 'creative_production',
    displayName: 'Creative Production',
    one_line_desc: 'Photo shoot, video shoot, music session, or film work',
    defaultRiskTier: 1,
    requiredTrustTier: 'verified',
    completionCriteriaType: 'session_completion',
    autoReleaseHours: 0,
    lateCancelPct: 50,
    requiresMutualConsent: false,
    requiresContentRelease: true,
    scoperContext: `TEMPLATE: creative_production
Market rate: photo shoot personal $50–$100, commercial $150–$400.
Video shoot extra half-day $80–$150, principal $150–$300.
Music session $40–$150. Film background $100–$200/day.
Usage rights multiplier: personal 1x, social commercial 1.5x, advertising 2–3x.
Never under $50 for any production task.`,
  },

  specialized_licensed: {
    slug: 'specialized_licensed',
    displayName: 'Specialized / Licensed',
    one_line_desc: 'Trade work, therapy, notary, or licensed skill services',
    defaultRiskTier: 1,
    requiredTrustTier: 'trusted',
    completionCriteriaType: 'photo_proof',
    autoReleaseHours: 24,
    lateCancelPct: 0,
    requiresMutualConsent: false,
    requiresContentRelease: false,
    scoperContext: `TEMPLATE: specialized_licensed
Market rate: electrician/plumber $75–$150/hr, HVAC $85–$150/hr.
Notary $15–$30/signing. Personal trainer $50–$100/session.
Licensed massage $60–$100/hr. Tutor $30–$60/hr general, $60–$120/hr specialized.
NEVER under $30/hr. Materials cost is separate — do not include in price.
Flag "license_required" for all trade work.`,
  },

  wildcard_bizarre: {
    slug: 'wildcard_bizarre',
    displayName: 'Wildcard / Custom',
    one_line_desc: 'Anything weird, one-off, or hard to categorize',
    defaultRiskTier: 1,
    requiredTrustTier: 'verified',
    completionCriteriaType: 'hybrid',
    autoReleaseHours: 48,
    lateCancelPct: 75,
    requiresMutualConsent: true,
    requiresContentRelease: false,
    wildcardMultipliers: WILDCARD_MULTIPLIERS,
    scoperContext: `TEMPLATE: wildcard_bizarre
One-off IRL performance/participation gig. Price like talent, NOT labor.
Base rate: $25–$100/hr depending on complexity.
DO NOT estimate a weirdness premium — the system applies deterministic multipliers.
Minimum 2-hour floor. $500 constitutional cap applies after multipliers.
Flag "bizarre_custom" + audience_size + performance_element.`,
  },
};

/**
 * Get template by slug. Falls back to wildcard_bizarre for unknown slugs.
 */
export function getTemplate(slug: string): TaskTemplate {
  return TaskTemplateRegistry[slug as TemplateSlug] ?? TaskTemplateRegistry.wildcard_bizarre;
}

/**
 * Get lightweight manifest for iOS template reclassify valve.
 * Returns slug, display_name, and one_line_desc for all 8 templates.
 */
export function getManifest(): Array<{ slug: TemplateSlug; display_name: string; one_line_desc: string }> {
  return Object.values(TaskTemplateRegistry).map(t => ({
    slug: t.slug,
    display_name: t.displayName,
    one_line_desc: t.one_line_desc,
  }));
}

/**
 * Apply deterministic weirdness multipliers to a wildcard base price.
 * Caps total premium at 50%. Final price clamped to maxPriceCents ($500 = 50000 cents).
 */
export function applyWildcardMultipliers(
  basePriceCents: number,
  activeFlags: string[],
  maxPriceCents = 50000
): number {
  const totalMultiplier = activeFlags
    .filter(f => WILDCARD_MULTIPLIERS[f] !== undefined)
    .reduce((sum, f) => sum + WILDCARD_MULTIPLIERS[f], 0);

  const cappedMultiplier = Math.min(totalMultiplier, MAX_WILDCARD_PREMIUM);
  const raw = Math.round(basePriceCents * (1 + cappedMultiplier));
  return Math.min(raw, maxPriceCents);
}
