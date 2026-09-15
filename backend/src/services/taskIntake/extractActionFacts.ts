import type { TaskAction } from './taskFacts.js';

type ActionObjectFact = {
  object: string;
  quantity?: number;
  evidence?: string;
};

type ObjectReferenceLike = {
  reference: string;
  resolvedObject: string;
  quantity: number | null;
  evidence: string;
};

type ActionType = TaskAction['type'];
type RawActionMatch = { type: ActionType; evidence: string; start: number; end: number };

function collectActionMatches(text: string): RawActionMatch[] {
  const matches: RawActionMatch[] = [];
  for (const definition of ACTION_PATTERNS) {
    definition.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = definition.pattern.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (definition.type === 'deliver' && /^bring$/i.test(match[0]) && /^\s+(?:your\s+own\s+)?(?:an?\s+|the\s+)?(?:truck|van|car|suv|drill|ladder|mower|rake|leaf\s+blower|tools?)\b/i.test(text.slice(end, end + 60))) continue;
      matches.push({ type: definition.type, evidence: match[0], start, end });
    }
  }
  return matches.sort((a, b) => a.start - b.start || a.end - b.end);
}

const ACTION_PATTERNS: Array<{
  type: ActionType;
  pattern: RegExp;
}> = [
  {
    type: 'pickup',
    pattern: /\b(?:pick\s*up|pickup|collect|grab)\b/gi,
  },
  {
    type: 'deliver',
    pattern: /\b(?:deliver|bring|transport|drop\s*off)\b/gi,
  },
  {
    type: 'move',
    pattern: /\b(?:move|carry|relocate)\b/gi,
  },
  {
    type: 'assemble',
    pattern: /\b(?:assemble|assembled|reassemble|reassembled|build|built|put\s+together)\b/gi,
  },
  {
    type: 'install',
    pattern: /\b(?:install|installed)\b/gi,
  },
  {
    type: 'mount',
    pattern: /\b(?:mount|mounted|anchor|anchored|attach|attached)\b/gi,
  },
  {
    type: 'clean',
    pattern: /\b(?:clean|cleaned|clean\s+up|wash|washed|scrub|scrubbed|vacuum|vacuumed|mop|mopped)\b/gi,
  },
  {
    type: 'haul',
    pattern: /\b(?:haul\s+away|take\s+away|carry\s+away)\b/gi,
  },
  {
    type: 'remove',
    pattern: /\b(?:remove|dispose\s+of|clear\s+out)\b/gi,
  },
  {
    type: 'walk',
    pattern: /\bwalk\b/gi,
  },
  {
    type: 'feed',
    pattern: /\bfeed\b/gi,
  },
  {
    type: 'watch',
    pattern: /\b(?:watch|pet\s*sit|petsit|babysit)\b/gi,
  },
  {
    type: 'repair',
    pattern: /\b(?:repair|fix)\b/gi,
  },
];

const OBJECT_ALIASES: Array<{
  pattern: RegExp;
  object: string;
}> = [
  { pattern: /\bcouches?\b|\bsofas?\b/i, object: 'couch' },
  {
    pattern: /\brefrigerators?\b|\bfridges?\b/i,
    object: 'refrigerator',
  },
  { pattern: /\bwashing\s+machines?\b/i, object: 'washing machine' },
  { pattern: /\bchairs?\b/i, object: 'chair' },
  { pattern: /\btables?\b/i, object: 'table' },
  { pattern: /\bdesks?\b/i, object: 'desk' },
  { pattern: /\bbeds?\b/i, object: 'bed' },
  { pattern: /\bmattresses?\b/i, object: 'mattress' },
  { pattern: /\bdressers?\b/i, object: 'dresser' },
  { pattern: /\bcabinets?\b/i, object: 'cabinet' },
  { pattern: /\bshelves?\b/i, object: 'shelf' },
  { pattern: /\bmirrors?\b/i, object: 'mirror' },
  { pattern: /\btvs?\b|\btelevisions?\b/i, object: 'tv' },
  { pattern: /\bbox(?:es)?\b/i, object: 'box' },
  { pattern: /\bpianos?\b/i, object: 'piano' },
  { pattern: /\bdogs?\b/i, object: 'dog' },
  { pattern: /\bcats?\b/i, object: 'cat' },
];

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

function findNearestExplicitObject(
  text: string,
  actionIndex: number,
  objectFacts: ActionObjectFact[],
): ActionObjectFact | undefined {
  let best:
    | {
        fact: ActionObjectFact;
        distance: number;
      }
    | undefined;

  for (const fact of objectFacts) {
    const evidence = fact.evidence?.toLowerCase();

    if (!evidence) {
      continue;
    }

    let searchFrom = 0;

    while (true) {
      const index = text.indexOf(evidence, searchFrom);

      if (index === -1) break;

      const distance = Math.abs(index - actionIndex);

      if (!best || distance < best.distance) {
        best = {
          fact,
          distance,
        };
      }

      searchFrom = index + Math.max(evidence.length, 1);
    }
  }

  return best?.fact;
}

