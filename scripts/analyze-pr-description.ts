#!/usr/bin/env tsx
/**
 * PR Description Analyzer v1.0.0
 *
 * Reads a PR description and compares developer intent against actual
 * changed files. Flags mismatches to help reviewers catch scope drift.
 *
 * Input sources (checked in order):
 * 1. GITHUB_EVENT_PATH env var (GitHub Actions event JSON → pull_request.body)
 * 2. PR_DESCRIPTION env var (for local testing)
 * 3. stdin
 *
 * Changed files source:
 * 1. CHANGED_FILES env var (comma-separated)
 * 2. git diff --name-only origin/main...HEAD
 *
 * @see backend/src/services/IntentParserService.ts
 */

import { IntentParserService } from '../backend/src/services/IntentParserService';
import { readFile } from 'fs/promises';
import { execSync } from 'child_process';

// ============================================================================
// SERVICE / ROUTER → FILE PATH MAPPING
// ============================================================================

function serviceToFilePaths(serviceName: string): string[] {
  return [
    `backend/src/services/${serviceName}.ts`,
  ];
}

function routerToFilePaths(routerName: string): string[] {
  return [
    `backend/src/routers/${routerName}.ts`,
  ];
}

function filePathToDomain(filePath: string): string | null {
  // Extract service name from path
  const serviceMatch = filePath.match(/backend\/src\/services\/(\w+)\.ts$/);
  if (serviceMatch) return serviceMatch[1];

  // Extract router name from path
  const routerMatch = filePath.match(/backend\/src\/routers\/(\w+)\.ts$/);
  if (routerMatch) return routerMatch[1];

  // Extract test name from path
  const testMatch = filePath.match(/backend\/tests\/.*\/(\w+)\.test\.ts$/);
  if (testMatch) return testMatch[1];

  return null;
}

// ============================================================================
// INPUT READING
// ============================================================================

async function getPRDescription(): Promise<string> {
  // 1. GitHub Actions event JSON
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      const raw = await readFile(eventPath, 'utf-8');
      const event = JSON.parse(raw);
      if (event.pull_request?.body) {
        return event.pull_request.body;
      }
    } catch {
      // Fall through
    }
  }

  // 2. PR_DESCRIPTION env var
  if (process.env.PR_DESCRIPTION) {
    return process.env.PR_DESCRIPTION;
  }

  // 3. stdin
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf-8').trim();
  }

  return '';
}

function getChangedFiles(): string[] {
  // 1. CHANGED_FILES env var
  if (process.env.CHANGED_FILES) {
    return process.env.CHANGED_FILES.split(',').map((f) => f.trim()).filter(Boolean);
  }

  // 2. git diff
  try {
    const output = execSync('git diff --name-only origin/main...HEAD', {
      encoding: 'utf-8',
      timeout: 10000,
    });
    return output.split('\n').map((f) => f.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================================================
// MISMATCH DETECTION
// ============================================================================

interface MismatchReport {
  mismatches: string[];
  analysis: Awaited<ReturnType<typeof IntentParserService.analyzeIntent>> extends { success: true; data: infer T } ? T : never;
}

async function compareIntentToChanges(description: string, changedFiles: string[]): Promise<MismatchReport | null> {
  const result = await IntentParserService.analyzeIntent(description);
  if (!result.success) return null;

  const analysis = result.data;
  const mismatches: string[] = [];

  // Check: intent mentions services that don't have changed files
  for (const svc of analysis.affectedServices) {
    const expectedPaths = serviceToFilePaths(svc);
    const found = expectedPaths.some((p) => changedFiles.some((cf) => cf.includes(p)));
    if (!found) {
      mismatches.push(`Description mentions ${svc} but no changes found in its files`);
    }
  }

  // Check: intent mentions routers that don't have changed files
  for (const rtr of analysis.affectedRouters) {
    const expectedPaths = routerToFilePaths(rtr);
    const found = expectedPaths.some((p) => changedFiles.some((cf) => cf.includes(p)));
    if (!found) {
      mismatches.push(`Description mentions router "${rtr}" but no changes found in ${expectedPaths.join(', ')}`);
    }
  }

  // Check: changed service/router files not mentioned in description
  for (const file of changedFiles) {
    const domain = filePathToDomain(file);
    if (!domain) continue;

    // Skip test files, configs, scripts
    if (file.includes('test') || file.includes('config') || file.includes('script')) continue;

    const mentionedInServices = analysis.affectedServices.some((s) =>
      s.toLowerCase().includes(domain.toLowerCase()) || domain.toLowerCase().includes(s.toLowerCase())
    );
    const mentionedInRouters = analysis.affectedRouters.some((r) =>
      r.toLowerCase() === domain.toLowerCase()
    );

    if (!mentionedInServices && !mentionedInRouters) {
      mismatches.push(`Changed ${file} but description doesn't mention "${domain}" domain`);
    }
  }

  return { mismatches, analysis };
}

// ============================================================================
// OUTPUT
// ============================================================================

function formatReport(report: MismatchReport, changedFiles: string[]): string {
  const lines: string[] = [];

  lines.push('## PR Description Analysis\n');
  lines.push(`**Intent:** ${report.analysis.query.slice(0, 200)}${report.analysis.query.length > 200 ? '...' : ''}\n`);
  lines.push(`**Tier:** ${report.analysis.suggestedTier.toUpperCase()}`);
  lines.push(`**Risk:** ${report.analysis.riskAssessment}\n`);

  lines.push(`### Changed Files (${changedFiles.length})`);
  for (const f of changedFiles.slice(0, 20)) {
    lines.push(`- ${f}`);
  }
  if (changedFiles.length > 20) {
    lines.push(`- ... and ${changedFiles.length - 20} more`);
  }
  lines.push('');

  if (report.mismatches.length > 0) {
    lines.push('### Mismatches Found');
    for (const m of report.mismatches) {
      lines.push(`- ${m}`);
    }
    lines.push('');
  } else {
    lines.push('### No Mismatches');
    lines.push('Description appears aligned with changed files.\n');
  }

  if (report.analysis.affectedInvariants.length > 0) {
    lines.push('### Affected Invariants');
    for (const inv of report.analysis.affectedInvariants) {
      lines.push(`- ${inv}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  const description = await getPRDescription();
  if (!description) {
    console.error('No PR description found. Set GITHUB_EVENT_PATH, PR_DESCRIPTION env var, or pipe via stdin.');
    process.exit(1);
  }

  const changedFiles = getChangedFiles();
  if (changedFiles.length === 0) {
    console.error('Warning: No changed files detected. Set CHANGED_FILES env var or ensure git origin/main is available.');
  }

  const report = await compareIntentToChanges(description, changedFiles);
  if (!report) {
    console.error('Failed to analyze intent.');
    process.exit(1);
  }

  console.log(formatReport(report, changedFiles));
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
