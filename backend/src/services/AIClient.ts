/**
 * AIClient v1.1.0
 *
 * Shared AI client with multi-model routing, timeout, fallback, and caching.
 *
 * Routes:
 *   primary   → OpenAI gpt-4o          (default for most tasks)
 *   fast      → Groq llama-3.3-70b     (low latency)
 *   reasoning → DeepSeek deepseek-r1   (complex reasoning, via OpenAI-compat API)
 *   safety    → Anthropic Claude Sonnet (high-stakes: disputes, trust, verification)
 *   backup    → Alibaba qwen-max       (fallback, via OpenAI-compat API)
 *
 * @see config.ts §ai
 */

import OpenAI from 'openai';
import Groq from 'groq-sdk';
import type { ZodSchema } from 'zod';
import { config } from '../config.js';
import { db } from '../db.js';
import { redis, CACHE_KEYS, CACHE_TTL } from '../cache/redis.js';
import crypto from 'crypto';
import { aiLogger } from '../logger.js';

const log = aiLogger.child({ service: 'AIClient' });
import {
  openaiBreaker,
  groqBreaker,
  deepseekBreaker,
  anthropicBreaker,
  alibabaBreaker,
  CircuitOpenError,
} from '../middleware/circuit-breaker.js';
import {
  assertExternalAIProviderIOAuthorized,
  isExternalAIProviderConfigured,
} from '../ai/ExternalAIProviderAuthority.js';
import {
  failAIOperation,
  type AIReservationRequest,
} from '../ai/UserAIBudget.js';
import {
  markAIProviderAttemptUnknown,
  releaseAIProviderAttempt,
  reserveAIProviderAttempt,
  settleAIProviderAttempt,
  type AIProviderAttempt,
} from '../ai/AISpendAttemptLedger.js';
import { validateAIOutput } from '../middleware/ai-guard.js';
import type { AIObservationContext } from './AIObservabilityPolicy.js';
import {
  AIObservabilityService,
  type AIObservationReceipt,
} from './AIObservabilityService.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export type AIRoute = 'primary' | 'fast' | 'reasoning' | 'safety' | 'backup';

export interface AICallOptions {
  /** Stable domain-operation identity; never reuse for an independent call. */
  operationId: string;
  route: AIRoute;
  systemPrompt?: string;
  prompt: string;
  temperature?: number;       // default: 0.7
  maxTokens?: number;         // default: 1024
  responseFormat?: 'json' | 'text';
  timeoutMs?: number;         // default: 30000
  enableCache?: boolean;      // default: true
  fallbackChain?: AIRoute[];  // default: auto-generated from route
  userId?: string;            // optional: namespaces cache key per user to prevent cache poisoning
  /** Required on every production provider call; tests may omit it when exercising transport only. */
  observability?: AIObservationContext;
}

export interface AICallResult {
  content: string;
  provider: string;
  model: string;
  cached: boolean;
  latencyMs: number;
  observation: AIObservationReceipt | null;
}

// ─── Provider Clients (lazy singletons) ────────────────────────────────────

let openaiClient: OpenAI | null = null;
let groqClient: Groq | null = null;
let deepseekClient: OpenAI | null = null;  // OpenAI-compatible API
let anthropicClient: OpenAI | null = null; // OpenAI-compatible API (Anthropic Messages → OpenAI compat)
let alibabaClient: OpenAI | null = null;   // OpenAI-compatible API

function getOpenAIClient(): OpenAI | null {
  assertExternalAIProviderIOAuthorized('AIClient:openai:construct');
  if (openaiClient) return openaiClient;
  if (!config.ai.openai.apiKey) return null;
  openaiClient = new OpenAI({ apiKey: config.ai.openai.apiKey, maxRetries: 0 });
  return openaiClient;
}

function getGroqClient(): Groq | null {
  assertExternalAIProviderIOAuthorized('AIClient:groq:construct');
  if (groqClient) return groqClient;
  if (!config.ai.groq.apiKey) return null;
  groqClient = new Groq({ apiKey: config.ai.groq.apiKey, maxRetries: 0 });
  return groqClient;
}

