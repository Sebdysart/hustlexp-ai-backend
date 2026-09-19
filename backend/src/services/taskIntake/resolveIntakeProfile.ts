import type { IntakeProfile, TaskCategory } from './types.js';
import type { TaskFacts } from './taskFacts.js';

export interface IntakeProfileResolution {
  category: TaskCategory;
  profile?: IntakeProfile;
  needsProfileClarification: boolean;
  evidence: string[];
}

export interface ResolveIntakeProfileInput {
  category: TaskCategory;
  raw: string;
  facts?: TaskFacts;
}

const VEHICLE = String.raw`(?:cars?|vehicles?|suvs?|sedans?|trucks?)`;
const CLEANING_ACTION = String.raw`(?:wash(?:ed|ing)?|clean(?:ed|ing)?|detail(?:ed|ing)?|vacuum(?:ed|ing)?|scrub(?:bed|bing)?|mop(?:ped|ping)?|pressure[- ]?wash(?:ed|ing)?|power[- ]?wash(?:ed|ing)?)`;
const SURFACE = String.raw`(?:driveways?|patios?|walkways?|pavement|concrete(?:\s+(?:surface|walkway|path))?|siding|decks?|outdoor\s+surfaces?|exterior\s+surfaces?|(?:outside|exterior)(?:\s+of)?\s+(?:the\s+)?(?:house|home|building))`;
const INDOOR = String.raw`(?:bedrooms?|bathrooms?|kitchens?|living\s+rooms?|apartments?|houses?|homes?|rooms?|offices?|indoor\s+areas?|interiors?)`;

function normalized(value: string): string {
  return value.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
}

function actionTargets(text: string, action: string, target: string): boolean {
  return new RegExp(`\\b${action}\\b[^.!?;]{0,45}\\b${target}\\b|\\b${target}\\b[^.!?;]{0,45}\\b(?:needs?|need|requires?|for|could\\s+use|is\\s+due\\s+for)\\s+(?:a\\s+)?(?:(?:full|complete|interior|exterior)\\s+)?${action}\\b`, 'i').test(text);
}

function directlyTargets(text: string, target: string): boolean {
  return new RegExp(`\\b${CLEANING_ACTION}\\b\\s+(?:(?:the|my|our|this|that|an?)\\s+)?(?:(?:outside|outdoor|exterior|inside|indoor)\\s+)?${target}\\b`, 'i').test(text);
}

export function hasVehicleTarget(text: string): boolean {
  return new RegExp(`\\b${VEHICLE}\\b`, 'i').test(normalized(text));
}

export function hasVehicleTargetedCleaning(text: string): boolean {
  const value = normalized(text);
  return actionTargets(value, CLEANING_ACTION, VEHICLE) || new RegExp(`\\bgive\\s+(?:(?:my|the|this)\\s+)?${VEHICLE}\\s+(?:a\\s+)?(?:(?:full|complete)\\s+)?detail\\b`, 'i').test(value);
}

function hasSurfaceCleaning(text: string): boolean {
  return actionTargets(text, CLEANING_ACTION, SURFACE) || /\b(?:pressure|power)[- ]?wash\b/i.test(text) && new RegExp(`\\b${SURFACE}\\b`, 'i').test(text);
}

function hasIndoorCleaning(text: string, facts?: TaskFacts): boolean {
  const factAreas = facts?.location?.areas?.join(' ') ?? '';
  const explicitIndoorTarget = actionTargets(text, CLEANING_ACTION, INDOOR);
  const indoorArea = new RegExp(`\\b${INDOOR}\\b`, 'i').test(`${text} ${factAreas}`);
  const indoorService = /\b(?:deep\s+clean(?:ed|ing)?|move[- ](?:in|out)\s+clean(?:ed|ing)?|mop(?:ped|ping)?|scrub(?:bed|bing)?|vacuum(?:ed|ing)?)\b/i.test(text);
  return explicitIndoorTarget || indoorService && indoorArea;
}

function hasMechanicalIntent(text: string): boolean {
  return /\b(?:repair|fix|diagnos(?:e|is|ing)|service|maintenance|won't\s+start|will\s+not\s+start|brakes?|brake\s+pads?|batter(?:y|ies)|engines?|check[- ]engine|warning\s+light|transmissions?|mechanical|not\s+drivable|cannot\s+be\s+driven|replace|replacement|oil\s+change|tires?|wipers?|headlights?|taillights?)\b/i.test(text);
}

export function profileCategory(profile: IntakeProfile): 'cleaning' | 'auto' {
  return profile.startsWith('cleaning_') ? 'cleaning' : 'auto';
}

export function isProfileCompatible(category: TaskCategory, profile: IntakeProfile | undefined): boolean {
  return profile === undefined || profileCategory(profile) === category;
}

export function resolveIntakeProfile(input: ResolveIntakeProfileInput): IntakeProfileResolution {
  const text = normalized(input.raw);
  if (input.category !== 'cleaning' && input.category !== 'auto') {
    return { category: input.category, needsProfileClarification: false, evidence: [] };
  }

  const vehicleCleaning = hasVehicleTargetedCleaning(text);
  const mechanical = hasMechanicalIntent(text);
  if (vehicleCleaning && mechanical) {
    return {
      category: 'auto',
      needsProfileClarification: true,
      evidence: ['Vehicle-targeted cleaning and mechanical work are both explicit.'],
    };
  }
  if (vehicleCleaning) {
    return {
      category: 'auto',
      profile: 'auto_cleaning',
      needsProfileClarification: false,
      evidence: ['A cleaning action directly targets a vehicle.'],
    };
  }

  if (input.category === 'auto') {
    if (mechanical) {
      return {
        category: 'auto',
        profile: 'auto_repair',
        needsProfileClarification: false,
        evidence: ['Explicit vehicle repair, maintenance, or fault evidence.'],
      };
    }
    return { category: 'auto', needsProfileClarification: true, evidence: [] };
  }

  const surface = hasSurfaceCleaning(text);
  const indoor = hasIndoorCleaning(text, input.facts);
  if (surface && indoor) {
    if (directlyTargets(text, SURFACE) && !directlyTargets(text, INDOOR)) return { category: 'cleaning', profile: 'cleaning_surface', needsProfileClarification: false, evidence: ['The cleaning action directly targets an exterior surface.'] };
    if (directlyTargets(text, INDOOR) && !directlyTargets(text, SURFACE)) return { category: 'cleaning', profile: 'cleaning_indoor', needsProfileClarification: false, evidence: ['The cleaning action directly targets an indoor area.'] };
    return { category: 'cleaning', needsProfileClarification: true, evidence: ['Indoor and outdoor-surface cleaning are both explicit.'] };
  }
  if (surface) {
    return { category: 'cleaning', profile: 'cleaning_surface', needsProfileClarification: false, evidence: ['A cleaning action directly targets an exterior surface.'] };
  }
  if (indoor) {
    return { category: 'cleaning', profile: 'cleaning_indoor', needsProfileClarification: false, evidence: ['A cleaning action or service directly targets an indoor area.'] };
  }
  return { category: 'cleaning', needsProfileClarification: true, evidence: [] };
}
