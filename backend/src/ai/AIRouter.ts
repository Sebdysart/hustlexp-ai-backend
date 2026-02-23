/**
 * AI Router with Cost Governance
 * 
 * CRITICAL: Prevents runaway AI costs with per-user daily budgets,
 * provider fallback chains, and centralized cost tracking.
 * 
 * @see AI_COST_GOVERNANCE.md
 */

import { Redis } from '@upstash/redis';
import { TRPCError } from '@trpc/server';
import { config } from '../config';
import { db } from '../db';
import { checkUserBudget, trackUserCost, checkGlobalBudget, trackGlobalCost } from './UserAIBudget';

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

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    if (!config.redis.restUrl || !config.redis.restToken) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'HX001: Redis not configured for AI cost tracking' });
    }
    redis = new Redis({ url: config.redis.restUrl, token: config.redis.restToken });
  }
  return redis;
}

function getBudgetKey(agent: string, userId: string): string {
  const today = new Date().toISOString().split('T')[0];
  return `ai:budget:${agent}:${userId}:${today}`;
}

function estimateCost(provider: AIProvider, tokensUsed: number): number {
  const costs = PROVIDER_COSTS[provider];
  const avgCostPer1K = (costs.input * 0.7 + costs.output * 0.3);
  return Math.ceil((tokensUsed / 1000) * avgCostPer1K);
}

async function checkBudget(agent: string, userId: string): Promise<{ allowed: boolean; spent: number; limit: number }> {
  const config = AGENT_BUDGETS[agent] || AGENT_BUDGETS.default;
  const budgetKey = getBudgetKey(agent, userId);
  try {
    const spent = Number(await getRedis().get(budgetKey) ?? 0);
    return { allowed: spent < config.dailyBudgetPerUser, spent, limit: config.dailyBudgetPerUser };
  } catch (error) {
    console.warn(`[AI Router] Failed to check budget:`, error);
    return { allowed: true, spent: 0, limit: config.dailyBudgetPerUser };
  }
}

