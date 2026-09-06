export const UNIVERSAL_V1_ASSEMBLY_SCOPE_CLASS =
  'STANDARD_SINGLE_FLAT_PACK_ITEM_V1' as const;
export const UNIVERSAL_V1_ITEM_COUNT_CLASS = 'one' as const;

/**
 * Complete, deterministic intake contract for furniture assembly. The
 * non-base choices are intentional: they let the UI collect truthful scope
 * evidence that routes to an estimate instead of forcing a false base answer.
 */
export const UNIVERSAL_V1_FURNITURE_ASSEMBLY_QUESTIONS = [
  {
    key: 'assembly_scope_class',
    label: 'Is this exactly one standard flat-pack furniture item?',
    kind: 'select',
    required: true,
    options: [
      {
        value: UNIVERSAL_V1_ASSEMBLY_SCOPE_CLASS,
        label: 'One standard flat-pack furniture item',
      },
      {
        value: 'OTHER_OR_CUSTOM',
        label: 'Other or custom assembly scope',
      },
    ],
  },
  {
    key: 'item_count_class',
    label: 'How many furniture items need assembly?',
    kind: 'select',
    required: true,
    options: [
      { value: UNIVERSAL_V1_ITEM_COUNT_CLASS, label: 'One item' },
      { value: 'MULTIPLE', label: 'Multiple items' },
    ],
  },
  { key: 'item', label: 'What item(s) — brand / model?', kind: 'text', required: true },
  { key: 'product_link', label: 'Product link (optional)', kind: 'text' },
  { key: 'new_in_box', label: 'New in box?', kind: 'yesno', required: true },
  {
    key: 'tools_included',
    label: 'Are assembly tools included?',
    kind: 'yesno',
    required: true,
  },
  {
    key: 'old_item_removal',
    label: 'Remove / haul an old item?',
    kind: 'yesno',
    required: true,
  },
  { key: 'timing', label: 'Preferred day / time?', kind: 'text', required: true },
] as const;

export interface UniversalV1StandardizedScopeInput {
  category: string;
  answers: Readonly<Record<string, unknown>>;
}

const FURNITURE_ASSEMBLY_ANSWER_KEYS = new Set([
  'assembly_scope_class',
  'item_count_class',
  'item',
  'product_link',
  'new_in_box',
  'tools_included',
  'old_item_removal',
  'timing',
  'access',
  'item_dimensions',
  'assembly_options',
  'scope_confirmed_at',
]);

const MOVING_ANSWER_KEYS = new Set([
  'size_weight',
  'access',
  'move_type',
  'workers_needed',
  'fragile',
  'timing',
  'scope_confirmed_at',
]);

function hasOnlyAllowedAnswerKeys(
  answers: Readonly<Record<string, unknown>>,
  allowedKeys: ReadonlySet<string>,
): boolean {
  return Object.keys(answers).every((key) => allowedKeys.has(key));
}

function furnitureAssemblyScopeIsEligible(
  answers: Readonly<Record<string, unknown>>,
): boolean {
  if (!hasOnlyAllowedAnswerKeys(answers, FURNITURE_ASSEMBLY_ANSWER_KEYS)) return false;
  return answers.assembly_scope_class === UNIVERSAL_V1_ASSEMBLY_SCOPE_CLASS
    && answers.item_count_class === UNIVERSAL_V1_ITEM_COUNT_CLASS
    && answers.new_in_box === true
    && answers.tools_included === true
    && answers.old_item_removal === false;
}

function movingScopeIsEligible(
  answers: Readonly<Record<string, unknown>>,
): boolean {
  if (!hasOnlyAllowedAnswerKeys(answers, MOVING_ANSWER_KEYS)) return false;
  return answers.size_weight === 'light'
    && answers.access === 'ground'
    && answers.move_type === 'same'
    && answers.workers_needed === 'one'
    && answers.fragile === false;
}

export function exactStandardizedScopeIsEligible(
  input: UniversalV1StandardizedScopeInput,
): boolean {
  if (input.category === 'furniture_assembly') {
    return furnitureAssemblyScopeIsEligible(input.answers);
  }
  if (input.category === 'moving') {
    return movingScopeIsEligible(input.answers);
  }
  return false;
}
