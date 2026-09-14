import { isDeepStrictEqual } from 'node:util';
import { classifyTask } from '../taskClassification/classifyTask.js';
import { extractIntakePrefill } from './extractPrefill.js';
import type { TaskCategory } from './types.js';

type ValidationCase = { input: string; category: TaskCategory | undefined; expectedAnswers: Record<string, unknown> };

export const validation150: ValidationCase[] = [
  {
    input: "Small lawn needs mowing; leave the clippings here.",
    category: "yard",
    expectedAnswers: { yard_size: "small", debris: false },
  },
  {
    input: "Large backyard needs leaf cleanup and haul-away.",
    category: "yard",
    expectedAnswers: { yard_size: "large", debris: true, debris_type: ["leaves"] },
  },
  {
    input: "Average-sized yard needs trimming; I have a rake and blower.",
    category: "yard",
    expectedAnswers: { yard_size: "medium", equipment_provided: true },
  },
  {
    input: "Tiny lawn needs leaves bagged and taken away.",
    category: "yard",
    expectedAnswers: { yard_size: "small", debris: true, debris_type: ["leaves"] },
  },
  {
    input: "Huge yard has branches and junk to remove.",
    category: "yard",
    expectedAnswers: { yard_size: "large", debris: true, debris_type: ["branches", "junk"] },
  },
  {
    input: "Medium lawn needs mowing; bring your own equipment.",
    category: "yard",
    expectedAnswers: { yard_size: "medium", equipment_provided: false },
  },
  {
    input: "Bag the leaves and leave the bags beside the shed.",
    category: "yard",
    expectedAnswers: { debris: false },
  },
  {
    input: "Remove the green waste from the front yard.",
    category: "yard",
    expectedAnswers: { debris: true, debris_type: ["green_waste"] },
  },
  {
    input: "Small garden cleanup; keep the debris on site.",
    category: "yard",
    expectedAnswers: { yard_size: "small", debris: false },
  },
  {
    input: "Trim shrubs and dispose of the cuttings.",
    category: "yard",
    expectedAnswers: { debris: true },
  },
  {
    input: "Deep clean two rooms in my apartment; supplies are here.",
    category: "cleaning",
    expectedAnswers: { property_type: "apartment", room_count: 2, cleaning_type: "deep", supplies_provided: true },
  },
  {
    input: "Clean three rooms upstairs and bring your own supplies.",
    category: "cleaning",
    expectedAnswers: { room_count: 3, supplies_provided: false },
  },
  {
    input: "Standard cleaning for four rooms in a house, no stairs.",
    category: "cleaning",
    expectedAnswers: { property_type: "house", room_count: 4, cleaning_type: "standard" },
  },
  {
    input: "Clean one room upstairs and two downstairs.",
    category: "cleaning",
    expectedAnswers: { room_count: 3 },
  },
  {
    input: "Need a move-out clean for the apartment.",
    category: "cleaning",
    expectedAnswers: { property_type: "apartment", cleaning_type: "move_out" },
  },
  {
    input: "Clean the kitchen and bathroom; I have the products.",
    category: "cleaning",
    expectedAnswers: { supplies_provided: true },
  },
  {
    input: "Clean five rooms and bring all cleaning supplies.",
    category: "cleaning",
    expectedAnswers: { room_count: 5, supplies_provided: false },
  },
  {
    input: "Regular condo cleaning; there are no stairs.",
    category: "cleaning",
    expectedAnswers: { cleaning_type: "standard" },
  },
  {
    input: "Deep clean two rooms on the upper floor.",
    category: "cleaning",
    expectedAnswers: { room_count: 2, cleaning_type: "deep" },
  },
  {
    input: "Clean the apartment; I don't have any supplies.",
    category: "cleaning",
    expectedAnswers: { property_type: "apartment", supplies_provided: false },
  },
  {
    input: "Move three boxes and a heavy dresser up two flights.",
    category: "moving",
    expectedAnswers: { item_count: 4, stairs: true, stair_flights: 2, large_items: true },
  },
  {
    input: "Carry two chairs downstairs; no vehicle needed.",
    category: "moving",
    expectedAnswers: { item_count: 2, stairs: true, vehicle_required: false },
  },
  {
    input: "Move a bulky wardrobe and one lamp.",
    category: "moving",
    expectedAnswers: { item_count: 2, large_items: true },
  },
  {
    input: "Move six boxes; a van is required.",
    category: "moving",
    expectedAnswers: { item_count: 6, vehicle_required: true },
  },
  {
    input: "Carry a couch and table upstairs three flights.",
    category: "moving",
    expectedAnswers: { item_count: 2, stairs: true, stair_flights: 3 },
  },
  {
    input: "Move one oversized desk into the house.",
    category: "moving",
    expectedAnswers: { item_count: 1, large_items: true },
  },
  {
    input: "Take four boxes downstairs.",
    category: "moving",
    expectedAnswers: { item_count: 4, stairs: true },
  },
  {
    input: "Move two mattresses and three boxes; need a truck.",
    category: "moving",
    expectedAnswers: { item_count: 5, vehicle_required: true },
  },
  {
    input: "Carry one heavy cabinet across the room.",
    category: "moving",
    expectedAnswers: { item_count: 1, large_items: true },
  },
  {
    input: "Move five chairs; no van required.",
    category: "moving",
    expectedAnswers: { item_count: 5, vehicle_required: false },
  },
  {
    input: "Assemble two bookshelves and mount them on drywall.",
    category: "assembly",
    expectedAnswers: { assembly_count: 2, assembly_type: "bookshelves", wall_mounting: true, wall_type: "drywall" },
  },
  {
    input: "Put together a desk.",
    category: "assembly",
    expectedAnswers: { assembly_count: 1, assembly_type: "desk" },
  },
  {
    input: "Mount four shelves on brick.",
    category: "assembly",
    expectedAnswers: { assembly_count: 4, assembly_type: "shelves", wall_mounting: true, wall_type: "brick" },
  },
  {
    input: "Assemble three stools and one table.",
    category: "assembly",
    expectedAnswers: { assembly_count: 4, assembly_type: "stools and table" },
  },
  {
    input: "Need a wardrobe assembled.",
    category: "assembly",
    expectedAnswers: { assembly_count: 1, assembly_type: "wardrobe" },
  },
  {
    input: "Put together two cabinets.",
    category: "assembly",
    expectedAnswers: { assembly_count: 2, assembly_type: "cabinets" },
  },
  {
    input: "Mount one TV bracket on concrete.",
    category: "assembly",
    expectedAnswers: { assembly_count: 1, assembly_type: "tv bracket", wall_mounting: true, wall_type: "concrete" },
  },
  {
    input: "Assemble four dining chairs.",
    category: "assembly",
    expectedAnswers: { assembly_count: 4, assembly_type: "dining chairs" },
  },
  {
    input: "Mount two racks on drywall and assemble one bench.",
    category: "assembly",
    expectedAnswers: { assembly_count: 3, assembly_type: "racks and bench", wall_mounting: true, wall_type: "drywall" },
  },
  {
    input: "I need a small cabinet put together.",
    category: "assembly",
    expectedAnswers: { assembly_count: 1, assembly_type: "cabinet" },
  },
  {
    input: "Deliver a mirror; a van is required.",
    category: "delivery",
    expectedAnswers: { delivery_item: "mirror" },
  },
  {
    input: "Bring my laptop to the office, no vehicle needed.",
    category: "delivery",
    expectedAnswers: { delivery_item: "laptop" },
  },
  {
    input: "Pick up a dresser and carry it upstairs.",
    category: "moving",
    expectedAnswers: {  },
  },
  {
    input: "Deliver a fragile glass vase.",
    category: "delivery",
    expectedAnswers: { delivery_item: "glass vase", heavy_or_fragile: true },
  },
  {
    input: "Bring the dining table to my apartment; a truck is needed.",
    category: "delivery",
    expectedAnswers: { delivery_item: "dining table" },
  },
  {
    input: "Pick up the package and take it downstairs.",
    category: "moving",
    expectedAnswers: {  },
  },
  {
    input: "Deliver a TV with no vehicle required.",
    category: "delivery",
    expectedAnswers: { delivery_item: "TV" },
  },
  {
    input: "Bring a heavy cabinet to my house.",
    category: "delivery",
    expectedAnswers: { delivery_item: "cabinet", heavy_or_fragile: true },
  },
  {
    input: "Pick up a small desk and deliver it to my office.",
    category: "delivery",
    expectedAnswers: { delivery_item: "desk" },
  },
  {
    input: "Deliver the artwork carefully; it's fragile.",
    category: "delivery",
    expectedAnswers: { delivery_item: "artwork", heavy_or_fragile: true },
  },
  {
    input: "Fix a loose cabinet hinge.",
    category: "handyman",
    expectedAnswers: {  },
  },
  {
    input: "Repair the handrail.",
    category: "handyman",
    expectedAnswers: {  },
  },
  {
    input: "Fix a hole in the drywall.",
    category: "handyman",
    expectedAnswers: {  },
  },
  {
    input: "Repair the broken garden gate.",
    category: "handyman",
    expectedAnswers: {  },
  },
  {
    input: "Tighten the loose shelf bracket.",
    category: "handyman",
    expectedAnswers: {  },
  },
  {
    input: "Fix the sticking closet door.",
    category: "handyman",
    expectedAnswers: {  },
  },
  {
    input: "Repair a loose stair railing.",
    category: "handyman",
    expectedAnswers: {  },
  },
  {
    input: "Fix the wooden fence latch.",
    category: "handyman",
    expectedAnswers: {  },
  },
  {
    input: "Repair a cracked cabinet door.",
    category: "handyman",
    expectedAnswers: {  },
  },
  {
    input: "Tighten a loose door handle.",
    category: "handyman",
    expectedAnswers: {  },
  },
  {
    input: "Inspect the roof around a damaged vent.",
    category: "home_services",
    expectedAnswers: {  },
  },
  {
    input: "Check the chimney for an issue.",
    category: "home_services",
    expectedAnswers: {  },
  },
  {
    input: "Service the garage door mechanism.",
    category: "home_services",
    expectedAnswers: {  },
  },
  {
    input: "Inspect the attic vent.",
    category: "home_services",
    expectedAnswers: {  },
  },
  {
    input: "Check the damaged roof flashing.",
    category: "home_services",
    expectedAnswers: {  },
  },
  {
    input: "Inspect the bathroom exhaust vent.",
    category: "home_services",
    expectedAnswers: {  },
  },
  {
    input: "Service the window mechanism.",
    category: "home_services",
    expectedAnswers: {  },
  },
  {
    input: "Inspect the chimney cap.",
    category: "home_services",
    expectedAnswers: {  },
  },
  {
    input: "Check the roof vent.",
    category: "home_services",
    expectedAnswers: {  },
  },
  {
    input: "Service the broken garage door opener.",
    category: "home_services",
    expectedAnswers: {  },
  },
  {
    input: "Replace the brake pads on my 2019 Civic.",
    category: "auto",
    expectedAnswers: {  },
  },
  {
    input: "My 2021 Corolla won't start and cannot be driven.",
    category: "auto",
    expectedAnswers: {  },
  },
  {
    input: "Change the oil on my Ford Fiesta.",
    category: "auto",
    expectedAnswers: {  },
  },
  {
    input: "Replace a taillight on my 2018 Accord.",
    category: "auto",
    expectedAnswers: {  },
  },
  {
    input: "The car still drives but needs a new battery.",
    category: "auto",
    expectedAnswers: {  },
  },
  {
    input: "Inspect a transmission problem on my vehicle.",
    category: "auto",
    expectedAnswers: {  },
  },
  {
    input: "Replace the wiper blades on my Camry.",
    category: "auto",
    expectedAnswers: {  },
  },
  {
    input: "Need tire replacement on a 2020 Civic.",
    category: "auto",
    expectedAnswers: {  },
  },
  {
    input: "My Honda Fit needs an oil change.",
    category: "auto",
    expectedAnswers: {  },
  },
  {
    input: "Replace the headlight on my Corolla.",
    category: "auto",
    expectedAnswers: {  },
  },
  {
    input: "Birthday party for 35 guests.",
    category: "events",
    expectedAnswers: { guest_count: 35 },
  },
  {
    input: "Wedding reception for 120 people.",
    category: "events",
    expectedAnswers: { guest_count: 120 },
  },
  {
    input: "Corporate banquet for 80 attendees.",
    category: "events",
    expectedAnswers: { guest_count: 80 },
  },
  {
    input: "Baby shower with 25 guests.",
    category: "events",
    expectedAnswers: { guest_count: 25 },
  },
  {
    input: "Anniversary dinner for 18 people.",
    category: "events",
    expectedAnswers: { guest_count: 18 },
  },
  {
    input: "Graduation party for 50 guests.",
    category: "events",
    expectedAnswers: { guest_count: 50 },
  },
  {
    input: "Small reception for 30 attendees.",
    category: "events",
    expectedAnswers: { guest_count: 30 },
  },
  {
    input: "Office party for 60 people.",
    category: "events",
    expectedAnswers: { guest_count: 60 },
  },
  {
    input: "Engagement party with 40 guests.",
    category: "events",
    expectedAnswers: { guest_count: 40 },
  },
  {
    input: "Dinner event for 22 people.",
    category: "events",
    expectedAnswers: { guest_count: 22 },
  },
  {
    input: "Walk two dogs and feed them.",
    category: "pet_care",
    expectedAnswers: { pet_type: "dog", pet_count: 2, care_type: ["walking", "feeding"] },
  },
  {
    input: "Feed one cat and sit with her.",
    category: "pet_care",
    expectedAnswers: { pet_type: "cat", pet_count: 1, care_type: ["feeding", "sitting"] },
  },
  {
    input: "Need someone to walk my dog.",
    category: "pet_care",
    expectedAnswers: { pet_type: "dog", care_type: ["walking"] },
  },
  {
    input: "Pet-sit three cats.",
    category: "pet_care",
    expectedAnswers: { pet_type: "cat", pet_count: 3, care_type: ["sitting"] },
  },
  {
    input: "Feed four dogs.",
    category: "pet_care",
    expectedAnswers: { pet_type: "dog", pet_count: 4, care_type: ["feeding"] },
  },
  {
    input: "Walk and sit with one puppy.",
    category: "pet_care",
    expectedAnswers: { pet_type: "dog", pet_count: 1, care_type: ["walking", "sitting"] },
  },
  {
    input: "Take care of two cats.",
    category: "pet_care",
    expectedAnswers: { pet_type: "cat", pet_count: 2 },
  },
  {
    input: "Feed and walk three dogs.",
    category: "pet_care",
    expectedAnswers: { pet_type: "dog", pet_count: 3, care_type: ["feeding", "walking"] },
  },
  {
    input: "Sit with my cat.",
    category: "pet_care",
    expectedAnswers: { pet_type: "cat", care_type: ["sitting"] },
  },
  {
    input: "Walk one dog and feed him afterward.",
    category: "pet_care",
    expectedAnswers: { pet_type: "dog", pet_count: 1, care_type: ["walking", "feeding"] },
  },
  {
    input: "Repaint the bedroom walls; the surface is already prepared.",
    category: "painting",
    expectedAnswers: { painting_surface: "interior_walls", painting_area: "bedroom", prep_needed: false },
  },
  {
    input: "Paint the outside walls of the garage; I'll provide the paint.",
    category: "painting",
    expectedAnswers: { painting_surface: "exterior_walls", painting_area: "garage", paint_provided: true },
  },
  {
    input: "The office ceiling needs two coats.",
    category: "painting",
    expectedAnswers: { painting_surface: "ceiling", painting_area: "office", coat_count: 2 },
  },
  {
    input: "Paint the deck; it needs sanding first.",
    category: "painting",
    expectedAnswers: { painting_surface: "deck", prep_needed: true },
  },
  {
    input: "Kitchen walls are peeling and need repainting.",
    category: "painting",
    expectedAnswers: { painting_surface: "interior_walls", painting_area: "kitchen", existing_damage: true },
  },
  {
    input: "Paint the nursery walls; you'll need to supply the paint.",
    category: "painting",
    expectedAnswers: { painting_surface: "interior_walls", painting_area: "nursery", paint_provided: false },
  },
  {
    input: "Repaint the front door; the paint is already here.",
    category: "painting",
    expectedAnswers: { painting_surface: "doors", paint_provided: true },
  },
  {
    input: "Paint the fence with three coats.",
    category: "painting",
    expectedAnswers: { painting_surface: "fence", coat_count: 3 },
  },
  {
    input: "Patch the cracked wall and paint it afterward.",
    category: "painting",
    expectedAnswers: { painting_surface: "interior_walls", existing_damage: true, prep_needed: true },
  },
  {
    input: "Paint the living room walls; they're ready for paint.",
    category: "painting",
    expectedAnswers: { painting_surface: "interior_walls", painting_area: "living room", prep_needed: false },
  },
  {
    input: "The kitchen faucet is dripping right now.",
    category: "plumbing",
    expectedAnswers: { plumbing_fixture: "faucet", plumbing_issue: "leak", active_leak: true },
  },
  {
    input: "Bathroom sink is clogged but not leaking.",
    category: "plumbing",
    expectedAnswers: { plumbing_fixture: "sink", plumbing_issue: "clog", active_leak: false },
  },
  {
    input: "Install a new toilet; I already bought it.",
    category: "plumbing",
    expectedAnswers: { plumbing_fixture: "toilet", plumbing_issue: "installation", parts_provided: true },
  },
  {
    input: "Replace the bathtub; I don't have the replacement.",
    category: "plumbing",
    expectedAnswers: { plumbing_fixture: "bathtub", plumbing_issue: "replacement", parts_provided: false },
  },
  {
    input: "Shower water pressure is very weak.",
    category: "plumbing",
    expectedAnswers: { plumbing_fixture: "shower", plumbing_issue: "low_pressure" },
  },
  {
    input: "Repair the water heater; there is no leak.",
    category: "plumbing",
    expectedAnswers: { plumbing_fixture: "water_heater", plumbing_issue: "repair", active_leak: false },
  },
  {
    input: "The pipe under the sink is leaking; I can reach the shutoff valve.",
    category: "plumbing",
    expectedAnswers: { plumbing_fixture: "pipe", plumbing_issue: "leak", active_leak: true, water_shutoff_available: true },
  },
  {
    input: "Faucet is leaking and I cannot access the water shutoff.",
    category: "plumbing",
    expectedAnswers: { plumbing_fixture: "faucet", plumbing_issue: "leak", active_leak: true, water_shutoff_available: false },
  },
  {
    input: "Need a new shower installed; provider must bring the parts.",
    category: "plumbing",
    expectedAnswers: { plumbing_fixture: "shower", plumbing_issue: "installation", parts_provided: false },
  },
  {
    input: "Replace a leaking pipe; the replacement pipe is on site.",
    category: "plumbing",
    expectedAnswers: { plumbing_fixture: "pipe", plumbing_issue: "replacement", active_leak: true, parts_provided: true },
  },
  {
    input: "Install a new outlet; this wall already has wiring.",
    category: "electrical",
    expectedAnswers: { electrical_fixture: "outlet", electrical_issue: "installation", existing_wiring: true },
  },
  {
    input: "Replace the light switch; I already have the replacement.",
    category: "electrical",
    expectedAnswers: { electrical_fixture: "switch", electrical_issue: "replacement", parts_provided: true },
  },
  {
    input: "The ceiling fan is flickering and power is still on.",
    category: "electrical",
    expectedAnswers: { electrical_fixture: "ceiling_fan", electrical_issue: "flickering", power_available: true },
  },
  {
    input: "Need a new ceiling fan; there is no existing wiring.",
    category: "electrical",
    expectedAnswers: { electrical_fixture: "ceiling_fan", electrical_issue: "installation", existing_wiring: false },
  },
  {
    input: "Replace a breaker inside the panel.",
    category: "electrical",
    expectedAnswers: { electrical_fixture: "breaker", electrical_issue: "replacement", panel_involved: true },
  },
  {
    input: "The outlet has no power.",
    category: "electrical",
    expectedAnswers: { electrical_fixture: "outlet", electrical_issue: "not_working", power_available: false },
  },
  {
    input: "Install a doorbell; I bought it already.",
    category: "electrical",
    expectedAnswers: { electrical_fixture: "doorbell", electrical_issue: "installation", parts_provided: true },
  },
  {
    input: "Repair the electrical panel.",
    category: "electrical",
    expectedAnswers: { electrical_fixture: "panel", electrical_issue: "repair", panel_involved: true },
  },
  {
    input: "Replace the outlet only; the panel is not involved.",
    category: "electrical",
    expectedAnswers: { electrical_fixture: "outlet", electrical_issue: "replacement", panel_involved: false },
  },
  {
    input: "The light is flickering but still has power.",
    category: "electrical",
    expectedAnswers: { electrical_fixture: "light", electrical_issue: "flickering", power_available: true },
  },
  {
    input: "Need some help tomorrow.",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "Looking for someone for a quick job.",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "Can somebody come by later?",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "I need a person for a few hours.",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "Need general help at home.",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "Looking for reliable assistance.",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "Can someone handle a small task?",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "Need help this afternoon.",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "I've got something that needs doing.",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "Need somebody nearby.",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "Can someone check something for me?",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "Looking for help next week.",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "Need a worker for a short job.",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "Can someone stop by in the morning?",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "Need a hand with something.",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "I have a task but no details yet.",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "Looking for someone experienced.",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "Need assistance for a couple of hours.",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "Can somebody help at my place?",
    category: undefined,
    expectedAnswers: {  },
  },
  {
    input: "Need someone available soon.",
    category: undefined,
    expectedAnswers: {  },
  },
];

