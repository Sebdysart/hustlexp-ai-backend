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

const compoundAssembly = extractIntakePrefill(
  'Put together four dining chairs and a table.',
  'assembly',
);
assert.equal(compoundAssembly.answers.assembly_count, 5);
assert.equal(compoundAssembly.answers.assembly_type, 'dining chairs and table');

const compoundMoving = extractIntakePrefill(
  'Move two couches and six boxes into the garage.',
  'moving',
);
assert.equal(compoundMoving.answers.item_count, 8);

const largerAssembly = extractIntakePrefill(
  'Assemble one desk, two shelves, and four chairs.',
  'assembly',
);
assert.equal(largerAssembly.answers.assembly_count, 7);

const unrelatedNumbers = extractIntakePrefill(
  'Walk two dogs for three hours.',
  'pet_care',
);
assert.equal(unrelatedNumbers.answers.pet_count, 2);
assert.equal(unrelatedNumbers.answers.assembly_count, undefined);

const longCompound = extractIntakePrefill(
  'Assemble three desks, two cabinets, four chairs, and a table.',
  'assembly',
);
assert.equal(longCompound.answers.assembly_count, 10);

const compoundMovingLoose = extractIntakePrefill(
  'Move two couches, six boxes and one lamp into the garage.',
  'moving',
);
assert.equal(compoundMovingLoose.answers.item_count, 9);

const durationCase = extractIntakePrefill(
  'Walk two dogs for three hours.',
  'pet_care',
);
assert.equal(durationCase.answers.pet_count, 2);

const mixedMeasurement = extractIntakePrefill(
  'Move two couches and six boxes up three flights of stairs.',
  'moving',
);
assert.equal(mixedMeasurement.answers.item_count, 8);
assert.equal(mixedMeasurement.answers.stair_flights, 3);
assert.equal(mixedMeasurement.answers.stairs, true);
