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
