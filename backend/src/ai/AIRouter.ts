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

const PROVIDER_FUNCTIONS: Record<AIProvider, (prompt: string, maxTokens: number) => Promise<AIResponse>> = {
  groq: callGroq, openai: callOpenAI, deepseek: callDeepSeek, alibaba: callAlibaba,
};

export interface CallAIResult {
  text: string; provider: AIProvider; model: string; tokensUsed: number; estimatedCostCents: number; attempts: number;
}

export async function callAI(agent: string, userId: string, prompt: string): Promise<CallAIResult> {
  const agentConfig = AGENT_BUDGETS[agent] || AGENT_BUDGETS.default;
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

export default { callAI, getBudgetStatus };