function getDeepSeekClient(): OpenAI | null {
  assertExternalAIProviderIOAuthorized('AIClient:deepseek:construct');
  if (deepseekClient) return deepseekClient;
  if (!config.ai.deepseek.apiKey) return null;
  deepseekClient = new OpenAI({
    apiKey: config.ai.deepseek.apiKey,
    baseURL: 'https://api.deepseek.com/v1',
    maxRetries: 0,
  });
  return deepseekClient;
}

function getAnthropicClient(): OpenAI | null {
  assertExternalAIProviderIOAuthorized('AIClient:anthropic:construct');
  if (anthropicClient) return anthropicClient;
  if (!config.ai.anthropic.apiKey) return null;
  anthropicClient = new OpenAI({
    apiKey: config.ai.anthropic.apiKey,
    baseURL: 'https://api.anthropic.com/v1/',
    defaultHeaders: { 'anthropic-version': '2023-06-01' },
    maxRetries: 0,
  });
  return anthropicClient;
}

function getAlibabaClient(): OpenAI | null {
  assertExternalAIProviderIOAuthorized('AIClient:alibaba:construct');
  if (alibabaClient) return alibabaClient;
  if (!config.ai.alibaba.apiKey) return null;
  alibabaClient = new OpenAI({
    apiKey: config.ai.alibaba.apiKey,
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    maxRetries: 0,
  });
  return alibabaClient;
}

// ─── Route → Provider/Model Mapping ────────────────────────────────────────

interface ProviderConfig {
  getClient: () => OpenAI | Groq | null;
  model: string;
  name: string;
}

type MeteredProvider = 'openai' | 'groq' | 'deepseek' | 'anthropic' | 'alibaba';

const PROVIDER_COSTS: Record<MeteredProvider, { input: number; output: number }> = {
  openai: { input: 2.5, output: 10 },
  groq: { input: 0.5, output: 0.8 },
  deepseek: { input: 1.4, output: 5.6 },
  anthropic: { input: 3, output: 15 },
  alibaba: { input: 1, output: 4 },
};

// Product-tuning default: one governed surface may reserve at most $1/day per
// user/system identity, while the cross-agent user ceiling remains $5/day.
const AI_CLIENT_AGENT_DAILY_CEILING_CENTS = 100;

const ROUTE_CONFIG: Record<AIRoute, ProviderConfig> = {
  primary: {
    getClient: getOpenAIClient,
    model: config.ai.openai.model,
    name: 'openai',
  },
  fast: {
    getClient: getGroqClient,
    model: config.ai.groq.model,
    name: 'groq',
  },
  reasoning: {
    getClient: getDeepSeekClient,
    model: config.ai.deepseek.model,
    name: 'deepseek',
  },
  safety: {
    getClient: getAnthropicClient,
    model: config.ai.anthropic.model,
    name: 'anthropic',
  },
  backup: {
    getClient: getAlibabaClient,
    model: config.ai.alibaba.model,
    name: 'alibaba',
  },
};

// Default fallback chains per route
const FALLBACK_CHAINS: Record<AIRoute, AIRoute[]> = {
  primary: ['fast', 'safety', 'backup'],
  fast: ['primary', 'backup'],
  reasoning: ['primary', 'safety', 'fast'],
  safety: ['reasoning', 'primary', 'fast'],
  backup: ['primary', 'fast'],
};

// ─── Cache Helpers ─────────────────────────────────────────────────────────

interface BoundAICacheEntry {
  version: 1;
  operationId: string;
  fingerprint: string;
  userId: string;
  provider: string;
  model: string;
  content: string;
}

function cacheBinding(identity: ReturnType<typeof spendIdentity>, provider: string, model: string): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: 1,
    operationId: identity.operationId,
    fingerprint: identity.fingerprint,
    userId: identity.userId,
    provider,
    model,
  })).digest('hex');
}

function parseBoundCacheEntry(
  raw: string,
  identity: ReturnType<typeof spendIdentity>,
  provider: string,
  model: string,
): BoundAICacheEntry | null {
  try {
    const value = JSON.parse(raw) as Partial<BoundAICacheEntry>;
    if (
      value.version !== 1
      || value.operationId !== identity.operationId
      || value.fingerprint !== identity.fingerprint
      || value.userId !== identity.userId
      || value.provider !== provider
      || value.model !== model
      || typeof value.content !== 'string'
    ) return null;
    return value as BoundAICacheEntry;
  } catch {
    return null;
  }
}

