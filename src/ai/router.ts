/**
 * AI Router for the src/ layer.
 *
 * `routedGenerate` is the single entry point that orchestrator.ts and other
 * src/ services call to execute an AI generation request.  It:
 *
 *  1. Maps a logical "task type" (e.g. 'planning', 'pricing') to a provider
 *     preference order.
 *  2. Iterates the preference order, trying each provider in turn.
 *  3. Records circuit-breaker outcomes via recordFailure / recordSuccess so
 *     that areAllCircuitsOpen() / isDegradedMode() can fire from real failures.
 *
 * NOTE: The actual HTTP calls to AI providers are lightweight stubs here
 * because the src/ layer intentionally avoids hard SDK dependencies at boot
 * time.  If a real key is present the call goes through; otherwise the
 * provider throws "not configured" and the next one is tried.
 */

import { recordFailure, recordSuccess, AI_PROVIDERS } from '../utils/reliability.js';
import { env } from '../config/env.js';
import { aiLogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskType =
  | 'planning'
  | 'pricing'
  | 'high_stakes_copy'
  | 'dispute'
  | 'default';

export interface GenerateMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface GenerateOptions {
  system?: string;
  messages: GenerateMessage[];
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface GenerateResult {
  content: string;
  provider: string;
}

// ---------------------------------------------------------------------------
// Task-type → provider preference mapping
// ---------------------------------------------------------------------------

// Only the four providers tracked by the circuit breakers matter here.
// 'anthropic' is used for high-stakes tasks; 'deepseek' for reasoning/planning;
// 'groq' for low-latency; 'openai' as the broad-capable default.
const TASK_PROVIDER_ORDER: Record<TaskType, string[]> = {
  planning:        ['deepseek', 'openai', 'groq', 'anthropic'],
  pricing:         ['groq',     'openai', 'deepseek', 'anthropic'],
  high_stakes_copy:['anthropic','openai', 'deepseek', 'groq'],
  dispute:         ['openai',   'anthropic', 'deepseek', 'groq'],
  default:         ['groq',     'openai', 'deepseek', 'anthropic'],
};

// ---------------------------------------------------------------------------
// Per-provider call helpers (thin wrappers — real SDK calls in production)
// ---------------------------------------------------------------------------

interface ProviderCallOptions {
  system?: string;
  messages: GenerateMessage[];
  json: boolean;
  maxTokens: number;
  temperature: number;
}

async function callOpenAI(opts: ProviderCallOptions): Promise<string> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('openai: OPENAI_API_KEY not configured');

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) {
    messages.push({ role: m.role as 'system' | 'user' | 'assistant', content: m.content });
  }

  const response = await client.chat.completions.create({
    model: env.OPENAI_MODEL || 'gpt-4o-mini',
    messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    ...(opts.json ? { response_format: { type: 'json_object' as const } } : {}),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('openai: empty response');
  return content;
}

async function callGroq(opts: ProviderCallOptions): Promise<string> {
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) throw new Error('groq: GROQ_API_KEY not configured');

  const { default: Groq } = await import('groq-sdk');
  const client = new Groq({ apiKey });

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) {
    messages.push({ role: m.role as 'system' | 'user' | 'assistant', content: m.content });
  }

  const response = await client.chat.completions.create({
    model: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    ...(opts.json ? { response_format: { type: 'json_object' as const } } : {}),
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('groq: empty response');
  return content;
}

async function callDeepSeek(opts: ProviderCallOptions): Promise<string> {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('deepseek: DEEPSEEK_API_KEY not configured');

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com/v1' });

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) {
    messages.push({ role: m.role as 'system' | 'user' | 'assistant', content: m.content });
  }

  const response = await client.chat.completions.create({
    model: env.DEEPSEEK_MODEL || 'deepseek-chat',
    messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('deepseek: empty response');
  return content;
}

async function callAnthropic(opts: ProviderCallOptions): Promise<string> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('anthropic: ANTHROPIC_API_KEY not configured');

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.anthropic.com/v1/',
    defaultHeaders: { 'anthropic-version': '2023-06-01' },
  });

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) {
    messages.push({ role: m.role as 'system' | 'user' | 'assistant', content: m.content });
  }

  const response = await client.chat.completions.create({
    model: env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022',
    messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('anthropic: empty response');
  return content;
}

// Map provider name → call function
const PROVIDER_CALL_FNS: Record<string, (opts: ProviderCallOptions) => Promise<string>> = {
  openai:    callOpenAI,
  groq:      callGroq,
  deepseek:  callDeepSeek,
  anthropic: callAnthropic,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute an AI generation request, trying providers in the order dictated by
 * the task type.  Circuit-breaker outcomes are recorded for every attempt so
 * that areAllCircuitsOpen() / isDegradedMode() can fire from real failures.
 */
export async function routedGenerate(
  taskType: TaskType | string,
  options: GenerateOptions,
): Promise<GenerateResult> {
  const providerOrder =
    TASK_PROVIDER_ORDER[taskType as TaskType] ??
    TASK_PROVIDER_ORDER.default;

  const callOpts: ProviderCallOptions = {
    system:      options.system,
    messages:    options.messages,
    json:        options.json ?? false,
    maxTokens:   options.maxTokens ?? 1024,
    temperature: options.temperature ?? 0.7,
  };

  let lastError: Error | null = null;

  for (const provider of providerOrder) {
    const callFn = PROVIDER_CALL_FNS[provider];
    if (!callFn) continue;

    try {
      const content = await callFn(callOpts);

      // --- Fix 1: record success so circuit can close after recovery ---
      recordSuccess(provider);

      aiLogger.debug({ provider, taskType }, 'routedGenerate succeeded');
      return { content, provider };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      // --- Fix 1: record failure so circuit opens after 5 consecutive fails ---
      recordFailure(provider);

      aiLogger.warn({ provider, taskType, err: err.message }, 'routedGenerate provider failed, trying next');
      lastError = err;
    }
  }

  throw lastError ?? new Error(`routedGenerate: all providers exhausted for task type '${taskType}'`);
}

// Re-export AI_PROVIDERS so callers can enumerate supported providers
export { AI_PROVIDERS };
