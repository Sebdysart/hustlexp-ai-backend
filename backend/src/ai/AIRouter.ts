/**
 * AI Router with Cost Governance
 * 
 * CRITICAL: Prevents runaway AI costs with per-user daily budgets,
 * provider fallback chains, and centralized cost tracking.
 * 
 * @see AI_COST_GOVERNANCE.md
 */

import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { TRPCError } from '@trpc/server';
import { config } from '../config.js';
import { db } from '../db.js';
import {
  checkAgentBudget,
  failAIOperation,
  type AIReservationRequest,
} from './UserAIBudget.js';
import {
  markAIProviderAttemptUnknown,
  releaseAIProviderAttempt,
  reserveAIProviderAttempt,
  settleAIProviderAttempt,
  type AIProviderAttempt,
} from './AISpendAttemptLedger.js';
// AUDIT FIX H6: provider calls must go through circuit breakers — a dead
// provider now fast-fails instead of being hammered by the fallback chain.
import { openaiBreaker, groqBreaker, deepseekBreaker, alibabaBreaker, CircuitOpenError } from '../middleware/circuit-breaker.js';
import { assertExternalAIProviderIOAuthorized } from './ExternalAIProviderAuthority.js';

interface AICallConfig {
  maxTokensPerCall: number;
  dailyBudgetPerUser: number;
  fallbackChain: AIProvider[];
  timeoutMs: number;
}

type AIProvider = 'groq' | 'openai' | 'deepseek' | 'alibaba';

const PROVIDER_COSTS: Record<AIProvider, { input: number; output: number }> = {
  groq: { input: 0.5, output: 0.8 },
  openai: { input: 2.5, output: 10 },
  deepseek: { input: 1.4, output: 5.6 },
  alibaba: { input: 1.0, output: 4.0 },
};

const AGENT_BUDGETS: Record<string, AICallConfig> = {
  judge: { maxTokensPerCall: 4000, dailyBudgetPerUser: 50, fallbackChain: ['groq', 'openai', 'deepseek'], timeoutMs: 30000 },
  matchmaker: { maxTokensPerCall: 2000, dailyBudgetPerUser: 10, fallbackChain: ['groq', 'openai'], timeoutMs: 10000 },
  dispute: { maxTokensPerCall: 8000, dailyBudgetPerUser: 100, fallbackChain: ['openai', 'deepseek', 'groq'], timeoutMs: 60000 },
  reputation: { maxTokensPerCall: 1500, dailyBudgetPerUser: 5, fallbackChain: ['groq', 'deepseek'], timeoutMs: 10000 },
  onboarding: { maxTokensPerCall: 1000, dailyBudgetPerUser: 5, fallbackChain: ['groq', 'openai'], timeoutMs: 10000 },
  moderation: { maxTokensPerCall: 2000, dailyBudgetPerUser: 10, fallbackChain: ['groq', 'openai'], timeoutMs: 15000 },
  incident_diagnosis: { maxTokensPerCall: 4000, dailyBudgetPerUser: 20, fallbackChain: ['deepseek', 'groq', 'openai'], timeoutMs: 45000 },
  intent_bridge: { maxTokensPerCall: 6000, dailyBudgetPerUser: 30, fallbackChain: ['deepseek', 'openai', 'groq'], timeoutMs: 60000 },
  default: { maxTokensPerCall: 2000, dailyBudgetPerUser: 25, fallbackChain: ['groq', 'openai', 'deepseek'], timeoutMs: 20000 },
};

function estimateActualCost(provider: AIProvider, promptTokens: number, completionTokens: number): number {
  const costs = PROVIDER_COSTS[provider];
  return Math.ceil((promptTokens / 1000) * costs.input + (completionTokens / 1000) * costs.output);
}

function estimateWorstCaseCost(provider: AIProvider, prompt: string, maxOutputTokens: number): number {
  const costs = PROVIDER_COSTS[provider];
  // A tokenizer cannot emit more byte tokens than the UTF-8 request payload;
  // 256 tokens additionally cover the chat envelope and provider-added syntax.
  const inputTokenUpperBound = Buffer.byteLength(prompt, 'utf8') + 256;
  return Math.max(1, Math.ceil(
    (inputTokenUpperBound / 1000) * costs.input
      + (maxOutputTokens / 1000) * costs.output,
  ));
}

