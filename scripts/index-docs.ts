/**
 * index-docs.ts
 *
 * Index all markdown docs into pgvector embeddings for the Knowledge Graph.
 *
 * Usage:
 *   tsx scripts/index-docs.ts --docs-path ../HUSTLEXP-DOCS
 *
 * Env vars:
 *   DATABASE_URL   - Postgres connection string
 *   OPENAI_API_KEY - OpenAI API key for embeddings
 *   DOCS_REPO_PATH - Default docs path (overridden by --docs-path)
 */

import pg from 'pg';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

// ============================================================================
// CONFIG
// ============================================================================

function getDocsPath(): string {
  const idx = process.argv.indexOf('--docs-path');
  if (idx !== -1 && process.argv[idx + 1]) {
    return path.resolve(process.argv[idx + 1]);
  }
  return path.resolve(process.env.DOCS_REPO_PATH || '../HustleXP/HUSTLEXP-DOCS');
}

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const BATCH_SIZE = 100;
const MAX_SECTION_LENGTH = 2000;

// ============================================================================
// HELPERS
// ============================================================================

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

interface DocSection {
  filePath: string;
  sectionHeader: string;
  content: string;
  isLocked: boolean;
}

function splitIntoSections(filePath: string, rawContent: string): DocSection[] {
  const relativePath = filePath;
  const isLockedFile = path.basename(filePath).includes('LOCKED') || rawContent.includes('LOCKED');
  const sections: DocSection[] = [];

  // Split by ## headers
  const h2Parts = rawContent.split(/^## /m);

  // First part before any ## header
  if (h2Parts[0].trim()) {
    sections.push({
      filePath: relativePath,
      sectionHeader: 'intro',
      content: h2Parts[0].trim(),
      isLocked: isLockedFile,
    });
  }

  for (let i = 1; i < h2Parts.length; i++) {
    const lines = h2Parts[i].split('\n');
    const header = lines[0].trim();
    const body = lines.slice(1).join('\n').trim();
    const fullContent = `## ${header}\n${body}`;

    if (fullContent.length <= MAX_SECTION_LENGTH) {
      sections.push({
        filePath: relativePath,
        sectionHeader: header,
        content: fullContent,
        isLocked: isLockedFile,
      });
    } else {
      // Split further by ### headers
      const h3Parts = fullContent.split(/^### /m);

      if (h3Parts[0].trim()) {
        sections.push({
          filePath: relativePath,
          sectionHeader: header,
          content: h3Parts[0].trim(),
          isLocked: isLockedFile,
        });
      }

      for (let j = 1; j < h3Parts.length; j++) {
        const h3Lines = h3Parts[j].split('\n');
        const h3Header = h3Lines[0].trim();
        const h3Body = h3Lines.slice(1).join('\n').trim();
        sections.push({
          filePath: relativePath,
          sectionHeader: `${header} > ${h3Header}`,
          content: `### ${h3Header}\n${h3Body}`,
          isLocked: isLockedFile,
        });
      }
    }
  }

  // If no sections were created (no ## headers), treat the whole file as one section
  if (sections.length === 0 && rawContent.trim()) {
    sections.push({
      filePath: relativePath,
      sectionHeader: 'full',
      content: rawContent.trim(),
      isLocked: isLockedFile,
    });
  }

  return sections;
}

async function generateEmbeddings(
  openai: OpenAI,
  texts: string[]
): Promise<number[][]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data.map((d) => d.embedding);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const docsPath = getDocsPath();

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL env var is required');
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY env var is required');
    process.exit(1);
  }

  console.log(`Docs path: ${docsPath}`);

  if (!fs.existsSync(docsPath)) {
    console.error(`ERROR: Docs path does not exist: ${docsPath}`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Find all markdown files
  const mdFiles = findMarkdownFiles(docsPath);
  console.log(`Found ${mdFiles.length} markdown files`);

  // Parse all sections
  const allSections: DocSection[] = [];
  for (const file of mdFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const relativePath = path.relative(docsPath, file);
    const sections = splitIntoSections(relativePath, content);
    allSections.push(...sections);
  }
  console.log(`Parsed ${allSections.length} sections`);

  // Generate embeddings in batches
  let embeddingsGenerated = 0;
  for (let i = 0; i < allSections.length; i += BATCH_SIZE) {
    const batch = allSections.slice(i, i + BATCH_SIZE);
    const texts = batch.map((s) => s.content);

    console.log(`Generating embeddings for batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allSections.length / BATCH_SIZE)}...`);
    const embeddings = await generateEmbeddings(openai, texts);

    // Upsert into database
    for (let j = 0; j < batch.length; j++) {
      const section = batch[j];
      const embedding = embeddings[j];
      const vectorStr = `[${embedding.join(',')}]`;

      await pool.query(
        `INSERT INTO doc_embeddings (file_path, section_header, content, embedding, is_locked, updated_at)
         VALUES ($1, $2, $3, $4::vector, $5, NOW())
         ON CONFLICT (file_path, section_header) DO UPDATE SET
           content = EXCLUDED.content,
           embedding = EXCLUDED.embedding,
           is_locked = EXCLUDED.is_locked,
           updated_at = NOW()`,
        [section.filePath, section.sectionHeader, section.content, vectorStr, section.isLocked]
      );
    }

    embeddingsGenerated += embeddings.length;
  }

  console.log('---');
  console.log(`${mdFiles.length} files scanned`);
  console.log(`${allSections.length} sections indexed`);
  console.log(`${embeddingsGenerated} embeddings generated`);

  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
