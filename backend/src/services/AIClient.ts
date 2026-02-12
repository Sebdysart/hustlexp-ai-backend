/**
 * AIClient v1.0.0
 *
 * Shared AI client with multi-model routing, timeout, fallback, and caching.
 *
 * Routes:
 *   primary  → OpenAI gpt-4o        (default for most tasks)
 *   fast     → Groq llama-3.3-70b   (low latency)
 *   reasoning → DeepSeek deepseek-r1 (complex reasoning, via OpenAI-compat API)
 *   backup   → Alibaba qwen-max     (fallback, via OpenAI-compat API)
 *
 * @see config.ts §ai
 */

import OpenAI from 'openai';
import Groq from 'groq-sdk';
import { config } from '../config';
import { redis, CACHE_KEYS, CACHE_TTL } from '../cache/redis';
import crypto from 'crypto';

// ─── Types ─────────────────────────────────────────────────────────────────

export type AIRoute = 'primary' | 'fast' | 'reasoning' | 'backup';

export interface AICallOptions {
  route: AIRoute;
  systemPrompt?: string;
  prompt: string;
  temperature?: number;       // default: 0.7
  maxTokens?: number;         // default: 1024
  responseFormat?: 'json' | 'text';
  timeoutMs?: number;         // default: 30000
  enableCache?: boolean;      // default: true
  fallbackChain?: AIRoute[];  // default: auto-generated from route
}

export interface AICallResult {
  content: string;
  provider: string;
  model: string;
  cached: boolean;
  latencyMs: number;
}

// ─── Provider Clients (lazy singletons) ────────────────────────────────────

let openaiClient: OpenAI | null = null;
let groqClient: Groq | null = null;
let deepseekClient: OpenAI | null = null;  // OpenAI-compatible API
let alibabaClient: OpenAI | null = null;   // OpenAI-compatible API

function getOpenAIClient(): OpenAI | null {
  if (openaiClient) return openaiClient;
  if (!config.ai.openai.apiKey) return null;
  openaiClient = new OpenAI({ apiKey: config.ai.openai.apiKey });
  return openaiClient;
}

function getGroqClient(): Groq | null {
  if (groqClient) return groqClient;
  if (!config.ai.groq.apiKey) return null;
  groqClient = new Groq({ apiKey: config.ai.groq.apiKey });
  return groqClient;
}

function getDeepSeekClient(): OpenAI | null {
  if (deepseekClient) return deepseekClient;
  if (!config.ai.deepseek.apiKey) return null;
  deepseekClient = new OpenAI({
    apiKey: config.ai.deepseek.apiKey,
    baseURL: 'https://api.deepseek.com/v1',
  });
  return deepseekClient;
}

function getAlibabaClient(): OpenAI | null {
  if (alibabaClient) return alibabaClient;
  if (!config.ai.alibaba.apiKey) return null;
  alibabaClient = new OpenAI({
    apiKey: config.ai.alibaba.apiKey,
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  });
  return alibabaClient;
}

// ─── Route → Provider/Model Mapping ────────────────────────────────────────

interface ProviderConfig {
  getClient: () => OpenAI | Groq | null;
  model: string;
  name: string;
}

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
  backup: {
    getClient: getAlibabaClient,
    model: config.ai.alibaba.model,
    name: 'alibaba',
  },
};

// Default fallback chains per route
const FALLBACK_CHAINS: Record<AIRoute, AIRoute[]> = {
  primary: ['fast', 'backup'],
  fast: ['primary', 'backup'],
  reasoning: ['primary', 'fast'],
  backup: ['primary', 'fast'],
};

// ─── Cache Helpers ─────────────────────────────────────────────────────────

function hashPrompt(systemPrompt: string | undefined, prompt: string, model: string): string {
  const input = `${systemPrompt || ''}|${prompt}|${model}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// ─── Core Call Function ────────────────────────────────────────────────────

async function callProvider(
  providerConfig: ProviderConfig,
  options: AICallOptions,
): Promise<string> {
  const client = providerConfig.getClient();
  if (!client) {
    throw new Error(`${providerConfig.name} client not configured (missing API key)`);
  }

  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (options.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }
  messages.push({ role: 'user', content: options.prompt });

  const timeout = options.timeoutMs || 30000;

  // Both OpenAI and Groq SDKs share a compatible API
  const chatClient = client as any;
  const response = await Promise.race([
    chatClient.chat.completions.create({
      model: providerConfig.model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 1024,
      ...(options.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${providerConfig.name} timeout after ${timeout}ms`)), timeout)
    ),
  ]);

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`${providerConfig.name} returned empty response`);
  }

  return content;
}

// ─── Public API ────────────────────────────────────────────────────────────

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

  // 1. Check cache
  if (enableCache) {
    const cacheHash = hashPrompt(options.systemPrompt, options.prompt, routeConfig.model);
    const cacheKey = CACHE_KEYS.aiCache(cacheHash);
    const cached = await redis.get<string>(cacheKey);
    if (cached) {
      return {
        content: cached,
        provider: routeConfig.name,
        model: routeConfig.model,
        cached: true,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  // 2. Try primary route, then fallback chain
  const chain = [options.route, ...(options.fallbackChain || FALLBACK_CHAINS[options.route])];
  let lastError: Error | null = null;

  for (const route of chain) {
    const cfg = ROUTE_CONFIG[route];
    try {
      const content = await callProvider(cfg, options);

      // 3. Cache successful response
      if (enableCache) {
        const cacheHash = hashPrompt(options.systemPrompt, options.prompt, cfg.model);
        const cacheKey = CACHE_KEYS.aiCache(cacheHash);
        await redis.set(cacheKey, content, CACHE_TTL.aiCache);
      }

      return {
        content,
        provider: cfg.name,
        model: cfg.model,
        cached: false,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(`[AIClient] ${cfg.name}/${cfg.model} failed: ${lastError.message}. Trying next...`);
    }
  }

  throw lastError || new Error('All AI providers failed');
}

/**
 * Call AI and parse JSON response. Throws if response is not valid JSON.
 */
export async function callJSON<T = any>(options: AICallOptions): Promise<{ data: T } & AICallResult> {
  const result = await call({
    ...options,
    responseFormat: 'json',
  });

  try {
    // Try direct JSON parse first
    const data = JSON.parse(result.content) as T;
    return { ...result, data };
  } catch {
    // Try extracting JSON from markdown code block
    const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[1].trim()) as T;
      return { ...result, data };
    }
    throw new Error(`Failed to parse AI response as JSON: ${result.content.slice(0, 200)}`);
  }
}

/**
 * Check if any AI provider is configured
 */
export function isConfigured(): boolean {
  return !!(
    config.ai.openai.apiKey ||
    config.ai.groq.apiKey ||
    config.ai.deepseek.apiKey ||
    config.ai.alibaba.apiKey
  );
}

// ─── Exported Module ───────────────────────────────────────────────────────

export const AIClient = {
  call,
  callJSON,
  isConfigured,
};

export default AIClient;
