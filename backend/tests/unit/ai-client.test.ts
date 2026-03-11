/**
 * AIClient Unit Tests
 *
 * Tests call, callJSON, and isConfigured with mocked providers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
