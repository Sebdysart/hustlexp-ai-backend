import { getQuestionsForIntake } from './definitions.js';
import { extractNumericFacts, type NumericFact } from './extractNumericFacts.js';
import { extractObjectFacts, totalObjectQuantity, type ObjectFact } from './extractObjectFacts.js';
import { extractConstraintFacts, type ConstraintFact } from './extractConstraintFacts.js';
import { resolveObjectReferences, type ObjectReferenceFact } from './resolveObjectReferences.js';
import type { IntakeAnswer, IntakeAnswers, IntakeProfile, TaskCategory } from './types.js';

interface Candidate { key: string; value: IntakeAnswer; confidence: number; evidence: string; }
interface QuantifiedItem { quantity: number; item: string; evidence: string; }
export interface IntakePrefillResult { answers: IntakeAnswers; evidence: Array<Candidate>; }
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
function quantityFromToken(token: string): number | null { const normalized = token.toLowerCase(); if (normalized === 'a' || normalized === 'an') return 1; if (/^\d+$/.test(normalized)) return Number(normalized); return WORDS[normalized] ?? null; }
function escapeRegex(value: string): string { return value.replace(/[.*+?^{}()|[\]\\]/g, '\\$&'); }

function add(items: Candidate[], candidate: Candidate): void { const i = items.findIndex((item) => item.key === candidate.key); if (i < 0) items.push(candidate); else if (candidate.confidence > items[i].confidence) items[i] = candidate; }
function setCandidate(candidates: Candidate[], candidate: Candidate): void { const existingIndex = candidates.findIndex((existing) => existing.key === candidate.key); if (existingIndex === -1) { candidates.push(candidate); return; } if (candidate.confidence >= candidates[existingIndex].confidence) candidates[existingIndex] = candidate; }
function removeCandidate(candidates: Candidate[], key: string): void { const index = candidates.findIndex((candidate) => candidate.key === key); if (index >= 0) candidates.splice(index, 1); }
function numericFactsForRole(facts: NumericFact[], role: NumericFact['role']): NumericFact[] { return facts.filter((fact) => fact.role === role); }
function sumNumericFacts(facts: NumericFact[], role: NumericFact['role']): number | undefined { const matching = numericFactsForRole(facts, role); return matching.length ? matching.reduce((total, fact) => total + fact.value, 0) : undefined; }
function numberBefore(
  text: string,
  nouns: readonly string[],
): {
  value: number;
  evidence: string;
} | null {
  const nounSet = new Set(
    nouns.map((noun) => noun.toLowerCase()),
  );
  const tokens = text.match(/\d+|[a-z][\w'-]*/gi) ?? [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].toLowerCase();
    const value = /^\d+$/.test(token) ? Number(token) : WORDS[token];

    if (!Number.isFinite(value)) continue;

    const maxNounIndex = Math.min(index + 3, tokens.length - 1);
    for (let nounIndex = index + 1; nounIndex <= maxNounIndex; nounIndex += 1) {
      const possibleNoun = tokens[nounIndex].toLowerCase();
      if (!nounSet.has(possibleNoun)) continue;
      return {
        value,
        evidence: tokens.slice(index, nounIndex + 1).join(' '),
      };
    }
  }

  return null;
}
function stripObjectNoise(value: string): string { return value.toLowerCase().replace(/\b(?:ikea|new|old|large|small|huge|heavy|very heavy|extremely heavy)\b/gi, '').replace(/\b\d+(?:-\w+)?\b/gi, '').replace(/\b(?:across town|in my backyard|in the backyard|in my garage|in the garage|to my house|to my home|to my property)\b.*$/i, '').replace(/\b(?:that(?:'s| is)|which is|but)\b.*$/i, '').replace(/\s+/g, ' ').trim(); }
function cleanObjectPhrase(value: string): string | null {
  let result = value
    .trim()
    .replace(/^(?:my|our|the|a|an|some|this|that|these|those)\s+/i, '')
    .replace(/^(?:new|old)\s+/i, '')
    .replace(/^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+/i, '')
    .replace(/\b(?:today|tomorrow|tonight|please|asap)\b.*$/i, '')
    .replace(/\bover\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hours?|hrs?|minutes?|mins?)\b.*$/i, '')
    .replace(/\bon\s+floor\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b.*$/i, '')
    .replace(/\bon\s+(?:the\s+)?(?:\d+(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+floor\b.*$/i, '')
    .replace(/[;,].*$/i, '')
    .replace(/\b(?:no vehicle is required|no vehicle required|vehicle is required|truck is needed|van is needed)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  result = stripObjectNoise(result);
  return !result || result.length > 100 || /^(?:it|them|this|that|these|those)$/i.test(result) ? null : result;
}
function extractActionObject(text: string, actions: readonly string[]) { const actionPattern = actions.map(escapeRegex).join('|'); const boundary = ['and', 'then', 'bring', 'deliver', 'transport', 'assemble', 'build', 'install', 'mount', 'anchor', 'attach', 'set up', 'put together', 'move', 'carry', 'take', 'from', 'to', 'into', 'onto', 'upstairs', 'downstairs', 'outside', 'inside', 'with', 'a vehicle', 'a truck', 'a van', 'no vehicle', 'vehicle is', 'truck is', 'van is'].map(escapeRegex).join('|'); const match = text.match(new RegExp('\\b(?:' + actionPattern + ')\\b\\s+(.{1,100}?)(?=\\s+(?:' + boundary + ')\\b|[.;]|$)', 'i')); if (!match) return null; const object = cleanObjectPhrase(match[1]); return object ? { object, evidence: match[0] } : null; }
function enumCandidate(text: string, key: string, values: Array<[string, RegExp[]]>): Candidate | null { for (const [value, patterns] of values) for (const pattern of patterns) if (pattern.test(text)) return { key, value, confidence: 0.97, evidence: 'Explicit ' + value + ' reference' }; return null; }
function extractAccess(text: string): Candidate | null { if (/\bupstairs\b/i.test(text)) return { key: 'access_restrictions', value: 'The task involves carrying or accessing items upstairs.', confidence: 0.96, evidence: 'upstairs' }; if (/\bdownstairs\b/i.test(text)) return { key: 'access_restrictions', value: 'The task involves carrying or accessing items downstairs.', confidence: 0.96, evidence: 'downstairs' }; return null; }
function extractRoomCount(text: string): number | undefined { let total = 0; let found = false; const matches = text.matchAll(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)[- ](?:bedrooms?|bathrooms?|rooms?)\b/gi); for (const match of matches) { const value = quantityFromToken(match[1]); if (value !== null) { total += value; found = true; } } if (/\bkitchen\b/i.test(text)) { total += 1; found = true; } return found ? total : undefined; }
function extractAccessRestriction(text: string): string | undefined { const parts: string[] = []; if (/\bnarrow\s+(?:staircase|stairs|hallway|corridor|doorway)\b/i.test(text)) parts.push('Access is narrow and may restrict movement.'); if (/\bno elevator\b|\belevator unavailable\b/i.test(text)) parts.push('No elevator is available.'); if (/\bwater\s+(?:is\s+)?(?:currently\s+)?shut\s*off\b/i.test(text)) parts.push('Water is currently unavailable at the property.'); if (/\bno (?:outdoor )?power outlet\b|\bno electricity\b/i.test(text)) parts.push('Required electrical power may not be available.'); if (/\bunderground garage\b/i.test(text)) parts.push('The vehicle or work area is in an underground garage.'); return parts.length ? parts.join(' ') : undefined; }
function extractCounts(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  return candidates;
}

function cleanCompoundItem(value: string): string | null { const cleaned = value.replace(/^(?:my|our|the|some|this|that|these|those|new|old)\s+/i, '').replace(/\s+(?:up|down|upstairs|downstairs|inside|outside)$/i, '').replace(/\s+over\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hours?|minutes?)\b.*$/i, '').replace(/\s+on\s+(?:floor\s+\d+|(?:the\s+)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+floor|drywall|brick|concrete|plaster)\b.*$/i, '').replace(/\s+/g, ' ').trim(); return !cleaned || cleaned.length > 80 ? null : cleaned; }
function extractQuantifiedItems(raw: string): QuantifiedItem[] {
  const text = raw.toLowerCase().replace(/[;:]/g, ',').replace(/\s+/g, ' ').trim();
  const quantityTokens = new Set(['a', 'an', ...Object.keys(WORDS)]);
  const tokens = text.match(/\d+|[a-z][\w'-]*|,/gi) ?? [];
  const items: QuantifiedItem[] = [];
  const hardBoundaries = new Set(['then', 'from', 'to', 'into', 'onto', 'upstairs', 'downstairs', 'outside', 'inside', 'deliver', 'transport', 'assemble', 'build', 'move', 'carry', 'install', 'mount']);
  const nonItemTokens = new Set(['time', 'times', 'hour', 'hours', 'minute', 'minutes', 'day', 'days', 'week', 'weeks', 'flight', 'flights', 'stair', 'stairs', 'staircase', 'floor', 'floors', 'story', 'stories', 'room', 'rooms', 'bedroom', 'bedrooms', 'guest', 'guests', 'person', 'people', 'attendee', 'attendees', 'mile', 'miles', 'foot', 'feet', 'inch', 'inches', 'meter', 'meters']);
  const isNonItemPhrase = (value: string) => value.toLowerCase().split(/\s+/).filter(Boolean).some((word) => nonItemTokens.has(word));
  const isQuantity = (token: string) => /^\d+$/.test(token) || quantityTokens.has(token);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].toLowerCase();
    if (!isQuantity(token)) continue;
    const quantity = quantityFromToken(token);
    if (quantity === null || quantity <= 0) continue;
    const itemTokens: string[] = [];
    let cursor = index + 1;
    while (cursor < tokens.length) {
      const current = tokens[cursor].toLowerCase();
      if (current === ',' || current === 'and' || hardBoundaries.has(current)) break;
      if (itemTokens.length && isQuantity(current)) break;
      itemTokens.push(current);
      cursor += 1;
    }
    const item = cleanCompoundItem(itemTokens.join(' '));
    if (!item || isNonItemPhrase(item)) continue;
    items.push({ quantity, item, evidence: [token, ...itemTokens].join(' ') });
    index = Math.max(index, cursor - 1);
  }
  return items;
}

function totalQuantity(items: readonly QuantifiedItem[]): number { return items.reduce((total, item) => total + item.quantity, 0); }
function compoundItemDescription(items: readonly QuantifiedItem[]): string | null { return items.length ? items.map((item) => item.item).join(' and ') : null; }
function applyCompoundItemFacts(text: string, candidates: Candidate[]): void {
  const items = extractQuantifiedItems(text);
  if (items.length < 2) return;
  const total = totalQuantity(items);
  const description = compoundItemDescription(items);
  if (!Number.isFinite(total) || total <= 0) return;
  const evidence = items.map((item) => item.evidence).join(' + ');
  if (/\b(?:assemble|build|put together)\b/i.test(text)) {
    add(candidates, { key: 'assembly_count', value: total, confidence: 0.96, evidence });
    if (description) add(candidates, { key: 'assembly_type', value: description, confidence: 0.95, evidence });
  }
  if (/\b(?:move|moving|carry|load|unload)\b/i.test(text)) add(candidates, { key: 'item_count', value: total, confidence: 0.96, evidence });
}

function extractYardFacts(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const yardWorkTypes: string[] = [];
  if (/\b(?:mow|mowing|cut\s+(?:the\s+)?grass|cut\s+(?:the\s+)?lawn)\b/i.test(text)) yardWorkTypes.push('mowing');
  if (/\b(?:trim|trimming|edge|edging|hedge trimming)\b/i.test(text)) yardWorkTypes.push('trimming');
  if (/\b(?:weed|weeding|pull weeds?)\b/i.test(text)) yardWorkTypes.push('weeding');
  if (/\b(?:leaf cleanup|clean up leaves|rake leaves|remove leaves|leaf piles?)\b/i.test(text)) yardWorkTypes.push('leaf_cleanup');
  if (/\b(?:branch cleanup|clean up branches|remove branches|fallen branches?|tree limbs?)\b/i.test(text)) yardWorkTypes.push('branch_cleanup');
  if (/\b(?:plant|planting)\b[^.!?]{0,35}\b(?:flowers?|plants?|shrubs?|bushes?|trees?)\b/i.test(text)) yardWorkTypes.push('planting');
  if (/\b(?:general yard cleanup|yard cleanup|clean up (?:the\s+)?yard|tidy (?:the\s+)?yard)\b/i.test(text)) yardWorkTypes.push('general_cleanup');
  if (yardWorkTypes.length) add(candidates, { key: 'yard_work_type', value: [...new Set(yardWorkTypes)], confidence: 0.97, evidence: 'Explicit yard-work actions.' });
  const yardSize = enumCandidate(text, 'yard_size', [
    ['small', [/\bsmall\b/i, /\btiny\b/i]],
    ['medium', [/\bmedium\b/i, /\baverage[- ]sized\b/i]],
    ['large', [/\blarge\b/i, /\bbig\b/i, /\bhuge\b/i]],
  ]);
  if (yardSize) add(candidates, yardSize);
  const debrisTypes: string[] = [];
  const mentionsLeavesAsDebris = /\bleaves\b/i.test(text) || /\bleaf\s+(?:pile|piles|litter|debris|waste)\b/i.test(text);
  if (mentionsLeavesAsDebris) debrisTypes.push('leaves');
  if (/\b(?:tree\s+)?branch(?:es)?\b|\btwigs?\b|\bsticks?\b/i.test(text)) debrisTypes.push('branches');
  if (/\bgrass clippings?\b|\bgreen waste\b|\byard waste\b|\bpine needles?\b/i.test(text)) debrisTypes.push('green_waste');
  if (/\bjunk\b|\btrash\b|\brubbish\b|\bgarbage\b/i.test(text)) debrisTypes.push('junk');
  if (debrisTypes.length) add(candidates, { key: 'debris_type', value: [...new Set(debrisTypes)], confidence: 0.96, evidence: 'Explicit yard debris reference' });
  const debrisRemovalRequested =
    /\b(?:remove|haul|take|carry)\b.*\b(?:away|off[- ]site|dispose|disposal)\b/i.test(text) ||
    /\b(?:remove|haul away|dispose of|take away)\b/i.test(text);
  if (debrisRemovalRequested || /\b(?:all of it|everything)\s+gone\b/i.test(text)) add(candidates, { key: 'debris', value: true, confidence: 0.97, evidence: 'Customer explicitly requests debris removal or disposal.' });
  const equipmentNotProvided =
    /\b(?:you|provider|worker)\s+(?:will\s+)?need\s+to\s+bring\s+(?:a|an|the|your\s+own)?\s*(?:mower|lawn mower|rake|leaf blower|trimmer|weed whacker|edger|yard tools?|gardening tools?)\b/i.test(text) ||
    /\bbring\s+(?:a|an|the|your\s+own)?\s*(?:mower|lawn mower|rake|leaf blower|trimmer|weed whacker|edger|yard tools?|gardening tools?)\b/i.test(text) ||
    /\b(?:i|we)\s+(?:do not|don't|dont|do n't)\s+have\s+(?:a|an|the|any)?\s*(?:mower|lawn mower|rake|leaf blower|trimmer|weed whacker|edger|yard tools?|gardening tools?)\b/i.test(text) ||
    /\bno\s+(?:mower|lawn mower|rake|leaf blower|trimmer|weed whacker|edger|yard tools?|gardening tools?)\s+(?:available|provided|here|on[- ]site)\b/i.test(text);
  if (equipmentNotProvided) add(candidates, { key: 'equipment_provided', value: false, confidence: 0.98, evidence: 'Customer explicitly states the provider must bring yard equipment.' });
  const equipmentProvided =
    /\b(?:i|we)\s+(?:have|already have|can provide|will provide)\s+(?:a|an|the|my|our)?\s*(?:mower|lawn mower|rake|leaf blower|trimmer|weed whacker|edger|yard tools?|gardening tools?)\b/i.test(text) ||
    /\b(?:mower|lawn mower|rake|leaf blower|trimmer|weed whacker|edger|yard tools?|gardening tools?)\s+(?:is|are)\s+(?:available|provided|here|on[- ]site)\b/i.test(text) ||
    /\b(?:mower|lawn mower|rake|leaf blower|trimmer|weed whacker|edger|yard tools?|gardening tools?)\s+(?:you can|for you to)\s+use\b/i.test(text);
  if (equipmentProvided && !equipmentNotProvided) add(candidates, { key: 'equipment_provided', value: true, confidence: 0.97, evidence: 'Customer explicitly states yard equipment is available.' });
  return candidates;
}

function ordinalSuffix(value: number): string { const mod100 = value % 100; if (mod100 >= 11 && mod100 <= 13) return 'th'; switch (value % 10) { case 1: return 'st'; case 2: return 'nd'; case 3: return 'rd'; default: return 'th'; } }
function buildAccessRestrictionSummary(facts: ConstraintFact[]): string | undefined {
  const parts: string[] = [];
  const floor = facts.find((fact) => fact.type === 'floor_access');
  const flights = facts.find((fact) => fact.type === 'stair_flights');

  if (floor && typeof floor.value === 'number') {
    parts.push(`Access involves the ${floor.value}${ordinalSuffix(floor.value)} floor.`);
  } else if (flights && typeof flights.value === 'number') {
    parts.push(`${flights.value} flight${flights.value === 1 ? '' : 's'} of stairs ${flights.value === 1 ? 'is' : 'are'} involved.`);
  } else if (facts.some((fact) => fact.type === 'stairs')) {
    parts.push('The task involves stair access.');
  } else if (facts.some((fact) => fact.type === 'elevator_available' && fact.value === true)) {
    parts.push('An elevator is available.');
  }

  if (facts.some((fact) => fact.type === 'no_elevator')) parts.push('No elevator is available.');
  if (facts.some((fact) => fact.type === 'narrow_access')) parts.push('Access is narrow and may restrict movement.');
  if (facts.some((fact) => fact.type === 'water_unavailable')) parts.push('Water is currently unavailable.');
  if (facts.some((fact) => fact.type === 'power_unavailable')) parts.push('Required electrical power may not be available.');
  if (facts.some((fact) => fact.type === 'underground_garage')) parts.push('The work area is in an underground garage.');
  if (facts.some((fact) => fact.type === 'approval_required')) parts.push('Landlord approval may be required.');
  if (facts.some((fact) => fact.type === 'time_window_restriction')) parts.push('Building rules restrict when the work can occur.');
  return parts.length ? parts.join(' ') : undefined;
}
function normalizeAssemblyType(value: string): string { return value.toLowerCase().replace(/\bchildren['’]s\b/gi, '').replace(/\bikea\b/gi, '').replace(/\b(?:large|small|huge|new|old)\b/gi, '').replace(/\bover\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hours?|hrs?|minutes?|mins?)\b.*$/i, '').replace(/\bon\s+floor\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b.*$/i, '').replace(/\bon\s+(?:the\s+)?(?:\d+(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+floor\b.*$/i, '').replace(/\bon\s+(?:drywall|brick|concrete|plaster)\b.*$/i, '').replace(/\s+(?:and\s+)?mount\s+(?:both|them|it)\b.*$/i, '').replace(/\s+do not\b.*$/i, '').replace(/\s+don't\b.*$/i, '').replace(/\s+/g, ' ').trim(); }
function renderObjectFact(fact: ObjectFact): string { if (fact.quantity !== null && fact.quantity > 1) { const plurals: Record<string,string> = { shelf:'shelves', box:'boxes', chair:'chairs', couch:'couches', washing_machine:'washing machines' }; return plurals[fact.object] ?? (fact.object.endsWith('s') ? fact.object : fact.object + 's'); } return fact.object; }
function normalizeDeliveryItem(value: string): string {
  const normalized = value
    .toLowerCase()
    .split(/[.!?]/, 1)[0]
    .replace(/^\s*(?:my|a|an|some)\s+/i, '')
    .replace(/^\s*(?:new|old)\s+/i, '')
    .replace(/^\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+/i, '')
    .replace(/^\s*(?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an|the|some|several)\s+)?(?:fragile|breakable|heavy|large|huge|new|old)\s+/i, '')
    .replace(/^\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an|the|some|several)\s+/i, '')
    .replace(/\b(?:fragile|breakable|heavy)\b\s*/gi, '')
    .replace(/\band\s+(?:a|an|the)\s+(?:fragile|breakable|heavy)\s+/gi, 'and ')
    .replace(/\band\s+(?:a|an|the)\s+/gi, 'and ')
    .replace(/\bwithout breaking it\b.*$/i, '')
    .replace(/\baway\b.*$/i, '')
    .replace(/\b(?:across town|to a donation center|to my property|to my house|home)\b.*$/i, '')
    .replace(/\s+(?:up|down)(?:stairs|\s+\d+\s+flights?)?\b.*$/i, '')
    .replace(/\s+with\s+no\s+vehicle\b.*$/i, '')
    .replace(/\s+(?:a\s+)?vehicle\s+is\s+required\b.*$/i, '')
    .replace(/\s+(?:you['’]ll|you will)\s+need\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized === 'tv' ? 'TV' : normalized;
}
function extractDeliveryList(text: string): string | undefined {
  const match = text.match(/\b(?:pick\s*up|pickup|collect|deliver|transport|bring|take|haul|grab|carry)\b\s+(.{1,120}?)(?=\s+and\s+(?:bring|deliver|install|assemble|mount|anchor|attach|set\s+up|put\s+together|transport|take|carry)\b|\s+(?:from|to|up|down|with\s+no\s+vehicle)\b|[.!?]|$)/i);
  if (!match || !/\band\b/i.test(match[1])) return undefined;
  const items = match[1].split(/\s+and\s+/i).map((item) => normalizeDeliveryItem(item)).filter(Boolean);
  return items.length > 1 ? items.join(' and ') : undefined;
}
function renderAssemblyReference(fact: ObjectFact | undefined, fallback: string): string {
  if (!fact) return fallback;
  return normalizeAssemblyType(fact.evidence.replace(/^(?:a|an|the|my|some|several|\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+/i, ''));
}
function extractVehicleRequired(text: string): boolean | undefined { if (/\b(?:you(?:'ll| will)?|provider|worker|someone)\s+(?:will\s+)?need(?:s)?\s+(?:a|an)?\s*(?:truck|van|suv|car|vehicle)\b/i.test(text) || /\bneed someone with\s+(?:a|an)\s+(?:truck|van|suv|car|vehicle)\b/i.test(text) || /\bprobably need\s+(?:a|an)\s+(?:truck|van|suv|car|vehicle)\b/i.test(text)) return true; return undefined; } function implicitSingularPetCount(text: string): number { return /\b(?:a|one)\s+(?:parrot|bird|puppy|kitten|dog|cat)\b/i.test(text) ? 1 : 0; }
function hasExplicitVehicleRequirement(text: string): boolean { return explicitlyRequiresVehicle(text); }
function explicitlyRequiresVehicle(text: string): boolean { return /\byou['’]ll need (?:a|an) (?:truck|van|car|suv|vehicle)\b/i.test(text) || /\byou will need (?:a|an) (?:truck|van|car|suv|vehicle)\b/i.test(text) || /\bneed someone with (?:a|an) (?:truck|van|car|suv|vehicle)\b/i.test(text) || /\bprobably need (?:a|an) (?:truck|van|car|suv|vehicle)\b/i.test(text); }

type LeakState = 'CURRENT_POSITIVE' | 'HISTORICAL_STOPPED' | 'CURRENT_NEGATED' | 'NONE';

function classifyLeakState(text: string): LeakState {
  if (/\b(?:was|were)\s+(?:leaking|dripping)\b[^.!?]{0,50}\bstopped\b|\b(?:leak|leaking|drip|dripping)\s+stopped\b|\b(?:leak|leaking|drip|dripping)\b[^.!?]{0,30}\b(?:yesterday|earlier|before)\b|\b(?:isn['’]?t|is\s+not|not)\s+(?:leaking|dripping)\s+(?:anymore|no longer)\b|\bno longer\s+(?:leaking|dripping)\b|\bstopped\s+(?:leaking|dripping)\b/i.test(text)) return 'HISTORICAL_STOPPED';
  if (/\b(?:isn['’]?t|is\s+not|not)\s+(?:leaking|dripping)\b|\b(?:no|without)\s+(?:any\s+)?(?:active\s+)?leak\b|\bthere\s+isn['’]?t\s+(?:any\s+)?leak\b|\bthere\s+is\s+no\s+leak\b/i.test(text)) return 'CURRENT_NEGATED';
  if (/\b(?:is|are|currently)\s+(?:leaking|dripping)\b|\b(?:leaking|dripping)\s+(?:right now|continuously)\b|\bwater\s+is\s+(?:currently\s+)?dripping\b|\bkeeps?\s+dripping\b|\band\s+(?:currently\s+)?(?:leaking|dripping)\b|\b(?:leaking|dripping)\s+(?:pipe|piping|sink|faucet|tap|toilet|shower|bathtub|tub|drain|water\s+heater)\b/i.test(text)) return 'CURRENT_POSITIVE';
  return 'NONE';
}

function extractExpandedCategoryFacts(text: string, activeCategories: ReadonlySet<TaskCategory>): Candidate[] {
  const candidates: Candidate[] = [];
  if (activeCategories.has('painting')) {
    const surface = enumCandidate(text, 'painting_surface', [
      ['exterior_walls', [/\b(?:exterior|outside)\b[^.!?]{0,30}\b(?:walls?|house)\b/i]],
      ['interior_walls', [/\b(?:interior|inside|living room|bedroom|kitchen|bathroom|hallway|lounge|guest room|dining room|garage|office|nursery)\s+walls?\b/i, /\b(?:paint|repaint|painting|painted|patch)\b[^.!?]{0,50}\bwalls?\b/i, /\bwall\b[^.!?]{0,30}\b(?:patch|paint|repaint)\b/i]],
      ['ceiling', [/\bceilings?\b/i]], ['trim', [/\b(?:trim|baseboards?|moulding|molding)\b/i]],
      ['doors', [/\b(?:front\s+)?doors?\b/i]], ['fence', [/\bfence\b/i]], ['deck', [/\bdeck\b/i]],
    ]); if (surface && !(/\bdon['’]?t\s+paint\b[^.!?]*\b(?:walls?|ceiling|trim|doors?|fence|deck)\b/i.test(text) && surface.value === 'doors')) add(candidates, surface);
    const area = text.match(/\b(living room|bedroom|kitchen|bathroom|hallway|lounge|guest room|dining room|garage|office|nursery|front door|back fence|deck)\b/i); if (area) add(candidates, { key: 'painting_area', value: area[1].toLowerCase(), confidence: 0.95, evidence: area[0] });
    const paintingSize = enumCandidate(text, 'painting_size', [['whole_property', [/\b(?:whole|entire)\s+(?:house|home|property|building)\b/i, /\b(?:all|every)\s+(?:the\s+)?(?:walls?|rooms?)\b/i]], ['several_rooms', [/\b(?:several|multiple|a few)\s+rooms?\b/i, /\b(?:two|three|four|five|six|2|3|4|5|6)\s+rooms?\b/i]], ['one_room', [/\b(?:one|1|single)\s+room\b/i, /\b(?:paint|repaint)\s+(?:the\s+)?(?:bedroom|kitchen|bathroom|living room|office|garage)\b/i]], ['small_feature', [/\b(?:one|single)\s+(?:door|wall|fence panel|small area|section)\b/i, /\bsmall\s+(?:area|section|patch)\b/i]]]); if (paintingSize) add(candidates, paintingSize);
    const surfaceCondition = enumCandidate(text, 'surface_condition', [['damaged', [/\b(?:water[- ]damaged|badly damaged|damaged drywall|damaged wall|surface damage)\b/i]], ['peeling_or_cracked', [/\b(?:peeling|flaking|cracked|cracks)\b/i]], ['minor_wear', [/\b(?:minor wear|scuffs?|small marks?|light wear)\b/i]], ['good', [/\b(?:surface|walls?)\s+(?:is|are)\s+(?:in\s+)?good condition\b/i, /\bclean\s+(?:and\s+)?(?:undamaged\s+)?walls?\b/i]]]); if (surfaceCondition) add(candidates, surfaceCondition);
    const paintNotProvided = /\bpaint\s+is\s+not\s+provided\b|\b(?:you|provider)\s+(?:need\s+to\s+)?(?:bring|supply|provide)\s+(?:the\s+)?paint\b|(?:^|[.!?;,]\s*)(?:bring|supply|provide)\s+(?:the\s+)?paint\b|\b(?:i|we)\s+don['’]?t\s+have\s+(?:the\s+)?paint\b|\bpaint\s+isn['’]?t\s+here\b/i.test(text);
    const paintProvided = /\b(?:already\s+have|have|bought)\s+(?:the\s+)?paint\b|\bpaint\s+(?:has\s+already\s+been\s+)?purchased\b|\bpaint\s+is\s+(?:already\s+)?here\b|\bpaint\s+is\s+provided\b/i.test(text);
    if (paintNotProvided || /\b(?:you['’]?ll|you)\s+need\s+to\s+bring\s+(?:the\s+)?paint\b/i.test(text)) add(candidates, { key: 'paint_provided', value: false, confidence: 0.99, evidence: 'Explicit provider paint responsibility.' });
    if (/\b(?:i['’]?ll|i\s+will|we['’]?ll|we\s+will)\s+(?:supply|provide)\s+(?:the\s+)?paint\b|\b(?:we|i)\s+bought\s+(?:all\s+the\s+)?paint\b|\bpaint\s+is\s+(?:already\s+)?(?:on site|here)\b/i.test(text)) setCandidate(candidates, { key: 'paint_provided', value: true, confidence: 1.0, evidence: 'Customer explicitly provides paint.' });
    else if (paintProvided) add(candidates, { key: 'paint_provided', value: true, confidence: 0.98, evidence: 'Explicit paint availability.' });
    const noPrep = /\bno\s+(?:prep|preparation)\s+(?:needed|required)\b|\b(?:surface|walls?)\s+are\s+ready\s+(?:to\s+paint|for\s+paint)\b|\bready\s+for\s+paint\b/i.test(text);
    const readyPrep = /\b(?:already\s+prepped|already\s+prepared|surface\s+is\s+ready|walls?\s+are\s+ready|surface\s+is\s+ready\s+to\s+go|ready\s+(?:to\s+paint|for\s+painting))\b/i.test(text);
    if (noPrep || readyPrep) add(candidates, { key: 'prep_needed', value: false, confidence: 0.99, evidence: 'Explicitly no painting preparation required.' });
    else if (/\b(?:sand|sanding|scrape|scraping|patch|patching|strip|stripping|prime|priming|prep(?:aration)?|surface prep)\w*\b/i.test(text)) add(candidates, { key: 'prep_needed', value: true, confidence: 0.98, evidence: 'Explicit painting preparation.' });
    const prepDetails: string[] = []; if (/\bpatch(?:ing)?\b/i.test(text)) prepDetails.push('patching'); if (/\bsand(?:ing)?\b/i.test(text)) prepDetails.push('sanding'); if (/\bscrap(?:e|ing)\b/i.test(text)) prepDetails.push('scraping'); if (/\bstrip(?:ping)?\b/i.test(text)) prepDetails.push('stripping'); if (/\bprim(?:e|ing)\b/i.test(text)) prepDetails.push('priming'); if (prepDetails.length) setCandidate(candidates, { key: 'prep_details', value: [...new Set(prepDetails)], confidence: 0.98, evidence: 'Explicit painting preparation work.' });
    if (/\b(?:high|tall|two[- ]story|second[- ]story|double[- ]height|vaulted)\s+(?:walls?|ceiling|exterior|area)\b|\b(?:ladder|scaffolding)\s+(?:needed|required)\b/i.test(text)) add(candidates, { key: 'high_access', value: true, confidence: 0.97, evidence: 'Explicit high or difficult painting access.' });
    if (/\b(?:no ladder|no scaffolding|easy to reach|ground[- ]level only)\b/i.test(text)) setCandidate(candidates, { key: 'high_access', value: false, confidence: 0.97, evidence: 'Painting area explicitly described as easily accessible.' });
    if (/\b(?:dark|black|navy|brown|deep)\b[^.!?]{0,35}\b(?:to|into)\s+(?:white|cream|light|lighter)\b/i.test(text)) add(candidates, { key: 'color_change', value: 'dark_to_light', confidence: 0.94, evidence: 'Explicit dark-to-light paint change.' }); else if (/\b(?:white|cream|light|lighter)\b[^.!?]{0,35}\b(?:to|into)\s+(?:dark|black|navy|brown|deep)\b/i.test(text)) add(candidates, { key: 'color_change', value: 'light_to_dark', confidence: 0.94, evidence: 'Explicit light-to-dark paint change.' }); else if (/\b(?:same|similar)\s+(?:color|colour|shade)\b/i.test(text)) add(candidates, { key: 'color_change', value: 'similar', confidence: 0.96, evidence: 'Similar paint color explicitly requested.' });
    if (/\b(?:water damage|peeling(?: paint)?|cracks?|cracked|damaged (?:wall|surface)|wall has cracks?)\b/i.test(text)) add(candidates, { key: 'existing_damage', value: true, confidence: 0.97, evidence: 'Explicit paint-surface damage.' });
    const coats = text.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+coats?\b/i); if (coats) { const n = quantityFromToken(coats[1]); if (n) add(candidates, { key: 'coat_count', value: n, confidence: 0.99, evidence: coats[0] }); }
  }
  if (activeCategories.has('handyman')) {
    const jobType = enumCandidate(text, 'handyman_job_type', [['installation', [/\binstall(?:ing|ation)?\b/i, /\bput\s+in\b/i]], ['replacement', [/\breplace(?:ment|d|ing)?\b/i, /\bswap(?:ping)?\s+out\b/i]], ['mounting', [/\bmount(?:ing)?\b/i, /\bhang(?:ing)?\b[^.!?]{0,30}\b(?:wall|tv|shelf|mirror|cabinet)\b/i]], ['adjustment', [/\badjust(?:ment|ing)?\b/i, /\brealign(?:ment|ing)?\b/i]], ['maintenance', [/\bmaintenance\b/i, /\bservice(?:ing)?\b/i]], ['repair', [/\brepair(?:ing)?\b/i, /\bfix(?:ing)?\b/i]]]); if (jobType) add(candidates, jobType);
    const workCount = text.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:items?|fixtures?|doors?|shelves?|cabinets?|areas?)\b/i); if (workCount) { const value = quantityFromToken(workCount[1]); if (value) add(candidates, { key: 'work_count', value, confidence: 0.94, evidence: workCount[0] }); }
    const itemCondition = enumCandidate(text, 'item_condition', [['new_installation', [/(?:brand[- ]new|new)\b[^.!?]{0,30}\b(?:install|mount|fit)\b/i]], ['not_working', [/\b(?:not working|doesn['’]?t work|won['’]?t work|stopped working)\b/i]], ['partially_broken', [/\b(?:partially broken|sometimes works|intermittent)\b/i]], ['damaged', [/\b(?:broken|damaged|cracked)\b/i]], ['working_but_needs_adjustment', [/\b(?:still works|working)\b[^.!?]{0,40}\b(?:adjust|realign|tighten)\b/i]]]); if (itemCondition) add(candidates, itemCondition);
  }
  if (activeCategories.has('home_services')) {
    const serviceScale = enumCandidate(text, 'service_scale', [['whole_property', [/\b(?:whole|entire)\s+(?:house|home|property|building)\b/i]], ['multiple_areas', [/\b(?:multiple|several|a few)\s+(?:rooms?|areas?|locations?)\b/i]], ['single_area', [/\b(?:one|single)\s+(?:room|area)\b/i]], ['single_item', [/\b(?:one|single)\s+(?:item|fixture|unit|appliance)\b/i]]]); if (serviceScale) add(candidates, serviceScale);
    if (/\b(?:can['’]?t|cannot|unable to)\s+(?:use|operate)\b|\b(?:not usable|unusable|out of service)\b/i.test(text)) add(candidates, { key: 'currently_usable', value: false, confidence: 0.96, evidence: 'Affected area or system explicitly unusable.' }); else if (/\b(?:still usable|still works|can still use|working normally)\b/i.test(text)) add(candidates, { key: 'currently_usable', value: true, confidence: 0.96, evidence: 'Affected area or system explicitly remains usable.' });
  }
  if (activeCategories.has('other')) {
    const location = enumCandidate(text, 'work_location_type', [['multiple_locations', [/\b(?:multiple|several|two|three)\s+locations?\b/i, /\bbetween\s+(?:two|multiple)\s+locations?\b/i]], ['business', [/\b(?:office|store|shop|warehouse|commercial property|business premises)\b/i]], ['outdoors', [/\b(?:outside|outdoors?|exterior|backyard|front yard)\b/i]], ['indoors', [/\b(?:inside|indoors?|interior|room|apartment|house)\b/i]], ['vehicle', [/\b(?:car|vehicle|truck|suv|van)\b/i]]]); if (location) add(candidates, location);
    if (/\b(?:heavy|bulky|awkward|fragile|very large|oversized)\b/i.test(text)) add(candidates, { key: 'heavy_or_awkward', value: true, confidence: 0.94, evidence: 'Explicit heavy, bulky, fragile, or awkward work.' });
    if (/\b(?:provider|you)\s+(?:need|needs|will need|should)\s+to\s+(?:bring|supply|provide)\s+(?:the\s+)?(?:materials?|parts?|supplies?)\b/i.test(text)) add(candidates, { key: 'materials_needed', value: true, confidence: 0.96, evidence: 'Provider explicitly needs to supply materials.' });
    if (/\b(?:i|we|customer)\s+(?:already\s+)?(?:have|provide|will provide)\s+(?:all\s+)?(?:the\s+)?(?:materials?|parts?|supplies?)\b/i.test(text)) setCandidate(candidates, { key: 'materials_needed', value: false, confidence: 0.96, evidence: 'Customer explicitly provides required materials.' });
  }
  if (activeCategories.has('plumbing')) {
    const compoundDrain = /\b(?:bathtub|tub|shower|sink)\s+drain\b/i.test(text);
    const fixture = enumCandidate(text, 'plumbing_fixture', [['water_heater', [/\bwater\s+heaters?\b/i]], ['bathtub', [/\b(?:bathtub|tub)\b/i]], ['faucet', [/\b(?:faucets?|taps?)\b/i]], ['toilet', [/\btoilets?\b/i]], ['shower', [/\bshowers?\b/i]], ['sink', [/\bsinks?\b/i]], ['pipe', [/\bpipes?|piping\b/i]], ['drain', [/\bdrains?\b/i]]]); if (fixture) add(candidates, fixture);
    const headFixture = text.match(/\b(pipe|drain)\b\s+(?:under|below|behind|beside|next\s+to|near)\b/i);
    if (headFixture) setCandidate(candidates, { key: 'plumbing_fixture', value: headFixture[1].toLowerCase(), confidence: 0.99, evidence: headFixture[0] });
    if (compoundDrain) setCandidate(candidates, { key: 'plumbing_fixture', value: 'drain', confidence: 0.99, evidence: 'Explicit compound drain fixture.' });
    const leakState = classifyLeakState(text);
    let issue = enumCandidate(text, 'plumbing_issue', [
      ['clog', [/\b(?:clog|clogged|blocked|unclog)\b/i]],
      ['low_pressure', [
        /\b(?:low|weak)\s+(?:water\s+)?pressure\b/i,
        /\bwater\s+pressure\s+(?:is\s+)?(?:very|really|extremely)?\s*(?:low|weak)\b/i,
        /\b(?:pressure|water pressure)\s+is\s+(?:really|very|extremely)?\s*weak\b/i,
      ]],
      ['no_water', [/\b(?:no water|not getting water|no hot water)\b/i]],
      ['installation', [/\b(?:install|installing|installation)\b/i, /\bneeds?\s+(?:installing|to be installed)\b/i, /\bnew\s+(?:sink|toilet|shower|bathtub|tub|faucet|pipe|water heater|drain)\b[^.!?]{0,20}\binstalled\b/i]],
      ['replacement', [/\b(?:replace|replacement)\b/i, /\bneeds?\s+(?:replacing|to be replaced)\b/i, /\brequires?\s+replacement\b/i]],
      ['repair', [/\b(?:repair|fix|fixing)\b/i, /\bneeds?\s+(?:repair|to be repaired)\b/i, /\brequires?\s+repair\b/i]],
    ]);
    const requestedOperation = /\b(?:install|installing|installation)\b/i.test(text) ? 'installation' : /\b(?:replace|replacement)\b/i.test(text) ? 'replacement' : /\b(?:repair|fix|fixing)\b/i.test(text) ? 'repair' : undefined;
    if (requestedOperation && (!issue || issue.value === 'repair')) issue = { key: 'plumbing_issue', value: requestedOperation, confidence: 0.98, evidence: 'Explicit requested plumbing operation.' };
    if (!issue && (leakState === 'CURRENT_POSITIVE' || leakState === 'HISTORICAL_STOPPED')) issue = { key: 'plumbing_issue', value: 'leak', confidence: 0.97, evidence: 'Explicit leak-related plumbing issue.' };
    if (issue) add(candidates, issue);
    const plumbingScope = enumCandidate(text, 'issue_scope', [
      ['whole_property', [/\b(?:whole|entire)\s+(?:house|home|property)\b[^.!?]{0,40}\b(?:plumbing|water|pressure|pipes?|drains?)\b/i, /\b(?:every|all)\s+(?:faucets?|fixtures?|drains?)\b/i]],
      ['multiple_fixtures', [/\b(?:multiple|several|two|three|four)\s+(?:fixtures?|faucets?|toilets?|sinks?|drains?|areas?)\b/i]],
      ['single_fixture', [/\b(?:one|single)\s+(?:fixture|faucet|toilet|sink|shower|drain|pipe)\b/i]],
    ]);
    if (plumbingScope) add(candidates, plumbingScope);
    if (/\b(?:can|able to)\s+(?:access|get to)\s+(?:the\s+)?(?:water\s+)?shutoff(?: valve)?\b/i.test(text)) setCandidate(candidates, { key: 'water_shutoff_available', value: true, confidence: 1.0, evidence: 'Accessible water shutoff.' });
    if (leakState === 'HISTORICAL_STOPPED' || leakState === 'CURRENT_NEGATED') add(candidates, { key: 'active_leak', value: false, confidence: 0.99, evidence: 'Leak explicitly inactive.' });
    else if (leakState === 'CURRENT_POSITIVE') add(candidates, { key: 'active_leak', value: true, confidence: 0.98, evidence: 'Current leak reported.' });
    if (/\b(?:can|able to)\s+shut off the water\b|\bshutoff valve is accessible\b|\bwater can be turned off\b/i.test(text)) add(candidates, { key: 'water_shutoff_available', value: true, confidence: 0.98, evidence: 'Accessible water shutoff.' }); else if (/\b(?:can['’]?t|cannot)\s+(?:access|shut off)\b.*\b(?:water|shutoff)\b|\bshutoff valve is inaccessible\b/i.test(text)) add(candidates, { key: 'water_shutoff_available', value: false, confidence: 0.98, evidence: 'Inaccessible water shutoff.' });
    if (/\b(?:already bought|have|got|bought)\b[^.!?]{0,30}\b(?:replacement part|faucet|parts?)\b|\bparts?\s+(?:are\s+)?provided\b/i.test(text)) add(candidates, { key: 'parts_provided', value: true, confidence: 0.97, evidence: 'Customer has plumbing parts.' }); else if (/\b(?:don['’]?t have|need to provide|supply)\b[^.!?]{0,30}\b(?:replacement part|parts?|fittings?)\b/i.test(text)) add(candidates, { key: 'parts_provided', value: false, confidence: 0.97, evidence: 'Provider must supply plumbing parts.' });
    if (/\b(?:faucet|toilet|pipe|replacement part)\b[^.!?]{0,25}\b(?:already\s+)?(?:bought|have|here)\b|\b(?:already\s+have|have)\s+(?:the\s+)?(?:faucet|toilet|pipe|replacement part)\b/i.test(text)) setCandidate(candidates, { key: 'parts_provided', value: true, confidence: 1.0, evidence: 'Customer has the named plumbing part.' });
    if (/\bparts?\s+(?:are|is|aren['’]?t|isn['’]?t)\s+not\s+provided\b|\b(?:i|we)\s+(?:don['’]?t|do not|haven['’]?t|have not)\s+\b(?:have\s+)?(?:the\s+)?(?:new one|replacement|part)\b/i.test(text)) setCandidate(candidates, { key: 'parts_provided', value: false, confidence: 1.0, evidence: 'Plumbing parts explicitly unavailable.' });
    if (/\b(?:can['’]?t|cannot)\s+(?:get to|access)\s+(?:the\s+)?(?:water\s+)?shutoff(?: valve)?\b|\bno access to (?:the\s+)?shutoff(?: valve)?\b|\binaccessible shutoff\b/i.test(text)) setCandidate(candidates, { key: 'water_shutoff_available', value: false, confidence: 1.0, evidence: 'Water shutoff is inaccessible.' });
  }
  if (activeCategories.has('electrical')) {
    const fixture = enumCandidate(text, 'electrical_fixture', [['breaker', [/\b(?:circuit\s+)?breakers?\b[^.!?]{0,20}\b(?:in|inside)\s+(?:the\s+)?(?:electrical\s+)?panel\b/i, /\bcircuit\s+breakers?\b|\bbreakers?\b/i]], ['ceiling_fan', [/\bceiling\s+fans?\b/i, /\b(?:install|replace|new)\s+(?:a\s+)?fan\b/i]], ['panel', [/\b(?:electrical|breaker)\s+panels?\b/i]], ['doorbell', [/\bdoorbells?\b/i]], ['switch', [/\b(?:light\s+)?switch(?:es)?\b/i]], ['outlet', [/\b(?:outlets?|sockets?|receptacles?)\b/i]], ['light', [/\blights?|light\s+fixtures?\b/i]]]); if (fixture) add(candidates, fixture);
    let issue = enumCandidate(text, 'electrical_issue', [['flickering', [/\bflicker(?:ing)?\b/i]], ['tripping', [/\btripping\b/i]], ['not_working', [/\b(?:not working|stopped working|dead)\b/i]], ['installation', [/\b(?:install|installing|installation)\b/i]], ['replacement', [/\b(?:replace|replaced|replacement)\b/i]], ['repair', [/\b(?:repair|fix)\b/i]]]);
    const requestedElectricalOperation = /\b(?:install|installing|installation)\b/i.test(text) ? 'installation' : /\b(?:replace|replaced|replacement)\b/i.test(text) ? 'replacement' : undefined;
    const stoppedTripping = /\b(?:isn['’]?t|is\s+not|not)\s+tripping\b|\bstopped\s+tripping\b|\bno longer\s+trips?\b/i.test(text);
    if (issue?.value === 'tripping' && stoppedTripping) issue = null;
    if (requestedElectricalOperation) issue = { key: 'electrical_issue', value: requestedElectricalOperation, confidence: 0.99, evidence: 'Explicit requested electrical operation.' };
    if (!requestedElectricalOperation && /\b(?:put\s+in|needs?\s+(?:installing|to be installed)|new\s+(?:ceiling\s+)?fan\s+needed|want\s+a\s+new\b[^.!?]{0,20}\binstalled)\b/i.test(text)) issue = { key: 'electrical_issue', value: 'installation', confidence: 0.98, evidence: 'Explicit electrical installation wording.' };
    if (!requestedElectricalOperation && /\b(?:needs?\s+(?:replacing|replacement|to be replaced)|want\s+it\s+replaced)\b/i.test(text)) issue = { key: 'electrical_issue', value: 'replacement', confidence: 0.98, evidence: 'Explicit electrical replacement wording.' };
    if (!requestedElectricalOperation && /\bneed(?:s)?\s+(?:a|an)\s+new\s+(?:ceiling\s+fan|fan|outlet|light|doorbell|switch|fixture)\b/i.test(text)) issue = { key: 'electrical_issue', value: 'installation', confidence: 0.98, evidence: 'New electrical fixture requested.' };
    if (/\b(?:provider|you)\b[^.!?]{0,30}\b(?:bring|supply|provide)\b[^.!?]{0,20}\b(?:them|it|fixture|light|outlet|switch|fan)\b/i.test(text)) add(candidates, { key: 'parts_provided', value: false, confidence: 0.98, evidence: 'Provider must supply electrical parts.' });
    if (issue) add(candidates, issue);
    const electricalScope = enumCandidate(text, 'issue_scope', [
      ['whole_property', [/\b(?:whole|entire)\s+(?:house|home|property)\b[^.!?]{0,40}\b(?:power|electrical|electricity|lights?|outlets?)\b/i, /\b(?:all|every)\s+(?:outlets?|lights?|switches?)\b/i]],
      ['multiple_fixtures', [/\b(?:multiple|several|two|three|four)\s+(?:outlets?|lights?|switches?|fixtures?|breakers?)\b/i]],
      ['room_or_area', [/\b(?:one|single|the)\s+(?:room|bedroom|kitchen|bathroom|garage|office|area)\b[^.!?]{0,40}\b(?:power|lights?|outlets?|electrical)\b/i]],
      ['single_fixture', [/\b(?:one|single)\s+(?:outlet|light|switch|fixture|breaker|fan|doorbell)\b/i]],
    ]);
    if (electricalScope) add(candidates, electricalScope);
    if (/\b(?:has power|still has power|power is still on)\b/i.test(text)) setCandidate(candidates, { key: 'power_available', value: true, confidence: 1.0, evidence: 'Explicit power availability.' });
    if (/\b(?:already bought it|i bought it already|have the replacement|already have the replacement|replacement is already here)\b/i.test(text) && /\b(?:fan|light|switch|outlet|fixture|doorbell)\b/i.test(text)) setCandidate(candidates, { key: 'parts_provided', value: true, confidence: 1.0, evidence: 'Customer has the named electrical part.' });
    if (/\b(?:power is on|there is power|circuit has power|power available)\b/i.test(text)) add(candidates, { key: 'power_available', value: true, confidence: 0.98, evidence: 'Explicit power availability.' }); else if (/\b(?:no power|power is off|no electricity)\b/i.test(text)) add(candidates, { key: 'power_available', value: false, confidence: 0.98, evidence: 'Explicit lack of power.' });
    const noExistingWiring = /\b(?:no wiring(?: exists)?|there is no wiring|no existing wiring|needs? new wiring|new wiring is needed|wiring needs to be added)\b/i.test(text);
    const existingWiring = /\b(?:existing wiring(?: already exists| is there)?|wiring already exists|wiring is already there|already wired|wiring exists|there is existing wiring)\b/i.test(text);
    if (noExistingWiring) add(candidates, { key: 'existing_wiring', value: false, confidence: 0.99, evidence: 'No existing wiring stated.' });
    else if (existingWiring) add(candidates, { key: 'existing_wiring', value: true, confidence: 0.98, evidence: 'Existing wiring stated.' });
    if (/\b(?:already bought|have|got)\b[^.!?]{0,30}\b(?:fixture|light|outlet|switch|fan)\b/i.test(text)) add(candidates, { key: 'parts_provided', value: true, confidence: 0.97, evidence: 'Customer has electrical fixture.' }); else if (/\b(?:bring|supply|provide)\b[^.!?]{0,30}\b(?:fixture|light|outlet|switch|fan)\b/i.test(text)) add(candidates, { key: 'parts_provided', value: false, confidence: 0.97, evidence: 'Provider must supply electrical fixture.' });
    if (/\b(?:electrical|breaker)\s+panel\b|\binstall\s+(?:a\s+)?breaker\b|\breplace\s+(?:a\s+)?breaker\s+in\s+the\s+panel\b/i.test(text)) add(candidates, { key: 'panel_involved', value: true, confidence: 0.99, evidence: 'Panel explicitly involved.' });
    if (/\b(?:panel is fine|panel is not involved|no panel work(?: needed)?|don['’]?t need panel work)\b/i.test(text)) setCandidate(candidates, { key: 'panel_involved', value: false, confidence: 0.99, evidence: 'Panel work explicitly excluded.' });
  }
  return candidates;
}
function extractExplicitVehicleType(text: string): 'car' | 'suv' | 'van' | 'truck' | undefined { const match = text.match(/\b(?:need|needs|require|requires|with|use|using|bring)\b[^.!?]{0,30}\b(car|suv|van|truck)\b/i) ?? text.match(/\b(car|suv|van|truck)\b[^.!?]{0,20}\b(?:is\s+)?required\b/i); return match ? match[1].toLowerCase() as 'car' | 'suv' | 'van' | 'truck' : undefined; }
function extractGenericFacts(raw: string, numericFacts: NumericFact[], objectFacts: ObjectFact[], objectReferences: ObjectReferenceFact[], constraintFacts: ConstraintFact[]): Candidate[] {
  const text = raw.toLowerCase().replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
  const result: Candidate[] = [];
  if (/\b(?:upstairs|downstairs|stairs|staircase)\b/i.test(text)) add(result, { key: 'stairs', value: true, confidence: 0.97, evidence: 'Explicit stair reference' });
  if (/\bmount\b.*\b(?:wall|tv|shelf|shelves|mirror|cabinet)\b|\b(?:anchor|attach|secure|fasten)\b.*\b(?:to|onto)\s+(?:the\s+)?wall\b|\b(?:floating\s+shelves?|wall[- ]mounted)\b/i.test(text)) add(result, { key: 'wall_mounting', value: true, confidence: 0.97, evidence: 'Explicit wall mounting or attachment instruction.' });
  if (/\bheavy\b|\bfragile\b|\bdelicate\b|\bbreakable\b|\bwithout breaking\b|\bdon't break\b|\bdo not break\b/i.test(text)) { add(result, { key: 'heavy_or_fragile', value: true, confidence: 0.94, evidence: 'Explicit heavy/fragile description' }); add(result, { key: 'large_items', value: true, confidence: 0.89, evidence: 'Explicit heavy item description' }); }
  const species = [/\bdogs?|pupp(?:y|ies)\b/i.test(text) ? 'dog' : null, /\bcats?|kittens?\b/i.test(text) ? 'cat' : null, /\bparrots?|birds?\b/i.test(text) ? 'bird' : null, /\bfish\b/i.test(text) ? 'fish' : null].filter((value): value is string => Boolean(value));
  if (new Set(species).size === 1) add(result, { key: 'pet_type', value: species[0], confidence: 0.97, evidence: 'Explicit pet reference' });
  const care: string[] = []; if (/\bwalk(?:ing)?\b/i.test(text)) care.push('walking'); if (/\bfeed(?:ing)?\b|\brefill food\b|\brefill water\b/i.test(text)) care.push('feeding'); if (/\b(?:watch|sit|pet sit|check on|visit)\b/i.test(text)) care.push('sitting'); if (care.length) add(result, { key: 'care_type', value: [...new Set(care)], confidence: 0.96, evidence: 'Explicit pet-care action' });
  for (const group of [extractYardFacts(text)]) for (const candidate of group) add(result, candidate);
  const referencedDelivery = objectReferences.find((r) => r.reference === 'it' || r.reference === 'them'); const explicitDelivery = ''; if (referencedDelivery && /\b(?:deliver|bring|take|haul|transport|carry|grab)\s+(?:it|them)\b/i.test(text)) setCandidate(result, { key: 'delivery_item', value: referencedDelivery.resolvedObject, confidence: 0.99, evidence: 'Resolved delivery reference.' }); else { const delivery = extractActionObject(text, ['pick up', 'pickup', 'collect', 'deliver', 'transport', 'bring', 'take', 'haul', 'grab', 'carry', 'move']); if (delivery) add(result, { key: 'delivery_item', value: normalizeDeliveryItem(delivery.object), confidence: 0.94, evidence: delivery.evidence }); else if (explicitDelivery) add(result, { key: 'delivery_item', value: explicitDelivery, confidence: 0.94, evidence: 'Explicit delivery object.' }); }
  const assemblyReference = objectReferences.find((r) => r.reference === 'it' || r.reference === 'them' || r.reference === 'new_one'); if (assemblyReference && /\b(?:assemble|reassemble|put together|install)\b/i.test(text)) { const referencedObjectFact = objectFacts.find((fact) => fact.object === assemblyReference.resolvedObject); const cleanedReference = referencedObjectFact ? cleanObjectPhrase(referencedObjectFact.evidence) : null; const assemblyReferenceValue = cleanedReference ? normalizeAssemblyType(cleanedReference) : assemblyReference.resolvedObject; setCandidate(result, { key: 'assembly_type', value: assemblyReferenceValue, confidence: 1.0, evidence: 'Authoritative object reference resolved ' + assemblyReference.reference + ' to ' + assemblyReference.resolvedObject + '.' }); } else { const assembly = extractActionObject(text, ['assemble', 'build', 'put together']); if (assembly) add(result, { key: 'assembly_type', value: normalizeAssemblyType(assembly.object), confidence: 0.94, evidence: assembly.evidence }); }
  applyCompoundItemFacts(text, result);
  if (/\bfloating shelves?\b/i.test(text)) add(result, { key: 'assembly_type', value: 'floating shelves', confidence: 0.96, evidence: 'Explicit floating shelf installation.' });
  if (/\bfurniture\b.*\b(?:put|assemble)\b.*\b(?:together|assembled)\b/i.test(text) || /\bput\b.*\beverything together\b/i.test(text)) add(result, { key: 'assembly_type', value: 'furniture', confidence: 0.92, evidence: 'Explicit furniture assembly request.' });
  if (/\bdisassemble\b.*\bassemble\b.*\bagain\b/i.test(text)) add(result, { key: 'assembly_count', value: 1, confidence: 0.94, evidence: 'One explicitly named item will be reassembled.' });
  if (!result.some((item) => item.key === 'assembly_type')) { const deliveryItem = result.find((item) => item.key === 'delivery_item'); if (deliveryItem && /\b(?:assemble|build|put together)\s+it\b/i.test(text)) { add(result, { key: 'assembly_type', value: deliveryItem.value, confidence: 0.90, evidence: 'Assembly pronoun resolved to delivery item' }); add(result, { key: 'assembly_count', value: 1, confidence: 0.90, evidence: 'Singular assembly pronoun' }); } }
  const property = enumCandidate(text, 'property_type', [['apartment', [/\bapartment\b/i, /\bflat\b/i]], ['house', [/\bhouse\b/i, /\bhome\b/i]], ['office', [/\boffice\b/i]]]); if (property) add(result, property);
  const bedroomPropertyMatch = text.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)[- ]bedroom\b/i); if (bedroomPropertyMatch) { const count = quantityFromToken(bedroomPropertyMatch[1]); if (count !== null) add(result, { key: 'room_count', value: count, confidence: 0.98, evidence: bedroomPropertyMatch[0] }); }
  const wall = enumCandidate(text, 'wall_type', [['drywall', [/\bdrywall\b/i]], ['brick', [/\bbrick\b/i]], ['concrete', [/\bconcrete\b/i]], ['wood', [/\bwood(?:en)? wall\b/i]]]); if (wall) add(result, wall);
  if (/\b(?:assemble|build|put together)\s+(?:a|an|my|the|this|that)\s+[a-z][\w'-]*(?:\s+[a-z][\w'-]*){0,3}\b/i.test(text)) add(result, { key: 'assembly_count', value: 1, confidence: 0.91, evidence: 'Singular assembly object' });
  const access = extractAccess(text); const stairFact = constraintFacts.find((f) => f.type === 'stairs'); if (stairFact) setCandidate(result, { key: 'stairs', value: true, confidence: stairFact.confidence, evidence: stairFact.evidence }); const flightFact = constraintFacts.find((f) => f.type === 'stair_flights'); if (flightFact && typeof flightFact.value === 'number') setCandidate(result, { key: 'stair_flights', value: flightFact.value, confidence: flightFact.confidence, evidence: flightFact.evidence }); const accessRestrictions = buildAccessRestrictionSummary(constraintFacts); if (accessRestrictions) setCandidate(result, { key: 'access_restrictions', value: accessRestrictions, confidence: 0.97, evidence: accessRestrictions });
  const explicitItemCount = sumNumericFacts(numericFacts, 'item_count'); const objectTotal = totalObjectQuantity(objectFacts); const itemCount = objectFacts.length > 0 ? objectTotal : explicitItemCount; if (itemCount !== undefined && itemCount > 0) setCandidate(result, { key: 'item_count', value: itemCount, confidence: 0.99, evidence: 'Object facts supplied the canonical movable-item count.' });
  const explicitRoomCount = sumNumericFacts(numericFacts, 'room_count');
  if (explicitRoomCount !== undefined) add(result, { key: 'room_count', value: explicitRoomCount, confidence: 0.98, evidence: 'Explicit room quantities.' });
  const cleaningRoomCounts = [...text.matchAll(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+rooms?\b/gi)].map((match) => quantityFromToken(match[1]) ?? 0).filter((value) => value > 0);
  if (cleaningRoomCounts.length > 1 && /\b(?:clean|cleaning|vacuum|mop|scrub)\b/i.test(text)) add(result, { key: 'room_count', value: cleaningRoomCounts.reduce((sum, value) => sum + value, 0), confidence: 0.99, evidence: 'Summed explicit cleaning room quantities.' });
  const parallelCleaningRooms = text.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+rooms?\s+upstairs\s+and\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+downstairs\b/i);
  if (parallelCleaningRooms && /\b(?:clean|cleaning|vacuum|mop|scrub)\b/i.test(text)) add(result, { key: 'room_count', value: (quantityFromToken(parallelCleaningRooms[1]) ?? 0) + (quantityFromToken(parallelCleaningRooms[2]) ?? 0), confidence: 1.0, evidence: parallelCleaningRooms[0] });
  if (/\b(?:rooms?|bedrooms?)\s+(?:upstairs|downstairs)\b|\b(?:upstairs|downstairs)\b[^.!?]{0,20}\brooms?\b/i.test(text) && /\b(?:clean|cleaning|vacuum|mop|scrub)\b/i.test(text)) add(result, { key: 'stairs', value: true, confidence: 0.96, evidence: 'Cleaning spans upstairs or downstairs rooms.' });
  if (/\b(?:no|without)\s+stairs?\b/i.test(text) && /\b(?:clean|cleaning|vacuum|mop|scrub)\b/i.test(text)) setCandidate(result, { key: 'stairs', value: false, confidence: 1.0, evidence: 'Explicit no-stairs cleaning constraint.' });
  if (/\b(?:i|we)\s+have\s+(?:all\s+the\s+)?(?:cleaning\s+)?supplies\b|\bcleaning supplies are here\b|\bcustomer provides supplies\b/i.test(text)) add(result, { key: 'supplies_provided', value: true, confidence: 0.97, evidence: 'Customer provides cleaning supplies.' }); else if (/\b(?:bring your own|you need to bring|provider supplies)\s+(?:cleaning\s+)?supplies\b/i.test(text)) add(result, { key: 'supplies_provided', value: false, confidence: 0.97, evidence: 'Provider supplies cleaning materials.' });
  const explicitPetCount = sumNumericFacts(numericFacts, 'pet_count');
  if (explicitPetCount !== undefined) add(result, { key: 'pet_count', value: explicitPetCount, confidence: 0.98, evidence: 'Explicit pet quantities.' });
  const eventPeopleMatch = text.match(/\b(?:event|party|wedding|reception)\b.*?\b(?:for|with|about|around)\s+(\d+)\s+people\b/i);
  const guestFacts = numericFactsForRole(numericFacts, 'guest_count');
  if (eventPeopleMatch) add(result, { key: 'guest_count', value: Number(eventPeopleMatch[1]), confidence: 0.96, evidence: eventPeopleMatch[0] });
  if (guestFacts.length) add(result, { key: 'guest_count', value: guestFacts.reduce((total, fact) => total + fact.value, 0), confidence: 0.99, evidence: 'Explicit guest quantities.' });
  const flightFacts = numericFactsForRole(numericFacts, 'stair_flights');
  if (flightFacts.length === 1) { add(result, { key: 'stair_flights', value: flightFacts[0].value, confidence: 0.99, evidence: flightFacts[0].evidence }); add(result, { key: 'stairs', value: true, confidence: 0.99, evidence: flightFacts[0].evidence }); }
  const broaderAccess = extractAccessRestriction(text);
  if (access || broaderAccess) add(result, { key: 'access_restrictions', value: [access?.value, broaderAccess].filter((value): value is string => typeof value === 'string').join(' '), confidence: 0.97, evidence: 'Combined access restrictions.' });
  const vehicleRequired = /\b(?:you(?:'ll| will)?|we(?:'ll| will)?|provider|worker|someone|probably|likely)\s+(?:will\s+)?need(?:s)?\s+(?:a|an)?\s*(?:truck|van|suv|car|vehicle)\b|\bneed someone with (?:a|an)\s+(?:truck|van|suv|car|vehicle)\b|\bneed (?:a|an)\s+(?:van|truck)\b/i.test(text) ? true : /\b(?:i|we)\s+(?:already\s+)?have\s+(?:a|an)\s+(?:truck|van|suv|car|vehicle)\b/i.test(text) ? false : undefined;
  if (vehicleRequired !== undefined) add(result, { key: 'vehicle_required', value: vehicleRequired, confidence: 0.96, evidence: vehicleRequired ? 'Customer explicitly indicates the provider needs a vehicle.' : 'Customer explicitly states a vehicle is already available.' });
  if (sumNumericFacts(numericFacts, 'item_count') === undefined && /\bmove\b/i.test(text)) { const singles = text.match(/\b(?:couch|sofa|bed|dresser|refrigerator|fridge|piano|mattress|desk|table|washer|washing machine|dryer|cabinet|tv)\b/gi) ?? []; if (singles.length) add(result, { key: 'item_count', value: singles.length, confidence: 0.9, evidence: 'Explicit individual moving items were named.' }); }
  return result;
}

function extractProfileFacts(text: string, profile: IntakeProfile | undefined): Candidate[] {
  const candidates: Candidate[] = [];
  if (profile === 'cleaning_indoor') {
    const cleaningType = enumCandidate(text, 'cleaning_type', [
      ['deep', [/\bdeep\s+clean(?:ing)?\b/i]],
      ['move_in_out', [/\bmove[- ](?:in|out)\s+clean(?:ing)?\b/i]],
      ['standard', [/\b(?:standard|regular|routine)(?:\s+\w+){0,2}\s+clean(?:ing)?\b/i]],
    ]);
    if (cleaningType) add(candidates, cleaningType);
  }
  if (profile === 'cleaning_surface') {
    const surface = enumCandidate(text, 'surface_type', [
      ['driveway', [/\bdriveways?\b/i]],
      ['patio', [/\bpatios?\b/i]],
      ['walkway', [/\b(?:walkways?|sidewalks?|paths?)\b/i]],
      ['siding', [/\bsiding\b/i]],
      ['concrete', [/\bconcrete(?:\s+surface)?\b/i]],
      ['deck', [/\bdecks?\b/i]],
    ]);
    if (surface) add(candidates, surface);
    if (/\b(?:i|we)\s+(?:have|will provide|can provide)\b[^.!?]{0,30}\b(?:washer|equipment|tools?)\b/i.test(text)) add(candidates, { key: 'equipment_provided', value: true, confidence: 0.98, evidence: 'Customer explicitly provides surface-cleaning equipment.' });
    if (/\b(?:bring|provide|supply)\s+(?:your\s+own\s+|the\s+)?(?:pressure\s+washer|power\s+washer|equipment|tools?)\b/i.test(text)) setCandidate(candidates, { key: 'equipment_provided', value: false, confidence: 0.99, evidence: 'Provider explicitly supplies surface-cleaning equipment.' });
    if (/\b(?:water|outdoor\s+faucet|hose\s+connection|spigot)\b[^.!?]{0,25}\b(?:available|accessible|works|on site)\b/i.test(text)) add(candidates, { key: 'water_access', value: true, confidence: 0.98, evidence: 'Water access is explicitly available.' });
    if (/\b(?:no|without)\s+(?:water|outdoor\s+faucet|hose\s+connection|spigot)\b|\bwater\s+(?:is\s+)?not\s+available\b/i.test(text)) setCandidate(candidates, { key: 'water_access', value: false, confidence: 0.99, evidence: 'Water access is explicitly unavailable.' });
  }
  if (profile === 'auto_cleaning' || profile === 'auto_repair') {
    const vehicle = text.match(/\b(suv|sedan|car|truck|vehicle)s?\b/i);
    if (vehicle) add(candidates, { key: 'vehicle_details', value: vehicle[1].toUpperCase() === 'SUV' ? 'SUV' : vehicle[1].toLowerCase(), confidence: 0.95, evidence: vehicle[0] });
  }
  if (profile === 'auto_cleaning') {
    const cleaningType = enumCandidate(text, 'auto_cleaning_type', [
      ['pressure_wash', [/\b(?:pressure|power)[- ]?wash(?:ing)?\b/i]],
      ['full_detail', [/\b(?:full|complete)\s+detail(?:ing)?\b/i]],
      ['interior_detail', [/\b(?:vacuum|clean|detail)\b[^.!?]{0,30}\b(?:inside|interior|cabin|seats?)\b|\b(?:inside|interior|cabin|seats?)\b[^.!?]{0,30}\b(?:vacuum|clean|detail)\b/i]],
      ['exterior_wash', [/\b(?:wash|clean)\b[^.!?]{0,25}\b(?:cars?|vehicles?|suvs?|sedans?|trucks?)\b|\b(?:cars?|vehicles?|suvs?|sedans?|trucks?)\b[^.!?]{0,25}\b(?:wash|clean)\b/i]],
    ]);
    if (cleaningType) add(candidates, cleaningType);
    if (/\b(?:i|we)\s+(?:have|will provide|can provide)\b[^.!?]{0,30}\b(?:washing|detailing|cleaning)?\s*(?:equipment|supplies|tools?)\b/i.test(text)) add(candidates, { key: 'equipment_provided', value: true, confidence: 0.98, evidence: 'Customer explicitly provides vehicle-cleaning equipment.' });
    if (/\b(?:bring|provide|supply)\s+(?:your\s+own\s+|the\s+)?(?:washing|detailing|cleaning)?\s*(?:equipment|supplies|tools?)\b/i.test(text)) setCandidate(candidates, { key: 'equipment_provided', value: false, confidence: 0.99, evidence: 'Provider explicitly supplies vehicle-cleaning equipment.' });
  }
  return candidates;
}
export function extractIntakePrefill(
  raw: string,
  primaryCategory: TaskCategory,
  secondaryIntents: readonly TaskCategory[] = [],
  intakeProfile?: IntakeProfile | null,
): IntakePrefillResult {
  const text = raw.toLowerCase();
  const activeProfile = intakeProfile && (intakeProfile.startsWith('cleaning_') ? primaryCategory === 'cleaning' : primaryCategory === 'auto') ? intakeProfile : undefined;
  const allowed = new Set(
    getQuestionsForIntake(primaryCategory, secondaryIntents, intakeProfile === null ? null : activeProfile).map((question) => question.key)
  );
  const numericFacts = extractNumericFacts(raw);
  const objectFacts = extractObjectFacts(raw);
  const objectReferences = resolveObjectReferences(raw, objectFacts);
  const constraintFacts = extractConstraintFacts(raw);
  const candidates = extractGenericFacts(
    raw,
    numericFacts,
    objectFacts,
    objectReferences,
    constraintFacts
  );
  const activeCategories = new Set([primaryCategory, ...secondaryIntents]);
  for (const candidate of extractExpandedCategoryFacts(text, activeCategories))
    setCandidate(candidates, candidate);
  for (const candidate of extractProfileFacts(text, activeProfile)) setCandidate(candidates, candidate);
  const hasExplicitAssemblyAction = /\b(?:assemble|reassemble|put together|build|install)\b/i.test(
    text
  );
  if (activeCategories.has('assembly') && hasExplicitAssemblyAction) {
    const assemblyObjectTotal = totalObjectQuantity(objectFacts);
    if (objectFacts.length > 0 && assemblyObjectTotal > 0)
      setCandidate(candidates, {
        key: 'assembly_count',
        value: assemblyObjectTotal,
        confidence: 0.99,
        evidence: 'Canonical object facts supplied the assembly count.',
      });
    const assemblyReference = objectReferences.find(
      (reference) =>
        reference.reference === 'it' ||
        reference.reference === 'them' ||
        reference.reference === 'new_one'
    );
    if (assemblyReference && /\b(?:assemble|reassemble|put together|install)\b/i.test(text))
      setCandidate(candidates, {
        key: 'assembly_type',
        value: candidates.find((candidate) => candidate.key === 'assembly_type')?.value ?? renderAssemblyReference(objectFacts.find((fact) => fact.object === assemblyReference.resolvedObject), assemblyReference.resolvedObject),
        confidence: 1.0,
        evidence:
          'Resolved ' +
          assemblyReference.reference +
          ' to ' +
          assemblyReference.resolvedObject +
          '.',
      });
  }
  if (activeCategories.has('delivery')) {
    const existingDeliveryItem = candidates.find((candidate) => candidate.key === 'delivery_item');
    if (existingDeliveryItem && typeof existingDeliveryItem.value === 'string')
      existingDeliveryItem.value = normalizeDeliveryItem(existingDeliveryItem.value);
    const deliveryReference = objectReferences.find(
      (reference) => reference.reference === 'it' || reference.reference === 'them'
    );
    if (deliveryReference) {
      const matchingObject = objectFacts.find(
        (object) => object.object === deliveryReference.resolvedObject
      );
      setCandidate(candidates, {
        key: 'delivery_item',
        value: matchingObject ? renderObjectFact(matchingObject) : deliveryReference.resolvedObject,
        confidence: 0.99,
        evidence: 'Resolved delivery reference ' + deliveryReference.reference + '.',
      });
    }
  }
  
  if (constraintFacts.some((fact) => fact.type === 'stairs' && fact.value === true))
    setCandidate(candidates, {
      key: 'stairs',
      value: true,
      confidence: 1.0,
      evidence: 'Canonical constraint facts indicate stair access.',
    });
  const deliveryCandidate = candidates.find(
    (candidate) => candidate.key === 'delivery_item' && typeof candidate.value === 'string'
  );
  if (deliveryCandidate)
    setCandidate(candidates, {
      key: 'delivery_item',
      value: normalizeDeliveryItem(deliveryCandidate.value as string),
      confidence: 1.0,
      evidence: 'Canonical delivery-item normalization.',
    });
  const finalAssemblyReference = objectReferences.find(
    (reference) =>
      reference.reference === 'it' ||
      reference.reference === 'them' ||
      reference.reference === 'new_one'
  );
  if (
    activeCategories.has('assembly') &&
    finalAssemblyReference &&
    /\b(?:assemble|reassemble|install|put together)\b/i.test(text)
  ) {
    const existingAssemblyType = candidates.find(
      (candidate) => candidate.key === 'assembly_type'
    );
    if (!existingAssemblyType)
    setCandidate(candidates, {
      key: 'assembly_type',
      value: renderAssemblyReference(objectFacts.find((fact) => fact.object === finalAssemblyReference.resolvedObject), finalAssemblyReference.resolvedObject),
      confidence: 1.01,
      evidence:
        'Authoritative object reference resolved ' +
        finalAssemblyReference.reference +
        ' to ' +
        finalAssemblyReference.resolvedObject +
        '.',
    });
  }
  for (const candidate of candidates) {
    if (candidate.key === 'delivery_item' && typeof candidate.value === 'string')
      candidate.value = normalizeDeliveryItem(candidate.value);
  }
  if (hasExplicitVehicleRequirement(text))
    setCandidate(candidates, {
      key: 'vehicle_required',
      value: true,
      confidence: 0.99,
      evidence: 'Explicit vehicle requirement.',
    });
  if (constraintFacts.some((fact) => fact.type === 'stairs' && fact.value === true))
    setCandidate(candidates, {
      key: 'stairs',
      value: true,
      confidence: 1.0,
      evidence: 'Canonical constraint facts indicate stair access.',
    });
  const explicitVehicleType = extractExplicitVehicleType(text);
  if (explicitVehicleType && activeCategories.has('delivery')) setCandidate(candidates, { key: 'vehicle_size', value: explicitVehicleType, confidence: 0.99, evidence: 'Explicit delivery vehicle requirement.' });
  if (explicitVehicleType && activeCategories.has('moving')) setCandidate(candidates, { key: 'vehicle_required', value: true, confidence: 0.99, evidence: 'Explicit vehicle requirement.' }); if (explicitVehicleType && activeCategories.has('other')) setCandidate(candidates, { key: 'provider_resources', value: explicitVehicleType, confidence: 0.99, evidence: 'Explicit provider vehicle/resource requirement.' });

  const explicitPetTotal = numericFacts.filter((fact) => fact.role === 'pet_count').reduce((sum, fact) => sum + fact.value, 0);
  const implicitPetMatches = text.match(/\b(?:a|an)\s+(?:parrot|bird|puppy|kitten|dog|cat)\b/gi) ?? [];
  const canonicalPetCount = explicitPetTotal + implicitPetMatches.length;
  if (canonicalPetCount > 0) setCandidate(candidates, { key: 'pet_count', value: canonicalPetCount, confidence: 0.99, evidence: 'Canonical pet quantities.' });
  const careTypes = new Set<string>();
  if (/\bwalk(?:ing|ed)?\b/i.test(text)) careTypes.add('walking');
  if (/\bfeed(?:ing|fed)?\b/i.test(text)) careTypes.add('feeding');
  if (/\b(?:look after|watch|check on|pet[\s-]?sit|sit(?:ting)?)\b/i.test(text)) careTypes.add('sitting');
  if (careTypes.size > 0) setCandidate(candidates, { key: 'care_type', value: [...careTypes], confidence: 0.98, evidence: 'Explicit pet-care actions.' });

  const replacementObjectCount = objectReferences.filter((reference) => reference.reference === 'new_one').length;
  if (replacementObjectCount > 0) { const existing = candidates.find((candidate) => candidate.key === 'item_count' && typeof candidate.value === 'number'); if (existing) setCandidate(candidates, { key: 'item_count', value: (existing.value as number) + replacementObjectCount, confidence: 1, evidence: 'Original object plus explicit replacement object.' }); }

  if (/\bmount\s+(?:my\s+|the\s+)?(?:tv|television|mirror|shelf|shelves|cabinet)\b/i.test(text) || /\b(?:attach|anchor|secure)\b.*\b(?:to|onto)\s+(?:the\s+)?wall\b/i.test(text)) setCandidate(candidates, { key: 'wall_mounting', value: true, confidence: 0.99, evidence: 'Explicit wall-mounting instruction.' });
  if (activeCategories.has('assembly') && objectFacts.length > 0 && /\bmount\s+(?:both|them|it)\b/i.test(text)) setCandidate(candidates, { key: 'wall_mounting', value: true, confidence: 0.99, evidence: 'Explicit wall-mounting reference to assembly objects.' });

  const deliveryReference = objectReferences.find((reference) => reference.reference === 'them');
  if (deliveryReference) { const sourceObject = objectFacts.find((fact) => fact.object === deliveryReference.resolvedObject); if (sourceObject) { const normalizedDeliveryReference = normalizeDeliveryItem(sourceObject.evidence); setCandidate(candidates, { key: 'delivery_item', value: normalizedDeliveryReference, confidence: 1, evidence: sourceObject.evidence }); } }

  if (activeCategories.has('delivery') && /\b(?:a|the)\s+(?:large\s+)?thing\b/i.test(text) && /\b(?:bring|brought|deliver|take)\b/i.test(text)) setCandidate(candidates, { key: 'delivery_item', value: 'thing', confidence: 0.9, evidence: 'Explicit but unspecified delivery object.' });

  const installsWallShelves = /\binstall\b[^.!?]{0,40}\bwall\s+shelves?\b/i.test(text);
  if (installsWallShelves) {
    setCandidate(candidates, { key: 'wall_mounting', value: true, confidence: 0.99, evidence: 'Explicit installation of wall-mounted shelves.' });
    setCandidate(candidates, { key: 'assembly_type', value: 'wall shelves', confidence: 0.97, evidence: 'Explicit wall-shelf installation.' });
  }

  const mountedCabinet = /\bmount\b[^.!?]{0,40}\b(?:a|an|one)?\s*cabinet\b/i.test(text); if (activeCategories.has('assembly') && mountedCabinet) { setCandidate(candidates, { key: 'assembly_type', value: 'cabinet', confidence: 0.97, evidence: 'Explicit mounted cabinet.' }); setCandidate(candidates, { key: 'assembly_count', value: 1, confidence: 0.99, evidence: 'Explicit single mounted cabinet.' }); }
  if (activeCategories.has('assembly')) {
    const assemblyState = enumCandidate(text, 'assembly_state', [
      ['boxed_new', [/\b(?:new|brand[- ]new)\b[^.!?]{0,40}\b(?:boxed|in the box|still boxed|flat[- ]packed|flat pack)\b/i, /\bstill\s+(?:in\s+)?(?:the\s+)?box\b/i]],
      ['partially_assembled', [/\b(?:partially|half|partly)\s+assembled\b/i, /\bassembly\s+(?:was\s+)?started\b/i]],
      ['disassembled', [/\b(?:disassembled|taken apart|dismantled)\b/i, /\bpreviously assembled\b[^.!?]{0,40}\b(?:taken apart|disassembled)\b/i]],
    ]);
    if (assemblyState) add(candidates, assemblyState);
    if (/\b(?:instructions?|manual)\s+(?:are|is)\s+(?:available|included|here)\b|\b(?:have|got)\s+(?:the\s+)?(?:instructions?|manual)\b/i.test(text)) add(candidates, { key: 'instructions_available', value: true, confidence: 0.97, evidence: 'Assembly instructions explicitly available.' });
    if (/\b(?:no|without)\s+(?:instructions?|manual)\b|\b(?:instructions?|manual)\s+(?:are|is)\s+(?:missing|lost|unavailable)\b/i.test(text)) setCandidate(candidates, { key: 'instructions_available', value: false, confidence: 0.98, evidence: 'Assembly instructions explicitly unavailable.' });
    const passiveAssembly = text.match(/\b(?:need|want|have)\s+(?:a|an|one)\s+([a-z][\w'-]*)\s+(?:assembled|put together)\b/i);
    if (passiveAssembly) {
      setCandidate(candidates, { key: 'assembly_type', value: passiveAssembly[1].toLowerCase(), confidence: 0.99, evidence: passiveAssembly[0] });
      setCandidate(candidates, { key: 'assembly_count', value: 1, confidence: 0.99, evidence: passiveAssembly[0] });
    }
    const mountedShelves = text.match(/\b(?:mount|install)\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?shelves?\b/i);
    if (mountedShelves) {
      const count = mountedShelves[1] ? quantityFromToken(mountedShelves[1]) : 1;
      setCandidate(candidates, { key: 'assembly_type', value: 'shelves', confidence: 0.98, evidence: mountedShelves[0] });
      if (count) setCandidate(candidates, { key: 'assembly_count', value: count, confidence: 0.99, evidence: mountedShelves[0] });
      if (/\b(?:assemble|build|put together)\b/i.test(text)) {
        const allItems = extractQuantifiedItems(text);
        if (allItems.length > 1) {
          setCandidate(candidates, { key: 'assembly_count', value: totalQuantity(allItems), confidence: 1.0, evidence: allItems.map((item) => item.evidence).join(' + ') });
          setCandidate(candidates, { key: 'assembly_type', value: compoundItemDescription(allItems) ?? 'shelves', confidence: 1.0, evidence: 'Aggregated assembly-family actions.' });
        }
      }
    }
    if (/\b(?:assemble|put together|build)\s+(?:a|an|one)\s+[a-z][\w'-]*/i.test(text) && !candidates.some((candidate) => candidate.key === 'assembly_count')) setCandidate(candidates, { key: 'assembly_count', value: 1, confidence: 0.98, evidence: 'Explicit singular assembly object.' });
  }

  const leavesDebrisOnSite =
    /\b(?:leave|keep)\b[^.!?]{0,50}\b(?:bags?|leaves?|branches?|debris|waste)\b/i.test(text) ||
    /\b(?:bags?|leaves?|branches?|debris|waste)\b[^.!?]{0,50}\bleft\b/i.test(text) ||
    /\b(?:leave|keep)\s+(?:it|them)\b[^.!?]{0,50}\b(?:pile|bagged|bags?|gate|fence|shed|there|behind)\b/i.test(text) ||
    /\bpile\b[^.!?]{0,40}\b(?:branches?|leaves?|debris)\b/i.test(text);
  if (leavesDebrisOnSite) {
    setCandidate(candidates, { key: 'debris', value: false, confidence: 0.99, evidence: 'Explicit instruction to leave debris on site.' });
  }
  if (/\b(?:take|haul|carry)\b[^.!?]{0,50}\b(?:away|with you)\b/i.test(text)) {
    setCandidate(candidates, { key: 'debris', value: true, confidence: 0.99, evidence: 'Explicit debris removal instruction.' });
  }

  if (activeCategories.has('moving') && /\b(?:no|without)\s+stairs?\b/i.test(text)) {
    removeCandidate(candidates, 'stairs');
    setCandidate(candidates, { key: 'stairs', value: false, confidence: 0.99, evidence: 'Explicit no-stairs statement.' });
    removeCandidate(candidates, 'access_restrictions');
  }
  if (activeCategories.has('moving') && /\b(?:no vehicle|vehicle (?:is )?not needed|without a vehicle)\b/i.test(text)) {
    setCandidate(candidates, { key: 'vehicle_required', value: false, confidence: 0.99, evidence: 'Explicit statement that no vehicle is required.' });
  } else if (activeCategories.has('moving') && /\b(?:bring|need|requires?|with)\b[^.!?]{0,30}\b(?:van|truck|car|suv)\b/i.test(text)) {
    setCandidate(candidates, { key: 'vehicle_required', value: true, confidence: 0.99, evidence: 'Explicit vehicle requirement.' });
  }

  if (/\b(?:mount nothing|do not mount|don't mount|do not anchor|don't anchor|not mounted)\b/i.test(text)) {
    setCandidate(candidates, { key: 'wall_mounting', value: false, confidence: 1.0, evidence: 'Explicit instruction not to wall-mount.' });
  }

  if (activeCategories.has('moving') && /\b(?:bulky|heavy|oversized)\s+(?:[\w'-]+\s+){0,2}(?:cabinet|tables?|wardrobe|desks?|dresser|couch|sofa|piano|bed|mattress)\b/i.test(text)) {
    setCandidate(candidates, { key: 'large_items', value: true, confidence: 0.98, evidence: 'Explicit bulky/heavy movable item.' });
  }
  if (/\b(?:no vehicle is required|no vehicle required|no vehicle needed|don['’]?t need a vehicle)\b/i.test(text)) setCandidate(candidates, { key: 'vehicle_required', value: false, confidence: 0.99, evidence: 'Explicitly no vehicle required.' });
  else if (/\b(?:a\s+)?(?:truck|van|vehicle)\s+is\s+(?:needed|required)\b/i.test(text)) setCandidate(candidates, { key: 'vehicle_required', value: true, confidence: 0.99, evidence: 'Explicit vehicle requirement.' });
  if (/\b(?:no vehicle is needed|no vehicle needed|vehicle is not needed|don['’]?t need a vehicle|no van needed|no truck needed)\b/i.test(text)) setCandidate(candidates, { key: 'vehicle_required', value: false, confidence: 1.0, evidence: 'Explicit vehicle negation.' });

  if (activeCategories.has('moving') && objectFacts.length > 0) {
    const count = totalObjectQuantity(objectFacts);
    if (count > 0) setCandidate(candidates, { key: 'item_count', value: count, confidence: 0.99, evidence: 'Object facts supplied the canonical movable-item count.' });
  }

  if (activeCategories.has('delivery')) {
    const deliveryList = extractDeliveryList(text);
    if (deliveryList) setCandidate(candidates, { key: 'delivery_item', value: deliveryList, confidence: 1.01, evidence: 'Explicit coordinated delivery items.' });
  }


  if (activeCategories.has('moving')) {
    const moveType = enumCandidate(text, 'move_type', [
      ['loading_unloading', [/\b(?:load|unload|loading|unloading)\b[^.!?]{0,40}\b(?:truck|van|moving truck|container)\b/i]],
      ['same_building', [/\b(?:upstairs|downstairs|another floor|different floor)\b/i, /\bwithin\s+(?:the\s+)?same\s+building\b/i]],
      ['within_property', [/\b(?:within|around)\s+(?:the\s+)?(?:house|home|property|yard)\b/i, /\bfrom\s+(?:one\s+)?room\s+to\s+(?:another|another room)\b/i]],
      ['pickup_only', [/\bpick\s*up\s+only\b/i]],
      ['dropoff_only', [/\b(?:drop[- ]?off|delivery)\s+only\b/i]],
      ['local_move', [/\bmove\b[^.!?]{0,60}\bfrom\b[^.!?]{0,60}\bto\b/i, /\bmoving\s+(?:house|home|apartment|apartments)\b/i]],
    ]);
    if (moveType) add(candidates, moveType);
  }
  if (activeCategories.has('delivery')) {
    const quantityMatch = text.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:items?|packages?|boxes?|parcels?|pieces?)\b/i);
    if (quantityMatch) {
      const quantity = quantityFromToken(quantityMatch[1]);
      if (quantity) add(candidates, { key: 'delivery_quantity', value: quantity, confidence: 0.96, evidence: quantityMatch[0] });
    }
    const pickupAccess = enumCandidate(text, 'pickup_access', [
      ['loading_area', [/\bpickup\b[^.!?]{0,50}\b(?:loading dock|loading area)\b/i]],
      ['elevator', [/\bpickup\b[^.!?]{0,50}\belevator\b/i]],
      ['stairs', [/\bpickup\b[^.!?]{0,50}\bstairs?\b/i]],
      ['curbside', [/\bcurbside\s+pickup\b/i]],
      ['ground_floor', [/\bpickup\b[^.!?]{0,50}\bground floor\b/i]],
    ]);
    if (pickupAccess) add(candidates, pickupAccess);
    const dropoffAccess = enumCandidate(text, 'dropoff_access', [
      ['loading_area', [/\b(?:drop[- ]?off|delivery)\b[^.!?]{0,50}\b(?:loading dock|loading area)\b/i]],
      ['elevator', [/\b(?:drop[- ]?off|delivery)\b[^.!?]{0,50}\belevator\b/i]],
      ['stairs', [/\b(?:drop[- ]?off|delivery)\b[^.!?]{0,50}\bstairs?\b/i]],
      ['curbside', [/\bcurbside\s+(?:drop[- ]?off|delivery)\b/i]],
      ['ground_floor', [/\b(?:drop[- ]?off|delivery)\b[^.!?]{0,50}\bground floor\b/i]],
    ]);
    if (dropoffAccess) add(candidates, dropoffAccess);
    if (/\b(?:someone|i|we|customer)\s+(?:will|can)\s+help\s+(?:load|unload)\b/i.test(text)) add(candidates, { key: 'loading_help', value: true, confidence: 0.96, evidence: 'Loading or unloading help explicitly available.' });
    if (/\b(?:no one|nobody)\s+(?:will|can)\s+help\s+(?:load|unload)\b|\bno\s+help\s+(?:loading|unloading)\b/i.test(text)) setCandidate(candidates, { key: 'loading_help', value: false, confidence: 0.97, evidence: 'No loading or unloading help available.' });
  }
  if (activeCategories.has('events')) {
    const duration = enumCandidate(text, 'event_duration', [
      ['multiple_days', [/\b(?:multiple|several|two|three|four)\s+days?\b/i]],
      ['full_day', [/\b(?:full|entire|whole)\s+day\b/i, /\ball[- ]day\b/i]],
      ['4_8_hours', [/\b(?:4|5|6|7|8)\s+hours?\b/i]],
      ['2_4_hours', [/\b(?:2|3|4)\s+hours?\b/i]],
      ['under_2_hours', [/\b(?:30|45|60|90)\s+minutes?\b/i, /\b(?:one|1)\s+hour\b/i]],
    ]);
    if (duration) add(candidates, duration);
    const venue = enumCandidate(text, 'venue_type', [
      ['outdoor', [/\b(?:outdoor|outside|park|garden|backyard)\b/i]],
      ['event_venue', [/\b(?:event venue|banquet hall|reception hall|wedding venue)\b/i]],
      ['office', [/\b(?:office|workplace|corporate event)\b/i]],
      ['home', [/\b(?:at home|my house|our house|residence)\b/i]],
    ]);
    if (venue) add(candidates, venue);
    if (/\b(?:provider|you)\s+(?:need|needs|should|will need)\s+to\s+(?:bring|supply|provide)\s+(?:event\s+)?(?:equipment|supplies|tables|chairs)\b/i.test(text)) add(candidates, { key: 'equipment_needed', value: true, confidence: 0.95, evidence: 'Provider event equipment responsibility explicitly stated.' });
  }
  if (activeCategories.has('pet_care')) {
    const duration = enumCandidate(text, 'care_duration', [
      ['multiple_days', [/\b(?:for\s+)?(?:two|three|four|five|several|multiple)\s+days?\b/i, /\bfor\s+the\s+weekend\b/i]],
      ['overnight', [/\bovernight\b/i, /\bstay\s+the\s+night\b/i]],
      ['full_day', [/\b(?:full|whole|entire)\s+day\b/i, /\ball[- ]day\b/i]],
      ['few_hours', [/\b(?:two|three|four|2|3|4)\s+hours?\b/i, /\bfew\s+hours?\b/i]],
      ['under_1_hour', [/\b(?:30|45)\s+minutes?\b/i, /\b(?:less than|under)\s+(?:an?\s+)?hour\b/i]],
    ]);
    if (duration) add(candidates, duration);
    const frequency = enumCandidate(text, 'care_frequency', [
      ['multiple_times_per_day', [/\b(?:twice|three times|multiple times)\s+(?:a|per)\s+day\b/i]],
      ['daily', [/\b(?:once\s+)?daily\b/i, /\bonce\s+(?:a|per)\s+day\b/i]],
      ['recurring', [/\b(?:every week|weekly|recurring|regularly)\b/i]],
      ['one_time', [/\b(?:one[- ]time|just once|single visit)\b/i]],
    ]);
    if (frequency) add(candidates, frequency);
  }

  const accepted = candidates.filter(
    (candidate) => candidate.confidence >= 0.88 && allowed.has(candidate.key)
  );
  const answers: IntakeAnswers = {};
  for (const candidate of accepted) answers[candidate.key] = candidate.value;
  return { answers, evidence: accepted };
}

















