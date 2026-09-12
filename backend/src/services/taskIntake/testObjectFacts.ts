import assert from 'node:assert/strict';
import { extractObjectFacts, totalObjectQuantity } from './extractObjectFacts.js';
const CASES = [
  { input: 'Move 12 boxes, a TV, desk, mattress and sofa.', expectedTotal: 16 }, { input: 'Move a piano from the first floor to a truck.', expectedTotal: 1 }, { input: 'I have a dresser that weighs about 200 pounds.', expectedTotal: 1 }, { input: 'Move my old washing machine outside and install the new one.', expectedTotal: 1 }, { input: 'Put together four dining chairs and a table.', expectedTotal: 5 }, { input: 'Install three floating shelves on a brick wall.', expectedTotal: 3 }, { input: 'Assemble 25 office desks.', expectedTotal: 25 }, { input: 'Pet sit four dogs, two cats and a parrot.', expectedTotal: 0 },
];
const failures: string[] = [];
for (const testCase of CASES) { const facts = extractObjectFacts(testCase.input); const total = totalObjectQuantity(facts); try { assert.equal(total, testCase.expectedTotal); } catch { failures.push([testCase.input, `expected=${testCase.expectedTotal}`, `actual=${total}`, `facts=${JSON.stringify(facts)}`].join(' | ')); } }
if (failures.length) { console.error(`Object fact failures: ${failures.length}/${CASES.length}`); for (const failure of failures) console.error(`- ${failure}`); process.exitCode = 1; } else console.log(`Object fact cases passed: ${CASES.length}/${CASES.length}`);