async function trackCost(agent: string, userId: string, provider: AIProvider, tokensUsed: number): Promise<void> {
  const cost = estimateCost(provider, tokensUsed);
  const budgetKey = getBudgetKey(agent, userId);
  try {
    await getRedis().incrby(budgetKey, cost);
    await getRedis().expire(budgetKey, 86400);
    await db.query(
      `INSERT INTO ai_cost_logs (agent_type, user_id, provider, tokens_used, estimated_cost_cents, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [agent, userId, provider, tokensUsed, cost]
    );
  } catch (error) {
    console.error(`[AI Router] Failed to track cost:`, error);
  }
}

interface AIResponse { text: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; provider: AIProvider; model: string; }

async function callGroq(prompt: string, maxTokens: number): Promise<AIResponse> {
  const { Groq } = await import('groq-sdk');
  const groq = new Groq({ apiKey: config.ai.groq.apiKey });
  const response = await groq.chat.completions.create({
    model: config.ai.groq.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
  });
  return {
    text: response.choices[0]?.message?.content || '',
    usage: { prompt_tokens: response.usage?.prompt_tokens || 0, completion_tokens: response.usage?.completion_tokens || 0, total_tokens: response.usage?.total_tokens || 0 },
    provider: 'groq', model: config.ai.groq.model,
  };
}

async function callOpenAI(prompt: string, maxTokens: number): Promise<AIResponse> {
  const { OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey: config.ai.openai.apiKey });
  const response = await openai.chat.completions.create({
    model: config.ai.openai.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
  });
  return {
    text: response.choices[0]?.message?.content || '',
    usage: { prompt_tokens: response.usage?.prompt_tokens || 0, completion_tokens: response.usage?.completion_tokens || 0, total_tokens: response.usage?.total_tokens || 0 },
    provider: 'openai', model: config.ai.openai.model,
  };
}

async function callDeepSeek(prompt: string, maxTokens: number): Promise<AIResponse> {
  const { OpenAI } = await import('openai');
  const deepseek = new OpenAI({ apiKey: config.ai.deepseek.apiKey, baseURL: 'https://api.deepseek.com' });
  const response = await deepseek.chat.completions.create({
    model: config.ai.deepseek.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
  });
  return {
    text: response.choices[0]?.message?.content || '',
    usage: { prompt_tokens: response.usage?.prompt_tokens || 0, completion_tokens: response.usage?.completion_tokens || 0, total_tokens: response.usage?.total_tokens || 0 },
    provider: 'deepseek', model: config.ai.deepseek.model,
  };
}

async function callAlibaba(prompt: string, maxTokens: number): Promise<AIResponse> {
  const { OpenAI } = await import('openai');
  const alibaba = new OpenAI({ apiKey: config.ai.alibaba.apiKey, baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
  const response = await alibaba.chat.completions.create({
    model: config.ai.alibaba.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
  });
  return {
    text: response.choices[0]?.message?.content || '',
    usage: { prompt_tokens: response.usage?.prompt_tokens || 0, completion_tokens: response.usage?.completion_tokens || 0, total_tokens: response.usage?.total_tokens || 0 },
    provider: 'alibaba', model: config.ai.alibaba.model,
  };
}

/** Retry a provider call with exponential backoff (1s base, max 3 retries, jitter) */
async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries: number = 3, baseDelayMs: number = 1000): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

const PROVIDER_FUNCTIONS: Record<AIProvider, (prompt: string, maxTokens: number) => Promise<AIResponse>> = {
  groq: (p, m) => retryWithBackoff(() => callGroq(p, m), 2),
  openai: (p, m) => retryWithBackoff(() => callOpenAI(p, m), 2),
  deepseek: (p, m) => retryWithBackoff(() => callDeepSeek(p, m), 2),
  alibaba: (p, m) => retryWithBackoff(() => callAlibaba(p, m), 2),
};

export interface CallAIResult {
  text: string; provider: AIProvider; model: string; tokensUsed: number; estimatedCostCents: number; attempts: number;
}

export async function callAI(agent: string, userId: string, prompt: string): Promise<CallAIResult> {
  const agentConfig = AGENT_BUDGETS[agent] || AGENT_BUDGETS.default;
  const globalBudget = await checkGlobalBudget();
  if (!globalBudget.allowed) {
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'HX703: Platform AI daily budget exceeded. Retry after midnight UTC.' });
  }
  const userBudget = await checkUserBudget(userId);
  if (!userBudget.allowed) {
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'HX704: Personal AI daily budget exceeded ($5.00/day). Retry after midnight UTC.' });
  }
  const budget = await checkBudget(agent, userId);
  if (!budget.allowed) {
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: `HX701: AI daily budget exceeded for ${agent}` });
  }
  let lastError: Error | null = null;
  for (let i = 0; i < agentConfig.fallbackChain.length; i++) {
    const provider = agentConfig.fallbackChain[i];
    try {
      const response = await PROVIDER_FUNCTIONS[provider](prompt, agentConfig.maxTokensPerCall);
      await trackCost(agent, userId, provider, response.usage.total_tokens);
      await trackUserCost(userId, estimateCost(provider, response.usage.total_tokens));
      await trackGlobalCost(estimateCost(provider, response.usage.total_tokens));
      return { text: response.text, provider: response.provider, model: response.model, tokensUsed: response.usage.total_tokens, estimatedCostCents: estimateCost(provider, response.usage.total_tokens), attempts: i + 1 };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (i < agentConfig.fallbackChain.length - 1) continue;
      break;
    }
  }
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `HX702: All AI providers exhausted for ${agent}. Last error: ${lastError?.message}` });
}

export async function getBudgetStatus(agent: string, userId: string): Promise<{ agent: string; userId: string; spent: number; limit: number; remaining: number; resetAt: string }> {
  const agentConfig = AGENT_BUDGETS[agent] || AGENT_BUDGETS.default;
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
