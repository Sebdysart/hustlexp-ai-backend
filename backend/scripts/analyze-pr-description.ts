/**
 * PR Description Analyzer v1.0.0
 *
 * Compares PR description intent against actual file changes.
 * Flags mismatches:
 * - Description mentions escrow but no escrow files changed
 * - Changed files not mentioned in description
 *
 * @see .github/workflows/orchestrator.yml (context job)
 */

import fs from 'fs';
import { execSync } from 'child_process';
import { IntentParserService } from '../src/services/IntentParserService';

interface PRDescriptionAnalysis {
  description: string;
  intent: any;
  changedFiles: string[];
  mismatches: string[];
  warnings: string[];
}

/**
 * Get PR description from GitHub event
 */
function getPRDescription(): string {
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) {
      return '';
    }

    const event = JSON.parse(fs.readFileSync(eventPath, 'utf-8'));
    return event.pull_request?.body || '';
  } catch (error) {
    console.error('Failed to read PR description:', error);
    return '';
  }
}

/**
 * Get changed files
 */
function getChangedFiles(): string[] {
  try {
    const baseBranch = process.env.GITHUB_BASE_REF || 'main';
    const headBranch = process.env.GITHUB_HEAD_REF || 'HEAD';

    const diffCommand = process.env.CI
      ? `git diff --name-only origin/${baseBranch}...${headBranch}`
      : `git diff --name-only main...HEAD`;

    const output = execSync(diffCommand, { encoding: 'utf-8' });
    return output.trim().split('\n').filter(Boolean);
  } catch (error) {
    console.error('Failed to get changed files:', error);
    return [];
  }
}

/**
 * Analyze PR description vs actual changes
 */
async function analyzePR(): Promise<PRDescriptionAnalysis> {
  const description = getPRDescription();
  const changedFiles = getChangedFiles();

  const mismatches: string[] = [];
  const warnings: string[] = [];

  if (!description) {
    warnings.push('No PR description provided');
    return { description, intent: null, changedFiles, mismatches, warnings };
  }

  // Analyze intent
  const intentResult = await IntentParserService.analyzeIntent(description);

  if (!intentResult.success) {
    warnings.push('Intent analysis failed - skipping validation');
    return { description, intent: null, changedFiles, mismatches, warnings };
  }

  const intent = intentResult.data!;

  // Check if mentioned services were actually changed
  intent.affectedServices.forEach(service => {
    const serviceFile = `backend/src/services/${service}.ts`;
    if (!changedFiles.includes(serviceFile)) {
      mismatches.push(`Description mentions ${service} but ${serviceFile} was not changed`);
    }
  });

  // Check if mentioned routers were actually changed
  intent.affectedRouters.forEach(router => {
    const routerFile = `backend/src/routers/${router}.ts`;
    if (!changedFiles.includes(routerFile)) {
      mismatches.push(`Description mentions ${router} router but ${routerFile} was not changed`);
    }
  });

  // Check if critical files were changed but not mentioned
  const criticalChanges = changedFiles.filter(f =>
    f.includes('EscrowService') ||
    f.includes('PaymentService') ||
    f.includes('LedgerService') ||
    f.includes('migrations/')
  );

  criticalChanges.forEach(file => {
    const serviceName = file.match(/\/(\w+Service)\.ts$/)?.[1];
    if (serviceName && !intent.affectedServices.includes(serviceName)) {
      mismatches.push(`Critical file ${file} changed but not mentioned in description`);
    }
  });

  return {
    description,
    intent,
    changedFiles,
    mismatches,
    warnings,
  };
}

/**
 * CLI entry point
 */
async function main() {
  console.log('===== PR DESCRIPTION ANALYSIS =====\n');

  const analysis = await analyzePR();

  if (analysis.warnings.length > 0) {
    console.log('⚠️  Warnings:');
    analysis.warnings.forEach(w => console.log(`  - ${w}`));
    console.log();
  }

  if (analysis.intent) {
    console.log('🎯 Intent Analysis:');
    console.log(`  Suggested Tier: ${analysis.intent.suggestedTier}`);
    console.log(`  Risk: ${analysis.intent.riskAssessment}`);
    console.log(`  Services: ${analysis.intent.affectedServices.join(', ') || 'none'}`);
    console.log(`  Routers: ${analysis.intent.affectedRouters.join(', ') || 'none'}`);
    console.log();
  }

  console.log(`📁 Changed Files: ${analysis.changedFiles.length}`);
  console.log();

  if (analysis.mismatches.length > 0) {
    console.log('❌ Intent Mismatches:');
    analysis.mismatches.forEach(m => console.log(`  - ${m}`));
    console.log();
    console.log('💡 Tip: Update PR description to accurately reflect changes\n');
  } else if (analysis.intent) {
    console.log('✅ Intent matches changes\n');
  }

  // Write markdown report
  let markdown = '## 🎯 PR Intent Analysis\n\n';

  if (analysis.intent) {
    markdown += `**Suggested Tier:** ${analysis.intent.suggestedTier.toUpperCase()}\n`;
    markdown += `**Risk Assessment:** ${analysis.intent.riskAssessment}\n\n`;

    if (analysis.intent.affectedServices.length > 0) {
      markdown += `**Affected Services:** ${analysis.intent.affectedServices.join(', ')}\n`;
    }
    if (analysis.intent.affectedRouters.length > 0) {
      markdown += `**Affected Routers:** ${analysis.intent.affectedRouters.join(', ')}\n`;
    }
    markdown += '\n';
  }

  if (analysis.mismatches.length > 0) {
    markdown += '### ⚠️ Intent Mismatches\n\n';
    analysis.mismatches.forEach(m => {
      markdown += `- ${m}\n`;
    });
    markdown += '\n';
  } else if (analysis.intent) {
    markdown += '✅ **Intent matches changes**\n\n';
  }

  fs.writeFileSync('pr-intent-analysis.md', markdown);
  console.log('Report saved to: pr-intent-analysis.md');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('PR analysis error:', err);
      process.exit(1);
    });
}
