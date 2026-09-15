import assert from 'node:assert/strict';

import { classifyTask } from './classifyTask.js';
import type { ServiceTaskCategory } from './types.js';

interface RegressionCase {
  input: string;
  expected: ServiceTaskCategory | null;
}

const cases: RegressionCase[] = [
  { input: 'Scrub several rooms on the upper floor and use your own products.', expected: 'cleaning' },
  { input: 'Mend the loose latch on the backyard gate.', expected: 'handyman' },
  { input: 'Repair a split cabinet door in the kitchen.', expected: 'handyman' },
  { input: 'Host an anniversary dinner for twenty-four guests.', expected: 'events' },
  { input: 'Arrange a graduation gathering for forty attendees.', expected: 'events' },
  { input: 'Make dinner for my family tonight.', expected: null },
  { input: 'Need somebody for a few hours tomorrow.', expected: null },
  { input: 'Carry the dresser to the upstairs bedroom.', expected: 'moving' },
  { input: 'Collect the dresser from the shop and deliver it to my home.', expected: 'delivery' },
  { input: 'Bring your drill to repair the cupboard hinge.', expected: 'handyman' },
  { input: 'Paint the fence beside the garden gate.', expected: 'painting' },
  { input: 'Fix the leaking tap in the bathroom.', expected: 'plumbing' },
  { input: 'Replace a dead wall outlet.', expected: 'electrical' },
  { input: 'Mount a television bracket on the wall.', expected: 'assembly' },
  { input: 'The water pressure is weak throughout the bathroom.', expected: 'plumbing' },
  { input: 'Install a fan in the bedroom.', expected: 'electrical' },
  { input: 'Repair the sliding closet door.', expected: 'handyman' },
  { input: 'Carry a heavy cabinet into the next room.', expected: 'moving' },
  { input: 'The hallway ceiling needs three coats.', expected: 'painting' },
  { input: 'Need general help at home tomorrow.', expected: null },
  { input: 'Looking for a worker for a couple of hours.', expected: null },
  { input: 'Can somebody handle a quick task?', expected: null },
  { input: 'Clean the floor after our family dinner.', expected: 'cleaning' },
  { input: 'Set up an anniversary reception for thirty guests.', expected: 'events' },
  { input: 'Carry my couch up to the second floor.', expected: 'moving' },
  { input: 'Move this parcel to the delivery address.', expected: 'delivery' },
  { input: 'Bring a ladder and fix the garden gate.', expected: 'handyman' },
  { input: 'Bring the paint and repaint the bedroom wall.', expected: 'painting' },
  { input: 'Repair the noisy ceiling fan.', expected: 'electrical' },
  { input: 'Patch a hole in the drywall.', expected: 'handyman' },
  { input: 'Clean dried paint from the bathroom floor.', expected: 'cleaning' },
  { input: 'Install a new kitchen tap.', expected: 'plumbing' },
  { input: 'Bring the lamp over to the office.', expected: 'delivery' },
  { input: 'Replace the windshield wipers on my sedan.', expected: 'auto' },
  { input: 'Inspect the roof vent for damage.', expected: 'home_services' },
  { input: 'Mow the lawn and collect the clippings.', expected: 'yard' },
  { input: 'Feed and walk my two dogs.', expected: 'pet_care' },
  { input: 'Move the couch, then assemble the bed frame.', expected: 'moving' },
  { input: 'The oil leak in my car stopped yesterday.', expected: 'auto' },
  { input: 'Inspect the roof where the leak stopped.', expected: 'home_services' },
  { input: 'Assemble the nightstand and bring ordinary hand tools.', expected: 'assembly' },
  { input: 'Tighten the handrail and bring a step ladder.', expected: 'handyman' },
  { input: 'Collect my purchased cabinet from the warehouse and bring it home.', expected: 'delivery' },
  { input: 'Give the rabbit food and wipe out its tray.', expected: 'pet_care' },
  { input: 'Walk the puppy, then wipe its muddy feet.', expected: 'pet_care' },
  { input: 'Remove dog hair from the living-room rug.', expected: 'cleaning' },
  { input: 'Patch the plaster below the basin; all plumbing is fine.', expected: 'handyman' },
  { input: 'Repair the ceiling beside the fan; the fan works normally.', expected: 'handyman' },
  { input: "Mount a shelf above the breaker panel; don't touch the wiring.", expected: 'assembly' },
  { input: 'Fill the wall dents and leave the surface unpainted.', expected: 'handyman' },
  { input: 'Wash the ceiling-fan blades; the fan itself works properly.', expected: 'cleaning' },
  { input: 'A quiet anniversary meal at home with my partner.', expected: null },
  { input: 'Anniversary supper for forty guests with serving staff.', expected: 'events' },
  { input: 'Hang a framed mirror on the masonry wall.', expected: 'assembly' },
  { input: 'Attach an already-built bookcase securely to the wall.', expected: 'assembly' },
  { input: 'Install a bathroom towel rail.', expected: 'handyman' },
  { input: 'Assess the swollen plaster after a moisture problem.', expected: 'home_services' },
  { input: 'Deliver the replacement car battery from the shop to my address.', expected: 'delivery' },
  { input: 'Assess the damp skirting after a leak; painting is not requested.', expected: 'home_services' },
  { input: 'Take this parcel from our office to the client address; no household move is needed.', expected: 'delivery' },
  { input: 'Could use help putting the boxed cot together.', expected: 'assembly' },
  { input: 'Looking for somebody to give food and water to three parrots.', expected: 'pet_care' },
  { input: 'Need help because the sedan runs rough and its engine warning light is on.', expected: 'auto' },
  { input: 'Can somebody check a doorbell that stopped working?', expected: 'electrical' },
  { input: 'Need check-in staff for our trade-show mixer.', expected: 'events' },
  { input: 'Collect the display from Redmond and drop it at our studio.', expected: 'delivery' },
  { input: 'Bring the grocery order from the market.', expected: 'delivery' },
  { input: 'The hallway walls need redoing in a warmer color.', expected: 'painting' },
  { input: 'Trim the overgrown hedge back from the front gate.', expected: 'yard' },
];

const failures: string[] = [];
for (const testCase of cases) {
  const result = await classifyTask(testCase.input);
  if (result.category !== testCase.expected) {
    failures.push(
      `${JSON.stringify(testCase.input)} expected ${testCase.expected ?? 'clarification'}, got ${result.category ?? 'clarification'}`,
    );
  }
}

assert.deepEqual(failures, []);
console.log(`Classifier regression passed: ${cases.length}/${cases.length}`);
