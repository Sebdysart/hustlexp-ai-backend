/**
 * AI Task Completeness Gate Test
 * 
 * Tests gate behavior with intentionally incomplete tasks.
 */

import { db } from '../backend/src/db';
import { InstantTaskGate } from '../backend/src/services/InstantTaskGate';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

interface TestCase {
  name: string;
  task: {
    title: string;
    description: string;
    location?: string;
    requirements?: string;
    deadline?: Date;
    category?: string;
  };
  expectedBlock: boolean;
  expectedFields?: string[];
}

const testCases: TestCase[] = [
  // Missing location (3 tests)
  {
    name: 'Missing location - delivery',
    task: {
      title: 'Deliver package',
      description: 'Need someone to deliver a package to downtown Seattle. Should take about 30 minutes.',
      category: 'delivery',
    },
    expectedBlock: true,
    expectedFields: ['location'],
  },
  {
    name: 'Missing location - cleaning',
    task: {
      title: 'Clean apartment',
      description: 'Need apartment cleaned. 2 bedrooms, 1 bathroom. Should take 2-3 hours.',
      category: 'cleaning',
    },
    expectedBlock: true,
    expectedFields: ['location'],
  },
  {
    name: 'Missing location - moving',
    task: {
      title: 'Move furniture',
      description: 'Help move a couch from my place. Need 2 people.',
      category: 'moving',
    },
    expectedBlock: true,
    expectedFields: ['location'],
  },
  
  // Missing access instructions (2 tests)
  {
    name: 'Missing access - apartment building',
    task: {
      title: 'Deliver groceries',
      description: 'Deliver groceries to my apartment building. I live on the 3rd floor.',
      location: '123 Main St, Seattle, WA',
      category: 'delivery',
    },
    expectedBlock: true,
    expectedFields: ['access_instructions'],
  },
  {
    name: 'Missing access - home delivery',
    task: {
      title: 'Package pickup',
      description: 'Pick up a package from my house. It will be on the front porch.',
      location: '456 Oak Ave, Seattle, WA',
      category: 'delivery',
    },
    expectedBlock: true,
    expectedFields: ['access_instructions'],
  },
  
  // Vague description (2 tests)
  {
    name: 'Vague description - move stuff',
    task: {
      title: 'Help me move',
      description: 'Help me move stuff',
      location: '789 Pine St, Seattle, WA',
      category: 'moving',
    },
    expectedBlock: true,
    expectedFields: ['description', 'quantity'],
  },
  {
    name: 'Vague description - help needed',
    task: {
      title: 'Need help',
      description: 'I need some help with a task',
      location: '321 Elm St, Seattle, WA',
      category: 'errands',
    },
    expectedBlock: true,
    expectedFields: ['description'],
  },
  
  // Missing quantity/dimensions (2 tests)
  {
    name: 'Missing quantity - move items',
    task: {
      title: 'Move boxes',
      description: 'Need help moving boxes from my apartment to storage unit. Should take a few hours.',
      location: '654 Maple Dr, Seattle, WA',
      category: 'moving',
    },
    expectedBlock: true,
    expectedFields: ['quantity'],
  },
  {
    name: 'Missing quantity - deliver items',
    task: {
      title: 'Deliver packages',
      description: 'Deliver several packages around downtown. You will need a car.',
      location: '987 Cedar Ln, Seattle, WA',
      category: 'delivery',
    },
    expectedBlock: true,
    expectedFields: ['quantity'],
  },
  
  // Missing success criteria (1 test)
  {
    name: 'Missing success criteria - vague completion',
    task: {
      title: 'Organize garage',
      description: 'Organize my garage',
      location: '147 Birch Way, Seattle, WA',
      category: 'errands',
    },
    expectedBlock: true,
    expectedFields: ['success_criteria'],
  },
];

async function testGate() {
  console.log('🧪 Testing AI Task Completeness Gate\n');
  console.log(`Testing ${testCases.length} intentionally incomplete tasks...\n`);

  let blockedCount = 0;
  let passedCount = 0;
  let totalQuestions = 0;
  let falseNegatives = 0;

  const results: Array<{
    name: string;
    blocked: boolean;
    questions: number;
    fields: string[];
    isFalseNegative: boolean;
  }> = [];

  for (const testCase of testCases) {
    const gateResult = await InstantTaskGate.check(testCase.task);
    
    const blocked = !gateResult.instantEligible;
    const questions = gateResult.questions.length;
    const fields = gateResult.blockReason ? [gateResult.blockReason] : [];
    
    // Check for false negative: expected to block but passed
    const isFalseNegative = testCase.expectedBlock && !blocked;
    
    if (blocked) {
      blockedCount++;
      totalQuestions += questions;
    } else {
      passedCount++;
      if (isFalseNegative) {
        falseNegatives++;
      }
    }

    results.push({
      name: testCase.name,
      blocked,
      questions,
      fields,
      isFalseNegative,
    });

    const status = blocked ? '❌ BLOCKED' : '✅ PASSED';
    const falseNegMarker = isFalseNegative ? ' ⚠️ FALSE NEGATIVE' : '';
    console.log(`${status} ${testCase.name}${falseNegMarker}`);
    if (blocked) {
      console.log(`   Missing: ${fields.join(', ')} (${questions} question${questions !== 1 ? 's' : ''})`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('📊 RESULTS');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const total = testCases.length;
  const blockRate = Math.round((blockedCount / total) * 100);
  const avgQuestions = blockedCount > 0 ? (totalQuestions / blockedCount).toFixed(1) : '0';

  console.log(`Total attempts: ${total}`);
  console.log(`Blocked: ${blockedCount}`);
  console.log(`Passed: ${passedCount}`);
  console.log(`\nInstant block rate: ${blockRate}%`);
  console.log(`Average questions asked: ${avgQuestions}`);
  console.log(`False negatives: ${falseNegatives}\n`);

  // Check acceptance criteria
  const blockRateOk = blockRate >= 20 && blockRate <= 40;
  const avgQuestionsOk = parseFloat(avgQuestions) <= 3;
  const falseNegativesOk = falseNegatives === 0;

  console.log('Acceptance Criteria:');
  console.log(`  Block rate 20-40%: ${blockRateOk ? '✅' : '❌'} (${blockRate}%)`);
  console.log(`  Avg questions ≤ 3: ${avgQuestionsOk ? '✅' : '❌'} (${avgQuestions})`);
  console.log(`  False negatives = 0: ${falseNegativesOk ? '✅' : '❌'} (${falseNegatives})\n`);

  const allPass = blockRateOk && avgQuestionsOk && falseNegativesOk;
  console.log(`Overall: ${allPass ? '✅ PASS' : '❌ FAIL'}\n`);

  // Output in strict format
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('REPORT (Strict Format):');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`Instant block rate: ${blockRate}%`);
  console.log(`Average questions asked: ${avgQuestions}`);
  console.log(`False negatives: ${falseNegatives}`);

  process.exit(allPass ? 0 : 1);
}

testGate().catch(e => {
  console.error('❌ Test failed:', e);
  process.exit(1);
});
