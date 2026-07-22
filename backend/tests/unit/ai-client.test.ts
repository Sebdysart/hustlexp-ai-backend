/**
 * AIClient Unit Tests
 *
 * Tests call, callJSON, and isConfigured with mocked providers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRecordObservation = vi.hoisted(() => vi.fn());
const observationReceipt = {
  observationId: '11111111-1111-4111-8111-111111111111',
  surfaceId: 'AI-SCOPER-PROPOSAL',
};

// Mock all external dependencies BEFORE imports
const mockCreate = vi.fn().mockResolvedValue({
  choices: [{ message: { content: 'AI response text' } }],
});

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockCreate } };
    },
  };
});

const mockGroqCreate = vi.fn().mockResolvedValue({
  choices: [{ message: { content: 'Groq response text' } }],
});

vi.mock('groq-sdk', () => {
  return {
    default: class MockGroq {
      chat = { completions: { create: mockGroqCreate } };
    },
  };
});

vi.mock('../../src/config', () => ({
  config: {
    ai: {
      openai: { apiKey: 'test-openai-key', model: 'gpt-4o' },
      groq: { apiKey: 'test-groq-key', model: 'llama-3.3-70b' },
      deepseek: { apiKey: '', model: 'deepseek-r1' },
      anthropic: { apiKey: '', model: 'claude-sonnet' },
      alibaba: { apiKey: '', model: 'qwen-max' },
    },
  },
}));

vi.mock('../../src/cache/redis', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  },
  CACHE_KEYS: {
    aiCache: (hash: string) => `ai:cache:${hash}`,
  },
  CACHE_TTL: {
    aiCache: 86400,
  },
}));

vi.mock('../../src/logger', () => ({
  aiLogger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

vi.mock('../../src/services/AIObservabilityService.js', () => ({
  AIObservabilityService: { record: mockRecordObservation },
}));

vi.mock('../../src/middleware/circuit-breaker', () => ({
  openaiBreaker: { execute: vi.fn((fn: () => Promise<unknown>) => fn()) },
  groqBreaker: { execute: vi.fn((fn: () => Promise<unknown>) => fn()) },
  deepseekBreaker: { execute: vi.fn((fn: () => Promise<unknown>) => fn()) },
  anthropicBreaker: { execute: vi.fn((fn: () => Promise<unknown>) => fn()) },
}));

import { AIClient } from '../../src/services/AIClient';
import { redis } from '../../src/cache/redis';

beforeEach(() => {
  vi.clearAllMocks();
  // Reset default mock responses
  mockCreate.mockResolvedValue({
    choices: [{ message: { content: 'AI response text' } }],
  });
  mockGroqCreate.mockResolvedValue({
    choices: [{ message: { content: 'Groq response text' } }],
  });
  mockRecordObservation.mockResolvedValue({ success: true, data: observationReceipt });
});

// ============================================================================
// isConfigured
// ============================================================================
describe('AIClient.isConfigured', () => {
  it('returns true when at least one provider is configured', () => {
    expect(AIClient.isConfigured()).toBe(true);
  });
});

// ============================================================================
// call
// ============================================================================
describe('AIClient.call', () => {
  it('returns AI response from primary route', async () => {
    const result = await AIClient.call({
      route: 'primary',
      prompt: 'Hello',
      enableCache: false,
    });

    expect(result.content).toBe('AI response text');
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o');
    expect(result.cached).toBe(false);
    expect(typeof result.latencyMs).toBe('number');
  });

  it('returns AI response from fast route', async () => {
    const result = await AIClient.call({
      route: 'fast',
      prompt: 'Quick question',
      enableCache: false,
    });

    expect(result.content).toBe('Groq response text');
    expect(result.provider).toBe('groq');
  });

  it('returns cached result when available', async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce('Cached response');

    const result = await AIClient.call({
      route: 'primary',
      prompt: 'Cached question',
      enableCache: true,
    });

    expect(result.content).toBe('Cached response');
    expect(result.cached).toBe(true);
    expect(result.provider).toBe('openai');
  });

  it('falls back when primary provider fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('OpenAI down'));

    const result = await AIClient.call({
      route: 'primary',
      prompt: 'Retry test',
      enableCache: false,
    });

    // Should fall back to fast (groq)
    expect(result.content).toBe('Groq response text');
    expect(result.provider).toBe('groq');
  });

  it('includes system prompt when provided', async () => {
    await AIClient.call({
      route: 'primary',
      prompt: 'User message',
      systemPrompt: 'System instructions',
      enableCache: false,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          { role: 'system', content: 'System instructions' },
          { role: 'user', content: 'User message' },
        ]),
      }),
    );
  });

  it('returns a persisted observation receipt for a governed provider call', async () => {
    const result = await AIClient.call({
      route: 'primary',
      prompt: 'Structure this task',
      enableCache: false,
      observability: {
        surfaceId: 'AI-SCOPER-PROPOSAL',
        authorityLevel: 'A2_PROPOSAL_ONLY',
        action: 'Propose editable scope',
        scopeAffected: 'task_draft_scope',
        reason: 'The Poster supplied free-form scope.',
        evidenceClasses: ['SANITIZED_TASK_DESCRIPTION'],
        expectedBenefit: 'Faster draft review.',
        uncertainty: 'Physical conditions remain unknown.',
        downside: 'The proposal may under-scope work.',
        policyVersion: 'hxos-scoper-proposal-v1',
        confidenceBand: 'UNKNOWN',
        controls: {
          apply: true, edit: true, dismiss: true, snooze: true, why: true,
          approve: false, override: true, autoExecute: false, reversible: true,
        },
        outcomeSource: 'task creation and outcomes',
        actorUserId: '22222222-2222-4222-8222-222222222222',
        affectedObjectType: 'TASK_DRAFT',
        affectedObjectId: 'draft-1',
      },
    });

    expect(result.observation).toEqual(observationReceipt);
    expect(mockRecordObservation).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      modelVersion: 'gpt-4o',
      executionResult: 'GENERATED',
      output: 'AI response text',
    }));
  });

  it('withholds provider output when the observability write fails', async () => {
    mockRecordObservation.mockResolvedValueOnce({
      success: false,
      error: { code: 'AI_OBSERVABILITY_REQUIRED', message: 'audit unavailable' },
    });

    await expect(AIClient.call({
      route: 'primary',
      prompt: 'Governed task',
      enableCache: false,
      observability: {
        surfaceId: 'AI-INCIDENT-DIAGNOSIS',
        authorityLevel: 'INFORMATIONAL_ONLY',
        action: 'Suggest a diagnosis',
        scopeAffected: 'operations_incident_diagnosis',
        reason: 'An operator requested assistance.',
        evidenceClasses: ['INCIDENT_FACTS'],
        expectedBenefit: 'Faster diagnosis.',
        uncertainty: 'The diagnosis is a hypothesis.',
        downside: 'It may be wrong.',
        policyVersion: 'hxos-incident-diagnosis-v1',
        confidenceBand: 'UNKNOWN',
        controls: {
          apply: false, edit: false, dismiss: true, snooze: false, why: true,
          approve: false, override: true, autoExecute: false, reversible: true,
        },
        outcomeSource: 'incident recovery telemetry',
        actorUserId: null,
        affectedObjectType: 'INCIDENT',
        affectedObjectId: 'incident-1',
      },
    })).rejects.toThrow('AI_OBSERVABILITY_REQUIRED');
    expect(mockGroqCreate).not.toHaveBeenCalled();
  });
});

// ============================================================================
// callJSON
// ============================================================================
describe('AIClient.callJSON', () => {
  it('parses valid JSON response', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"key":"value","count":42}' } }],
    });

    const result = await AIClient.callJSON({
      route: 'primary',
      prompt: 'Give me JSON',
      enableCache: false,
    });

    expect(result.data).toEqual({ key: 'value', count: 42 });
    expect(result.provider).toBe('openai');
  });

  it('throws when response is not valid JSON', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'not json at all' } }],
    });

    await expect(
      AIClient.callJSON({
        route: 'primary',
        prompt: 'Bad JSON',
        enableCache: false,
      }),
    ).rejects.toThrow();
  });

  it('extracts JSON from markdown code block', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '```json\n{"extracted":true}\n```' } }],
    });

    const result = await AIClient.callJSON({
      route: 'primary',
      prompt: 'Markdown JSON',
      enableCache: false,
    });

    expect(result.data).toEqual({ extracted: true });
  });
});
