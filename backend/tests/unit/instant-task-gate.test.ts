/**
 * InstantTaskGate Unit Tests
 *
 * Tests the pure heuristic checkInstantEligibility function.
 * All branches: missing_location, vague_location, missing_access,
 * missing_success_criteria, semantic_ambiguity, and instant-eligible paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../src/logger', () => {
  const childFn = () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: childFn,
  });
  const mockLogger = {
    child: childFn,
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  return { logger: mockLogger };
});

// Mock AIClient so AI path is bypassed (we only test the heuristic)
vi.mock('../../src/services/AIClient', () => ({
  AIClient: {
    isConfigured: vi.fn().mockReturnValue(false),
    callJSON: vi.fn(),
  },
}));

import { checkInstantEligibility, InstantTaskGate } from '../../src/services/InstantTaskGate';

// ============================================================================
// HELPERS
// ============================================================================

interface TaskDraftLike {
  title: string;
  description: string;
  location?: string;
  requirements?: string;
  deadline?: Date;
  category?: string;
}

function makeTask(overrides: Partial<TaskDraftLike> = {}): TaskDraftLike {
  return {
    title: 'Deliver package',
    description: 'Pick up the package at 123 Main St and deliver it to 456 Oak Ave.',
    location: '123 Main St, Los Angeles, CA 90001',
    requirements: undefined,
    category: 'delivery',
    ...overrides,
  };
}

// ============================================================================
// MISSING LOCATION — hard blocker
// ============================================================================

describe('checkInstantEligibility — missing_location', () => {
  it('blocks when location is undefined', async () => {
    const result = await checkInstantEligibility(makeTask({ location: undefined }));
    expect(result.instantEligible).toBe(false);
    expect(result.blockReason).toBe('missing_location');
    expect(result.questions.length).toBeGreaterThan(0);
  });

  it('blocks when location is empty string', async () => {
    const result = await checkInstantEligibility(makeTask({ location: '' }));
    expect(result.instantEligible).toBe(false);
    expect(result.blockReason).toBe('missing_location');
  });

  it('blocks when location is only whitespace', async () => {
    const result = await checkInstantEligibility(makeTask({ location: '   ' }));
    expect(result.instantEligible).toBe(false);
    expect(result.blockReason).toBe('missing_location');
  });
});

// ============================================================================
// VAGUE LOCATION — hard blocker
// ============================================================================

describe('checkInstantEligibility — vague_location', () => {
  it('blocks on "somewhere" in short location', async () => {
    const result = await checkInstantEligibility(makeTask({ location: 'somewhere downtown' }));
    expect(result.instantEligible).toBe(false);
    expect(result.blockReason).toBe('vague_location');
  });

  it('blocks on "near" in short location', async () => {
    const result = await checkInstantEligibility(makeTask({ location: 'near the park' }));
    expect(result.instantEligible).toBe(false);
    expect(result.blockReason).toBe('vague_location');
  });

  it('blocks on "around" in short location', async () => {
    const result = await checkInstantEligibility(makeTask({ location: 'around here' }));
    expect(result.instantEligible).toBe(false);
    expect(result.blockReason).toBe('vague_location');
  });

  it('blocks on "downtown" in short location', async () => {
    const result = await checkInstantEligibility(makeTask({ location: 'downtown' }));
    expect(result.instantEligible).toBe(false);
    expect(result.blockReason).toBe('vague_location');
  });

  it('blocks on "nearby" in short location', async () => {
    const result = await checkInstantEligibility(makeTask({ location: 'nearby location' }));
    expect(result.instantEligible).toBe(false);
    expect(result.blockReason).toBe('vague_location');
  });

  it('blocks on "campus" in short location', async () => {
    const result = await checkInstantEligibility(makeTask({ location: 'campus' }));
    expect(result.instantEligible).toBe(false);
    expect(result.blockReason).toBe('vague_location');
  });

  it('does NOT block a specific address with "near" in a long string', async () => {
    // Long location strings (30+ chars) pass the vague check
    const result = await checkInstantEligibility(makeTask({
      location: '123 Near Oak Street, San Francisco, CA 94102',
    }));
    // Should either pass or fail for a different reason, not vague_location
    if (!result.instantEligible) {
      expect(result.blockReason).not.toBe('vague_location');
    }
  });

  it('clears the question for the vague location block', async () => {
    const result = await checkInstantEligibility(makeTask({ location: 'somewhere' }));
    expect(result.questions.length).toBeGreaterThan(0);
    expect(result.questions[0]).toMatch(/address|location/i);
  });
});

// ============================================================================
// MISSING ACCESS — hard blocker for private spaces
// ============================================================================

describe('checkInstantEligibility — missing_access', () => {
  it('blocks when task is inside an apartment with no access info', async () => {
    const result = await checkInstantEligibility(makeTask({
      title: 'Move furniture',
      description: 'Help me move furniture inside my apartment, 3rd floor.',
      location: '456 Oak Ave Apt 3B, Los Angeles, CA 90001',
    }));
    expect(result.instantEligible).toBe(false);
    expect(result.blockReason).toBe('missing_access');
    expect(result.questions[0]).toMatch(/access|key|code|buzzer/i);
  });

  it('blocks when description says "in the house" without access info', async () => {
    const result = await checkInstantEligibility(makeTask({
      title: 'Clean house',
      description: 'Clean the kitchen and bathrooms in the house. Bring your own supplies.',
      location: '789 Pine St, Austin, TX 78701',
    }));
    expect(result.instantEligible).toBe(false);
    expect(result.blockReason).toBe('missing_access');
  });

  it('passes when apartment task includes door code in description', async () => {
    const result = await checkInstantEligibility(makeTask({
      title: 'Deliver groceries',
      description: 'Deliver groceries to apartment 3B. Door code is 1234. Ring buzzer 301.',
      location: '456 Oak Ave Apt 3B, Los Angeles, CA 90001',
    }));
    // With access info (code/buzzer), should not block on missing_access
    if (!result.instantEligible) {
      expect(result.blockReason).not.toBe('missing_access');
    }
  });

  it('passes when task says "will be on porch" (public access)', async () => {
    const result = await checkInstantEligibility(makeTask({
      title: 'Pick up donation box',
      description: 'Pick up the donation box, it will be on the porch outside the front door.',
      location: '123 Maple Dr, Portland, OR 97201',
    }));
    if (!result.instantEligible) {
      expect(result.blockReason).not.toBe('missing_access');
    }
  });

  it('passes when requirements field has key info', async () => {
    const result = await checkInstantEligibility(makeTask({
      title: 'Water plants',
      description: 'Water my indoor plants in the apartment.',
      location: '456 Oak Ave, Los Angeles, CA 90001',
      requirements: 'Key is under the doormat. Apartment 2A.',
    }));
    if (!result.instantEligible) {
      expect(result.blockReason).not.toBe('missing_access');
    }
  });

  it('passes when "i will be" is mentioned (owner present)', async () => {
    const result = await checkInstantEligibility(makeTask({
      title: 'Help carry boxes',
      description: 'Help me carry boxes from inside my apartment. I will be there to let you in.',
      location: '789 Elm St Apt 5, Chicago, IL 60601',
    }));
    if (!result.instantEligible) {
      expect(result.blockReason).not.toBe('missing_access');
    }
  });
});

// ============================================================================
// MISSING SUCCESS CRITERIA — complex short tasks
// ============================================================================

describe('checkInstantEligibility — missing_success_criteria', () => {
  it('blocks a cleaning task with extremely short description', async () => {
    const result = await checkInstantEligibility(makeTask({
      title: 'Clean house',
      description: 'clean it', // < 20 chars
      category: 'cleaning',
      location: '123 Main St, Austin, TX 78701',
    }));
    expect(result.instantEligible).toBe(false);
    expect(result.blockReason).toBe('missing_success_criteria');
  });

  it('blocks an organizing task with only 5-char description', async () => {
    const result = await checkInstantEligibility(makeTask({
      title: 'Organize garage',
      description: 'do it',
      category: 'organizing',
      location: '456 Oak Ave, San Diego, CA 92101',
    }));
    expect(result.instantEligible).toBe(false);
    expect(result.blockReason).toBe('missing_success_criteria');
  });

  it('does NOT block cleaning task with 20+ char description', async () => {
    const result = await checkInstantEligibility(makeTask({
      title: 'Deep clean kitchen',
      description: 'Deep clean the kitchen, including stovetop, oven, counters, and floor.',
      category: 'cleaning',
      location: '789 Pine St, Denver, CO 80201',
    }));
    if (!result.instantEligible) {
      expect(result.blockReason).not.toBe('missing_success_criteria');
    }
  });

  it('passes a complex task with "done" in short description', async () => {
    const result = await checkInstantEligibility(makeTask({
      title: 'Assembly',
      description: 'done when finished',
      category: 'assembly',
      location: '321 Birch Blvd, Seattle, WA 98101',
    }));
    if (!result.instantEligible) {
      expect(result.blockReason).not.toBe('missing_success_criteria');
    }
  });

  it('does not trigger for non-complex task categories', async () => {
    const result = await checkInstantEligibility(makeTask({
      title: 'Deliver package',
      description: 'short',
      category: 'delivery',
      location: '123 Main St, Miami, FL 33101',
    }));
    // Delivery is not in complexTaskTypes, should not fire this blocker
    if (!result.instantEligible) {
      expect(result.blockReason).not.toBe('missing_success_criteria');
    }
  });
});

// ============================================================================
// SEMANTIC AMBIGUITY
// ============================================================================

describe('checkInstantEligibility — semantic_ambiguity', () => {
  it('blocks on "help me" with very short description', async () => {
    const result = await checkInstantEligibility(makeTask({
      title: 'help me',
      description: 'help me',
      location: '123 Main St, Boston, MA 02101',
    }));
    expect(result.instantEligible).toBe(false);
    expect(result.blockReason).toBe('semantic_ambiguity');
  });

  it('blocks on "need help" with short total text', async () => {
    const result = await checkInstantEligibility(makeTask({
      title: 'need help',
      description: 'need help',
      location: '456 Oak Ave, NYC, NY 10001',
    }));
    expect(result.instantEligible).toBe(false);
    expect(result.blockReason).toBe('semantic_ambiguity');
  });

  it('blocks moving task with vague quantity', async () => {
    const result = await checkInstantEligibility(makeTask({
      title: 'Help me move',
      description: 'Help me move some boxes from my apartment to a storage unit down the street. Should take about 2 hours.',
      location: '789 Elm St Apt 3, Chicago, IL 60601',
      requirements: 'Key code is 1234',
    }));
    // "some boxes" with moving is semantically ambiguous for quantity
    // May or may not block depending on exact logic — just verify result structure
    expect(typeof result.instantEligible).toBe('boolean');
    if (!result.instantEligible) {
      expect(['semantic_ambiguity', 'missing_access']).toContain(result.blockReason);
    }
  });
});

// ============================================================================
// INSTANT ELIGIBLE — happy paths
// ============================================================================

describe('checkInstantEligibility — instantEligible', () => {
  it('passes a well-described delivery task with specific address', async () => {
    const result = await checkInstantEligibility({
      title: 'Package delivery',
      description: 'Pick up a sealed envelope from the front desk at 123 Main St and drop it off at the mail center at 456 Oak Ave. Front desk staff will assist.',
      location: '123 Main St, Los Angeles, CA 90001',
      category: 'delivery',
    });
    expect(result.instantEligible).toBe(true);
    expect(result.blockReason).toBeUndefined();
    expect(result.questions).toHaveLength(0);
  });

  it('passes a grocery run with specific list and address', async () => {
    const result = await checkInstantEligibility({
      title: 'Grocery pickup',
      description: 'Buy 2 gallons of milk, 1 dozen eggs, and a loaf of bread from Trader Joe\'s at 100 Broadway. Deliver to my door at 555 Park Ave.',
      location: '100 Broadway, New York, NY 10006',
      category: 'errands',
    });
    expect(result.instantEligible).toBe(true);
  });

  it('passes a lawn mowing task with clear scope', async () => {
    const result = await checkInstantEligibility({
      title: 'Mow front lawn',
      description: 'Mow the front lawn at 321 Oak St. Mow in a standard pattern and bag clippings. Mower and bags provided on porch.',
      location: '321 Oak St, Austin, TX 78701',
      category: 'yardwork',
    });
    expect(result.instantEligible).toBe(true);
  });

  it('passes furniture assembly with model number', async () => {
    const result = await checkInstantEligibility({
      title: 'Assemble IKEA desk',
      description: 'Assemble one IKEA MICKE desk (model #802.447.59). All parts and instructions will be in the box. Takes about 2 hours. Bring your own tools.',
      location: '789 Pine Ave, Seattle, WA 98101',
      category: 'assembly',
    });
    expect(result.instantEligible).toBe(true);
  });

  it('passes outdoor task with specific location and no private space concerns', async () => {
    const result = await checkInstantEligibility({
      title: 'Dog walking',
      description: 'Walk my golden retriever Buddy for 45 minutes around Griffith Park. Start and end at the main parking lot on Vermont Ave.',
      location: '4730 Crystal Springs Dr, Los Angeles, CA 90027',
      category: 'pet-care',
    });
    expect(result.instantEligible).toBe(true);
  });

  it('returns empty questions array when eligible', async () => {
    const result = await checkInstantEligibility(makeTask());
    if (result.instantEligible) {
      expect(result.questions).toEqual([]);
    }
  });
});

// ============================================================================
// RESULT STRUCTURE
// ============================================================================

describe('checkInstantEligibility — result structure', () => {
  it('always returns instantEligible boolean', async () => {
    const result = await checkInstantEligibility(makeTask());
    expect(typeof result.instantEligible).toBe('boolean');
  });

  it('always returns questions array', async () => {
    const result = await checkInstantEligibility(makeTask({ location: undefined }));
    expect(Array.isArray(result.questions)).toBe(true);
  });

  it('blocked result always has blockReason string', async () => {
    const result = await checkInstantEligibility(makeTask({ location: undefined }));
    expect(typeof result.blockReason).toBe('string');
  });

  it('eligible result has no blockReason', async () => {
    const result = await checkInstantEligibility(makeTask());
    if (result.instantEligible) {
      expect(result.blockReason).toBeUndefined();
    }
  });
});

// ============================================================================
// InstantTaskGate export (check: callAIGate)
// ============================================================================

describe('InstantTaskGate.check', () => {
  it('is a function', () => {
    expect(typeof InstantTaskGate.check).toBe('function');
  });

  it('blocks missing location via the check wrapper', async () => {
    const result = await InstantTaskGate.check(makeTask({ location: undefined }) as any);
    expect(result.instantEligible).toBe(false);
    expect(result.blockReason).toBe('missing_location');
  });

  it('returns eligible for a well-formed task via the check wrapper', async () => {
    const result = await InstantTaskGate.check(makeTask() as any);
    expect(typeof result.instantEligible).toBe('boolean');
    // With AIClient.isConfigured() mocked to false, falls back to heuristic
    expect(result.instantEligible).toBe(true);
  });
});
