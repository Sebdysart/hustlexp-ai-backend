export type AreaFact = { area: string; evidence: string; confidence: number };

const AREA_ALIASES = [
  { pattern: /\bkitchens?\b/i, area: 'kitchen' }, { pattern: /\bbathrooms?\b/i, area: 'bathroom' },
  { pattern: /\bbedrooms?\b/i, area: 'bedroom' }, { pattern: /\bliving\s+rooms?\b/i, area: 'living room' },
  { pattern: /\bdining\s+rooms?\b/i, area: 'dining room' }, { pattern: /\bgarages?\b/i, area: 'garage' },
  { pattern: /\bdriveways?\b/i, area: 'driveway' }, { pattern: /\bbackyards?\b/i, area: 'backyard' },
  { pattern: /\bfront\s+yards?\b/i, area: 'front yard' }, { pattern: /(?<!\bback)(?<!\bfront\s)\byards?\b/i, area: 'yard' },
  { pattern: /\bbalcon(?:y|ies)\b/i, area: 'balcony' }, { pattern: /\bpatios?\b/i, area: 'patio' },
  { pattern: /\bbasements?\b/i, area: 'basement' }, { pattern: /\battics?\b/i, area: 'attic' },
  { pattern: /\boffices?\b/i, area: 'office' }, { pattern: /\bhallways?\b/i, area: 'hallway' },
  { pattern: /\broof(?:line)?s?\b/i, area: 'roof' },
];

export function extractAreaFacts(input: string): AreaFact[] {
  const text = input.toLowerCase();
  const matches: Array<AreaFact & { index: number }> = [];
  for (const definition of AREA_ALIASES) {
    const match = definition.pattern.exec(text);
    definition.pattern.lastIndex = 0;
    if (match && match.index !== undefined) matches.push({ area: definition.area, evidence: match[0], confidence: 0.96, index: match.index });
  }
  matches.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const facts: AreaFact[] = [];
  for (const match of matches) {
    if (seen.has(match.area)) continue;
    seen.add(match.area);
    facts.push({ area: match.area, evidence: match.evidence, confidence: match.confidence });
  }
  return facts;
}
