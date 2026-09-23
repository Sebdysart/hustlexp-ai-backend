import assert from 'node:assert/strict';
import { getQuestionsForCategory } from './definitions.js';
import { validateTaskIntake } from './validateIntake.js';
import { buildTaskScopeSummary } from './buildScopeSummary.js';
import type { IntakeAnswers } from './types.js';

const valid = (category: 'painting'|'plumbing'|'electrical', answers: IntakeAnswers) => {
  const result = validateTaskIntake(category, answers);
  assert.equal(result.invalidAnswers?.length ?? 0, 0);
  assert.equal(result.readyForDraft, true);
};

valid('painting', { painting_surface: 'interior_walls', painting_area: 'living room', paint_provided: true });
valid('painting', { painting_surface: 'ceiling', painting_area: 'bedroom', paint_provided: false, coat_count: 2 });
valid('painting', { painting_surface: 'fence', painting_area: 'back fence', paint_provided: true });
assert.ok(validateTaskIntake('painting', { painting_surface: 'walls' }).invalidAnswers?.includes('painting_surface'));
assert.ok(validateTaskIntake('painting', { painting_surface: 'fence', paint_provided: 'yes' }).invalidAnswers?.includes('paint_provided'));
assert.ok(validateTaskIntake('painting', { painting_surface: 'fence', coat_count: 0 }).invalidAnswers?.includes('coat_count'));

valid('plumbing', { plumbing_fixture: 'sink', plumbing_issue: 'leak', active_leak: true });
valid('plumbing', { plumbing_fixture: 'toilet', plumbing_issue: 'clog', active_leak: false });
valid('plumbing', { plumbing_fixture: 'faucet', plumbing_issue: 'installation', parts_provided: true });
valid('plumbing', { plumbing_fixture: 'water_heater', plumbing_issue: 'repair', water_shutoff_available: false });
assert.ok(validateTaskIntake('plumbing', { plumbing_fixture: 'bathtub', plumbing_issue: 'leak' }).invalidAnswers?.length === 0);
assert.ok(validateTaskIntake('plumbing', { plumbing_fixture: 'sink', plumbing_issue: 'broken' }).invalidAnswers?.includes('plumbing_issue'));
assert.ok(validateTaskIntake('plumbing', { plumbing_fixture: 'sink', plumbing_issue: 'leak', active_leak: 'true' }).invalidAnswers?.includes('active_leak'));

valid('electrical', { electrical_fixture: 'light', electrical_issue: 'installation', existing_wiring: true, parts_provided: true });
valid('electrical', { electrical_fixture: 'outlet', electrical_issue: 'replacement' });
valid('electrical', { electrical_fixture: 'breaker', electrical_issue: 'tripping', panel_involved: true });
valid('electrical', { electrical_fixture: 'ceiling_fan', electrical_issue: 'installation' });
assert.ok(validateTaskIntake('electrical', { electrical_fixture: 'fan', electrical_issue: 'repair' }).invalidAnswers?.includes('electrical_fixture'));
assert.ok(validateTaskIntake('electrical', { electrical_fixture: 'light', electrical_issue: 'broken' }).invalidAnswers?.includes('electrical_issue'));
assert.ok(validateTaskIntake('electrical', { electrical_fixture: 'light', electrical_issue: 'repair', panel_involved: 'yes' }).invalidAnswers?.includes('panel_involved'));

assert.ok(!getQuestionsForCategory('painting').some((question) => question.key === 'plumbing_fixture'));
assert.match(buildTaskScopeSummary('painting', 'Paint my living room walls.', { painting_surface: 'interior_walls', painting_area: 'living room', paint_provided: true }), /Painting work/);
assert.match(buildTaskScopeSummary('plumbing', 'Kitchen sink is leaking.', { plumbing_fixture: 'sink', plumbing_issue: 'leak', active_leak: true }), /Active leak reported/);
assert.match(buildTaskScopeSummary('electrical', 'Install ceiling lights.', { electrical_fixture: 'light', electrical_issue: 'installation', existing_wiring: true, parts_provided: true }), /Existing wiring is available/);

console.log(`Expanded category schema cases passed: ${getQuestionsForCategory('painting').length + getQuestionsForCategory('plumbing').length + getQuestionsForCategory('electrical').length}`);
