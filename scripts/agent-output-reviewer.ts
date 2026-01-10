#!/usr/bin/env tsx
/**
 * Agent Output Reviewer
 * 
 * Helps review and validate agent outputs against coordination guidelines
 * 
 * Usage:
 *   tsx scripts/agent-output-reviewer.ts <agent-id> <output-file>
 */

interface ReviewChecklist {
  backendIntegration: boolean;
  errorHandling: boolean;
  loadingStates: boolean;
  codeStyle: boolean;
  documentation: boolean;
  noHardcodedValues: boolean;
  edgeCases: boolean;
}

interface AgentOutput {
  agentId: string;
  timestamp: string;
  focusArea: string;
  files: string[];
  description: string;
  review?: {
    status: 'pending' | 'approved' | 'needs_revision';
    checklist: ReviewChecklist;
    feedback: string[];
    blockers: string[];
  };
}

async function reviewOutput(agentId: string, outputPath: string): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');
  
  console.log(`\n🔍 Reviewing output from Agent: ${agentId}`);
  console.log(`📁 File: ${outputPath}\n`);
  
  // Read the output
  let content: string;
  try {
    content = await fs.readFile(outputPath, 'utf-8');
  } catch (error) {
    console.error(`❌ Could not read file: ${outputPath}`);
    return;
  }
  
  const review: Partial<AgentOutput['review']> = {
    status: 'pending',
    checklist: {
      backendIntegration: false,
      errorHandling: false,
      loadingStates: false,
      codeStyle: false,
      documentation: false,
      noHardcodedValues: false,
      edgeCases: false,
    },
    feedback: [],
    blockers: [],
  };
  
  // Check for backend integration
  const backendUrl = 'hustlexp-ai-backend-production.up.railway.app';
  const hasBackendIntegration = content.includes(backendUrl) || 
                                 content.includes('/api/') || 
                                 content.includes('/ai/orchestrate');
  
  if (hasBackendIntegration) {
    review.checklist!.backendIntegration = true;
    review.feedback!.push('✅ Backend integration detected');
  } else {
    review.feedback!.push('⚠️  No clear backend integration found - verify API endpoints');
  }
  
  // Check for error handling
  const errorPatterns = [
    /catch\s*\(/i,
    /do\s*\{.*catch/i,
    /error/i,
    /Error/i,
    /try\s*\{/i,
  ];
  const hasErrorHandling = errorPatterns.some(pattern => pattern.test(content));
  
  if (hasErrorHandling) {
    review.checklist!.errorHandling = true;
    review.feedback!.push('✅ Error handling patterns detected');
  } else {
    review.feedback!.push('⚠️  Limited error handling - ensure all async operations have error handling');
  }
  
  // Check for loading states
  const loadingPatterns = [
    /loading/i,
    /isLoading/i,
    /Loading/i,
    /@State.*loading/i,
    /@Published.*loading/i,
  ];
  const hasLoadingStates = loadingPatterns.some(pattern => pattern.test(content));
  
  if (hasLoadingStates) {
    review.checklist!.loadingStates = true;
    review.feedback!.push('✅ Loading states detected');
  } else {
    review.feedback!.push('⚠️  No loading states found - add loading indicators for async operations');
  }
  
  // Check for hardcoded values
  const hardcodedPatterns = [
    /https?:\/\/[^"'\s]+/g,
    /localhost:\d+/,
    /127\.0\.0\.1/,
  ];
  const hardcodedMatches = content.match(hardcodedPatterns.join('|'));
  
  if (!hardcodedMatches || hardcodedMatches.length === 0) {
    review.checklist!.noHardcodedValues = true;
    review.feedback!.push('✅ No hardcoded URLs detected');
  } else {
    review.feedback!.push(`⚠️  Found potential hardcoded values: ${hardcodedMatches.slice(0, 3).join(', ')}`);
  }
  
  // Check for documentation
  const docPatterns = [
    /\/\/.*[A-Z]/,
    /\/\*\*/,
    /MARK:/,
    /TODO:/,
  ];
  const hasDocumentation = docPatterns.some(pattern => pattern.test(content));
  
  if (hasDocumentation) {
    review.checklist!.documentation = true;
    review.feedback!.push('✅ Documentation/comments found');
  } else {
    review.feedback!.push('💡 Consider adding documentation for complex logic');
  }
  
  // Determine overall status
  const checksPassed = Object.values(review.checklist!).filter(Boolean).length;
  const totalChecks = Object.keys(review.checklist!).length;
  
  if (checksPassed >= totalChecks * 0.7) {
    review.status = 'approved';
  } else if (review.blockers!.length > 0) {
    review.status = 'needs_revision';
  }
  
  // Print review
  console.log('📋 Review Results:');
  console.log('─'.repeat(50));
  console.log(`Status: ${review.status?.toUpperCase()}`);
  console.log(`Checks Passed: ${checksPassed}/${totalChecks}\n`);
  
  console.log('Checklist:');
  Object.entries(review.checklist!).forEach(([key, value]) => {
    const icon = value ? '✅' : '❌';
    const label = key.replace(/([A-Z])/g, ' $1').trim();
    console.log(`  ${icon} ${label}`);
  });
  
  console.log('\nFeedback:');
  review.feedback!.forEach(f => console.log(`  ${f}`));
  
  if (review.blockers!.length > 0) {
    console.log('\n🚨 Blockers:');
    review.blockers!.forEach(b => console.log(`  ❌ ${b}`));
  }
  
  console.log('\n' + '─'.repeat(50));
  
  // Save review to file
  const reviewPath = path.join('agent-reviews', `${agentId}-${Date.now()}.json`);
  await fs.mkdir('agent-reviews', { recursive: true });
  await fs.writeFile(reviewPath, JSON.stringify({
    agentId,
    timestamp: new Date().toISOString(),
    review,
  }, null, 2));
  
  console.log(`\n💾 Review saved to: ${reviewPath}`);
}

async function main() {
  const agentId = process.argv[2];
  const outputPath = process.argv[3];
  
  if (!agentId || !outputPath) {
    console.error('Usage: tsx scripts/agent-output-reviewer.ts <agent-id> <output-file>');
    process.exit(1);
  }
  
  await reviewOutput(agentId, outputPath);
}

main();
