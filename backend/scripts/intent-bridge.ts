/**
 * Intent Bridge CLI v1.0.0
 *
 * Natural language → implementation guidance
 *
 * Usage:
 *   npx tsx scripts/intent-bridge.ts "Add timezone tracking to task creation"
 *
 * Output: Affected invariants, specs, services, implementation plan
 */

import { IntentParserService } from '../src/services/IntentParserService';

async function main() {
  const description = process.argv.slice(2).join(' ');

  if (!description) {
    console.error('Usage: npx tsx scripts/intent-bridge.ts "<feature description>"');
    console.error('Example: npx tsx scripts/intent-bridge.ts "Add timezone tracking to task creation"');
    process.exit(1);
  }

  console.log('===== INTENT BRIDGE ANALYSIS =====\n');
  console.log(`Request: ${description}\n`);

  const result = await IntentParserService.analyzeIntent(description);

  if (!result.success) {
    console.error('❌ Analysis failed:', result.error?.message);
    process.exit(1);
  }

  const analysis = result.data!;

  console.log(`📊 Suggested Tier: ${analysis.suggestedTier.toUpperCase()}`);
  console.log(`⚠️  Risk Assessment: ${analysis.riskAssessment}\n`);

  if (analysis.affectedInvariants.length > 0) {
    console.log('🔐 Affected Invariants:');
    analysis.affectedInvariants.forEach(inv => console.log(`  - ${inv}`));
    console.log();
  }

  if (analysis.affectedSpecs.length > 0) {
    console.log('📄 Affected Specs:');
    analysis.affectedSpecs.forEach(spec => console.log(`  - ${spec}`));
    console.log();
  }

  if (analysis.affectedServices.length > 0) {
    console.log('🔧 Affected Services:');
    analysis.affectedServices.forEach(svc => console.log(`  - ${svc}`));
    console.log();
  }

  if (analysis.affectedRouters.length > 0) {
    console.log('🛣️  Affected Routers:');
    analysis.affectedRouters.forEach(router => console.log(`  - ${router}`));
    console.log();
  }

  if (analysis.suggestedTestFiles.length > 0) {
    console.log('🧪 Suggested Test Files:');
    analysis.suggestedTestFiles.forEach(test => console.log(`  - ${test}`));
    console.log();
  }

  if (analysis.implementationPlan.length > 0) {
    console.log('📋 Implementation Plan:');
    analysis.implementationPlan.forEach(step => console.log(`  ${step}`));
    console.log();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Intent bridge error:', err);
      process.exit(1);
    });
}
