import { getQuestionsForIntake } from './definitions.js';
import { extractNumericFacts, type NumericFact } from './extractNumericFacts.js';
import { extractObjectFacts, totalObjectQuantity, type ObjectFact } from './extractObjectFacts.js';
import { extractConstraintFacts, type ConstraintFact } from './extractConstraintFacts.js';
import { resolveObjectReferences, type ObjectReferenceFact } from './resolveObjectReferences.js';
import type { IntakeAnswer, IntakeAnswers, TaskCategory } from './types.js';

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
    .replace(/\s+/g, ' ')
    .trim();
  result = stripObjectNoise(result);
  return !result || result.length > 100 || /^(?:it|them|this|that|these|those)$/i.test(result) ? null : result;
}
function extractActionObject(text: string, actions: readonly string[]) { const actionPattern = actions.map(escapeRegex).join('|'); const boundary = ['and', 'then', 'bring', 'deliver', 'transport', 'assemble', 'build', 'install', 'mount', 'anchor', 'attach', 'set up', 'put together', 'move', 'carry', 'take', 'from', 'to', 'into', 'onto', 'upstairs', 'downstairs', 'outside', 'inside'].map(escapeRegex).join('|'); const match = text.match(new RegExp('\\b(?:' + actionPattern + ')\\b\\s+(.{1,100}?)(?=\\s+(?:' + boundary + ')\\b|$)', 'i')); if (!match) return null; const object = cleanObjectPhrase(match[1]); return object ? { object, evidence: match[0] } : null; }
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
  if (/\b(?:isn['’]?t|is\s+not|not)\s+(?:leaking|dripping)\b|\bno\s+(?:active\s+)?leak\b/i.test(text)) return 'CURRENT_NEGATED';
  if (/\b(?:is|are|currently)\s+(?:leaking|dripping)\b|\b(?:leaking|dripping)\s+(?:right now|continuously)\b|\bwater\s+is\s+(?:currently\s+)?dripping\b|\bkeeps?\s+dripping\b|\band\s+(?:currently\s+)?(?:leaking|dripping)\b|\b(?:leaking|dripping)\s+(?:pipe|piping|sink|faucet|tap|toilet|shower|bathtub|tub|drain|water\s+heater)\b/i.test(text)) return 'CURRENT_POSITIVE';
  return 'NONE';
}

function extractExpandedCategoryFacts(text: string, activeCategories: ReadonlySet<TaskCategory>): Candidate[] {
  const candidates: Candidate[] = [];
  if (activeCategories.has('painting')) {
    const surface = enumCandidate(text, 'painting_surface', [
      ['interior_walls', [/\b(?:interior|inside|living room|bedroom|kitchen|bathroom|hallway)\s+walls?\b/i]],
      ['exterior_walls', [/\b(?:exterior|outside)\s+(?:walls?|of the house)\b/i]],
      ['ceiling', [/\bceilings?\b/i]], ['trim', [/\b(?:trim|baseboards?|moulding|molding)\b/i]],
      ['doors', [/\b(?:front\s+)?doors?\b/i]], ['fence', [/\bfence\b/i]], ['deck', [/\bdeck\b/i]],
    ]); if (surface && !(/\bdon['’]?t\s+paint\b[^.!?]*\b(?:walls?|ceiling|trim|doors?|fence|deck)\b/i.test(text) && surface.value === 'doors')) add(candidates, surface);
    const area = text.match(/\b(living room|bedroom|kitchen|bathroom|hallway|front door|back fence|deck)\b/i); if (area) add(candidates, { key: 'painting_area', value: area[1].toLowerCase(), confidence: 0.95, evidence: area[0] });
    const paintNotProvided = /\bpaint\s+is\s+not\s+provided\b|\b(?:bring|supply|provide)\s+the\s+paint\b|\b(?:i|we)\s+don['’]?t\s+have\s+(?:the\s+)?paint\b|\bpaint\s+isn['’]?t\s+here\b/i.test(text);
    const paintProvided = /\b(?:already\s+have|have|bought)\s+(?:the\s+)?paint\b|\bpaint\s+(?:has\s+already\s+been\s+)?purchased\b|\bpaint\s+is\s+(?:already\s+)?here\b|\bpaint\s+is\s+provided\b/i.test(text);
    if (paintNotProvided) add(candidates, { key: 'paint_provided', value: false, confidence: 0.99, evidence: 'Explicit paint responsibility.' });
    else if (paintProvided) add(candidates, { key: 'paint_provided', value: true, confidence: 0.98, evidence: 'Explicit paint availability.' });
    const noPrep = /\bno\s+(?:prep|preparation)\s+(?:needed|required)\b|\b(?:surface|walls?)\s+are\s+ready\s+(?:to\s+paint|for\s+paint)\b|\bready\s+for\s+paint\b/i.test(text);
    if (noPrep) add(candidates, { key: 'prep_needed', value: false, confidence: 0.99, evidence: 'Explicitly no painting preparation required.' });
    else if (/\b(?:sand|scrape|patch|strip|prime|prep(?:aration)?|surface prep)\w*\b/i.test(text)) add(candidates, { key: 'prep_needed', value: true, confidence: 0.98, evidence: 'Explicit painting preparation.' });
    if (/\b(?:water damage|peeling paint|cracks?|damaged (?:wall|surface))\b/i.test(text)) add(candidates, { key: 'existing_damage', value: true, confidence: 0.97, evidence: 'Explicit paint-surface damage.' });
    const coats = text.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+coats?\b/i); if (coats) { const n = quantityFromToken(coats[1]); if (n) add(candidates, { key: 'coat_count', value: n, confidence: 0.99, evidence: coats[0] }); }
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
        /\bwater\s+pressure\s+(?:is\s+)?(?:very\s+)?(?:low|weak)\b/i,
      ]],
      ['no_water', [/\b(?:no water|not getting water|no hot water)\b/i]],
      ['installation', [/\b(?:install|installing|installation)\b/i]],
      ['replacement', [/\b(?:replace|replacement)\b/i]],
      ['repair', [/\b(?:repair|fix|fixing)\b/i]],
    ]);
    const requestedOperation = /\b(?:install|installing|installation)\b/i.test(text) ? 'installation' : /\b(?:replace|replacement)\b/i.test(text) ? 'replacement' : /\b(?:repair|fix|fixing)\b/i.test(text) ? 'repair' : undefined;
    if (requestedOperation && (!issue || issue.value === 'repair')) issue = { key: 'plumbing_issue', value: requestedOperation, confidence: 0.98, evidence: 'Explicit requested plumbing operation.' };
    if (!issue && (leakState === 'CURRENT_POSITIVE' || leakState === 'HISTORICAL_STOPPED')) issue = { key: 'plumbing_issue', value: 'leak', confidence: 0.97, evidence: 'Explicit leak-related plumbing issue.' };
    if (issue) add(candidates, issue);
    if (leakState === 'HISTORICAL_STOPPED' || leakState === 'CURRENT_NEGATED') add(candidates, { key: 'active_leak', value: false, confidence: 0.99, evidence: 'Leak explicitly inactive.' });
    else if (leakState === 'CURRENT_POSITIVE') add(candidates, { key: 'active_leak', value: true, confidence: 0.98, evidence: 'Current leak reported.' });
    if (/\b(?:can|able to)\s+shut off the water\b|\bshutoff valve is accessible\b|\bwater can be turned off\b/i.test(text)) add(candidates, { key: 'water_shutoff_available', value: true, confidence: 0.98, evidence: 'Accessible water shutoff.' }); else if (/\b(?:can['’]?t|cannot)\s+(?:access|shut off)\b.*\b(?:water|shutoff)\b|\bshutoff valve is inaccessible\b/i.test(text)) add(candidates, { key: 'water_shutoff_available', value: false, confidence: 0.98, evidence: 'Inaccessible water shutoff.' });
    if (/\b(?:already bought|have|got|bought)\b[^.!?]{0,30}\b(?:replacement part|faucet|parts?)\b|\bparts?\s+(?:are\s+)?provided\b/i.test(text)) add(candidates, { key: 'parts_provided', value: true, confidence: 0.97, evidence: 'Customer has plumbing parts.' }); else if (/\b(?:don['’]?t have|need to provide|supply)\b[^.!?]{0,30}\b(?:replacement part|parts?|fittings?)\b/i.test(text)) add(candidates, { key: 'parts_provided', value: false, confidence: 0.97, evidence: 'Provider must supply plumbing parts.' });
  }
  if (activeCategories.has('electrical')) {
    const fixture = enumCandidate(text, 'electrical_fixture', [['ceiling_fan', [/\bceiling\s+fans?\b/i, /\b(?:install|replace|new)\s+(?:a\s+)?fan\b/i]], ['panel', [/\b(?:electrical|breaker)\s+panels?\b/i]], ['breaker', [/\bcircuit\s+breakers?\b|\bbreakers?\b/i]], ['doorbell', [/\bdoorbells?\b/i]], ['switch', [/\b(?:light\s+)?switch(?:es)?\b/i]], ['outlet', [/\b(?:outlets?|sockets?|receptacles?)\b/i]], ['light', [/\blights?|light\s+fixtures?\b/i]]]); if (fixture) add(candidates, fixture);
    let issue = enumCandidate(text, 'electrical_issue', [['flickering', [/\bflicker(?:ing)?\b/i]], ['tripping', [/\btripping\b/i]], ['not_working', [/\b(?:not working|stopped working|dead)\b/i]], ['installation', [/\b(?:install|installing|installation)\b/i]], ['replacement', [/\b(?:replace|replaced|replacement)\b/i]], ['repair', [/\b(?:repair|fix)\b/i]]]);
    const requestedElectricalOperation = /\b(?:install|installing|installation)\b/i.test(text) ? 'installation' : /\b(?:replace|replaced|replacement)\b/i.test(text) ? 'replacement' : undefined;
    const stoppedTripping = /\b(?:isn['’]?t|is\s+not|not)\s+tripping\b|\bstopped\s+tripping\b|\bno longer\s+trips?\b/i.test(text);
    if (issue?.value === 'tripping' && stoppedTripping) issue = null;
    if (requestedElectricalOperation) issue = { key: 'electrical_issue', value: requestedElectricalOperation, confidence: 0.99, evidence: 'Explicit requested electrical operation.' };
    if (issue) add(candidates, issue);
    if (/\b(?:power is on|there is power|circuit has power|power available)\b/i.test(text)) add(candidates, { key: 'power_available', value: true, confidence: 0.98, evidence: 'Explicit power availability.' }); else if (/\b(?:no power|power is off|no electricity)\b/i.test(text)) add(candidates, { key: 'power_available', value: false, confidence: 0.98, evidence: 'Explicit lack of power.' });
    const noExistingWiring = /\b(?:no wiring(?: exists)?|there is no wiring|no existing wiring|needs? new wiring|new wiring is needed|wiring needs to be added)\b/i.test(text);
    const existingWiring = /\b(?:existing wiring(?: already exists| is there)?|wiring already exists|wiring is already there|already wired|wiring exists|there is existing wiring)\b/i.test(text);
    if (noExistingWiring) add(candidates, { key: 'existing_wiring', value: false, confidence: 0.99, evidence: 'No existing wiring stated.' });
    else if (existingWiring) add(candidates, { key: 'existing_wiring', value: true, confidence: 0.98, evidence: 'Existing wiring stated.' });
    if (/\b(?:already bought|have|got)\b[^.!?]{0,30}\b(?:fixture|light|outlet|switch|fan)\b/i.test(text)) add(candidates, { key: 'parts_provided', value: true, confidence: 0.97, evidence: 'Customer has electrical fixture.' }); else if (/\b(?:bring|supply|provide)\b[^.!?]{0,30}\b(?:fixture|light|outlet|switch|fan)\b/i.test(text)) add(candidates, { key: 'parts_provided', value: false, confidence: 0.97, evidence: 'Provider must supply electrical fixture.' });
    if (/\b(?:electrical|breaker)\s+panel\b|\binstall\s+(?:a\s+)?breaker\b|\breplace\s+(?:a\s+)?breaker\s+in\s+the\s+panel\b/i.test(text)) add(candidates, { key: 'panel_involved', value: true, confidence: 0.99, evidence: 'Panel explicitly involved.' });
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
export function extractIntakePrefill(
  raw: string,
  primaryCategory: TaskCategory,
  secondaryIntents: readonly TaskCategory[] = []
): IntakePrefillResult {
  const text = raw.toLowerCase();
  const allowed = new Set(
    getQuestionsForIntake(primaryCategory, secondaryIntents).map((question) => question.key)
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

  const leavesDebrisOnSite =
    /\b(?:leave|keep)\b[^.!?]{0,50}\b(?:bags?|leaves?|branches?|debris|waste)\b/i.test(text) ||
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

  if (activeCategories.has('moving') && objectFacts.length > 0) {
    const count = totalObjectQuantity(objectFacts);
    if (count > 0) setCandidate(candidates, { key: 'item_count', value: count, confidence: 0.99, evidence: 'Object facts supplied the canonical movable-item count.' });
  }

  if (activeCategories.has('delivery')) {
    const deliveryList = extractDeliveryList(text);
    if (deliveryList) setCandidate(candidates, { key: 'delivery_item', value: deliveryList, confidence: 1.01, evidence: 'Explicit coordinated delivery items.' });
  }

  const accepted = candidates.filter(
    (candidate) => candidate.confidence >= 0.88 && allowed.has(candidate.key)
  );
  const answers: IntakeAnswers = {};
  for (const candidate of accepted) answers[candidate.key] = candidate.value;
  return { answers, evidence: accepted };
}

















