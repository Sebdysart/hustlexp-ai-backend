import assert from 'node:assert/strict';

import { inferSecondaryIntentsForTest } from './classifyTask.js';

const secondary = inferSecondaryIntentsForTest(
  'Move my couch and mount my TV after we get to the new apartment.',
  'moving',
);

assert.equal(secondary.includes('assembly'), true);
console.log('Secondary-intent regression passed.');
