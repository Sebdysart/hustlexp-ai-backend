import { classifyTask } from './classifyTask.js';
import type { ServiceTaskCategory } from './types.js';

interface TaxonomyCase {
  input: string;
  expected: ServiceTaskCategory | null;
}

const movingDeliveryCases: TaxonomyCase[] = [
  { input: 'Lift the armchair and carry it to the second floor.', expected: 'moving' },
  { input: 'Pick up this parcel and take it down to the basement.', expected: 'moving' },
  { input: 'Pick up the dresser and move it into the guest room.', expected: 'moving' },
  { input: 'Bring the wardrobe upstairs from the hallway.', expected: 'moving' },
  { input: 'Carry these boxes from the bedroom into the garage.', expected: 'moving' },
  { input: 'Unload our belongings from the moving truck into the house.', expected: 'moving' },
  { input: 'Pick up the laundry basket and take it downstairs.', expected: 'moving' },
  { input: 'Move the bookcase from the study into the next room.', expected: 'moving' },
  { input: 'Carry this package up one flight inside the building.', expected: 'moving' },
  { input: 'Bring the cabinet down to the ground floor.', expected: 'moving' },
  { input: 'Collect the sofa from the retailer and deliver it to my address.', expected: 'delivery' },
  { input: 'Pick up the parcel at the depot and drop it at our office.', expected: 'delivery' },
  { input: 'Collect a chair from the warehouse and bring it to the apartment.', expected: 'delivery' },
  { input: 'Courier this envelope to the client business.', expected: 'delivery' },
  { input: 'Transport the purchased table from the showroom to my home.', expected: 'delivery' },
  { input: 'Pick up the cake from the bakery and deliver it to the venue.', expected: 'delivery' },
  { input: 'Retrieve the keys from the agent and take them to my address.', expected: 'delivery' },
  { input: 'Bring a television.', expected: null },
  { input: 'Bring two floor lamps.', expected: null },
  { input: 'Pick up the box.', expected: null },
];

const wallMountCases: TaxonomyCase[] = [
  { input: 'Have the hallway mirror mounted securely on the wall.', expected: 'assembly' },
  { input: 'Mount a floating shelf above the desk.', expected: 'assembly' },
  { input: 'Anchor the already assembled bookcase to the wall.', expected: 'assembly' },
  { input: 'Mount the television bracket on concrete.', expected: 'assembly' },
  { input: 'Secure the assembled cabinet to the masonry wall.', expected: 'assembly' },
  { input: 'Hang the coat rack on the entryway wall.', expected: 'assembly' },
  { input: 'A framed mirror needs hanging on the plaster wall.', expected: 'assembly' },
  { input: 'Repair the loose bracket behind the bathroom mirror.', expected: 'handyman' },
  { input: 'Tighten the existing shelf bracket that pulled away from the wall.', expected: 'handyman' },
  { input: 'Fix the door on the cabinet that is already mounted.', expected: 'handyman' },
];

const cases = [...movingDeliveryCases, ...wallMountCases];
const failures: string[] = [];

for (const testCase of cases) {
  const result = await classifyTask(testCase.input);
  if (result.category !== testCase.expected) {
    failures.push(
      `${JSON.stringify(testCase.input)} expected ${testCase.expected ?? 'clarification'}, ` +
        `got ${result.category ?? 'clarification'} (${result.overrideReason ?? 'model'}, margin ${result.margin.toFixed(4)})`,
    );
  }
}

if (failures.length > 0) {
  console.error(`Category taxonomy regression failures: ${failures.length}`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exitCode = 1;
} else {
  console.log(`Category taxonomy regression passed: ${cases.length}/${cases.length}`);
}
