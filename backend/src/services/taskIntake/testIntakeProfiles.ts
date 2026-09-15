import assert from 'node:assert/strict';
import { B, getQuestionsForIntake } from './definitions.js';
import { extractIntakePrefill } from './extractPrefill.js';
import { resolveIntakeProfile } from './resolveIntakeProfile.js';
import { sanitizeIntakeAnswers } from './sanitizeIntakeAnswers.js';
import { validateTaskIntake } from './validateIntake.js';
import { buildTaskScopeSummary } from './buildScopeSummary.js';
import type { IntakeAnswers, IntakeProfile, TaskCategory } from './types.js';

interface ProfileRoutingCase {
  input: string;
  category: TaskCategory;
  expectedCategory: TaskCategory;
  expectedProfile?: IntakeProfile;
  mustAsk: string[];
  mustNotAsk: string[];
  expectedPrefills: IntakeAnswers;
}

export const intakeProfileCases: ProfileRoutingCase[] = [
  { input: 'Please clean the bedroom before Friday.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_indoor', mustAsk: ['room_count', 'cleaning_type'], mustNotAsk: ['surface_type', 'water_access'], expectedPrefills: {} },
  { input: 'Our apartment needs a deep cleaning.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_indoor', mustAsk: ['property_type', 'supplies_provided'], mustNotAsk: ['surface_type'], expectedPrefills: { property_type: 'apartment', cleaning_type: 'deep' } },
  { input: 'Mop the kitchen floor and scrub the counters.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_indoor', mustAsk: ['room_count'], mustNotAsk: ['surface_area'], expectedPrefills: {} },
  { input: 'I need the living room vacuumed.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_indoor', mustAsk: ['cleaning_type'], mustNotAsk: ['water_access'], expectedPrefills: {} },
  { input: 'Move-out cleaning for my house.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_indoor', mustAsk: ['property_type'], mustNotAsk: ['surface_type'], expectedPrefills: { property_type: 'house' } },
  { input: 'Could someone scrub both bathrooms?', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_indoor', mustAsk: ['supplies_provided'], mustNotAsk: ['auto_cleaning_type'], expectedPrefills: {} },
  { input: 'Vacuum the office interior after the meeting.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_indoor', mustAsk: ['property_type'], mustNotAsk: ['surface_type'], expectedPrefills: { property_type: 'office' } },
  { input: 'Deep clean three rooms in the home.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_indoor', mustAsk: ['room_count'], mustNotAsk: ['water_access'], expectedPrefills: { room_count: 3 } },
  { input: 'The kitchen and bedroom need cleaning.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_indoor', mustAsk: ['cleaning_type'], mustNotAsk: ['surface_area'], expectedPrefills: {} },
  { input: 'Clean all rooms inside the apartment.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_indoor', mustAsk: ['supplies_provided'], mustNotAsk: ['surface_type'], expectedPrefills: { property_type: 'apartment' } },
  { input: 'Standard house cleaning, including the bathroom.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_indoor', mustAsk: ['property_type'], mustNotAsk: ['auto_cleaning_type'], expectedPrefills: { property_type: 'house', cleaning_type: 'standard' } },
  { input: 'Can you vacuum two bedrooms?', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_indoor', mustAsk: ['room_count'], mustNotAsk: ['surface_type'], expectedPrefills: { room_count: 2 } },

  { input: 'Pressure wash my driveway.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_surface', mustAsk: ['surface_type', 'water_access'], mustNotAsk: ['room_count', 'property_type'], expectedPrefills: { surface_type: 'driveway' } },
  { input: 'The patio needs power washing.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_surface', mustAsk: ['surface_area'], mustNotAsk: ['cleaning_type'], expectedPrefills: { surface_type: 'patio' } },
  { input: 'Clean the concrete walkway out front.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_surface', mustAsk: ['equipment_provided'], mustNotAsk: ['room_count'], expectedPrefills: { surface_type: 'walkway' } },
  { input: 'Wash the siding on the back of the house.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_surface', mustAsk: ['surface_type'], mustNotAsk: ['property_type'], expectedPrefills: { surface_type: 'siding' } },
  { input: 'Scrub the outdoor concrete surface.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_surface', mustAsk: ['water_access'], mustNotAsk: ['cleaning_type'], expectedPrefills: { surface_type: 'concrete' } },
  { input: 'Power-wash the deck behind the garage.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_surface', mustAsk: ['surface_area'], mustNotAsk: ['room_count'], expectedPrefills: { surface_type: 'deck' } },
  { input: 'Our front pavement could use pressure washing.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_surface', mustAsk: ['surface_type'], mustNotAsk: ['property_type'], expectedPrefills: {} },
  { input: 'Clean the exterior surface by the pool.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_surface', mustAsk: ['equipment_provided'], mustNotAsk: ['cleaning_type'], expectedPrefills: {} },
  { input: 'Wash both walkways; the outdoor faucet is available.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_surface', mustAsk: ['water_access'], mustNotAsk: ['room_count'], expectedPrefills: { surface_type: 'walkway', water_access: true } },
  { input: 'Pressure washing for a small patio; bring your own equipment.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_surface', mustAsk: ['equipment_provided'], mustNotAsk: ['property_type'], expectedPrefills: { surface_type: 'patio', equipment_provided: false } },
  { input: 'The driveway needs washing, but there is no water connection.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_surface', mustAsk: ['water_access'], mustNotAsk: ['cleaning_type'], expectedPrefills: { surface_type: 'driveway', water_access: false } },
  { input: 'Please power wash the exterior siding.', category: 'cleaning', expectedCategory: 'cleaning', expectedProfile: 'cleaning_surface', mustAsk: ['surface_type'], mustNotAsk: ['room_count'], expectedPrefills: { surface_type: 'siding' } },

  { input: "My car won't start and needs diagnosis.", category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_repair', mustAsk: ['auto_service_type', 'vehicle_drivable'], mustNotAsk: ['auto_cleaning_type'], expectedPrefills: { vehicle_details: 'car' } },
  { input: 'Replace the brake pads on my sedan.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_repair', mustAsk: ['parts_provided'], mustNotAsk: ['equipment_provided'], expectedPrefills: { vehicle_details: 'sedan' } },
  { input: 'Diagnose the check-engine light on this SUV.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_repair', mustAsk: ['vehicle_details'], mustNotAsk: ['auto_cleaning_type'], expectedPrefills: { vehicle_details: 'SUV' } },
  { input: 'The truck transmission is slipping.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_repair', mustAsk: ['auto_service_type'], mustNotAsk: ['equipment_provided'], expectedPrefills: { vehicle_details: 'truck' } },
  { input: 'Car battery keeps dying overnight.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_repair', mustAsk: ['vehicle_drivable'], mustNotAsk: ['auto_cleaning_type'], expectedPrefills: { vehicle_details: 'car' } },
  { input: 'Service the engine and change the oil.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_repair', mustAsk: ['parts_provided'], mustNotAsk: ['equipment_provided'], expectedPrefills: {} },
  { input: 'The sedan has a warning light and runs rough.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_repair', mustAsk: ['auto_service_type'], mustNotAsk: ['auto_cleaning_type'], expectedPrefills: { vehicle_details: 'sedan' } },
  { input: 'Need two tires replaced on the car.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_repair', mustAsk: ['parts_provided'], mustNotAsk: ['equipment_provided'], expectedPrefills: { vehicle_details: 'car' } },
  { input: 'Fix the broken taillight on my truck.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_repair', mustAsk: ['vehicle_drivable'], mustNotAsk: ['auto_cleaning_type'], expectedPrefills: { vehicle_details: 'truck' } },
  { input: 'Vehicle is not drivable after a brake issue.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_repair', mustAsk: ['auto_service_type'], mustNotAsk: ['equipment_provided'], expectedPrefills: { vehicle_details: 'vehicle' } },
  { input: 'Repair the wipers on the SUV.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_repair', mustAsk: ['parts_provided'], mustNotAsk: ['auto_cleaning_type'], expectedPrefills: { vehicle_details: 'SUV' } },
  { input: 'My sedan requires routine maintenance.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_repair', mustAsk: ['auto_service_type'], mustNotAsk: ['equipment_provided'], expectedPrefills: { vehicle_details: 'sedan' } },

  { input: 'Wash my SUV.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_cleaning', mustAsk: ['auto_cleaning_type'], mustNotAsk: ['vehicle_drivable', 'parts_provided'], expectedPrefills: { vehicle_details: 'SUV', auto_cleaning_type: 'exterior_wash' } },
  { input: 'Detail the sedan inside and out.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_cleaning', mustAsk: ['equipment_provided'], mustNotAsk: ['auto_service_type'], expectedPrefills: { vehicle_details: 'sedan' } },
  { input: 'Vacuum the interior of my car.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_cleaning', mustAsk: ['vehicle_details'], mustNotAsk: ['vehicle_drivable'], expectedPrefills: { vehicle_details: 'car', auto_cleaning_type: 'interior_detail' } },
  { input: 'Pressure-wash the truck exterior.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_cleaning', mustAsk: ['auto_cleaning_type'], mustNotAsk: ['parts_provided'], expectedPrefills: { vehicle_details: 'truck', auto_cleaning_type: 'pressure_wash' } },
  { input: 'The vehicle needs a full detail.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_cleaning', mustAsk: ['equipment_provided'], mustNotAsk: ['auto_service_type'], expectedPrefills: { vehicle_details: 'vehicle', auto_cleaning_type: 'full_detail' } },
  { input: 'Clean the seats inside the SUV.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_cleaning', mustAsk: ['auto_cleaning_type'], mustNotAsk: ['vehicle_drivable'], expectedPrefills: { vehicle_details: 'SUV', auto_cleaning_type: 'interior_detail' } },
  { input: 'Exterior wash for my sedan.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_cleaning', mustAsk: ['equipment_provided'], mustNotAsk: ['parts_provided'], expectedPrefills: { vehicle_details: 'sedan', auto_cleaning_type: 'exterior_wash' } },
  { input: 'Please clean the car and bring detailing supplies.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_cleaning', mustAsk: ['equipment_provided'], mustNotAsk: ['auto_service_type'], expectedPrefills: { vehicle_details: 'car', auto_cleaning_type: 'exterior_wash', equipment_provided: false } },
  { input: 'Wash two vehicles; I have the cleaning equipment.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_cleaning', mustAsk: ['vehicle_details'], mustNotAsk: ['vehicle_drivable'], expectedPrefills: { vehicle_details: 'vehicle', auto_cleaning_type: 'exterior_wash', equipment_provided: true } },
  { input: 'Power washing needed for the SUV.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_cleaning', mustAsk: ['auto_cleaning_type'], mustNotAsk: ['parts_provided'], expectedPrefills: { vehicle_details: 'SUV', auto_cleaning_type: 'pressure_wash' } },
  { input: 'Clean my truck cabin.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_cleaning', mustAsk: ['equipment_provided'], mustNotAsk: ['vehicle_drivable'], expectedPrefills: { vehicle_details: 'truck', auto_cleaning_type: 'interior_detail' } },
  { input: 'Give the car a complete detail.', category: 'auto', expectedCategory: 'auto', expectedProfile: 'auto_cleaning', mustAsk: ['auto_cleaning_type'], mustNotAsk: ['auto_service_type'], expectedPrefills: { vehicle_details: 'car', auto_cleaning_type: 'full_detail' } },

  { input: 'I need help cleaning something.', category: 'cleaning', expectedCategory: 'cleaning', mustAsk: ['intake_profile'], mustNotAsk: ['room_count', 'surface_type'], expectedPrefills: {} },
  { input: 'Clean the kitchen and power wash the patio.', category: 'cleaning', expectedCategory: 'cleaning', mustAsk: ['intake_profile'], mustNotAsk: ['property_type', 'water_access'], expectedPrefills: {} },
  { input: 'Can someone help with my vehicle?', category: 'auto', expectedCategory: 'auto', mustAsk: ['intake_profile'], mustNotAsk: ['vehicle_drivable', 'auto_cleaning_type'], expectedPrefills: {} },
  { input: 'Wash the car and then inspect the brakes.', category: 'auto', expectedCategory: 'auto', mustAsk: ['intake_profile'], mustNotAsk: ['parts_provided', 'equipment_provided'], expectedPrefills: {} },
  { input: 'The sedan needs detailing and engine service.', category: 'auto', expectedCategory: 'auto', mustAsk: ['intake_profile'], mustNotAsk: ['vehicle_drivable'], expectedPrefills: {} },
  { input: 'General cleaning help at the property.', category: 'cleaning', expectedCategory: 'cleaning', mustAsk: ['intake_profile'], mustNotAsk: ['cleaning_type', 'surface_area'], expectedPrefills: {} },

  { input: 'Pressure wash my car in the driveway.', category: 'cleaning', expectedCategory: 'auto', expectedProfile: 'auto_cleaning', mustAsk: ['auto_cleaning_type'], mustNotAsk: ['room_count', 'vehicle_drivable'], expectedPrefills: { vehicle_details: 'car', auto_cleaning_type: 'pressure_wash' } },
  { input: 'Clean the truck parked outside.', category: 'cleaning', expectedCategory: 'auto', expectedProfile: 'auto_cleaning', mustAsk: ['equipment_provided'], mustNotAsk: ['property_type', 'parts_provided'], expectedPrefills: { vehicle_details: 'truck', auto_cleaning_type: 'exterior_wash' } },
  { input: 'Move the couch upstairs.', category: 'moving', expectedCategory: 'moving', mustAsk: ['item_count', 'stairs'], mustNotAsk: ['intake_profile'], expectedPrefills: {} },
  { input: 'Mow the front lawn.', category: 'yard', expectedCategory: 'yard', mustAsk: ['yard_size', 'debris'], mustNotAsk: ['intake_profile'], expectedPrefills: {} },
  { input: 'Scrub the bathroom and wash the outside deck.', category: 'cleaning', expectedCategory: 'cleaning', mustAsk: ['intake_profile'], mustNotAsk: ['room_count', 'surface_type'], expectedPrefills: {} },
  { input: 'Detail the car, then diagnose its transmission noise.', category: 'auto', expectedCategory: 'auto', mustAsk: ['intake_profile'], mustNotAsk: ['auto_service_type', 'auto_cleaning_type'], expectedPrefills: {} },
];

assert.equal(intakeProfileCases.length, 60);
const counts = intakeProfileCases.reduce<Record<string, number>>((result, item) => { result[item.expectedProfile ?? 'unresolved'] = (result[item.expectedProfile ?? 'unresolved'] ?? 0) + 1; return result; }, {});
for (const profile of ['cleaning_indoor', 'cleaning_surface', 'auto_repair', 'auto_cleaning']) assert.ok((counts[profile] ?? 0) >= 12, `${profile} must have at least 12 cases`);

for (const item of intakeProfileCases) {
  const resolution = resolveIntakeProfile({ category: item.category, raw: item.input });
  assert.equal(resolution.category, item.expectedCategory, item.input);
  assert.equal(resolution.profile, item.expectedProfile, item.input);
  const questions = getQuestionsForIntake(resolution.category, [], resolution.profile ?? null);
  const keys = new Set(questions.map((question) => question.key));
  for (const key of item.mustAsk) assert.ok(keys.has(key), `${item.input}: expected ${key}`);
  for (const key of item.mustNotAsk) assert.ok(!keys.has(key), `${item.input}: did not expect ${key}`);
  const prefill = extractIntakePrefill(item.input, resolution.category, [], resolution.profile ?? null).answers;
  for (const [key, value] of Object.entries(item.expectedPrefills)) assert.deepEqual(prefill[key], value, `${item.input}: ${key}`);
}

const sanitizedSurface = sanitizeIntakeAnswers('cleaning', { property_type: 'house', room_count: 4, cleaning_type: 'deep', supplies_provided: true, surface_type: 'driveway', water_access: true }, [], 'cleaning_surface');
assert.deepEqual(sanitizedSurface, { surface_type: 'driveway', water_access: true });
const sanitizedAutoCleaning = sanitizeIntakeAnswers('auto', { vehicle_details: 'SUV', auto_service_type: 'brakes', vehicle_drivable: false, parts_provided: true, auto_cleaning_type: 'full_detail' }, [], 'auto_cleaning');
assert.deepEqual(sanitizedAutoCleaning, { vehicle_details: 'SUV', auto_cleaning_type: 'full_detail' });
assert.equal(validateTaskIntake('cleaning', {}, [], null).missingRequired[0], 'intake_profile');
assert.deepEqual(validateTaskIntake('auto', {}).missingRequired, ['intake_profile']);
assert.deepEqual(validateTaskIntake('cleaning', {}, [], 'auto_cleaning').invalidAnswers, ['intake_profile']);
assert.ok(validateTaskIntake('cleaning', { surface_type: 'driveway', equipment_provided: false, water_access: true }, [], 'cleaning_surface').readyForDraft);
const yardKeys = getQuestionsForIntake('yard').map((question) => question.key);
for (const question of B.yard) assert.ok(yardKeys.includes(question.key));
assert.ok(!yardKeys.includes('intake_profile'));
const surfaceSummary = buildTaskScopeSummary('cleaning', 'Wash the patio.', { surface_type: 'patio', equipment_provided: false, water_access: true }, [], 'cleaning_surface');
assert.match(surfaceSummary, /Patio cleaning/);
assert.doesNotMatch(surfaceSummary, /room|indoor/i);
const autoCleaningSummary = buildTaskScopeSummary('auto', 'Detail the SUV.', { vehicle_details: 'SUV', auto_cleaning_type: 'full_detail', equipment_provided: false }, [], 'auto_cleaning');
assert.match(autoCleaningSummary, /Vehicle cleaning: Full Detail/);
assert.doesNotMatch(autoCleaningSummary, /drivable|parts/i);

console.log(`Intake profile routing cases passed: ${intakeProfileCases.length}`);
