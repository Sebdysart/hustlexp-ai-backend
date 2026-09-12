import assert from 'node:assert/strict';
import { extractNumericFacts, type NumericFactRole } from './extractNumericFacts.js';
type ExpectedFact = { role: NumericFactRole; value: number };
const CASES: Array<{ input: string; expected: ExpectedFact[] }> = [
  { input: 'Move 5 boxes for 2 hours.', expected: [{ role: 'item_count', value: 5 }, { role: 'duration', value: 2 }] },
  { input: 'Carry 3 chairs up 2 flights.', expected: [{ role: 'item_count', value: 3 }, { role: 'stair_flights', value: 2 }] },
  { input: 'Walk two dogs for three hours.', expected: [{ role: 'pet_count', value: 2 }, { role: 'duration', value: 3 }] },
  { input: 'Need two people to check guests in at an event.', expected: [{ role: 'worker_count', value: 2 }] },
  { input: 'Move 20 boxes from my garage into a moving truck.', expected: [{ role: 'item_count', value: 20 }] },
  { input: 'Move a piano from the first floor to a truck.', expected: [] },
  { input: 'I have a dresser that weighs about 200 pounds.', expected: [{ role: 'weight', value: 200 }] },
  { input: 'Clean 12 bedrooms and 8 bathrooms.', expected: [{ role: 'room_count', value: 12 }, { role: 'room_count', value: 8 }] },
  { input: 'Move furniture through a hallway only 30 inches wide.', expected: [{ role: 'dimension', value: 30 }] },
  { input: 'Carry a cabinet through a 30 inch doorway.', expected: [{ role: 'dimension', value: 30 }] },
  { input: 'The opening is 3 feet wide.', expected: [{ role: 'dimension', value: 3 }] },
  { input: 'The shelf is 4 ft. long.', expected: [{ role: 'dimension', value: 4 }] },
  { input: 'Pick up a couch 15 miles away.', expected: [{ role: 'distance', value: 15 }] },
];
const simplify = (input: string): ExpectedFact[] => extractNumericFacts(input).map((fact) => ({ role: fact.role, value: fact.value }));

const failures: string[] = [];
for (const testCase of CASES) { const actual = simplify(testCase.input); try { assert.deepStrictEqual(actual, testCase.expected); } catch { failures.push([testCase.input, `expected=${JSON.stringify(testCase.expected)}`, `actual=${JSON.stringify(actual)}`].join(' | ')); } }
if (failures.length) { console.error(`Numeric fact failures: ${failures.length}/${CASES.length}`); for (const failure of failures) console.error(`- ${failure}`); process.exitCode = 1; } else console.log(`Numeric fact cases passed: ${CASES.length}/${CASES.length}`);


