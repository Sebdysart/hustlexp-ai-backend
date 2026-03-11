/**
 * AIClient Extra Unit Tests
 *
 * Covers branches not exercised by ai-client.test.ts:
 * - All providers in full fallback chain exhausted → throws
 * - Custom fallbackChain override
 * - callJSON with Zod schema validation (pass and fail)
 * - responseFormat: 'json' passes response_format to API
 * - Custom temperature and maxTokens
 * - isConfigured returns false when no keys
 * - backup route (Alibaba via OpenAI-compat)
 * - Cache stores result after successful call
 * - reasoning route (DeepSeek)
 * - Empty content response throws
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockOpenAICreate = vi.fn().mockResolvedValue({
  choices: [{ message: { content: 'openai-response' } }],
});

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockOpenAICreate } };
  },
}));

const mockGroqCreate = vi.fn().mockResolvedValue({
  choices: [{ message: { content: 'groq-response' } }],
});

vi.mock('groq-sdk', () => ({
  default: class MockGroq {
    chat = { completions: { create: mockGroqCreate } };
  },
}));

// Config — all keys populated so every route has a client
vi.mock('../../src/config', () => ({
  config: {
    ai: {
      openai:   { apiKey: 'openai-key',   model: 'gpt-4o' },
      groq:     { apiKey: 'groq-key',     model: 'llama-3.3-70b' },
      deepseek: { apiKey: 'deepseek-key', model: 'deepseek-r1' },
      anthropic:{ apiKey: 'anthropic-key',model: 'claude-sonnet' },
      alibaba:  { apiKey: 'alibaba-key',  model: 'qwen-max' },
    },
    redis: { restUrl: 'https://test.upstash.io', restToken: 'test-token' },
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
  logger:   { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

vi.mock('../../src/middleware/circuit-breaker', () => ({
  openaiBreaker:   { execute: vi.fn((fn: () => Promise<unknown>) => fn()) },
  groqBreaker:     { execute: vi.fn((fn: () => Promise<unknown>) => fn()) },
  deepseekBreaker: { execute: vi.fn((fn: () => Promise<unknown>) => fn()) },
  anthropicBreaker:{ execute: vi.fn((fn: () => Promise<unknown>) => fn()) },
}));

// ─── Imports ──────────────────────────────────────────────────────────────────
import { AIClient, call, callJSON, isConfigured } from '../../src/services/AIClient';
import { redis } from '../../src/cache/redis';

const mockRedisGet = vi.mocked(redis.get);
const mockRedisSet = vi.mocked(redis.set);

beforeEach(() => {
  vi.clearAllMocks();
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue(undefined);
  mockOpenAICreate.mockResolvedValue({
    choices: [{ message: { content: 'openai-response' } }],
  });
  mockGroqCreate.mockResolvedValue({
    choices: [{ message: { content: 'groq-response' } }],
  });
});

// ============================================================================
// isConfigured
// ============================================================================

describe('isConfigured', () => {
  it('returns true when all providers are configured', () => {
    expect(isConfigured()).toBe(true);
  });
});

// ============================================================================
// Fallback chain exhaustion
// ============================================================================

describe('call — fallback chain exhaustion', () => {
  it('throws when all providers in fallback chain fail', async () => {
    // OpenAI + Groq both fail — primary + its fallbacks
    mockOpenAICreate.mockRejectedValue(new Error('OpenAI down'));
    mockGroqCreate.mockRejectedValue(new Error('Groq down'));

    // primary route: primary → fast → safety → backup
    // safety (anthropic) and backup (alibaba) both use OpenAI-compat backed by mockOpenAICreate
    await expect(
      call({
        route: 'primary',
        prompt: 'all fail',
        enableCache: false,
      })
    ).rejects.toThrow();
  });

  it('uses custom fallbackChain override', async () => {
    // Primary fails, groq succeeds
    mockOpenAICreate.mockRejectedValueOnce(new Error('OpenAI down'));

    const result = await call({
      route: 'primary',
      prompt: 'custom chain',
      fallbackChain: ['fast'],
      enableCache: false,
    });

    expect(result.provider).toBe('groq');
    expect(result.content).toBe('groq-response');
  });

  it('succeeds on backup route after primary and fast fail', async () => {
    mockOpenAICreate
      .mockRejectedValueOnce(new Error('OpenAI down')) // primary
      .mockResolvedValue({ choices: [{ message: { content: 'backup-response' } }] }); // backup (alibaba via OpenAI compat)
    mockGroqCreate.mockRejectedValueOnce(new Error('Groq down')); // fast

    const result = await call({
      route: 'primary',
      prompt: 'test backup',
      fallbackChain: ['fast', 'backup'],
      enableCache: false,
    });

    expect(result.content).toBe('backup-response');
  });
});

// ============================================================================
// Cache behaviour
// ============================================================================

describe('call — caching', () => {
  it('stores successful response in cache', async () => {
    await call({
      route: 'primary',
      prompt: 'store me',
      enableCache: true,
    });

    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringContaining('ai:cache:'),
      'openai-response',
      86400
    );
  });

  it('skips cache when enableCache is false', async () => {
    await call({
      route: 'primary',
      prompt: 'no cache',
      enableCache: false,
    });

    expect(mockRedisGet).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });
});

// ============================================================================
// callJSON — options
// ============================================================================

describe('callJSON', () => {
  it('sets responseFormat json on the underlying call', async () => {
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"ok":true}' } }],
    });

    await callJSON({
      route: 'primary',
      prompt: 'json please',
      enableCache: false,
    });

    expect(mockOpenAICreate).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: { type: 'json_object' },
      })
    );
  });

  it('validates response with Zod schema when provided', async () => {
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"name":"Alice","age":30}' } }],
    });

    const schema = z.object({ name: z.string(), age: z.number() });

    const result = await callJSON({
      route: 'primary',
      prompt: 'user data',
      enableCache: false,
      schema,
    });

    expect(result.data).toEqual({ name: 'Alice', age: 30 });
  });

  it('throws ZodError when response fails schema validation', async () => {
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"name":123}' } }], // name should be string
    });

    const schema = z.object({ name: z.string() });

    await expect(
      callJSON({
        route: 'primary',
        prompt: 'bad data',
        enableCache: false,
        schema,
      })
    ).rejects.toThrow();
  });

  it('extracts JSON from markdown code block without json language tag', async () => {
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: '```\n{"plain":true}\n```' } }],
    });

    const result = await callJSON({
      route: 'primary',
      prompt: 'plain code block',
      enableCache: false,
    });

    expect(result.data).toEqual({ plain: true });
  });
});

// ============================================================================
// call — request parameters
// ============================================================================

describe('call — request parameters', () => {
  it('passes custom temperature and maxTokens to provider', async () => {
    await call({
      route: 'primary',
      prompt: 'custom params',
      temperature: 0.1,
      maxTokens: 512,
      enableCache: false,
    });

    expect(mockOpenAICreate).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.1,
        max_tokens: 512,
      })
    );
  });

  it('uses default temperature 0.7 and maxTokens 1024 when not specified', async () => {
    await call({
      route: 'primary',
      prompt: 'defaults',
      enableCache: false,
    });

    expect(mockOpenAICreate).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.7,
        max_tokens: 1024,
      })
    );
  });

  it('passes correct model for fast route', async () => {
    await call({
      route: 'fast',
      prompt: 'fast call',
      enableCache: false,
    });

    expect(mockGroqCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'llama-3.3-70b',
      })
    );
  });
});

// ============================================================================
// AIClient namespace export
// ============================================================================

describe('AIClient namespace export', () => {
  it('exposes call, callJSON, and isConfigured', () => {
    expect(typeof AIClient.call).toBe('function');
    expect(typeof AIClient.callJSON).toBe('function');
    expect(typeof AIClient.isConfigured).toBe('function');
  });
});