async function checkBudget(agent: string, userId: string): Promise<{ allowed: boolean; spent: number; limit: number }> {
  const agentConfig = AGENT_BUDGETS[agent] || AGENT_BUDGETS.default;
  return checkAgentBudget(agent, userId, agentConfig.dailyBudgetPerUser);
}

async function recordSettledCost(
  agent: string,
  userId: string,
  provider: AIProvider,
  response: AIResponse,
  costCents: number,
  fingerprint: string,
): Promise<void> {
  // This audit write intentionally precedes Redis settlement. If it fails, the
  // conservative reservation remains and the provider response is not returned.
  await db.query(
    `INSERT INTO ai_cost_logs (
       agent_type, user_id, provider, model, tokens_used, prompt_tokens,
       completion_tokens, estimated_cost_cents, request_hash, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
    [
      agent,
      userId,
      provider,
      response.model,
      response.usage.total_tokens,
      response.usage.prompt_tokens,
      response.usage.completion_tokens,
      costCents,
      fingerprint,
    ],
  );
}

interface AIResponse {
  text: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  usageReliable: boolean;
  provider: AIProvider;
  model: string;
}

function normalizeUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined): Pick<AIResponse, 'usage' | 'usageReliable'> {
  const promptTokens = usage?.prompt_tokens;
  const completionTokens = usage?.completion_tokens;
  const totalTokens = usage?.total_tokens;
  const usageReliable = [promptTokens, completionTokens, totalTokens].every(
    (value) => Number.isSafeInteger(value) && (value as number) >= 0,
  ) && totalTokens === (promptTokens as number) + (completionTokens as number);
  return {
    usage: {
      prompt_tokens: usageReliable ? promptTokens as number : 0,
      completion_tokens: usageReliable ? completionTokens as number : 0,
      total_tokens: usageReliable ? totalTokens as number : 0,
    },
    usageReliable,
  };
}

async function withProviderTimeout<T>(
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await call(controller.signal);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function callGroq(prompt: string, maxTokens: number, timeoutMs: number): Promise<AIResponse> {
  assertExternalAIProviderIOAuthorized('AIRouter:groq');
  const { Groq } = await import('groq-sdk');
  const groq = new Groq({ apiKey: config.ai.groq.apiKey, maxRetries: 0 });
  const response = await withProviderTimeout(timeoutMs, (signal) =>
    groqBreaker.execute(() => groq.chat.completions.create({
      model: config.ai.groq.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
    }, { signal })),
  );
  return {
    text: response.choices[0]?.message?.content || '',
    ...normalizeUsage(response.usage),
    provider: 'groq', model: config.ai.groq.model,
  };
}

async function callOpenAI(prompt: string, maxTokens: number, timeoutMs: number): Promise<AIResponse> {
  assertExternalAIProviderIOAuthorized('AIRouter:openai');
  const { OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey: config.ai.openai.apiKey, maxRetries: 0 });
  const response = await withProviderTimeout(timeoutMs, (signal) =>
    openaiBreaker.execute(() => openai.chat.completions.create({
      model: config.ai.openai.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
    }, { signal })),
  );
  return {
    text: response.choices[0]?.message?.content || '',
    ...normalizeUsage(response.usage),
    provider: 'openai', model: config.ai.openai.model,
  };
}

async function callDeepSeek(prompt: string, maxTokens: number, timeoutMs: number): Promise<AIResponse> {
  assertExternalAIProviderIOAuthorized('AIRouter:deepseek');
  const { OpenAI } = await import('openai');
  const deepseek = new OpenAI({ apiKey: config.ai.deepseek.apiKey, baseURL: 'https://api.deepseek.com', maxRetries: 0 });
  const response = await withProviderTimeout(timeoutMs, (signal) =>
    deepseekBreaker.execute(() => deepseek.chat.completions.create({
      model: config.ai.deepseek.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
    }, { signal })),
  );
  return {
    text: response.choices[0]?.message?.content || '',
    ...normalizeUsage(response.usage),
    provider: 'deepseek', model: config.ai.deepseek.model,
  };
}

async function callAlibaba(prompt: string, maxTokens: number, timeoutMs: number): Promise<AIResponse> {
  assertExternalAIProviderIOAuthorized('AIRouter:alibaba');
  const { OpenAI } = await import('openai');
  const alibaba = new OpenAI({ apiKey: config.ai.alibaba.apiKey, baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', maxRetries: 0 });
  const response = await withProviderTimeout(timeoutMs, (signal) =>
    alibabaBreaker.execute(() => alibaba.chat.completions.create({
      model: config.ai.alibaba.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
    }, { signal })),
  );
  return {
    text: response.choices[0]?.message?.content || '',
    ...normalizeUsage(response.usage),
    provider: 'alibaba', model: config.ai.alibaba.model,
  };
}

const PROVIDER_FUNCTIONS: Record<AIProvider, (prompt: string, maxTokens: number, timeoutMs: number) => Promise<AIResponse>> = {
  groq: callGroq,
  openai: callOpenAI,
  deepseek: callDeepSeek,
  alibaba: callAlibaba,
};

const MAX_PROVIDER_IO_ATTEMPTS = 2;
const PROVIDER_RETRY_BASE_DELAY_MS = 250;

export interface CallAIResult {
  text: string; provider: AIProvider; model: string; tokensUsed: number; estimatedCostCents: number; attempts: number;
}

export interface CallAIOptions {
  /** Stable business-operation identity supplied by the caller. */
  operationId: string;
}

function operationFingerprint(agent: string, userId: string, prompt: string): string {
  return createHash('sha256').update(JSON.stringify({ agent, userId, prompt })).digest('hex');
}

function meteringFailure(cause: unknown): TRPCError {
  console.error('[AI Router] Spend authority unavailable:', cause);
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'HX705: AI spend authority unavailable; no further provider call was attempted.',
  });
}

function parseCompletedResult(resultJson: string): CallAIResult {
  const parsed = JSON.parse(resultJson) as Partial<CallAIResult>;
  if (
    typeof parsed.text !== 'string'
    || !['groq', 'openai', 'deepseek', 'alibaba'].includes(parsed.provider ?? '')
    || typeof parsed.model !== 'string'
    || !Number.isSafeInteger(parsed.tokensUsed)
    || !Number.isSafeInteger(parsed.estimatedCostCents)
    || !Number.isSafeInteger(parsed.attempts)
  ) {
    throw new Error('AI_OPERATION_CACHED_RESULT_INVALID');
  }
  return parsed as CallAIResult;
}

function budgetError(scope: 'global' | 'user' | 'agent', agent: string): TRPCError {
  if (scope === 'global') {
    return new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'HX703: Platform AI daily budget exceeded. Retry after midnight UTC.' });
  }
  if (scope === 'user') {
    return new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'HX704: Personal AI daily budget exceeded ($5.00/day). Retry after midnight UTC.' });
  }
  return new TRPCError({ code: 'TOO_MANY_REQUESTS', message: `HX701: AI daily budget exceeded for ${agent}` });
}

export async function callAI(
  agent: string,
  userId: string,
  prompt: string,
  options: CallAIOptions,
): Promise<CallAIResult> {
  if (!options?.operationId || options.operationId.trim() !== options.operationId || options.operationId.length > 256) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'HX700: A stable AI operationId is required.' });
  }
  // Release policy is hard-dormant. Isolated transport tests replace the
  // authority module; deployed/local/preview/staging builds cannot proceed.
  assertExternalAIProviderIOAuthorized(`AIRouter:${agent}`);
  const agentConfig = AGENT_BUDGETS[agent] || AGENT_BUDGETS.default;
  const ownerToken = randomUUID();
  const fingerprint = operationFingerprint(agent, userId, prompt);
  let lastError: Error | null = null;
  let providerIoAttempts = 0;
  let lastReservation: AIReservationRequest | null = null;

  for (let providerIndex = 0; providerIndex < agentConfig.fallbackChain.length; providerIndex++) {
    const provider = agentConfig.fallbackChain[providerIndex];
    for (let providerAttempt = 0; providerAttempt < MAX_PROVIDER_IO_ATTEMPTS; providerAttempt++) {
      const reservation: AIReservationRequest = {
        agent,
        userId,
        operationId: options.operationId,
        fingerprint,
        ownerToken,
        attemptId: `${providerIndex}:${provider}:${providerAttempt}`,
        reserveCents: estimateWorstCaseCost(provider, prompt, agentConfig.maxTokensPerCall),
        agentLimitCents: agentConfig.dailyBudgetPerUser,
      };
      const durableAttempt: AIProviderAttempt = {
        reservation,
        providerKind: provider,
        providerModel: config.ai[provider].model,
      };
      lastReservation = reservation;

      let authority;
      try {
        authority = await reserveAIProviderAttempt(durableAttempt);
      } catch (error) {
        throw meteringFailure(error);
      }

      if (authority.status === 'completed') {
        try {
          return parseCompletedResult(authority.resultJson);
        } catch (error) {
          throw meteringFailure(error);
        }
      }
      if (authority.status === 'failed') {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `HX702: ${authority.message}` });
      }
      if (authority.status === 'in_progress') {
        throw new TRPCError({ code: 'CONFLICT', message: 'HX706: This AI operation is already in progress or has an uncertain provider outcome.' });
      }
      if (authority.status === 'conflict') {
        throw new TRPCError({ code: 'CONFLICT', message: 'HX707: operationId was already used for a different AI request.' });
      }
      if (authority.status === 'limit') throw budgetError(authority.scope, agent);

      providerIoAttempts += 1;
      let response: AIResponse;
      try {
        response = await PROVIDER_FUNCTIONS[provider](prompt, agentConfig.maxTokensPerCall, agentConfig.timeoutMs);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        try {
          if (error instanceof CircuitOpenError) {
            // CircuitOpenError is the only proven no-provider-I/O outcome.
            await releaseAIProviderAttempt(durableAttempt);
          } else {
            // Timeouts, network errors, and provider errors have unknown billing
            // outcomes, so the worst-case reservation remains charged.
            await markAIProviderAttemptUnknown(durableAttempt);
          }
        } catch (meteringError) {
          throw meteringFailure(meteringError);
        }
        if (error instanceof CircuitOpenError) break;
        if (providerAttempt + 1 < MAX_PROVIDER_IO_ATTEMPTS) {
          const delay = PROVIDER_RETRY_BASE_DELAY_MS * Math.pow(2, providerAttempt) + Math.random() * 50;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        continue;
      }

      const actualCostCents = response.usageReliable
        ? estimateActualCost(provider, response.usage.prompt_tokens, response.usage.completion_tokens)
        : reservation.reserveCents;
      if (actualCostCents > reservation.reserveCents) {
        try {
          await markAIProviderAttemptUnknown(durableAttempt, 'USAGE_EXCEEDED_RESERVATION');
        } catch (error) {
          throw meteringFailure(error);
        }
        throw meteringFailure(new Error('AI_PROVIDER_USAGE_EXCEEDED_WORST_CASE_RESERVATION'));
      }

      const result: CallAIResult = {
        text: response.text,
        provider: response.provider,
        model: response.model,
        tokensUsed: response.usage.total_tokens,
        estimatedCostCents: actualCostCents,
        attempts: providerIoAttempts,
      };

      // A successful provider response is terminal. Audit or settlement failure
      // is surfaced and can never fall through to another paid provider.
      try {
        await recordSettledCost(agent, userId, provider, response, actualCostCents, fingerprint);
        await settleAIProviderAttempt({
          ...durableAttempt,
          actualCostCents,
          resultJson: JSON.stringify(result),
        });
      } catch (error) {
        throw meteringFailure(error);
      }
      return result;
    }
  }

  if (lastReservation) {
    try {
      await failAIOperation(lastReservation, `All AI providers exhausted for ${agent}`);
    } catch (error) {
      throw meteringFailure(error);
    }
  }
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `HX702: All AI providers exhausted for ${agent}. Last error: ${lastError?.message}` });
}

export async function getBudgetStatus(agent: string, userId: string): Promise<{ agent: string; userId: string; spent: number; limit: number; remaining: number; resetAt: string }> {
  const budget = await checkBudget(agent, userId);
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return { agent, userId, spent: budget.spent, limit: budget.limit, remaining: Math.max(0, budget.limit - budget.spent), resetAt: tomorrow.toISOString() };
}

// ============================================================================
// AI COST DASHBOARD & ALERTING (AUDIT FIX)
// ============================================================================

export interface CostSummary {
  totalCostCents: number;
  totalTokens: number;
  callCount: number;
  byAgent: Record<string, { costCents: number; tokens: number; calls: number }>;
  byProvider: Record<string, { costCents: number; tokens: number; calls: number }>;
  period: string;
}

/**
 * Get aggregated AI cost summary for a time period (admin dashboard)
 */
export async function getCostDashboard(
  periodDays: number = 30
): Promise<CostSummary> {
  const result = await db.query<{
    agent_type: string;
    provider: string;
    total_cost: string;
    total_tokens: string;
    call_count: string;
  }>(
    `SELECT agent_type, provider,
       SUM(estimated_cost_cents) as total_cost,
       SUM(tokens_used) as total_tokens,
       COUNT(*) as call_count
     FROM ai_cost_logs
     WHERE created_at > NOW() - INTERVAL '1 day' * $1
     GROUP BY agent_type, provider
     ORDER BY total_cost DESC`,
    [periodDays]
  );

  const byAgent: Record<string, { costCents: number; tokens: number; calls: number }> = {};
  const byProvider: Record<string, { costCents: number; tokens: number; calls: number }> = {};
  let totalCostCents = 0;
  let totalTokens = 0;
  let callCount = 0;

  for (const row of result.rows) {
    const cost = parseInt(row.total_cost, 10) || 0;
    const tokens = parseInt(row.total_tokens, 10) || 0;
    const calls = parseInt(row.call_count, 10) || 0;

    totalCostCents += cost;
    totalTokens += tokens;
    callCount += calls;

    if (!byAgent[row.agent_type]) {
      byAgent[row.agent_type] = { costCents: 0, tokens: 0, calls: 0 };
    }
    byAgent[row.agent_type].costCents += cost;
    byAgent[row.agent_type].tokens += tokens;
    byAgent[row.agent_type].calls += calls;

    if (!byProvider[row.provider]) {
      byProvider[row.provider] = { costCents: 0, tokens: 0, calls: 0 };
    }
    byProvider[row.provider].costCents += cost;
    byProvider[row.provider].tokens += tokens;
    byProvider[row.provider].calls += calls;
  }

  return {
    totalCostCents,
    totalTokens,
    callCount,
    byAgent,
    byProvider,
    period: `${periodDays} days`,
  };
}

/**
 * Check if any agent is approaching budget alerts and return warnings
 */
export async function checkCostAlerts(): Promise<{
  alerts: Array<{
    level: 'warning' | 'critical';
    agent: string;
    message: string;
    dailyCostCents: number;
    projectedMonthlyCents: number;
  }>;
}> {
  const result = await db.query<{
    agent_type: string;
    daily_cost: string;
  }>(
    `SELECT agent_type, SUM(estimated_cost_cents) as daily_cost
     FROM ai_cost_logs
     WHERE created_at > NOW() - INTERVAL '24 hours'
     GROUP BY agent_type`
  );

  const alerts: Array<{
    level: 'warning' | 'critical';
    agent: string;
    message: string;
    dailyCostCents: number;
    projectedMonthlyCents: number;
  }> = [];

  for (const row of result.rows) {
    const dailyCost = parseInt(row.daily_cost, 10) || 0;
    const projectedMonthly = dailyCost * 30;

    // Alert thresholds: warning at $50/day, critical at $150/day per agent
    if (dailyCost > 15000) {
      alerts.push({
        level: 'critical',
        agent: row.agent_type,
        message: `Agent "${row.agent_type}" spending $${(dailyCost / 100).toFixed(2)}/day (projected $${(projectedMonthly / 100).toFixed(2)}/month). IMMEDIATE ATTENTION REQUIRED.`,
        dailyCostCents: dailyCost,
        projectedMonthlyCents: projectedMonthly,
      });
    } else if (dailyCost > 5000) {
      alerts.push({
        level: 'warning',
        agent: row.agent_type,
        message: `Agent "${row.agent_type}" spending $${(dailyCost / 100).toFixed(2)}/day (projected $${(projectedMonthly / 100).toFixed(2)}/month). Monitor closely.`,
        dailyCostCents: dailyCost,
        projectedMonthlyCents: projectedMonthly,
      });
    }
  }

  return { alerts };
}

export default { callAI, getBudgetStatus, getCostDashboard, checkCostAlerts };
