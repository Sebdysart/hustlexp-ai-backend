import { getQuestionsForIntake } from './definitions.js';
import type { IntakeAnswer, IntakeAnswers, TaskCategory } from './types.js';

interface Candidate { key: string; value: IntakeAnswer; confidence: number; evidence: string; }
interface QuantifiedItem { quantity: number; item: string; evidence: string; }
export interface IntakePrefillResult { answers: IntakeAnswers; evidence: Array<Candidate>; }
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
function quantityFromToken(token: string): number | null { const normalized = token.toLowerCase(); if (normalized === 'a' || normalized === 'an') return 1; if (/^\d+$/.test(normalized)) return Number(normalized); return WORDS[normalized] ?? null; }
function escapeRegex(value: string): string { return value.replace(/[.*+?^{}()|[\]\\]/g, '\\$&'); }

function add(items: Candidate[], candidate: Candidate): void { const i = items.findIndex((item) => item.key === candidate.key); if (i < 0) items.push(candidate); else if (candidate.confidence > items[i].confidence) items[i] = candidate; }
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

function cleanCompoundItem(value: string): string | null { const cleaned = value.replace(/^(?:my|our|the|some|this|that|these|those|new|old)\s+/i, '').replace(/\s+(?:up|down|upstairs|downstairs|inside|outside)$/i, '').replace(/\s+/g, ' ').trim(); return !cleaned || cleaned.length > 80 ? null : cleaned; }
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
  applyCompoundItemFacts(text, result);
  return result;
}
export function extractIntakePrefill(raw: string, primaryCategory: TaskCategory, secondaryIntents: readonly TaskCategory[] = []): IntakePrefillResult { const allowed = new Set(getQuestionsForIntake(primaryCategory, secondaryIntents).map((question) => question.key)); const accepted = extractGenericFacts(raw).filter((candidate) => candidate.confidence >= 0.88 && allowed.has(candidate.key)); const answers: IntakeAnswers = {}; for (const candidate of accepted) answers[candidate.key] = candidate.value; return { answers, evidence: accepted }; }


