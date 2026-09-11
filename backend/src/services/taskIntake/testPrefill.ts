import assert from 'node:assert/strict';
import { extractIntakePrefill } from './extractPrefill.js';
import type { TaskCategory } from './types.js';

const cases: Array<{
  raw: string;
  category: TaskCategory;
  secondary?: TaskCategory[];
}> = [
  {
    raw: 'Pick up my new bed, bring it upstairs and assemble it.',
    category: 'delivery',
    secondary: ['assembly'],
  },
  {
    raw: 'Walk two large dogs twice today.',
    category: 'pet_care',
  },
  {
    raw: 'Move 20 boxes down two flights of stairs.',
    category: 'moving',
  },
  {
    raw: 'Put together four dining chairs and a table.',
    category: 'assembly',
  },
  {
    raw: 'Deliver 30 folding chairs to an event venue.',
    category: 'delivery',
    secondary: ['events'],
  },
  {
    raw: 'I need my apartment cleaned, three rooms total.',
    category: 'cleaning',
  },
];

for (const testCase of cases) {
  const result = extractIntakePrefill(
    testCase.raw,
    testCase.category,
    testCase.secondary ?? [],
  );

  console.log('\n--------------------------------');
  console.log(testCase.raw);
  console.log(JSON.stringify(result, null, 2));
}

const moving = extractIntakePrefill(
  'Move 20 boxes down two flights of stairs.',
  'moving',
);
assert.equal(moving.answers.item_count, 20);
assert.equal(moving.answers.stairs, true);
assert.equal(moving.answers.stair_flights, 2);

const pet = extractIntakePrefill(
  'Walk two large dogs twice today.',
  'pet_care',
);
assert.equal(pet.answers.pet_type, 'dog');
assert.equal(pet.answers.pet_count, 2);
assert.deepEqual(pet.answers.care_type, ['walking']);

const mixed = extractIntakePrefill(
  'Pick up my new bed, bring it upstairs and assemble it.',
  'delivery',
  ['assembly'],
);
assert.equal(mixed.answers.delivery_item, 'bed');
assert.equal(mixed.answers.assembly_type, 'bed');
assert.equal(mixed.answers.assembly_count, 1);
