import { describe, expect, it } from 'vitest';

import {
  buildUniversalV1TaskDraftSafetyEvidence,
  parseUniversalV1TaskDraft,
  type SanitizedTaskDraftAnswer,
} from '../../src/services/UniversalV1TaskDraftParser';
import type { TaskDraftCategory } from '../../src/services/UniversalV1TaskDraftIngress';

const ALL_CATEGORIES: TaskDraftCategory[] = [
  'moving',
  'furniture_assembly',
  'errands',
  'yard',
  'tech',
  'cleaning',
  'handyman',
  'other',
];

function parse(
  category: TaskDraftCategory,
  sanitizedRaw = 'Help with a local task near downtown',
  sanitizedAnswers: Record<string, SanitizedTaskDraftAnswer> = {}
) {
  return parseUniversalV1TaskDraft({ category, sanitizedRaw, sanitizedAnswers });
}

describe('UniversalV1TaskDraftParser', () => {
  it.each(ALL_CATEGORIES)('produces a complete display-only scope for %s', (category) => {
    const result = parse(category);

    expect(result).toMatchObject({
      category,
      estimate_display_only: true,
    });
    expect(result.title).not.toHaveLength(0);
    expect(result.scope_summary).not.toHaveLength(0);
    expect(result.labor_label).not.toHaveLength(0);
    expect(result.est_price_min_cents).toBeGreaterThan(0);
    expect(result.est_price_max_cents).toBeGreaterThan(result.est_price_min_cents);
    expect(result.required_skills.length).toBeGreaterThan(0);
    expect(Array.isArray(result.required_tools)).toBe(true);
    expect(result.recommended_hustler_profile).not.toHaveLength(0);
  });

  it('derives electrical risk from a known free-text details answer', () => {
    const result = parse('handyman', 'Diagnose an issue', {
      details: 'electrical panel wiring',
      timing: 'weekday morning',
    });

    expect(result.safetyEvidence).toContain('electrical panel wiring');
    expect(result.risk_flags).toContain('Electrical');
    expect(result.missing_questions).toEqual([]);
  });

  it('includes an affirmative ladder/tree answer as safety evidence', () => {
    const result = parse('yard', 'Tidy the back yard', {
      ladder_tree: true,
    });

    expect(result.safetyEvidence).toBe('Any ladder, tree or chainsaw work?');
    expect(result.risk_flags).toEqual(['Height / ladder work', 'Tree / chainsaw work']);
  });

  it('does not turn a false ladder/tree answer into a positive risk', () => {
    const result = parse('yard', 'Tidy the lawn', {
      ladder_tree: false,
    });

    expect(result.safetyEvidence).not.toContain('ladder');
    expect(result.safetyEvidence).not.toContain('tree');
    expect(result.risk_flags).not.toContain('Height / ladder work');
    expect(result.risk_flags).not.toContain('Tree / chainsaw work');
  });

  it('reports only unanswered required category questions', () => {
    const result = parse('moving', 'Move several boxes', {
      size_weight: 'heavy',
      access: 'stairs',
      move_type: 'transport',
      fragile: false,
    });

    expect(result.missing_questions).toEqual(['Preferred day / time?']);
    expect(result.safetyEvidence).toBe('Heavy (needs two)\nStairs\nTransport to another address');
    expect(result.risk_flags).toEqual(['Heavy items (2+ people)', 'Stairs / constrained access']);
  });

  it('uses additional sanitized answer values as narrowing safety evidence', () => {
    const answers = {
      details: 'printer setup',
      timing: 'Saturday afternoon',
      unknown_client_field: 'electrical wiring',
      additional_observations: ['near a breaker', 'indoor'],
    };

    expect(buildUniversalV1TaskDraftSafetyEvidence('tech', answers)).toBe(
      'printer setup\nSaturday afternoon\nnear a breaker\nindoor\nelectrical wiring'
    );
    expect(parse('tech', 'Set up a printer', answers).risk_flags).toContain('Electrical');
  });

  it('omits false booleans and server-derived negative scope fields from safety evidence', () => {
    const result = parse('tech', 'Set up a printer', {
      ladder_tree: false,
      excluded_work: 'ladder and tree work',
      safety_restrictions: 'no electrical wiring',
    });

    expect(result.safetyEvidence).toBe('');
    expect(result.risk_flags).toEqual([]);
  });

  it('uses the readable key for an affirmative additional boolean', () => {
    const result = parse('tech', 'Set up a printer', {
      electrical_panel_work: true,
    });

    expect(result.safetyEvidence).toBe('electrical panel work');
    expect(result.risk_flags).toContain('Electrical');
  });

  it('preserves an assumed privacy-safe scope without adding identifiers', () => {
    const result = parse('furniture_assembly', 'Assemble a six drawer dresser near downtown', {
      item: 'six drawer dresser',
      new_in_box: false,
      timing: 'Saturday morning',
    });

    expect(result.title).toBe('Assemble a six drawer dresser near downtown');
    expect(result.scope_summary).toBe('Assemble a six drawer dresser near downtown');
    expect(JSON.stringify(result)).not.toMatch(/@|\b\d{3}[-.) ]\d{3}/u);
  });

  it('returns byte-for-byte equivalent values for identical inputs', () => {
    const input = {
      category: 'errands' as const,
      sanitizedRaw: 'Pick up a small prepaid parcel',
      sanitizedAnswers: {
        pickup_dropoff: 'Downtown to north neighborhood',
        item_size: 'small',
        paid_already: true,
        vehicle_needed: false,
        timing: 'Tuesday after 3pm',
      },
    };

    const first = parseUniversalV1TaskDraft(input);
    const second = parseUniversalV1TaskDraft(input);

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