// ─── Circuit Breaker Mapping ─────────────────────────────────────────────

import type { CircuitBreaker } from '../middleware/circuit-breaker.js';

const PROVIDER_BREAKERS: Record<string, CircuitBreaker> = {
  openai: openaiBreaker,
  groq: groqBreaker,
  deepseek: deepseekBreaker,
  anthropic: anthropicBreaker,
  alibaba: alibabaBreaker,
};

// ─── Core Call Function ────────────────────────────────────────────────────

async function callProvider(
  providerConfig: ProviderConfig,
  client: OpenAI | Groq,
  options: AICallOptions,
): Promise<{ content: string; promptTokens: number; completionTokens: number; totalTokens: number; usageReliable: boolean }> {
  assertExternalAIProviderIOAuthorized(`AIClient:${providerConfig.name}:io`);
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (options.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }
  messages.push({ role: 'user', content: options.prompt });

  const timeout = options.timeoutMs || 30000;
  const breaker = PROVIDER_BREAKERS[providerConfig.name];

  // Wrap the API call with circuit breaker protection
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeout);
  const apiCall = () => (client as unknown as {
    chat: { completions: { create: (opts: Record<string, unknown>, request?: { signal?: AbortSignal }) => Promise<unknown> } };
  }).chat.completions.create({
      model: providerConfig.model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 1024,
      ...(options.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
    }, { signal: controller.signal });

  let rawResponse: unknown;
  try {
    rawResponse = breaker ? await breaker.execute(apiCall) : await apiCall();
  } finally {
    clearTimeout(timeoutHandle);
  }
  const response = rawResponse as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`${providerConfig.name} returned empty response`);
  }

  const promptTokens = response.usage?.prompt_tokens;
  const completionTokens = response.usage?.completion_tokens;
  const totalTokens = response.usage?.total_tokens;
  const usageReliable = [promptTokens, completionTokens, totalTokens].every(
    (value) => Number.isSafeInteger(value) && (value as number) >= 0,
  ) && totalTokens === (promptTokens as number) + (completionTokens as number);

  return {
    content,
    promptTokens: usageReliable ? promptTokens as number : 0,
    completionTokens: usageReliable ? completionTokens as number : 0,
    totalTokens: usageReliable ? totalTokens as number : 0,
    usageReliable,
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

async function recordObservation(
  options: AICallOptions,
  result: {
    provider: string;
    model: string;
    executionResult: 'GENERATED' | 'CACHED' | 'FAILED';
    output: string | null;
    latencyMs: number;
  },
): Promise<AIObservationReceipt | null> {
  if (!options.observability) return null;
  const recorded = await AIObservabilityService.record({
    context: options.observability,
    provider: result.provider,
    modelVersion: result.model,
    executionResult: result.executionResult,
    output: result.output,
    latencyMs: result.latencyMs,
  });
  if (!recorded.success) {
    throw new Error(`AI_OBSERVABILITY_REQUIRED:${recorded.error.code}`);
  }
  return recorded.data;
}

type MeteredProviderResult = {
  content: string;
  provider: MeteredProvider;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costCents: number;
};

function spendIdentity(options: AICallOptions): {
  operationId: string;
  fingerprint: string;
  agent: string;
  userId: string;
  auditUserId: string | null;
} {
  const actorUserId = options.observability?.actorUserId ?? options.userId ?? null;
  const userId = actorUserId ?? `system:ai-client:${options.observability?.surfaceId ?? options.route}`;
  const material = {
    operationId: options.operationId,
    route: options.route,
    systemPrompt: options.systemPrompt ?? '',
    prompt: options.prompt,
    observability: options.observability ?? null,
    userId,
  };
  if (!options.operationId || options.operationId.trim() !== options.operationId || options.operationId.length > 256) {
    throw new Error('AI_SPEND_OPERATION_ID_REQUIRED');
  }
  const operationId = `ai-client:${crypto.createHash('sha256').update(JSON.stringify({
    operationId: options.operationId,
    userId,
    surfaceId: options.observability?.surfaceId ?? options.route,
  })).digest('hex')}`;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    envelopeVersion: 1,
    ...material,
    temperature: options.temperature ?? 0.7,
    maxTokens: options.maxTokens ?? 1024,
    responseFormat: options.responseFormat ?? 'text',
    timeoutMs: options.timeoutMs ?? 30_000,
    fallbackChain: options.fallbackChain ?? FALLBACK_CHAINS[options.route],
    routeProvidersAndModels: Object.fromEntries(
      [options.route, ...(options.fallbackChain ?? FALLBACK_CHAINS[options.route])]
        .map((route) => [route, {
          provider: ROUTE_CONFIG[route].name,
          model: ROUTE_CONFIG[route].model,
        }]),
    ),
  })).digest('hex');
  return {
    operationId,
    fingerprint,
    agent: options.observability?.surfaceId ?? `AI-CLIENT-${options.route.toUpperCase()}`,
    userId,
    auditUserId: actorUserId,
  };
}

