/**
 * Pipeline Cost Tracker v1.0.0
 *
 * Logs pipeline run metadata for cost optimization analysis.
 * Builds dataset over time to optimize tier thresholds and gate selection.
 *
 * Output: JSON artifact uploaded to GitHub Actions
 */

import fs from 'fs';
import path from 'path';

interface PipelineCostData {
  timestamp: string;
  prNumber: number;
  prTier: number;
  prTierName: string;
  riskScore: number;
  readinessScore: number;
  gatesExecuted: {
    typecheck: boolean;
    lint: boolean;
    tests: boolean;
    invariants: boolean;
    tdad: boolean;
    knowledgeGraph: boolean;
    holodeck: boolean;
    contractValidation: boolean;
    migrationSafety: boolean;
  };
  duration: {
    total: number; // seconds
    typecheck?: number;
    tests?: number;
    holodeck?: number;
  };
  costs: {
    estimatedTotal: number; // USD
    holodeck: number;
    ai: number;
  };
  outcome: 'passed' | 'failed' | 'degraded';
  changedFilesCount: number;
}

/**
 * Calculate estimated costs based on gates executed
 */
function calculateCosts(gatesExecuted: PipelineCostData['gatesExecuted']): PipelineCostData['costs'] {
  const costs = {
    estimatedTotal: 0,
    holodeck: 0,
    ai: 0,
  };

  // Holodeck: ~$0.10 per run (iOS simulator + validation)
  if (gatesExecuted.holodeck) {
    costs.holodeck = 0.10;
  }

  // Knowledge graph AI embeddings: ~$0.02 per run
  if (gatesExecuted.knowledgeGraph) {
    costs.ai += 0.02;
  }

  // TDAD contract validation AI: ~$0.03 per run
  if (gatesExecuted.tdad) {
    costs.ai += 0.03;
  }

  costs.estimatedTotal = costs.holodeck + costs.ai;
  return costs;
}

/**
 * Track pipeline run
 */
export function trackPipelineRun(data: Partial<PipelineCostData>): void {
  const record: PipelineCostData = {
    timestamp: new Date().toISOString(),
    prNumber: data.prNumber || parseInt(process.env.GITHUB_PR_NUMBER || '0'),
    prTier: data.prTier || parseInt(process.env.PR_TIER || '1'),
    prTierName: data.prTierName || process.env.PR_TIER_NAME || 'STANDARD',
    riskScore: data.riskScore || parseInt(process.env.PR_RISK_SCORE || '50'),
    readinessScore: data.readinessScore || parseInt(process.env.READINESS_SCORE || '0'),
    gatesExecuted: data.gatesExecuted || {
      typecheck: process.env.GATE_TYPECHECK === 'true',
      lint: process.env.GATE_LINT === 'true',
      tests: process.env.GATE_TESTS === 'true',
      invariants: process.env.GATE_INVARIANTS === 'true',
      tdad: process.env.GATE_TDAD === 'true',
      knowledgeGraph: process.env.GATE_KNOWLEDGE_GRAPH === 'true',
      holodeck: process.env.GATE_HOLODECK === 'true',
      contractValidation: process.env.GATE_CONTRACT_VALIDATION === 'true',
      migrationSafety: process.env.GATE_MIGRATION_SAFETY === 'true',
    },
    duration: data.duration || {
      total: parseInt(process.env.PIPELINE_DURATION || '0'),
    },
    costs: {
      estimatedTotal: 0,
      holodeck: 0,
      ai: 0,
    },
    outcome: (data.outcome || process.env.PIPELINE_OUTCOME || 'passed') as 'passed' | 'failed' | 'degraded',
    changedFilesCount: data.changedFilesCount || parseInt(process.env.CHANGED_FILES_COUNT || '0'),
  };

  // Calculate costs
  record.costs = calculateCosts(record.gatesExecuted);

  // Write to artifact directory
  const artifactDir = process.env.GITHUB_WORKSPACE
    ? path.join(process.env.GITHUB_WORKSPACE, 'pipeline-artifacts')
    : path.join(process.cwd(), 'pipeline-artifacts');

  if (!fs.existsSync(artifactDir)) {
    fs.mkdirSync(artifactDir, { recursive: true });
  }

  const filename = `pipeline-cost-${record.prNumber}-${Date.now()}.json`;
  const filepath = path.join(artifactDir, filename);

  fs.writeFileSync(filepath, JSON.stringify(record, null, 2));

  console.log(`Pipeline cost data saved to: ${filepath}`);
  console.log(`Estimated cost: $${record.costs.estimatedTotal.toFixed(3)}`);
  console.log(`Gates executed: ${Object.values(record.gatesExecuted).filter(Boolean).length}/9`);
}

/**
 * Analyze historical cost data
 */
export function analyzeCostHistory(artifactDir: string): void {
  const files = fs.readdirSync(artifactDir).filter(f => f.startsWith('pipeline-cost-'));

  if (files.length === 0) {
    console.log('No cost data available yet');
    return;
  }

  const records: PipelineCostData[] = files.map(f => {
    const content = fs.readFileSync(path.join(artifactDir, f), 'utf-8');
    return JSON.parse(content);
  });

  // Group by tier
  const byTier = records.reduce((acc, r) => {
    if (!acc[r.prTierName]) {
      acc[r.prTierName] = [];
    }
    acc[r.prTierName].push(r);
    return acc;
  }, {} as Record<string, PipelineCostData[]>);

  console.log('\n===== PIPELINE COST ANALYSIS =====\n');
  console.log(`Total Runs: ${records.length}`);
  console.log(`Total Cost: $${records.reduce((sum, r) => sum + r.costs.estimatedTotal, 0).toFixed(2)}\n`);

  Object.entries(byTier).forEach(([tier, runs]) => {
    const avgCost = runs.reduce((sum, r) => sum + r.costs.estimatedTotal, 0) / runs.length;
    const avgDuration = runs.reduce((sum, r) => sum + r.duration.total, 0) / runs.length;
    const passRate = runs.filter(r => r.outcome === 'passed').length / runs.length * 100;

    console.log(`${tier}:`);
    console.log(`  Runs: ${runs.length}`);
    console.log(`  Avg Cost: $${avgCost.toFixed(3)}`);
    console.log(`  Avg Duration: ${(avgDuration / 60).toFixed(1)} min`);
    console.log(`  Pass Rate: ${passRate.toFixed(1)}%`);
    console.log();
  });

  // Cost by gate
  const gateCosts = {
    holodeck: records.filter(r => r.gatesExecuted.holodeck).reduce((sum, r) => sum + r.costs.holodeck, 0),
    ai: records.filter(r => r.gatesExecuted.knowledgeGraph || r.gatesExecuted.tdad).reduce((sum, r) => sum + r.costs.ai, 0),
  };

  console.log('Cost by Gate:');
  console.log(`  Holodeck: $${gateCosts.holodeck.toFixed(2)}`);
  console.log(`  AI (Knowledge Graph + TDAD): $${gateCosts.ai.toFixed(2)}`);
}

/**
 * CLI entry point
 */
if (require.main === module) {
  const command = process.argv[2];

  if (command === 'analyze') {
    const artifactDir = process.argv[3] || path.join(process.cwd(), 'pipeline-artifacts');
    analyzeCostHistory(artifactDir);
  } else {
    trackPipelineRun({});
  }
}
