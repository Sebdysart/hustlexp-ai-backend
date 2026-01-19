/**
 * Debug gate to see what's blocking each test case
 */

import { InstantTaskGate } from '../backend/src/services/InstantTaskGate';

const testCase = {
  name: 'Missing quantity - move items',
  task: {
    title: 'Move boxes',
    description: 'Need help moving boxes from my apartment to storage unit. Should take a few hours.',
    location: '654 Maple Dr, Seattle, WA',
    category: 'moving',
  },
};

async function debug() {
  const result = await InstantTaskGate.check(testCase.task);
  console.log(`\n${testCase.name}:`);
  console.log(`  Eligible: ${result.instantEligible}`);
  console.log(`  Block reason: ${result.blockReason}`);
  console.log(`  Questions: ${result.questions.join(', ')}`);
}

debug();