function worstCaseCost(provider: MeteredProvider, options: AICallOptions): number {
  const rates = PROVIDER_COSTS[provider];
  const inputBytes = Buffer.byteLength(options.systemPrompt ?? '', 'utf8')
    + Buffer.byteLength(options.prompt, 'utf8')
    + 512;
  return Math.max(1, Math.ceil(
    (inputBytes / 1000) * rates.input
      + ((options.maxTokens ?? 1024) / 1000) * rates.output,
  ));
}

function actualCost(provider: MeteredProvider, result: Awaited<ReturnType<typeof callProvider>>, reserved: number): number {
  if (!result.usageReliable) return reserved;
  const rates = PROVIDER_COSTS[provider];
  return Math.ceil(
    (result.promptTokens / 1000) * rates.input
      + (result.completionTokens / 1000) * rates.output,
  );
}

function parseMeteredReplay(resultJson: string): MeteredProviderResult {
  const parsed = JSON.parse(resultJson) as Partial<MeteredProviderResult>;
  if (
    typeof parsed.content !== 'string'
    || !['openai', 'groq', 'deepseek', 'anthropic', 'alibaba'].includes(parsed.provider ?? '')
    || typeof parsed.model !== 'string'
    || !Number.isSafeInteger(parsed.promptTokens)
    || !Number.isSafeInteger(parsed.completionTokens)
    || !Number.isSafeInteger(parsed.totalTokens)
    || !Number.isSafeInteger(parsed.costCents)
  ) throw new Error('AI_SPEND_CACHED_RESULT_INVALID');
  return parsed as MeteredProviderResult;
}

