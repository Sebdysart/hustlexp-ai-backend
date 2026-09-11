import { getQuestionsForIntake } from './definitions.js';
import type { IntakeAnswer, IntakeAnswers, TaskCategory } from './types.js';

interface Candidate { key: string; value: IntakeAnswer; confidence: number; evidence: string; }
export interface IntakePrefillResult { answers: IntakeAnswers; evidence: Array<Candidate>; }
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
function escapeRegex(value: string): string { return value.replace(/[.*+?^{}()|[\]\\]/g, '\\$&'); }

function add(items: Candidate[], candidate: Candidate): void { const i = items.findIndex((item) => item.key === candidate.key); if (i < 0) items.push(candidate); else if (candidate.confidence > items[i].confidence) items[i] = candidate; }
function numberBefore(text: string, nouns: readonly string[]) { const numberPattern = ['\\d+', ...Object.keys(WORDS).map(escapeRegex)].join('|'); const nounPattern = nouns.map(escapeRegex).join('|'); const match = text.match(new RegExp('\\b(' + numberPattern + ')\\s+(?:\\w+\\s+){0,2}(?:' + nounPattern + ')\\b', 'i')); if (!match) return null; const token = match[1].toLowerCase(); const value = /^\\d+$/.test(token) ? Number(token) : WORDS[token]; return Number.isFinite(value) ? { value, evidence: match[0] } : null; }
function cleanObjectPhrase(value: string): string | null { let result = value.trim().replace(/^(?:my|our|the|a|an|some|this|that|these|those)\s+/i, '').replace(/^(?:new|old)\s+/i, '').replace(/^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+/i, '').replace(/\b(?:today|tomorrow|tonight|please|asap)\b.*$/i, '').replace(/\s+/g, ' ').trim(); result = result.replace(/^(?:my|our|the|a|an|some|this|that|these|those)\s+/i, '').replace(/^(?:new|old)\s+/i, '').trim(); return !result || result.length > 100 || /^(?:it|them|this|that|these|those)$/i.test(result) ? null : result; }
function extractActionObject(text: string, actions: readonly string[]) { const actionPattern = actions.map(escapeRegex).join('|'); const boundary = ['and', 'then', 'bring', 'deliver', 'transport', 'assemble', 'build', 'install', 'mount', 'move', 'carry', 'take', 'from', 'to', 'into', 'onto', 'upstairs', 'downstairs', 'outside', 'inside'].map(escapeRegex).join('|'); const match = text.match(new RegExp('\\b(?:' + actionPattern + ')\\b\\s+(.{1,100}?)(?=\\s+(?:' + boundary + ')\\b|$)', 'i')); if (!match) return null; const object = cleanObjectPhrase(match[1]); if (!object) return null; return { object, evidence: match[0] }; }
function enumCandidate(text: string, key: string, values: Array<[string, RegExp[]]>): Candidate | null { for (const [value, patterns] of values) for (const pattern of patterns) if (pattern.test(text)) return { key, value, confidence: 0.97, evidence: 'Explicit ' + value + ' reference' }; return null; }
function extractAccess(text: string): Candidate | null { if (/\bupstairs\b/i.test(text)) return { key: 'access_restrictions', value: 'The task involves carrying or accessing items upstairs.', confidence: 0.96, evidence: 'upstairs' }; if (/\bdownstairs\b/i.test(text)) return { key: 'access_restrictions', value: 'The task involves carrying or accessing items downstairs.', confidence: 0.96, evidence: 'downstairs' }; const flights = numberBefore(text, ['flight', 'flights']); return flights ? { key: 'access_restrictions', value: flights.value + ' flight' + (flights.value === 1 ? '' : 's') + ' of stairs are involved.', confidence: 0.98, evidence: flights.evidence } : null; }
function extractCounts(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const movingItems = numberBefore(text, [
    'box', 'boxes', 'item', 'items', 'bag', 'bags', 'piece', 'pieces',
  ]);
  if (movingItems) {
    add(candidates, {
      key: 'item_count',
      value: movingItems.value,
      confidence: 0.94,
      evidence: movingItems.evidence,
    });
  }
  for (const [key, nouns, confidence] of [
    ['assembly_count', ['chair', 'chairs', 'desk', 'desks', 'table', 'tables', 'cabinet', 'cabinets', 'shelf', 'shelves', 'bed', 'beds', 'item', 'items'], 0.90],
    ['room_count', ['room', 'rooms', 'bedroom', 'bedrooms'], 0.95],
    ['guest_count', ['guest', 'guests', 'person', 'people', 'attendee', 'attendees'], 0.97],
  ] as const) {
    const count = numberBefore(text, nouns);
    if (count) add(candidates, { key, value: count.value, confidence, evidence: count.evidence });
  }
  return candidates;
}

