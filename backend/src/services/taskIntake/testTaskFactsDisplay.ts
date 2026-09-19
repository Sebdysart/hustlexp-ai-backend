import assert from 'node:assert/strict';
import { getTaskFactsForDisplay } from './getTaskFactsForDisplay.js';

const fence = getTaskFactsForDisplay({
  rawInput: 'fix my wooden fence, 3 meters of damage',
  category: 'handyman',
  structured: {
    answers: {
      work_type: 'fixing my wooden fence, its broken',
      materials_provided: true,
      special_tools: false,
      required_tools: [],
      preferred_window: 'today_or_tomorrow',
      required_vehicle: 'none',
      required_worker_count: '1',
    },
  },
});

assert.ok(fence);
assert.ok(fence.serviceDetails?.includes('fixing my wooden fence, its broken'));
assert.deepEqual(fence.resources?.provided, ['materials']);
assert.equal(fence.resources?.vehicleRequired, false);
assert.equal(fence.staffing?.workerCount, 1);
assert.equal(fence.timing?.preference, 'today or tomorrow');

assert.equal(getTaskFactsForDisplay({ rawInput: undefined }), null);
assert.equal(getTaskFactsForDisplay({ rawInput: null }), null);
assert.equal(getTaskFactsForDisplay({ rawInput: '   ' }), null);
assert.ok(getTaskFactsForDisplay({ rawInput: 'Move two chairs upstairs.' }));
assert.ok(getTaskFactsForDisplay({ rawInput: 'Move two chairs.', structured: { answers: 'invalid' } }));

const rawWins = getTaskFactsForDisplay({
  rawInput: 'Move two chairs.',
  structured: { answers: { item_count: 99, required_vehicle: 'none' } },
});
assert.equal(rawWins?.objects?.[0]?.quantity, 2);

console.log('TaskFacts display enrichment cases passed.');
