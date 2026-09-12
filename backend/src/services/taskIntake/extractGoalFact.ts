export type GoalFact = {
  goal: string;
  evidence: string;
  confidence: number;
};

const GOAL_PATTERNS = [
  { goal: 'moving', pattern: /\b(?:move|moving|moved|carry|relocate)\b/i },
  { goal: 'delivery', pattern: /\b(?:deliver|delivering|delivered|drop\s*off|transport|pick\s*up|pickup)\b/i },
  { goal: 'assembly', pattern: /\b(?:assemble|assembled|assembly|build|built|put\s+together|reassemble)\b/i },
  { goal: 'installation', pattern: /\b(?:install|installed|installation|mount|mounted|anchor|attach)\b/i },
  { goal: 'cleaning', pattern: /\b(?:clean|cleaned|cleaning|wash|washed|scrub|scrubbed|vacuum|vacuumed|mop|mopped)\b/i },
  { goal: 'removal', pattern: /\b(?:remove|haul\s+away|take\s+away|dispose\s+of|clear\s+out)\b/i },
  { goal: 'repair', pattern: /\b(?:repair|repaired|fix|fixed)\b/i },
  { goal: 'pet care', pattern: /\b(?:walk|feed|watch|pet\s*[-]?sit|petsit)\b/i },
];

export function extractGoalFact(input: string): GoalFact | undefined {
  const text = input.toLowerCase();
  let earliest: { goal: string; evidence: string; index: number } | undefined;
  for (const definition of GOAL_PATTERNS) {
    const match = definition.pattern.exec(text);
    definition.pattern.lastIndex = 0;
    if (match && match.index !== undefined && (!earliest || match.index < earliest.index)) earliest = { goal: definition.goal, evidence: match[0], index: match.index };
  }
  return earliest ? { goal: earliest.goal, evidence: earliest.evidence, confidence: 0.95 } : undefined;
}
