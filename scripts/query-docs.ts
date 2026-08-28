/**
 * query-docs.ts
 *
 * CLI tool to query the Knowledge Graph.
 *
 * Usage:
 *   tsx scripts/query-docs.ts "How does escrow release work?"
 *
 * Env vars:
 *   DATABASE_URL   - Postgres connection string
 *   OPENAI_API_KEY - OpenAI API key for embeddings
 */

import { KnowledgeGraphService } from '../backend/src/services/KnowledgeGraphService';

async function main() {
  const query = process.argv[2];

  if (!query) {
    console.error('Usage: tsx scripts/query-docs.ts "your query here"');
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL env var is required');
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY env var is required');
    process.exit(1);
  }

  console.log(`Query: "${query}"\n`);

  const results = await KnowledgeGraphService.queryDocs(query);

  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  for (const result of results) {
    const locked = result.isLocked ? ' [LOCKED]' : '';
    console.log(`--- ${result.filePath} > ${result.sectionHeader}${locked}`);
    console.log(`    Similarity: ${result.similarity.toFixed(4)}`);
    console.log(`    ${result.content.slice(0, 200).replace(/\n/g, ' ')}...`);
    console.log();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
