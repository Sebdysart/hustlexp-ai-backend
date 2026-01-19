/**
 * AI Task Completeness Gate Test - Realistic Tasks
 * 
 * Tests gate behavior with realistic user task attempts.
 * Target: 20-40% block rate
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
}

const testCases: TestCase[] = [
  // Perfect tasks (should pass)
  {
    name: 'Perfect - detailed delivery',
    task: {
      title: 'Deliver groceries',
      description: 'Deliver 3 bags of groceries to 123 Main St, Apt 4B, Seattle, WA 98101. Use door code 1234 to enter building. Leave bags at apartment door. Should take about 20 minutes.',
      location: '123 Main St, Seattle, WA 98101',
      category: 'delivery',
    },
  },
  {
    name: 'Perfect - moving with details',
    task: {
      title: 'Move furniture',
      description: 'Move 2 couches and 1 coffee table from 456 Oak Ave, Seattle to 789 Pine St storage unit. I will meet you at the apartment at 2pm. Storage unit code is 5678. Should take 2-3 hours.',
      location: '456 Oak Ave, Seattle, WA',
      category: 'moving',
    },
  },
  {
    name: 'Perfect - cleaning task',
    task: {
      title: 'Deep clean apartment',
      description: 'Deep clean my 2-bedroom apartment at 321 Elm St, Unit 5, Seattle. Clean all rooms, bathrooms, kitchen, and vacuum carpets. Task is complete when all surfaces are clean and floors are vacuumed. Access via front door code 9876.',
      location: '321 Elm St, Seattle, WA',
      category: 'cleaning',
    },
  },
  
  // Good tasks (should pass - minor imperfections)
  {
    name: 'Good - delivery with porch',
    task: {
      title: 'Package pickup',
      description: 'Pick up a package from my house at 654 Maple Dr, Seattle. Package will be on the front porch. Should take 10 minutes.',
      location: '654 Maple Dr, Seattle, WA',
      category: 'delivery',
    },
  },
  {
    name: 'Good - moving with time estimate',
    task: {
      title: 'Move boxes',
      description: 'Help move 5 boxes from my apartment at 987 Cedar Ln to my storage unit at 147 Birch Way. I will be there to let you in. Should take about 1 hour.',
      location: '987 Cedar Ln, Seattle, WA',
      category: 'moving',
    },
  },
  {
    name: 'Good - errand task',
    task: {
      title: 'Pick up dry cleaning',
      description: 'Pick up dry cleaning from Cleaners Plus at 258 Spruce Ave, Seattle and deliver to my office at 369 Willow St. Office is open 9am-5pm. Should take 30 minutes.',
      location: '258 Spruce Ave, Seattle, WA',
      category: 'errands',
    },
  },
  
  // Sloppy but executable (should pass - real users are imperfect)
  {
    name: 'Sloppy - missing some detail but executable',
    task: {
      title: 'Help with yard work',
      description: 'Need help mowing the lawn and trimming bushes at my house. Address is 741 Aspen St, Seattle. I will be home to let you in. Should take 2 hours.',
      location: '741 Aspen St, Seattle, WA',
      category: 'errands',
    },
  },
  {
    name: 'Sloppy - vague but has location',
    task: {
      title: 'Assemble furniture',
      description: 'Assemble a bookshelf I bought. It is at my apartment at 852 Poplar Dr, Seattle. I will be there. Should take about 1 hour.',
      location: '852 Poplar Dr, Seattle, WA',
      category: 'errands',
    },
  },
  
  // Ambiguous (should block)
  {
    name: 'Ambiguous - missing location',
    task: {
      title: 'Deliver package',
      description: 'Need someone to deliver a package to downtown Seattle. Should take about 30 minutes.',
      category: 'delivery',
    },
  },
  {
    name: 'Ambiguous - vague description',
    task: {
      title: 'Need help',
      description: 'I need some help with a task around my house.',
      location: '123 Main St, Seattle, WA',
      category: 'errands',
    },
  },
];

async function testGate() {
  console.log('🧪 Testing AI Task Completeness Gate - Realistic Tasks\n');
  console.log(`Testing ${testCases.length} realistic task attempts...\n`);

  let blockedCount = 0;
  let passedCount = 0;
  let totalQuestions = 0;

  const results: Array<{
    name: string;
    blocked: boolean;
    questions: number;
  }> = [];

  for (const testCase of testCases) {
    const gateResult = await InstantTaskGate.check(testCase.task);
    
    const blocked = !gateResult.instantEligible;
    const questions = gateResult.questions.length;
    
    if (blocked) {
      blockedCount++;
      totalQuestions += questions;
    } else {
      passedCount++;
    }

    results.push({
      name: testCase.name,
      blocked,
      questions,
    });

    const status = blocked ? '❌ BLOCKED' : '✅ PASSED';
    console.log(`${status} ${testCase.name}`);
    if (blocked) {
      console.log(`   Questions: ${gateResult.questions.join('; ')} (${questions} question${questions !== 1 ? 's' : ''})`);
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
  console.log(`Average questions asked: ${avgQuestions}\n`);

  // Check acceptance criteria
  const blockRateOk = blockRate >= 20 && blockRate <= 40;
  const avgQuestionsOk = parseFloat(avgQuestions) <= 3;

  console.log('Acceptance Criteria:');
  console.log(`  Block rate 20-40%: ${blockRateOk ? '✅' : '❌'} (${blockRate}%)`);
  console.log(`  Avg questions ≤ 3: ${avgQuestionsOk ? '✅' : '❌'} (${avgQuestions})\n`);

  const allPass = blockRateOk && avgQuestionsOk;
  console.log(`Overall: ${allPass ? '✅ PASS' : '❌ FAIL'}\n`);

  // Output in strict format
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('REPORT (Strict Format):');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`Realistic tasks — Instant block rate: ${blockRate}%`);

  process.exit(allPass ? 0 : 1);
}

testGate().catch(e => {
  console.error('❌ Test failed:', e);
  process.exit(1);
});