function findObjectAfterAction(
  text: string,
  actionEnd: number,
): string | undefined {
  let tail = text.slice(actionEnd, actionEnd + 100);

  // Stop searching when another explicit action begins.
  // Example:
  // "move a couch and mount a tv"
  //              ^ stop here for the move action
  const nextActionPattern =
    /\b(?:and|then|after(?:wards)?|before)\s+(?:pick\s*up|pickup|collect|grab|deliver|bring|transport|drop\s*off|move|carry|relocate|assemble|reassemble|build|put\s+together|install|mount|anchor|attach|clean|wash|scrub|vacuum|mop|haul\s+away|take\s+away|carry\s+away|remove|dispose\s+of|clear\s+out|walk|feed|watch|pet\s*sit|petsit|babysit|repair|fix)\b/i;

  const nextActionMatch = tail.match(nextActionPattern);

  if (
    nextActionMatch &&
    nextActionMatch.index !== undefined
  ) {
    tail = tail.slice(0, nextActionMatch.index);
  }

  let nearest:
    | {
        object: string;
        index: number;
      }
    | undefined;

  for (const alias of OBJECT_ALIASES) {
    const match = tail.match(alias.pattern);

    if (!match || match.index === undefined) {
      continue;
    }

    if (!nearest || match.index < nearest.index) {
      nearest = {
        object: alias.object,
        index: match.index,
      };
    }
  }

  return nearest?.object;
}

function findObjectAfterActionWithinClause(text: string, actionEnd: number, clauseEnd: number): string | undefined {
  const tail = text.slice(actionEnd, clauseEnd);
  let nearest: { object: string; index: number } | undefined;
  for (const alias of OBJECT_ALIASES) {
    alias.pattern.lastIndex = 0;
    const match = alias.pattern.exec(tail);
    alias.pattern.lastIndex = 0;
    if (match && match.index !== undefined && (!nearest || match.index < nearest.index)) nearest = { object: alias.object, index: match.index };
  }
  return nearest?.object;
}

function findReferenceAfterAction(
  text: string,
  actionEnd: number,
  references: ObjectReferenceLike[],
): ObjectReferenceLike | undefined {
  const tail = text.slice(actionEnd, actionEnd + 70);

  return references.find((reference) => {
    const escapedReference = reference.reference.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );

    return new RegExp(
      `\\b${escapedReference}\\b`,
      'i',
    ).test(tail);
  });
}

function findMatchingObjectFact(
  explicitObject: string,
  objectFacts: ActionObjectFact[],
): ActionObjectFact | undefined {
  const directMatch = objectFacts.find(
    (fact) => fact.object === explicitObject,
  );

  if (directMatch) {
    return directMatch;
  }

  if (explicitObject === 'dog' || explicitObject === 'cat') {
    const petMatch = objectFacts.find(
      (fact) => fact.object === 'pet',
    );

    if (petMatch) {
      return petMatch;
    }
  }

  const escapedObject = explicitObject.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );

  const evidencePattern = new RegExp(
    `\\b${escapedObject}s?\\b`,
    'i',
  );

  return objectFacts.find(
    (fact) =>
      fact.quantity !== undefined &&
      fact.evidence !== undefined &&
      evidencePattern.test(fact.evidence),
  );
}

function resolveActionQuantity(
  object: string | undefined,
  objectFacts: ActionObjectFact[],
  referenceQuantity?: number,
): number | undefined {
  if (
    referenceQuantity !== undefined &&
    referenceQuantity > 0
  ) {
    return referenceQuantity;
  }

  if (!object) {
    return undefined;
  }

  const matchingFact = findMatchingObjectFact(
    object,
    objectFacts,
  );

  return matchingFact?.quantity ?? undefined;
}

function addAction(
  actions: TaskAction[],
  action: TaskAction,
): void {
  const duplicate = actions.some(
    (existing) =>
      existing.type === action.type &&
      existing.object === action.object &&
      existing.evidence === action.evidence,
  );

  if (!duplicate) {
    actions.push(action);
  }
}

export function extractActionFacts(
  input: string,
  objectFacts: ActionObjectFact[],
  objectReferences: ObjectReferenceLike[],
): TaskAction[] {
  const text = input.toLowerCase();
  const actions: TaskAction[] = [];
  const rawActions = collectActionMatches(text);
  for (let index = 0; index < rawActions.length; index += 1) {
    const rawAction = rawActions[index];
    const actionStart = rawAction.start;
    const actionEnd = rawAction.end;
    const nextActionStart = rawActions[index + 1]?.start ?? text.length;
    const actionClause = text.slice(actionEnd, nextActionStart);
    let object: string | undefined;
    let quantity: number | undefined;
    const directPronoun = /^\s+(?:them|it|both)\b/i.test(actionClause);
    if (directPronoun) {
      const previousAction = actions.at(-1);
      if (previousAction?.object) { object = previousAction.object; quantity = previousAction.quantity; }
    }
    if (!object) {

      const reference = findReferenceAfterAction(
        text,
        actionEnd,
        objectReferences,
      );

      const explicitObject = findObjectAfterActionWithinClause(
        text,
        actionEnd,
        nextActionStart,
      );

      const nearestFact = findNearestExplicitObject(
        text,
        actionStart,
        objectFacts,
      );

      if (explicitObject) {
        object = explicitObject;
        quantity = resolveActionQuantity(
          explicitObject,
          objectFacts,
        );
      } else if (reference) {
        object = reference.resolvedObject;
        quantity = resolveActionQuantity(
          reference.resolvedObject,
          objectFacts,
          reference.quantity || undefined,
        );
      } else if (nearestFact) {
        object = nearestFact.object;
        quantity = nearestFact.quantity ?? undefined;
      }
    }
    addAction(actions, { type: rawAction.type, ...(object ? { object } : {}), ...(quantity === undefined ? {} : { quantity }), evidence: rawAction.evidence });
  }
  return actions;
}