function extractGenericFacts(raw: string): Candidate[] {
  const text = raw.toLowerCase().replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
  const result: Candidate[] = [];
  const stairFlights = numberBefore(text, ['flight', 'flights']);
  if (stairFlights) { add(result, { key: 'stair_flights', value: stairFlights.value, confidence: 0.99, evidence: stairFlights.evidence }); add(result, { key: 'stairs', value: true, confidence: 0.99, evidence: stairFlights.evidence }); }
  else if (/\b(?:upstairs|downstairs|stairs|staircase)\b/i.test(text)) add(result, { key: 'stairs', value: true, confidence: 0.97, evidence: 'Explicit stair reference' });
  if (/\b(?:mount|mounted|mounting|wall-mounted)\b/i.test(text)) add(result, { key: 'wall_mounting', value: true, confidence: 0.97, evidence: 'Explicit wall mounting reference' });
  if (/\b(?:heavy|fragile|delicate|breakable)\b/i.test(text)) { add(result, { key: 'heavy_or_fragile', value: true, confidence: 0.94, evidence: 'Explicit heavy/fragile description' }); add(result, { key: 'large_items', value: true, confidence: 0.89, evidence: 'Explicit heavy item description' }); }
  const pet = text.match(/\b(dog|dogs|puppy|cat|cats|kitten|bird|parrot|fish|rabbit|bunny)\b/i); if (pet) add(result, { key: 'pet_type', value: /dog|puppy/i.test(pet[1]) ? 'dog' : /cat|kitten/i.test(pet[1]) ? 'cat' : pet[1], confidence: 0.97, evidence: 'Explicit pet reference' });
  const petCount = numberBefore(text, ['dog', 'dogs', 'puppy', 'puppies', 'cat', 'cats', 'pet', 'pets']); if (petCount) add(result, { key: 'pet_count', value: petCount.value, confidence: 0.98, evidence: petCount.evidence });
  const care: string[] = []; if (/\b(?:walk|walking)\b/i.test(text)) care.push('walking'); if (/\b(?:feed|feeding)\b/i.test(text)) care.push('feeding'); if (/\b(?:pet sit|pet sitting|watch my|look after)\b/i.test(text)) care.push('sitting'); if (care.length) add(result, { key: 'care_type', value: care, confidence: 0.96, evidence: 'Explicit pet-care action' });
  for (const group of [extractCounts(text)]) for (const candidate of group) add(result, candidate);
  const delivery = extractActionObject(text, ['pick up', 'pickup', 'collect', 'deliver', 'transport']); if (delivery) add(result, { key: 'delivery_item', value: delivery.object, confidence: 0.94, evidence: delivery.evidence });
  const assembly = extractActionObject(text, ['assemble', 'build', 'put together']); if (assembly) add(result, { key: 'assembly_type', value: assembly.object, confidence: 0.94, evidence: assembly.evidence });
  if (!result.some((item) => item.key === 'assembly_type')) { const deliveryItem = result.find((item) => item.key === 'delivery_item'); if (deliveryItem && /\b(?:assemble|build|put together)\s+it\b/i.test(text)) { add(result, { key: 'assembly_type', value: deliveryItem.value, confidence: 0.90, evidence: 'Assembly pronoun resolved to delivery item' }); add(result, { key: 'assembly_count', value: 1, confidence: 0.90, evidence: 'Singular assembly pronoun' }); } }
  const property = enumCandidate(text, 'property_type', [['apartment', [/\bapartment\b/i, /\bflat\b/i]], ['house', [/\bhouse\b/i, /\bhome\b/i]], ['office', [/\boffice\b/i]]]); if (property) add(result, property);
  const wall = enumCandidate(text, 'wall_type', [['drywall', [/\bdrywall\b/i]], ['brick', [/\bbrick\b/i]], ['concrete', [/\bconcrete\b/i]], ['wood', [/\bwood(?:en)? wall\b/i]]]); if (wall) add(result, wall);
  if (/\b(?:assemble|build|put together)\s+(?:a|an|my|the|this|that)\s+[a-z][\w'-]*(?:\s+[a-z][\w'-]*){0,3}\b/i.test(text)) add(result, { key: 'assembly_count', value: 1, confidence: 0.91, evidence: 'Singular assembly object' });
  const access = extractAccess(text); if (access) add(result, access);
  return result;
}
export function extractIntakePrefill(raw: string, primaryCategory: TaskCategory, secondaryIntents: readonly TaskCategory[] = []): IntakePrefillResult { const allowed = new Set(getQuestionsForIntake(primaryCategory, secondaryIntents).map((question) => question.key)); const accepted = extractGenericFacts(raw).filter((candidate) => candidate.confidence >= 0.88 && allowed.has(candidate.key)); const answers: IntakeAnswers = {}; for (const candidate of accepted) answers[candidate.key] = candidate.value; return { answers, evidence: accepted }; }