async function auditProviderCost(
  identity: ReturnType<typeof spendIdentity>,
  result: MeteredProviderResult,
): Promise<void> {
  await db.query(
    `INSERT INTO ai_cost_logs (
       agent_type, user_id, provider, model, tokens_used, prompt_tokens,
       completion_tokens, estimated_cost_cents, request_hash, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
    [
      identity.agent,
      identity.auditUserId,
      result.provider,
      result.model,
      result.totalTokens,
      result.promptTokens,
      result.completionTokens,
      result.costCents,
      identity.fingerprint,
    ],
  );
}

async function auditUnknownProviderCost(
  identity: ReturnType<typeof spendIdentity>,
  provider: MeteredProvider,
  model: string,
  reservation: AIReservationRequest,
): Promise<void> {
  await db.query(
    `INSERT INTO ai_cost_logs (
       agent_type, user_id, provider, model, tokens_used,
       estimated_cost_cents, request_hash, error_code, created_at
     ) VALUES ($1, $2, $3, $4, 0, $5, $6, $7, NOW())`,
    [identity.agent, identity.auditUserId, provider, model, reservation.reserveCents, identity.fingerprint, 'HX_AI_UNKNOWN'],
  );
}

/**
 * Call an AI model with automatic routing, caching, and fallback.
 *
 * @example
 * const result = await AIClient.call({
 *   route: 'primary',
 *   systemPrompt: 'You are a task pricing expert.',
 *   prompt: 'Analyze this task: "Move furniture from apartment to storage"',
 *   responseFormat: 'json',
 *   temperature: 0,
 * });
 */
export async function call(options: AICallOptions): Promise<AICallResult> {
  const startTime = Date.now();
  const routeConfig = ROUTE_CONFIG[options.route];
  const enableCache = options.enableCache !== false;
  // Validate and bind spend authority before cache access: cached calls still
  // need an attributable operation identity for observation and replay safety.
  const identity = spendIdentity(options);
  assertExternalAIProviderIOAuthorized(`AIClient:${options.route}`);

  // 1. Check cache
  if (enableCache) {
    const cacheHash = cacheBinding(identity, routeConfig.name, routeConfig.model);
    const cacheKey = CACHE_KEYS.aiCache(cacheHash);
    const cached = await redis.get<string>(cacheKey);
    const boundCache = cached
      ? parseBoundCacheEntry(cached, identity, routeConfig.name, routeConfig.model)
      : null;
    if (boundCache) {
      const latencyMs = Date.now() - startTime;
      const observation = await recordObservation(options, {
        provider: routeConfig.name,
        model: routeConfig.model,
        executionResult: 'CACHED',
        output: boundCache.content,
        latencyMs,
      });
      return {
        content: boundCache.content,
        provider: routeConfig.name,
        model: routeConfig.model,
        cached: true,
        latencyMs,
        observation,
      };
    }
  }

  // 2. Try primary route, then fallback chain
  const chain = [options.route, ...(options.fallbackChain || FALLBACK_CHAINS[options.route])];
  let lastError: Error | null = null;
  const ownerToken = crypto.randomUUID();
  let lastReservation: AIReservationRequest | null = null;

  for (let routeIndex = 0; routeIndex < chain.length; routeIndex++) {
    const route = chain[routeIndex];
    const cfg = ROUTE_CONFIG[route];
    const provider = cfg.name as MeteredProvider;
    const client = cfg.getClient();
    if (!client) {
      lastError = new Error(`${cfg.name} client not configured (missing API key)`);
      continue;
    }

    // The window is intentionally recalculated immediately before every
    // possible provider I/O so a fallback crossing midnight charges the new
    // UTC day rather than the first attempt's stale day.
    const reservation: AIReservationRequest = {
      agent: identity.agent,
      userId: identity.userId,
      operationId: identity.operationId,
      fingerprint: identity.fingerprint,
      ownerToken,
      attemptId: `${routeIndex}:${route}:${provider}`,
      reserveCents: worstCaseCost(provider, options),
      agentLimitCents: AI_CLIENT_AGENT_DAILY_CEILING_CENTS,
    };
    const providerAttempt: AIProviderAttempt = {
      reservation,
      providerKind: provider,
      providerModel: cfg.model,
    };
    lastReservation = reservation;

    let authority;
    try {
      authority = await reserveAIProviderAttempt(providerAttempt);
    } catch (error) {
      throw new Error(`AI_SPEND_AUTHORITY_REQUIRED:${error instanceof Error ? error.message : String(error)}`);
    }

    let metered: MeteredProviderResult;
    let replayed = false;
    if (authority.status === 'completed') {
      metered = parseMeteredReplay(authority.resultJson);
      replayed = true;
    } else {
      if (authority.status === 'failed') throw new Error(`AI_SPEND_OPERATION_FAILED:${authority.message}`);
      if (authority.status === 'in_progress') throw new Error('AI_SPEND_OPERATION_IN_PROGRESS');
      if (authority.status === 'conflict') throw new Error('AI_SPEND_OPERATION_CONFLICT');
      if (authority.status === 'limit') throw new Error(`AI_SPEND_LIMIT:${authority.scope}`);

      let providerResult: Awaited<ReturnType<typeof callProvider>>;
      try {
        providerResult = await callProvider(cfg, client, options);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        try {
          if (error instanceof CircuitOpenError) {
            await releaseAIProviderAttempt(providerAttempt);
          } else {
            await markAIProviderAttemptUnknown(providerAttempt);
            await auditUnknownProviderCost(identity, provider, cfg.model, reservation);
          }
        } catch (meteringError) {
          throw new Error(`AI_SPEND_AUTHORITY_REQUIRED:${meteringError instanceof Error ? meteringError.message : String(meteringError)}`);
        }
        log.warn({ err: lastError.message, provider: cfg.name, model: cfg.model, route }, 'Provider failed, trying next in fallback chain');
        continue;
      }

      let content = providerResult.content;

      // 3. Validate and sanitize AI output before caching or returning
      const validation = validateAIOutput(content);
      if (!validation.valid) {
        log.warn({ violations: validation.violations }, 'AIClient: AI output failed validation');
        content = validation.sanitized ?? content;
      }

      const costCents = actualCost(provider, providerResult, reservation.reserveCents);
      if (costCents > reservation.reserveCents) {
        await markAIProviderAttemptUnknown(providerAttempt, 'USAGE_EXCEEDED_RESERVATION');
        throw new Error('AI_SPEND_USAGE_EXCEEDED_RESERVATION');
      }
      metered = {
        content,
        provider,
        model: cfg.model,
        promptTokens: providerResult.promptTokens,
        completionTokens: providerResult.completionTokens,
        totalTokens: providerResult.totalTokens,
        costCents,
      };

      // Provider success is terminal: audit and Redis settlement errors are
      // surfaced and can never fall through to another paid provider.
      await auditProviderCost(identity, metered);
      await settleAIProviderAttempt({
        ...providerAttempt,
        actualCostCents: costCents,
        resultJson: JSON.stringify(metered),
      });
    }

    // 4. Cache successful response, including idempotent spend replays.
    if (enableCache) {
      const cacheHash = cacheBinding(identity, metered.provider, metered.model);
      const cacheKey = CACHE_KEYS.aiCache(cacheHash);
      const cacheEntry: BoundAICacheEntry = {
        version: 1,
        operationId: identity.operationId,
        fingerprint: identity.fingerprint,
        userId: identity.userId,
        provider: metered.provider,
        model: metered.model,
        content: metered.content,
      };
      await redis.set(cacheKey, JSON.stringify(cacheEntry), CACHE_TTL.aiCache);
    }

    const latencyMs = Date.now() - startTime;
    const observation = await recordObservation(options, {
      provider: metered.provider,
      model: metered.model,
      executionResult: replayed ? 'CACHED' : 'GENERATED',
      output: metered.content,
      latencyMs,
    });

    return {
      content: metered.content,
      provider: metered.provider,
      model: metered.model,
      cached: replayed,
      latencyMs,
      observation,
    };
  }

  if (lastReservation) {
    await failAIOperation(lastReservation, `All AI providers exhausted for ${options.route}`);
  }

  if (options.observability) {
    try {
      await recordObservation(options, {
        provider: routeConfig.name,
        model: routeConfig.model,
        executionResult: 'FAILED',
        output: null,
        latencyMs: Date.now() - startTime,
      });
    } catch (auditError) {
      log.error({ err: auditError instanceof Error ? auditError.message : String(auditError) }, 'Failed AI call could not be audited');
    }
  }

  throw lastError || new Error('All AI providers failed');
}

/**
 * Call AI and parse JSON response. Throws if response is not valid JSON.
 *
 * If `schema` is provided, validates the parsed response with Zod at runtime.
 * If not, uses legacy `as T` assertion (backward compatible).
 */
export async function callJSON<T = unknown>(
  options: AICallOptions & { schema?: ZodSchema<T> }
): Promise<{ data: T } & AICallResult> {
  const { schema, ...callOptions } = options;
  const result = await call({
    ...callOptions,
    responseFormat: 'json',
  });

  // Validate and sanitize the raw string before JSON parsing
  const jsonValidation = validateAIOutput(result.content);
  if (!jsonValidation.valid) {
    log.warn({ violations: jsonValidation.violations }, 'AIClient: callJSON raw output failed validation');
    result.content = jsonValidation.sanitized ?? result.content;
  }

  let parsed: unknown;
  try {
    // Try direct JSON parse first
    parsed = JSON.parse(result.content);
  } catch {
    // Try extracting JSON from markdown code block
    const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[1].trim());
    } else {
      throw new Error(`Failed to parse AI response as JSON: ${result.content.slice(0, 200)}`);
    }
  }

  // If schema provided, validate with Zod (runtime safety)
  if (schema) {
    const validated = schema.parse(parsed);
    return { ...result, data: validated };
  }

  // Legacy path: no runtime validation (backward compatible)
  return { ...result, data: parsed as T };
}

/**
 * Check if any AI provider is configured
 */
export function isConfigured(): boolean {
  return isExternalAIProviderConfigured();
}

// ─── Exported Module ───────────────────────────────────────────────────────

export const AIClient = {
  call,
  callJSON,
  isConfigured,
};

export default AIClient;
