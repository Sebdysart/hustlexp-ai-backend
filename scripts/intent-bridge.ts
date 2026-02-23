#!/usr/bin/env tsx
/**
 * Intent Bridge CLI v1.0.0
 *
 * Natural language intent analysis for HustleXP changes.
 *
 * Usage:
 *   npx tsx scripts/intent-bridge.ts "Add timezone tracking to task creation"
 *   echo "Refactor escrow release flow" | npx tsx scripts/intent-bridge.ts
 *
 * Outputs formatted markdown analysis to stdout.
 *
 * @see backend/src/services/IntentParserService.ts
 */

import { IntentParserService } from '../backend/src/services/IntentParserService';
import type { IntentAnalysis } from '../backend/src/services/IntentParserService';

// ============================================================================
// TIER DISPLAY
// ============================================================================

const TIER_LABELS: Record<string, string> = {
  trivial: 'Tier 0 (TRIVIAL) — Merge threshold: auto-merge',
  standard: 'Tier 1 (STANDARD) — Merge threshold: 80/100',
  critical: 'Tier 2 (CRITICAL) — Merge threshold: 95/100',
  architectural: 'Tier 3 (ARCHITECTURAL) — Merge threshold: 100/100 + 2 reviewers',
};

// ============================================================================
// FORMATTING
// ============================================================================

function formatAnalysis(analysis: IntentAnalysis): string {
  const lines: string[] = [];

  lines.push('## Intent Analysis\n');
  lines.push(`**Query:** ${analysis.query}\n`);

  // Invariants
  if (analysis.affectedInvariants.length > 0) {
    lines.push('### Affected Invariants');
    for (const inv of analysis.affectedInvariants) {
      lines.push(`- ${inv}`);
    }
    lines.push('');
  }

  // Services
  if (analysis.affectedServices.length > 0) {
    lines.push('### Affected Services');
    for (const svc of analysis.affectedServices) {
      const kebab = svc
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .toLowerCase();
      // Not all services follow the exact same naming; best-effort path
      lines.push(`- ${svc} (backend/src/services/${svc}.ts)`);
    }
    lines.push('');
  }

  // Routers
  if (analysis.affectedRouters.length > 0) {
    lines.push('### Affected Routers');
    for (const rtr of analysis.affectedRouters) {
      lines.push(`- ${rtr} (backend/src/routers/${rtr}.ts)`);
    }
    lines.push('');
  }

  // Suggested test files
  if (analysis.suggestedTestFiles.length > 0) {
    lines.push('### Suggested Test Files');
    for (const tf of analysis.suggestedTestFiles) {
      lines.push(`- ${tf}`);
    }
    lines.push('');
  }

  // Risk assessment
  lines.push('### Risk Assessment');
  lines.push(`${analysis.suggestedTier} — ${analysis.riskAssessment}\n`);

  // Related docs
  if (analysis.relatedDocs.length > 0) {
    lines.push('### Related Documentation');
    analysis.relatedDocs.forEach((doc, i) => {
      lines.push(`${i + 1}. ${doc.filePath} > ${doc.section} (similarity: ${doc.similarity.toFixed(2)})`);
    });
    lines.push('');
  }

  // Classification
  lines.push('### Classification');
  lines.push(TIER_LABELS[analysis.suggestedTier] || `Tier: ${analysis.suggestedTier}`);

  return lines.join('\n');
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  let description: string;

  // Read from args or stdin
  const args = process.argv.slice(2);
  if (args.length > 0) {
    description = args.join(' ');
  } else if (!process.stdin.isTTY) {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    description = Buffer.concat(chunks).toString('utf-8').trim();
  } else {
    console.error('Usage: npx tsx scripts/intent-bridge.ts "description of your change"');
    console.error('   or: echo "description" | npx tsx scripts/intent-bridge.ts');
    process.exit(1);
  }

  if (!description) {
    console.error('Error: Empty description provided.');
    process.exit(1);
  }

  const result = await IntentParserService.analyzeIntent(description);

  if (!result.success) {
    console.error(`Error: ${result.error.message}`);
    process.exit(1);
  }

  console.log(formatAnalysis(result.data));
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
