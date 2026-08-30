/**
 * KnowledgeGraphService v1.0.0
 *
 * Semantic search over vectorized documentation using pgvector.
 *
 * @see backend/database/constitutional-schema.sql
 */

import { db } from '../db.js';
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import OpenAI from 'openai';
// AUDIT FIX H5: embeddings previously hit OpenAI with no circuit breaker and
// no cost accounting — unmetered, unprotected spend invisible to AI governance.
import { openaiBreaker, CircuitOpenError } from '../middleware/circuit-breaker.js';
import {
  type AIReservationRequest,
} from '../ai/UserAIBudget.js';
import {
  markAIProviderAttemptUnknown,
  releaseAIProviderAttempt,
  reserveAIProviderAttempt,
  settleAIProviderAttempt,
  type AIProviderAttempt,
} from '../ai/AISpendAttemptLedger.js';
import { assertExternalAIProviderIOAuthorized } from '../ai/ExternalAIProviderAuthority.js';
import { aiObservation } from './AIObservabilityPolicy.js';
import { AIObservabilityService, aiObservationHash } from './AIObservabilityService.js';

// ============================================================================
// TYPES
// ============================================================================

interface DocSection {
  filePath: string;
  sectionHeader: string;
  content: string;
  similarity: number;
  isLocked: boolean;
}

// ============================================================================
// EMBEDDING HELPER
// ============================================================================

let openaiClient: OpenAI | null = null;
const MAX_EMBEDDING_INPUT_BYTES = 32 * 1024;
const EMBEDDING_PROVIDER_TIMEOUT_MS = 15_000;

function getOpenAI(): OpenAI {
  assertExternalAIProviderIOAuthorized('KnowledgeGraph:openai:construct');
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '', maxRetries: 0 });
  }
  return openaiClient;
}

async function generateQueryEmbedding(text: string): Promise<number[]> {
  const inputBytes = Buffer.byteLength(text, 'utf8');
  if (inputBytes === 0 || inputBytes > MAX_EMBEDDING_INPUT_BYTES) {
    throw new Error('AI_KNOWLEDGE_EMBEDDING_INPUT_SIZE_INVALID');
  }
  assertExternalAIProviderIOAuthorized('KnowledgeGraph:openai:embedding');
  const openai = getOpenAI();
  const startedAt = Date.now();
  const textHash = aiObservationHash(text);
  const operationId = `knowledge-embedding:${createHash('sha256').update(JSON.stringify({
    route: 'openai-embedding',
    systemPrompt: 'HustleXP documentation similarity retrieval',
    prompt: text,
    object: textHash,
    user: 'system:knowledge-graph-embedding',
  })).digest('hex')}`;
  const reservation: AIReservationRequest = {
    agent: 'AI-KNOWLEDGE-EMBEDDING',
    userId: 'system:knowledge-graph-embedding',
    operationId,
    fingerprint: createHash('sha256').update(`${operationId}|text-embedding-3-small|1536`).digest('hex'),
    ownerToken: randomUUID(),
    attemptId: '0:openai:text-embedding-3-small',
    // text-embedding-3-small is $0.02 / 1M input tokens. A one-cent
    // reservation safely covers up to 500k tokens; this input is far smaller.
    reserveCents: Math.max(1, Math.ceil((inputBytes + 64) * 0.000002)),
    agentLimitCents: 25,
  };
  const providerAttempt: AIProviderAttempt = {
    reservation,
    providerKind: 'openai',
    providerModel: 'text-embedding-3-small',
  };
  const authority = await reserveAIProviderAttempt(providerAttempt);
  if (authority.status === 'completed') {
    const cached = JSON.parse(authority.resultJson) as { embedding?: unknown };
    if (!Array.isArray(cached.embedding) || cached.embedding.length !== 1536 || cached.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('AI_SPEND_CACHED_EMBEDDING_INVALID');
    }
    const observed = await AIObservabilityService.record({
      context: aiObservation('AI-KNOWLEDGE-EMBEDDING', {
        affectedObjectType: 'DOCUMENT_QUERY',
        affectedObjectId: textHash,
      }),
      provider: 'openai',
      modelVersion: 'text-embedding-3-small',
      executionResult: 'CACHED',
      output: cached.embedding.join(','),
      latencyMs: Date.now() - startedAt,
    });
    if (!observed.success) throw new Error(`AI_OBSERVABILITY_REQUIRED:${observed.error.code}`);
    return cached.embedding as number[];
  }
  if (authority.status !== 'reserved') throw new Error(`AI_SPEND_EMBEDDING_REJECTED:${authority.status}`);

  // AUDIT FIX H5: breaker-protected — an OpenAI outage fast-fails instead of
  // hanging every doc query.
  let response;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), EMBEDDING_PROVIDER_TIMEOUT_MS);
  try {
    response = await openaiBreaker.execute(() => openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
      dimensions: 1536,
    }, { signal: controller.signal }));
  } catch (error) {
    if (error instanceof CircuitOpenError) await releaseAIProviderAttempt(providerAttempt);
    else await markAIProviderAttemptUnknown(providerAttempt);
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }

  // Account for the known provider outcome before any downstream observation
  // write. Observation failure withholds output but cannot erase spend truth.
  const tokensUsed = response.usage?.total_tokens ?? 0;
  const costCents = Math.max(1, Math.ceil(tokensUsed * 0.000002));
  await db.query(
    `INSERT INTO ai_cost_logs (agent_type, user_id, provider, model, tokens_used, estimated_cost_cents, request_hash, created_at)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, NOW())`,
    ['knowledge_graph_embedding', 'openai', 'text-embedding-3-small', tokensUsed, costCents, reservation.fingerprint],
  );
  await settleAIProviderAttempt({
    ...providerAttempt,
    actualCostCents: costCents,
    resultJson: JSON.stringify({ embedding: response.data[0].embedding }),
  });

  const observed = await AIObservabilityService.record({
    context: aiObservation('AI-KNOWLEDGE-EMBEDDING', {
      affectedObjectType: 'DOCUMENT_QUERY',
      affectedObjectId: textHash,
    }),
    provider: 'openai',
    modelVersion: 'text-embedding-3-small',
    executionResult: 'GENERATED',
    output: response.data[0]?.embedding.join(',') ?? '',
    latencyMs: Date.now() - startedAt,
  });
  if (!observed.success) {
    throw new Error(`AI_OBSERVABILITY_REQUIRED:${observed.error.code}`);
  }

  return response.data[0].embedding;
}

// ============================================================================
// SERVICE
// ============================================================================

export const KnowledgeGraphService = {
  /**
   * Query docs by semantic similarity.
   * Uses pgvector cosine distance operator <=>.
   */
  queryDocs: async (query: string, topK: number = 5): Promise<DocSection[]> => {
    const embedding = await generateQueryEmbedding(query);
    const vectorStr = `[${embedding.join(',')}]`;

    const result = await db.readQuery<{
      file_path: string;
      section_header: string;
      content: string;
      is_locked: boolean;
      similarity: number;
    }>(
      `SELECT file_path, section_header, content, is_locked,
              1 - (embedding <=> $1::vector) AS similarity
       FROM doc_embeddings
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vectorStr, topK]
    );

    return result.rows.map((row) => ({
      filePath: row.file_path,
      sectionHeader: row.section_header,
      content: row.content,
      similarity: row.similarity,
      isLocked: row.is_locked,
    }));
  },

  /**
   * Find invariants relevant to a specific router/domain.
   */
  getRelatedInvariants: async (routerName: string): Promise<DocSection[]> => {
    const embedding = await generateQueryEmbedding(`invariant ${routerName}`);
    const vectorStr = `[${embedding.join(',')}]`;

    const result = await db.readQuery<{
      file_path: string;
      section_header: string;
      content: string;
      is_locked: boolean;
      similarity: number;
    }>(
      `SELECT file_path, section_header, content, is_locked,
              1 - (embedding <=> $1::vector) AS similarity
       FROM doc_embeddings
       WHERE file_path ILIKE '%INVARIANTS%' OR file_path ILIKE '%invariant%'
       ORDER BY embedding <=> $1::vector
       LIMIT 10`,
      [vectorStr]
    );

    return result.rows.map((row) => ({
      filePath: row.file_path,
      sectionHeader: row.section_header,
      content: row.content,
      similarity: row.similarity,
      isLocked: row.is_locked,
    }));
  },

  /**
   * Get the API contract for a specific procedure.
   */
  getContractForProcedure: async (router: string, procedure: string): Promise<DocSection[]> => {
    const embedding = await generateQueryEmbedding(`${router}.${procedure}`);
    const vectorStr = `[${embedding.join(',')}]`;

    const result = await db.readQuery<{
      file_path: string;
      section_header: string;
      content: string;
      is_locked: boolean;
      similarity: number;
    }>(
      `SELECT file_path, section_header, content, is_locked,
              1 - (embedding <=> $1::vector) AS similarity
       FROM doc_embeddings
       WHERE file_path ILIKE '%API_CONTRACT%'
       ORDER BY embedding <=> $1::vector
       LIMIT 5`,
      [vectorStr]
    );

    return result.rows.map((row) => ({
      filePath: row.file_path,
      sectionHeader: row.section_header,
      content: row.content,
      similarity: row.similarity,
      isLocked: row.is_locked,
    }));
  },
};
