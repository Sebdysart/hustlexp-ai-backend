/**
 * query-docs-for-pr.ts
 *
 * Script for use in GitHub Actions context.
 * Reads CHANGED_FILES env var and queries the Knowledge Graph
 * for affected invariants and specs.
 *
 * Env vars:
 *   DATABASE_URL    - Postgres connection string
 *   OPENAI_API_KEY  - OpenAI API key for embeddings
 *   CHANGED_FILES   - Newline-separated list of changed file paths
 *   GITHUB_OUTPUT   - Path to GitHub Actions output file
 */

import fs from 'fs';
import { KnowledgeGraphService } from '../backend/src/services/KnowledgeGraphService';

// ============================================================================
// HELPERS
// ============================================================================

function extractDomain(filePath: string): string | null {
  // Extract domain from file paths like:
  //   backend/src/services/EscrowService.ts -> escrow
  //   backend/src/routers/taskRouter.ts -> task
  //   backend/src/services/XPTaxService.ts -> xptax
  const serviceMatch = filePath.match(/services\/(\w+?)Service\./i);
  if (serviceMatch) return serviceMatch[1].toLowerCase();

  const routerMatch = filePath.match(/routers\/(\w+?)Router\./i);
  if (routerMatch) return routerMatch[1].toLowerCase();

  const repoMatch = filePath.match(/repositories\/(\w+?)Repository\./i);
  if (repoMatch) return repoMatch[1].toLowerCase();

  return null;
}

function appendGitHubOutput(key: string, value: string) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${key}=${value}\n`);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const changedFiles = (process.env.CHANGED_FILES || '').trim();

  if (!changedFiles) {
    console.log('No changed files provided, skipping.');
    appendGitHubOutput('invariants', '[]');
    appendGitHubOutput('specs', '[]');
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL env var is required');
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY env var is required');
    process.exit(1);
  }

  const files = changedFiles.split('\n').filter(Boolean);
  console.log(`Analyzing ${files.length} changed files...`);

  // Extract unique domains
  const domains = new Set<string>();
  for (const file of files) {
    const domain = extractDomain(file);
    if (domain) {
      domains.add(domain);
      console.log(`  ${file} -> domain: ${domain}`);
    }
  }

  if (domains.size === 0) {
    console.log('No recognizable domains found in changed files.');
    appendGitHubOutput('invariants', '[]');
    appendGitHubOutput('specs', '[]');
    return;
  }

  // Query knowledge graph for each domain
  const invariantIds = new Set<string>();
  const specFiles = new Set<string>();

  for (const domain of domains) {
    console.log(`\nQuerying knowledge graph for domain: ${domain}`);

    const invariants = await KnowledgeGraphService.getRelatedInvariants(domain);
    for (const inv of invariants) {
      // Extract invariant IDs like INV-1, INV-2, etc. from section headers or content
      const idMatches = inv.content.match(/INV-\d+/g);
      if (idMatches) {
        for (const id of idMatches) {
          invariantIds.add(id);
        }
      }
      // Track spec file paths
      if (inv.filePath.includes('spec') || inv.filePath.includes('PER')) {
        specFiles.add(inv.filePath);
      }
    }

    // Also search for general docs about this domain
    const docs = await KnowledgeGraphService.queryDocs(domain, 3);
    for (const doc of docs) {
      if (doc.filePath.includes('spec')) {
        specFiles.add(doc.filePath);
      }
    }
  }

  const invariantsArr = Array.from(invariantIds);
  const specsArr = Array.from(specFiles);

  console.log(`\nAffected invariants: ${JSON.stringify(invariantsArr)}`);
  console.log(`Affected specs: ${JSON.stringify(specsArr)}`);

  appendGitHubOutput('invariants', JSON.stringify(invariantsArr));
  appendGitHubOutput('specs', JSON.stringify(specsArr));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
