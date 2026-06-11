/**
 * KnowledgeGraphService v1.0.0
 *
 * Semantic search over vectorized documentation using pgvector.
 *
 * @see backend/database/constitutional-schema.sql
 */

import { db } from '../db.js';
import OpenAI from 'openai';
// AUDIT FIX H5: embeddings previously hit OpenAI with no circuit breaker and
// no cost accounting — unmetered, unprotected spend invisible to AI governance.
import { openaiBreaker } from '../middleware/circuit-breaker.js';
import { logger } from '../logger.js';

const kgLog = logger.child({ service: 'KnowledgeGraphService' });

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

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' });
  }
  return openaiClient;
}

async function generateQueryEmbedding(text: string): Promise<number[]> {
  const openai = getOpenAI();
  // AUDIT FIX H5: breaker-protected — an OpenAI outage fast-fails instead of
  // hanging every doc query.
  const response = await openaiBreaker.execute(() => openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
    dimensions: 1536,
  }));

  // AUDIT FIX H5: record token usage in the AI cost ledger (system call —
  // no user attribution; user_id is nullable per GDPR D63-2). Non-fatal:
  // a cost-log failure must never break doc search.
  const tokensUsed = response.usage?.total_tokens ?? 0;
  if (tokensUsed > 0) {
    try {
      await db.query(
        `INSERT INTO ai_cost_logs (agent_type, user_id, provider, tokens_used, estimated_cost_cents, created_at)
         VALUES ($1, NULL, $2, $3, $4, NOW())`,
        // text-embedding-3-small: $0.02 / 1M tokens → cents = tokens × 0.000002
        ['knowledge_graph_embedding', 'openai', tokensUsed, Math.ceil(tokensUsed * 0.000002)]
      );
    } catch (costErr) {
      kgLog.warn(
        { err: costErr instanceof Error ? costErr.message : String(costErr), tokensUsed },
        'Failed to record embedding cost (non-fatal)'
      );
    }
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