const UNORDERED_KEYS = new Set(['debris_type', 'care_type', 'event_help_type']);
function answersEqual(key: string, actual: unknown, expected: unknown): boolean {
  if (UNORDERED_KEYS.has(key) && Array.isArray(actual) && Array.isArray(expected)) {
    return [...actual].map(String).sort().join('\0') === [...expected].map(String).sort().join('\0');
  }
  return isDeepStrictEqual(actual, expected);
}

async function main(): Promise<void> {
  const failures: string[] = [];
  let categoryMismatches = 0;
  let expectedAnswerMismatches = 0;
  let failedCases = 0;

  for (const testCase of validation150) {
    let failed = false;
    const classification = await classifyTask(testCase.input);
    const expectedCategory = testCase.category === 'other' ? null : testCase.category;
    const expectedClarification = testCase.category === 'other' || testCase.category === undefined;
    const actualCategoryMatches = expectedClarification
      ? (classification.category === null || classification.category === undefined) && classification.needsClarification
      : classification.category === expectedCategory;
    if (!actualCategoryMatches) {
      categoryMismatches += 1; failed = true;
      failures.push([`Input: "${testCase.input}"`, 'Mismatch type: category', `Expected: ${expectedCategory ?? 'undefined (needs clarification)'}`, `Actual: ${classification.category ?? 'undefined'}`].join('\n'));
    }
    const answers = extractIntakePrefill(testCase.input, testCase.category ?? 'other').answers;
    for (const [key, expected] of Object.entries(testCase.expectedAnswers)) {
      if (!answersEqual(key, answers[key], expected)) {
        expectedAnswerMismatches += 1; failed = true;
        failures.push([`Input: "${testCase.input}"`, `Mismatch type: expected answer (${key})`, `Expected: ${JSON.stringify(expected)}`, `Actual: ${JSON.stringify(answers[key])}`].join('\n'));
      }
    }
    if (failed) failedCases += 1;
  }

  console.log(`Validation 150 cases: ${validation150.length}`);
  console.log(`Category mismatches: ${categoryMismatches}`);
  console.log(`Expected-answer mismatches: ${expectedAnswerMismatches}`);
  console.log(`Cases passed: ${validation150.length - failedCases}`);
  console.log(`Cases failed: ${failedCases}`);
  if (failures.length) { console.error(`\nValidation failures: ${failures.length}`); failures.forEach((failure, index) => console.error(`\n${index + 1}. ${failure}`)); process.exitCode = 1; }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });


