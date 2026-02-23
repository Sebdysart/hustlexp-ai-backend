/**
 * KnowledgeGraphService v1.0.0
 *
 * Semantic search over vectorized documentation using pgvector.
 *
 * @see migrations/20260222_007_doc_embeddings.sql
 */

import { db } from '../db';
import OpenAI from 'openai';

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
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

async function generateQueryEmbedding(text: string): Promise<number[]> {
  const openai = getOpenAI();
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
    dimensions: 1536,
  });
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
