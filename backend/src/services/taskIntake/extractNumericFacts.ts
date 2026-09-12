export type NumericFactRole = 'item_count' | 'room_count' | 'pet_count' | 'guest_count' | 'worker_count' | 'stair_flights' | 'floor_number' | 'weight' | 'duration' | 'distance' | 'dimension';
export type NumericFact = { role: NumericFactRole; value: number; evidence: string; confidence: number };
const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
function parseNumber(raw: string): number | undefined { const normalized = raw.toLowerCase().trim(); return /^\d+$/.test(normalized) ? Number(normalized) : WORD_NUMBERS[normalized]; }
function pushFact(facts: NumericFact[], fact: NumericFact): void { if (!facts.some((existing) => existing.role === fact.role && existing.value === fact.value && existing.evidence === fact.evidence)) facts.push(fact); }
export function extractNumericFacts(input: string): NumericFact[] {
  const text = input.toLowerCase(); const facts: NumericFact[] = [];
  const isRangeContext =
    /\bbetween\s+\d+\s+and\s+\d+\b/i.test(text) ||
    /\b\d+\s*(?:-|to)\s*\d+\s+(?:guests?|attendees?|people|persons?|participants?)\b/i.test(text);
  const NUMBER_PATTERN = String.raw`\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty`;
  const number = `(${NUMBER_PATTERN})`;
  const patterns: Array<{ regex: RegExp; role: NumericFactRole; confidence: number }> = [
    { regex: new RegExp(String.raw`\b${number}\s+(?:boxes?|chairs?|couches?|sofas?|beds?|desks?|tables?|mattresses?|dressers?|cabinets?|refrigerators?|fridges?|washers?|washing machines?|dryers?|shelves?|mirrors?|pianos?)\b`, 'gi'), role: 'item_count', confidence: 0.98 },
    { regex: new RegExp(String.raw`\b${number}\s+(?:bedrooms?|bathrooms?|rooms?)\b`, 'gi'), role: 'room_count', confidence: 0.98 },
    { regex: new RegExp(String.raw`\b${number}[-\s]room\b`, 'gi'), role: 'room_count', confidence: 0.98 },
    { regex: new RegExp(`\\b${number}\\s+(dogs?|cats?|puppies|puppy|kittens?|birds?|parrots?)\\b`, 'gi'), role: 'pet_count', confidence: 0.98 },
    { regex: new RegExp(`\\b${number}\\s+(?:[\\w'-]+\\s+){1,2}(dogs?|cats?|puppies|puppy|kittens?|birds?|parrots?)\\b`, 'gi'), role: 'pet_count', confidence: 0.98 },
    { regex: new RegExp(String.raw`\b${number}\s+(?:guests?|attendees?|participants?|people(?!\s+(?:to|for)\b)|persons?(?!\s+(?:to|for)\b))\b`, 'gi'), role: 'guest_count', confidence: 0.99 },
    { regex: new RegExp(String.raw`\b${number}\s+(?:workers?|people|persons|helpers?)\s+(?:to|for)\b`, 'gi'), role: 'worker_count', confidence: 0.98 },
    { regex: new RegExp(String.raw`\b${number}\s+flights?(?:\s+of\s+stairs?)?\b`, 'gi'), role: 'stair_flights', confidence: 0.99 },
    { regex: new RegExp(String.raw`\b(?:floor|level)\s+${number}\b`, 'gi'), role: 'floor_number', confidence: 0.96 },
    { regex: new RegExp(String.raw`\b${number}(?:st|nd|rd|th)\s+floor\b`, 'gi'), role: 'floor_number', confidence: 0.98 },
    { regex: new RegExp(String.raw`\b${number}\s*(?:pounds?|lbs?)\b`, 'gi'), role: 'weight', confidence: 0.99 },
    { regex: new RegExp(String.raw`\b${number}\s*(?:hours?|hrs?|minutes?|mins?)\b`, 'gi'), role: 'duration', confidence: 0.99 },
    { regex: new RegExp(String.raw`\b${number}\s*(?:miles?|mi)\b`, 'gi'), role: 'distance', confidence: 0.99 },
    { regex: new RegExp(String.raw`\b${number}\s*(?:inches?|feet|ft)\b`, 'gi'), role: 'dimension', confidence: 0.97 },
  ];
  for (const pattern of patterns) {
    if (pattern.role === 'guest_count' && isRangeContext) continue;
    for (const match of text.matchAll(pattern.regex)) { const value = parseNumber(match[1]); if (value !== undefined) pushFact(facts, { role: pattern.role, value, evidence: match[0], confidence: pattern.confidence }); }
  }
  return facts;
}





