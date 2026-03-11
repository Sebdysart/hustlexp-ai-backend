/**
 * src/ai/router.ts Unit Tests
 *
 * Tests routedGenerate — the single entry point that routes AI generation
 * requests across providers (deepseek, openai, groq, anthropic) using the
 * task-type preference order, with circuit-breaker recording on success/failure.
 *
 * All external dependencies (AI SDKs, telemetry, reliability utils) are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted — creates shared mock fns that can be referenced inside vi.mock()
// factories (which are hoisted to the top of the file by the Vitest transform).
// ---------------------------------------------------------------------------

const {
  mockRecordFailure,
  mockRecordSuccess,
  mockOpenAICreate,
  mockGroqCreate,
} = vi.hoisted(() => ({
  mockRecordFailure: vi.fn(),
  mockRecordSuccess: vi.fn(),
  mockOpenAICreate:  vi.fn(),
  mockGroqCreate:    vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../utils/reliability.js', () => ({
  recordFailure: mockRecordFailure,
  recordSuccess: mockRecordSuccess,
  AI_PROVIDERS:  ['openai', 'groq', 'deepseek', 'anthropic'] as const,
}));

vi.mock('../telemetry/index.js', () => ({
  tracer: {
    startActiveSpan: vi.fn((name: string, fn: (span: any) => Promise<any>) => {
      const span = {
        setAttribute:    vi.fn(),
        setStatus:       vi.fn(),
        recordException: vi.fn(),
        end:             vi.fn(),
      };
      return fn(span);
    }),
  },
}));

vi.mock('../utils/logger.js', () => ({
  aiLogger: {
    debug: vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    info:  vi.fn(),
    child: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
  },
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockOpenAICreate } };
    constructor(_opts: unknown) {}
  },
}));

vi.mock('groq-sdk', () => ({
  default: class MockGroq {
    chat = { completions: { create: mockGroqCreate } };
    constructor(_opts: unknown) {}
  },
}));

// ---------------------------------------------------------------------------
// Set env vars so providers are "configured" (non-empty API keys)
// ---------------------------------------------------------------------------

vi.stubEnv('OPENAI_API_KEY',    'test-openai-key');
vi.stubEnv('GROQ_API_KEY',      'test-groq-key');
vi.stubEnv('DEEPSEEK_API_KEY',  'test-deepseek-key');
vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
vi.stubEnv('OPENAI_MODEL',      'gpt-4o-mini');
vi.stubEnv('GROQ_MODEL',        'llama-3.3-70b-versatile');
vi.stubEnv('DEEPSEEK_MODEL',    'deepseek-chat');
vi.stubEnv('ANTHROPIC_MODEL',   'claude-3-5-haiku-20241022');

// ---------------------------------------------------------------------------
// System-under-test (import AFTER mocks are set up)
// ---------------------------------------------------------------------------

import { routedGenerate, AI_PROVIDERS } from '../ai/router.js';

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

const successChatResponse = (content = 'Hello!') => ({
  choices: [{ message: { content } }],
});

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AI_PROVIDERS re-export
// ---------------------------------------------------------------------------

describe('AI_PROVIDERS', () => {
  it('exports the expected four provider names', () => {
    expect(AI_PROVIDERS).toContain('openai');
    expect(AI_PROVIDERS).toContain('groq');
    expect(AI_PROVIDERS).toContain('deepseek');
    expect(AI_PROVIDERS).toContain('anthropic');
    expect(AI_PROVIDERS).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// routedGenerate — task-type routing (provider order)
// ---------------------------------------------------------------------------

describe('routedGenerate — task-type provider ordering', () => {
  it('tries deepseek first for "planning" tasks', async () => {
    // deepseek uses the openai client with a different baseURL
    mockOpenAICreate.mockResolvedValueOnce(successChatResponse('plan result'));

    const result = await routedGenerate('planning', {
      messages: [{ role: 'user', content: 'Plan a task' }],
    });

    expect(result.content).toBe('plan result');
    expect(result.provider).toBe('deepseek');
  });

  it('tries groq first for "pricing" tasks', async () => {
    mockGroqCreate.mockResolvedValueOnce(successChatResponse('price result'));

    const result = await routedGenerate('pricing', {
      messages: [{ role: 'user', content: 'Price a task' }],
    });

    expect(result.content).toBe('price result');
    expect(result.provider).toBe('groq');
  });

  it('tries openai first for "dispute" tasks', async () => {
    mockOpenAICreate.mockResolvedValueOnce(successChatResponse('dispute result'));

    const result = await routedGenerate('dispute', {
      messages: [{ role: 'user', content: 'Resolve dispute' }],
    });

    expect(result.content).toBe('dispute result');
    expect(result.provider).toBe('openai');
  });

  it('tries anthropic first for "high_stakes_copy" tasks', async () => {
    // anthropic also uses the openai compat client
    mockOpenAICreate.mockResolvedValueOnce(successChatResponse('copy result'));

    const result = await routedGenerate('high_stakes_copy', {
      messages: [{ role: 'user', content: 'Write copy' }],
    });

    expect(result.content).toBe('copy result');
    expect(result.provider).toBe('anthropic');
  });

  it('uses default task order (groq first) for unknown task types', async () => {
    mockGroqCreate.mockResolvedValueOnce(successChatResponse('default result'));

    const result = await routedGenerate('totally_unknown_type', {
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result.content).toBe('default result');
    expect(result.provider).toBe('groq');
  });
});

// ---------------------------------------------------------------------------
// routedGenerate — happy path details
// ---------------------------------------------------------------------------

describe('routedGenerate — happy path', () => {
  it('returns content and provider name', async () => {
    mockGroqCreate.mockResolvedValueOnce(successChatResponse('Great answer'));

    const result = await routedGenerate('default', {
      messages: [{ role: 'user', content: 'Question' }],
    });

    expect(result.content).toBe('Great answer');
    expect(result.provider).toBe('groq');
  });

  it('records a success on the circuit breaker after a successful call', async () => {
    mockGroqCreate.mockResolvedValueOnce(successChatResponse('OK'));

    await routedGenerate('default', {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(mockRecordSuccess).toHaveBeenCalledWith('groq');
  });

  it('passes system prompt to the provider when provided', async () => {
    mockGroqCreate.mockResolvedValueOnce(successChatResponse('reply'));

    await routedGenerate('default', {
      system:   'You are an expert task matcher.',
      messages: [{ role: 'user', content: 'Match me' }],
    });

    expect(mockGroqCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          { role: 'system', content: 'You are an expert task matcher.' },
        ]),
      }),
    );
  });

  it('defaults maxTokens to 1024 when not provided', async () => {
    mockGroqCreate.mockResolvedValueOnce(successChatResponse('reply'));

    await routedGenerate('default', {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(mockGroqCreate).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 1024 }),
    );
  });

  it('defaults temperature to 0.7 when not provided', async () => {
    mockGroqCreate.mockResolvedValueOnce(successChatResponse('reply'));

    await routedGenerate('default', {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(mockGroqCreate).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.7 }),
    );
  });

  it('passes custom maxTokens and temperature when provided', async () => {
    mockGroqCreate.mockResolvedValueOnce(successChatResponse('reply'));

    await routedGenerate('default', {
      messages:    [{ role: 'user', content: 'test' }],
      maxTokens:   2048,
      temperature: 0.2,
    });

    expect(mockGroqCreate).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 2048, temperature: 0.2 }),
    );
  });
});

// ---------------------------------------------------------------------------
// routedGenerate — provider fallback on failure
// ---------------------------------------------------------------------------

describe('routedGenerate — provider fallback', () => {
  it('falls back to the next provider when the first one fails', async () => {
    // groq fails, openai succeeds (default order: groq, openai, deepseek, anthropic)
    mockGroqCreate.mockRejectedValueOnce(new Error('Groq down'));
    mockOpenAICreate.mockResolvedValueOnce(successChatResponse('OpenAI fallback'));

    const result = await routedGenerate('default', {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.content).toBe('OpenAI fallback');
    expect(result.provider).toBe('openai');
  });

  it('records a failure for the failed provider before trying the next', async () => {
    mockGroqCreate.mockRejectedValueOnce(new Error('Groq down'));
    mockOpenAICreate.mockResolvedValueOnce(successChatResponse('fallback'));

    await routedGenerate('default', {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(mockRecordFailure).toHaveBeenCalledWith('groq');
    expect(mockRecordSuccess).toHaveBeenCalledWith('openai');
  });

  it('throws an error when all providers in the chain fail', async () => {
    mockGroqCreate.mockRejectedValue(new Error('Groq down'));
    mockOpenAICreate.mockRejectedValue(new Error('All down'));

    await expect(
      routedGenerate('pricing', {
        messages: [{ role: 'user', content: 'test' }],
      }),
    ).rejects.toThrow(/all providers exhausted|down/i);
  });

  it('records a failure for every provider that fails before throwing', async () => {
    mockGroqCreate.mockRejectedValue(new Error('Groq down'));
    mockOpenAICreate.mockRejectedValue(new Error('Others down'));

    try {
      await routedGenerate('pricing', {
        messages: [{ role: 'user', content: 'test' }],
      });
    } catch {
      // expected
    }

    expect(mockRecordFailure).toHaveBeenCalledWith('groq');
    expect(mockRecordFailure).toHaveBeenCalledWith('openai');
  });
});

// ---------------------------------------------------------------------------
// routedGenerate — provider not configured
// ---------------------------------------------------------------------------

describe('routedGenerate — provider not configured', () => {
  it('skips a provider that throws "not configured" and tries the next', async () => {
    mockGroqCreate.mockRejectedValueOnce(new Error('groq: GROQ_API_KEY not configured'));
    mockOpenAICreate.mockResolvedValueOnce(successChatResponse('openai configured'));

    const result = await routedGenerate('default', {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.content).toBe('openai configured');
    expect(result.provider).toBe('openai');
  });
});

// ---------------------------------------------------------------------------
// routedGenerate — options forwarding
// ---------------------------------------------------------------------------

describe('routedGenerate — options forwarding', () => {
  it('passes json=true to the provider call', async () => {
    mockGroqCreate.mockResolvedValueOnce(successChatResponse('{"key":"value"}'));

    await routedGenerate('default', {
      messages: [{ role: 'user', content: 'Give me JSON' }],
      json:     true,
    });

    expect(mockGroqCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: { type: 'json_object' },
      }),
    );
  });

  it('does NOT set response_format when json=false', async () => {
    mockGroqCreate.mockResolvedValueOnce(successChatResponse('plain text'));

    await routedGenerate('default', {
      messages: [{ role: 'user', content: 'text' }],
      json:     false,
    });

    const callArg = mockGroqCreate.mock.calls[0][0];
    expect(callArg).not.toHaveProperty('response_format');
  });

  it('supports multi-turn conversation messages', async () => {
    mockGroqCreate.mockResolvedValueOnce(successChatResponse('Continuing...'));

    await routedGenerate('default', {
      messages: [
        { role: 'user',      content: 'First message' },
        { role: 'assistant', content: 'First reply' },
        { role: 'user',      content: 'Follow-up question' },
      ],
    });

    const callArg = mockGroqCreate.mock.calls[0][0];
    expect(callArg.messages).toHaveLength(3);
  });
});
