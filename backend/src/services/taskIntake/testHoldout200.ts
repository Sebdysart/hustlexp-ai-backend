import { isDeepStrictEqual } from 'node:util';
import { classifyTask } from '../taskClassification/classifyTask.js';
import { extractIntakePrefill } from './extractPrefill.js';
import type { TaskCategory } from './types.js';

type HoldoutCase = {
  input: string;
  category: TaskCategory;
  expectedAnswers: Record<string, unknown>;
};

const UNORDERED_ANSWER_KEYS = new Set([
  'debris_type',
  'care_type',
  'event_help_type',
]);

function answersEqual(
  key: string,
  actual: unknown,
  expected: unknown,
): boolean {
  if (UNORDERED_ANSWER_KEYS.has(key) && Array.isArray(actual) && Array.isArray(expected)) {
    const normalize = (value: unknown) => String(value).toLowerCase();
    return [...actual].map(normalize).sort().join('\u0000') === [...expected].map(normalize).sort().join('\u0000');
  }

  if (key === 'access_restrictions' && typeof actual === 'string' && typeof expected === 'string') {
    const semantic = (value: string): string => {
      const text = value.toLowerCase();
      if (/floor/.test(text)) return 'floor';
      if (/elevator/.test(text)) return 'elevator';
      if (/stair|upstairs|downstairs/.test(text)) return 'stairs';
      return text.replace(/\s+/g, ' ').trim();
    };
    return semantic(actual) === semantic(expected);
  }

  return isDeepStrictEqual(actual, expected);
}

const cases: HoldoutCase[] = [{
  input: 'Could you repaint the lounge walls? They\'re already prepped.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'interior_walls',
    painting_area: 'lounge',
    prep_needed: false,
  },
},

{
  input: 'Need the ceiling in the guest room painted, two coats please.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'ceiling',
    painting_area: 'guest room',
    coat_count: 2,
  },
},

{
  input: 'Paint the backyard fence. I have the paint here.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'fence',
    paint_provided: true,
  },
},

{
  input: 'Repaint our front door, no prep required.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'doors',
    prep_needed: false,
  },
},

{
  input: 'The outside walls need a fresh coat.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'exterior_walls',
  },
},

{
  input: 'Please paint the deck after sanding it.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'deck',
    prep_needed: true,
  },
},

{
  input: 'Kitchen walls need painting and you\'ll need to bring the paint.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'interior_walls',
    painting_area: 'kitchen',
    paint_provided: false,
  },
},

{
  input: 'Bedroom walls are peeling and need repainting.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'interior_walls',
    painting_area: 'bedroom',
    existing_damage: true,
  },
},

{
  input: 'Can you paint the trim in the hallway?',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'trim',
    painting_area: 'hallway',
  },
},

{
  input: 'Paint three doors, one coat each.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'doors',
    coat_count: 1,
  },
},

{
  input: 'Living room ceiling has water damage and needs repainting.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'ceiling',
    painting_area: 'living room',
    existing_damage: true,
  },
},

{
  input: 'Paint the fence but leave the gate alone.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'fence',
  },
},

{
  input: 'We bought all the paint already; just do the dining room walls.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'interior_walls',
    painting_area: 'dining room',
    paint_provided: true,
  },
},

{
  input: 'Need the bedroom ceiling primed and painted.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'ceiling',
    painting_area: 'bedroom',
    prep_needed: true,
  },
},

{
  input: 'Repaint the baseboards in two rooms.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'trim',
  },
},

{
  input: 'Paint the exterior of the garage walls.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'exterior_walls',
    painting_area: 'garage',
  },
},

{
  input: 'Deck needs scraping before you paint it.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'deck',
    prep_needed: true,
  },
},

{
  input: 'Paint my office walls. Surface is ready to go.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'interior_walls',
    painting_area: 'office',
    prep_needed: false,
  },
},

{
  input: 'Need four coats on the front door.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'doors',
    coat_count: 4,
  },
},

{
  input: 'The wall has cracks, patch and paint it.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'interior_walls',
    existing_damage: true,
    prep_needed: true,
  },
},

{
  input: 'Paint the nursery walls; paint is already on site.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'interior_walls',
    painting_area: 'nursery',
    paint_provided: true,
  },
},

{
  input: 'Repaint the trim around the living room windows.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'trim',
    painting_area: 'living room',
  },
},

{
  input: 'Paint the patio deck, I don\'t have paint.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'deck',
    paint_provided: false,
  },
},

{
  input: 'Sand the old finish and repaint the fence.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'fence',
    prep_needed: true,
  },
},

{
  input: 'Please paint the bathroom ceiling.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'ceiling',
    painting_area: 'bathroom',
  },
},

{
  input: 'Paint the inside walls of the garage.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'interior_walls',
    painting_area: 'garage',
  },
},

{
  input: 'The front door paint is peeling; repaint it.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'doors',
    existing_damage: true,
  },
},

{
  input: 'Paint the house.',

  category: 'painting',

  expectedAnswers: {},
},

{
  input: 'Need painting in the bedroom, not sure what surface yet.',

  category: 'painting',

  expectedAnswers: {
    painting_area: 'bedroom',
  },
},

{
  input: 'Paint the living room walls with three coats; I\'ll supply the paint.',

  category: 'painting',

  expectedAnswers: {
    painting_surface: 'interior_walls',
    painting_area: 'living room',
    coat_count: 3,
    paint_provided: true,
  },
},

{
  input: 'The pipe below the kitchen sink is leaking right now.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'pipe',
    plumbing_issue: 'leak',
    active_leak: true,
  },
},

{
  input: 'Toilet is blocked but it\'s not leaking.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'toilet',
    plumbing_issue: 'clog',
    active_leak: false,
  },
},

{
  input: 'Please install the new faucet I bought.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'faucet',
    plumbing_issue: 'installation',
    parts_provided: true,
  },
},

{
  input: 'Replace the bathroom sink; there is no leak.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'sink',
    plumbing_issue: 'replacement',
    active_leak: false,
  },
},

{
  input: 'Shower pressure is really weak.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'shower',
    plumbing_issue: 'low_pressure',
  },
},

{
  input: 'The tub drain is clogged.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'drain',
    plumbing_issue: 'clog',
  },
},

{
  input: 'Faucet is dripping at the moment.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'faucet',
    plumbing_issue: 'leak',
    active_leak: true,
  },
},

{
  input: 'Water heater needs to be repaired.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'water_heater',
    plumbing_issue: 'repair',
  },
},

{
  input: 'No water comes out of the bathroom faucet.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'faucet',
    plumbing_issue: 'no_water',
  },
},

{
  input: 'Replace this leaking pipe; the new pipe is already here.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'pipe',
    plumbing_issue: 'replacement',
    active_leak: true,
    parts_provided: true,
  },
},

{
  input: 'The sink isn\'t leaking, it\'s just blocked.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'sink',
    plumbing_issue: 'clog',
    active_leak: false,
  },
},

{
  input: 'The leak stopped this morning.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_issue: 'leak',
    active_leak: false,
  },
},

{
  input: 'Faucet stopped dripping overnight.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'faucet',
    plumbing_issue: 'leak',
    active_leak: false,
  },
},

{
  input: 'Pipe is not leaking.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'pipe',
    active_leak: false,
  },
},

{
  input: 'Water pressure is low and there isn\'t any leak.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_issue: 'low_pressure',
    active_leak: false,
  },
},

{
  input: 'Install a toilet. I already have the toilet.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'toilet',
    plumbing_issue: 'installation',
    parts_provided: true,
  },
},

{
  input: 'Need a new shower installed, parts are not provided.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'shower',
    plumbing_issue: 'installation',
    parts_provided: false,
  },
},

{
  input: 'The sink drain is blocked.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'drain',
    plumbing_issue: 'clog',
  },
},

{
  input: 'Pipe behind the toilet is leaking.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'pipe',
    plumbing_issue: 'leak',
    active_leak: true,
  },
},

{
  input: 'I can access the water shutoff, the faucet is leaking.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'faucet',
    plumbing_issue: 'leak',
    active_leak: true,
    water_shutoff_available: true,
  },
},

{
  input: 'Can\'t get to the shutoff valve; sink is leaking.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'sink',
    plumbing_issue: 'leak',
    active_leak: true,
    water_shutoff_available: false,
  },
},

{
  input: 'Replace the faucet, I don\'t have the new one.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'faucet',
    plumbing_issue: 'replacement',
    parts_provided: false,
  },
},

{
  input: 'The shower drain is clogged but there is no leak.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'drain',
    plumbing_issue: 'clog',
    active_leak: false,
  },
},

{
  input: 'The pipe was leaking yesterday but has stopped.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'pipe',
    plumbing_issue: 'leak',
    active_leak: false,
  },
},

{
  input: 'Kitchen tap has no water.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'faucet',
    plumbing_issue: 'no_water',
  },
},

{
  input: 'Repair the toilet.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'toilet',
    plumbing_issue: 'repair',
  },
},

{
  input: 'I bought the faucet but not the fittings; it needs installing.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'faucet',
    plumbing_issue: 'installation',
  },
},

{
  input: 'The bathtub needs replacing.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'bathtub',
    plumbing_issue: 'replacement',
  },
},

{
  input: 'Drain is slow, not completely clogged.',

  category: 'plumbing',

  expectedAnswers: {
    plumbing_fixture: 'drain',
  },
},

{
  input: 'Need plumbing help in the bathroom.',

  category: 'plumbing',

  expectedAnswers: {},
},

{
  input: 'Install three ceiling lights; the wiring is already there.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'light',
    electrical_issue: 'installation',
    existing_wiring: true,
  },
},

{
  input: 'Replace the outlet by the bed.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'outlet',
    electrical_issue: 'replacement',
  },
},

{
  input: 'Bathroom light keeps flickering.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'light',
    electrical_issue: 'flickering',
  },
},

{
  input: 'The breaker keeps tripping.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'breaker',
    electrical_issue: 'tripping',
  },
},

{
  input: 'Install a ceiling fan, there is no wiring yet.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'ceiling_fan',
    electrical_issue: 'installation',
    existing_wiring: false,
  },
},

{
  input: 'Replace both switches in the hallway.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'switch',
    electrical_issue: 'replacement',
  },
},

{
  input: 'Doorbell stopped working.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'doorbell',
    electrical_issue: 'not_working',
  },
},

{
  input: 'Put in a new outlet; this wall is already wired.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'outlet',
    electrical_issue: 'installation',
    existing_wiring: true,
  },
},

{
  input: 'Replace the ceiling light; I already bought the fixture.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'light',
    electrical_issue: 'replacement',
    parts_provided: true,
  },
},

{
  input: 'There is no power in the bedroom.',

  category: 'electrical',

  expectedAnswers: {
    power_available: false,
  },
},

{
  input: 'The light works fine, I just want it replaced.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'light',
    electrical_issue: 'replacement',
  },
},

{
  input: 'Breaker is not tripping anymore.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'breaker',
  },
},

{
  input: 'Outlet has power but needs replacing.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'outlet',
    electrical_issue: 'replacement',
    power_available: true,
  },
},

{
  input: 'Install a fan; I already bought it.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'ceiling_fan',
    electrical_issue: 'installation',
    parts_provided: true,
  },
},

{
  input: 'You need to supply the new switch.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'switch',
    parts_provided: false,
  },
},

{
  input: 'Panel is fine, only replace the outlet.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'outlet',
    electrical_issue: 'replacement',
    panel_involved: false,
  },
},

{
  input: 'Replace a breaker in the electrical panel.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'breaker',
    electrical_issue: 'replacement',
    panel_involved: true,
  },
},

{
  input: 'The switch still works, replace it anyway.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'switch',
    electrical_issue: 'replacement',
  },
},

{
  input: 'Install a doorbell, wiring already exists.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'doorbell',
    electrical_issue: 'installation',
    existing_wiring: true,
  },
},

{
  input: 'The outlet stopped working yesterday.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'outlet',
    electrical_issue: 'not_working',
  },
},

{
  input: 'Light is flickering but power is still on.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'light',
    electrical_issue: 'flickering',
    power_available: true,
  },
},

{
  input: 'Need a new ceiling fan, no existing wiring.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'ceiling_fan',
    electrical_issue: 'installation',
    existing_wiring: false,
  },
},

{
  input: 'Replace the light switch; I have the replacement already.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'switch',
    electrical_issue: 'replacement',
    parts_provided: true,
  },
},

{
  input: 'Install two outlets, provider needs to bring them.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'outlet',
    electrical_issue: 'installation',
    parts_provided: false,
  },
},

{
  input: 'Electrical panel needs repair.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'panel',
    electrical_issue: 'repair',
    panel_involved: true,
  },
},

{
  input: 'The breaker stopped tripping.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'breaker',
  },
},

{
  input: 'Doorbell works but I want a new one installed.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'doorbell',
    electrical_issue: 'installation',
  },
},

{
  input: 'No power at the outlet.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'outlet',
    power_available: false,
  },
},

{
  input: 'The ceiling fan is noisy but still works.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'ceiling_fan',
  },
},

{
  input: 'Need electrical help in the kitchen.',

  category: 'electrical',

  expectedAnswers: {},
},

{
  input: 'Rake leaves across a tiny backyard.',

  category: 'yard',

  expectedAnswers: {
    yard_size: 'small',
    debris_type: [
      'leaves',
    ],
  },
},

{
  input: 'Clear branches from a big lawn and haul them away.',

  category: 'yard',

  expectedAnswers: {
    yard_size: 'large',
    debris: true,
    debris_type: [
      'branches',
    ],
  },
},

{
  input: 'Average-sized yard needs leaves bagged and left by the shed.',

  category: 'yard',

  expectedAnswers: {
    yard_size: 'medium',
    debris: false,
    debris_type: [
      'leaves',
    ],
  },
},

{
  input: 'Remove rubbish and green waste from the yard.',

  category: 'yard',

  expectedAnswers: {
    debris: true,
    debris_type: [
      'junk',
      'green_waste',
    ],
  },
},

{
  input: 'I have a rake and blower here for the cleanup.',

  category: 'yard',

  expectedAnswers: {
    equipment_provided: true,
  },
},

{
  input: 'Bring your own yard tools; there are branches everywhere.',

  category: 'yard',

  expectedAnswers: {
    equipment_provided: false,
    debris_type: [
      'branches',
    ],
  },
},

{
  input: 'Small front lawn covered with pine needles.',

  category: 'yard',

  expectedAnswers: {
    yard_size: 'small',
    debris_type: [
      'green_waste',
    ],
  },
},

{
  input: 'Pile the cut branches by the fence, don\'t take them.',

  category: 'yard',

  expectedAnswers: {
    debris: false,
    debris_type: [
      'branches',
    ],
  },
},

{
  input: 'Clean four rooms in my house.',

  category: 'cleaning',

  expectedAnswers: {
    property_type: 'house',
    room_count: 4,
  },
},

{
  input: 'Office cleaning for seven rooms.',

  category: 'cleaning',

  expectedAnswers: {
    property_type: 'office',
    room_count: 7,
  },
},

{
  input: 'Clean two rooms upstairs and one downstairs.',

  category: 'cleaning',

  expectedAnswers: {
    room_count: 3,
    stairs: true,
    access_restrictions: 'The task involves rooms both upstairs and downstairs.',
  },
},

{
  input: 'Please clean the apartment; I have all the supplies.',

  category: 'cleaning',

  expectedAnswers: {
    supplies_provided: true,
  },
},

{
  input: 'Clean the office and bring your own supplies.',

  category: 'cleaning',

  expectedAnswers: {
    property_type: 'office',
    supplies_provided: false,
  },
},

{
  input: 'Deep clean five rooms in a house.',

  category: 'cleaning',

  expectedAnswers: {
    property_type: 'house',
    room_count: 5,
  },
},

{
  input: 'Clean three rooms, there are no stairs.',

  category: 'cleaning',

  expectedAnswers: {
    room_count: 3,
    stairs: false,
  },
},

{
  input: 'Need the house cleaned, not sure how many rooms yet.',

  category: 'cleaning',

  expectedAnswers: {
    property_type: 'house',
  },
},

{
  input: 'Move eight boxes and two chairs.',

  category: 'moving',

  expectedAnswers: {
    item_count: 10,
  },
},

{
  input: 'Carry a heavy wardrobe up three flights.',

  category: 'moving',

  expectedAnswers: {
    item_count: 1,
    large_items: true,
    stairs: true,
    stair_flights: 3,
    access_restrictions: '3 flights of stairs are involved.',
  },
},

{
  input: 'Move five boxes, no stairs involved.',

  category: 'moving',

  expectedAnswers: {
    item_count: 5,
    stairs: false,
  },
},

{
  input: 'Move a couch and two tables; bring a van.',

  category: 'moving',

  expectedAnswers: {
    item_count: 3,
    large_items: true,
    vehicle_required: true,
  },
},

{
  input: 'Carry four chairs downstairs.',

  category: 'moving',

  expectedAnswers: {
    item_count: 4,
    stairs: true,
    access_restrictions: 'The task involves carrying items downstairs.',
  },
},

{
  input: 'Move six boxes, no vehicle needed.',

  category: 'moving',

  expectedAnswers: {
    item_count: 6,
    vehicle_required: false,
  },
},

{
  input: 'Move a bulky desk and one lamp.',

  category: 'moving',

  expectedAnswers: {
    item_count: 2,
    large_items: true,
  },
},

{
  input: 'Move three boxes up one flight.',

  category: 'moving',

  expectedAnswers: {
    item_count: 3,
    stairs: true,
    stair_flights: 1,
    access_restrictions: '1 flight of stairs is involved.',
  },
},

{
  input: 'Put together two desks and four chairs.',

  category: 'assembly',

  expectedAnswers: {
    assembly_count: 6,
    assembly_type: 'desks and chairs',
  },
},

{
  input: 'Assemble one cabinet and three shelves.',

  category: 'assembly',

  expectedAnswers: {
    assembly_count: 4,
    assembly_type: 'cabinet and shelves',
  },
},

{
  input: 'Mount two shelves on drywall.',

  category: 'assembly',

  expectedAnswers: {
    assembly_count: 2,
    assembly_type: 'shelves',
    wall_mounting: true,
    wall_type: 'drywall',
  },
},

{
  input: 'Assemble a table then mount a shelf on brick.',

  category: 'assembly',

  expectedAnswers: {
    assembly_count: 2,
    assembly_type: 'table and shelf',
    wall_mounting: true,
    wall_type: 'brick',
  },
},

{
  input: 'Put together five dining chairs.',

  category: 'assembly',

  expectedAnswers: {
    assembly_count: 5,
    assembly_type: 'dining chairs',
  },
},

{
  input: 'Assemble one desk and one chair.',

  category: 'assembly',

  expectedAnswers: {
    assembly_count: 2,
    assembly_type: 'desk and chair',
  },
},

{
  input: 'Mount three shelves on brick.',

  category: 'assembly',

  expectedAnswers: {
    assembly_count: 3,
    assembly_type: 'shelves',
    wall_mounting: true,
    wall_type: 'brick',
  },
},

{
  input: 'Need a cabinet assembled.',

  category: 'assembly',

  expectedAnswers: {
    assembly_count: 1,
    assembly_type: 'cabinet',
  },
},

{
  input: 'Deliver a fragile mirror to my apartment.',

  category: 'delivery',

  expectedAnswers: {
    delivery_item: 'mirror',
    heavy_or_fragile: true,
  },
},

{
  input: 'Bring two lamps and a vase.',

  category: 'delivery',

  expectedAnswers: {
    delivery_item: 'lamps and vase',
  },
},

{
  input: 'Pick up a heavy cabinet and deliver it here.',

  category: 'delivery',

  expectedAnswers: {
    delivery_item: 'cabinet',
    heavy_or_fragile: true,
  },
},

{
  input: 'Deliver a glass table; a truck is needed.',

  category: 'delivery',

  expectedAnswers: {
    delivery_item: 'glass table',
    vehicle_required: true,
  },
},

{
  input: 'Bring a TV, no vehicle is required.',

  category: 'delivery',

  expectedAnswers: {
    delivery_item: 'TV',
    vehicle_required: false,
  },
},

{
  input: 'Pick up a sofa and bring it upstairs.',

  category: 'delivery',

  expectedAnswers: {
    delivery_item: 'couch',
    stairs: true,
    access_restrictions: 'The task involves carrying items upstairs.',
  },
},

{
  input: 'Deliver a breakable lamp.',

  category: 'delivery',

  expectedAnswers: {
    delivery_item: 'lamp',
    heavy_or_fragile: true,
  },
},

{
  input: 'Bring a small desk to my office.',

  category: 'delivery',

  expectedAnswers: {
    delivery_item: 'desk',
  },
},

{
  input: 'Fix the loose wooden fence panel.',

  category: 'handyman',

  expectedAnswers: {},
},

{
  input: 'Repair a hole in the drywall; I have the patching material.',

  category: 'handyman',

  expectedAnswers: {},
},

{
  input: 'Fix the cabinet hinge, bring your own materials.',

  category: 'handyman',

  expectedAnswers: {},
},

{
  input: 'Repair the broken closet door.',

  category: 'handyman',

  expectedAnswers: {},
},

{
  input: 'Tighten and repair the loose handrail.',

  category: 'handyman',

  expectedAnswers: {},
},

{
  input: 'Fix the shelf bracket; no special tools needed.',

  category: 'handyman',

  expectedAnswers: {},
},

{
  input: 'Repair the garden gate, I have the replacement hardware.',

  category: 'handyman',

  expectedAnswers: {},
},

{
  input: 'Need a handyman to fix a loose door frame.',

  category: 'handyman',

  expectedAnswers: {},
},

{
  input: 'Repair my ceiling fan, it has an issue.',

  category: 'electrical',

  expectedAnswers: {
    electrical_fixture: 'ceiling_fan',
    electrical_issue: 'repair',
  },
},

{
  input: 'Inspect the damaged section of the roof.',

  category: 'home_services',

  expectedAnswers: {},
},

{
  input: 'Repair the garage door.',

  category: 'home_services',

  expectedAnswers: {},
},

{
  input: 'Check the damaged bathroom exhaust vent.',

  category: 'home_services',

  expectedAnswers: {},
},

{
  input: 'Service the broken window mechanism.',

  category: 'home_services',

  expectedAnswers: {},
},

{
  input: 'Inspect the attic vent; no visible damage.',

  category: 'home_services',

  expectedAnswers: {},
},

{
  input: 'Repair the patio screen door.',

  category: 'handyman',

  expectedAnswers: {},
},

{
  input: 'Need someone to inspect an issue around the chimney.',

  category: 'home_services',

  expectedAnswers: {},
},

{
  input: 'Replace the brake pads on my 2018 Honda Civic; I bought the pads.',

  category: 'auto',

  expectedAnswers: {},
},

{
  input: 'My 2020 Toyota Corolla won\'t start and can\'t be driven.',

  category: 'auto',

  expectedAnswers: {},
},

{
  input: 'Change the oil on my Ford Focus.',

  category: 'auto',

  expectedAnswers: {},
},

{
  input: 'Replace a headlight on my 2017 Camry; I don\'t have the bulb.',

  category: 'auto',

  expectedAnswers: {},
},

{
  input: 'My car is drivable but needs a battery replacement.',

  category: 'auto',

  expectedAnswers: {},
},

{
  input: 'Need tire replacement on a 2019 Accord.',

  category: 'auto',

  expectedAnswers: {},
},

{
  input: 'The vehicle won\'t move; inspect the transmission issue.',

  category: 'auto',

  expectedAnswers: {},
},

{
  input: 'Replace the wiper blades, I already have them.',

  category: 'auto',

  expectedAnswers: {},
},

{
  input: 'Need setup help for a party with 45 guests.',

  category: 'events',

  expectedAnswers: {
    guest_count: 45,
  },
},

{
  input: 'Corporate dinner for 120 people.',

  category: 'events',

  expectedAnswers: {
    guest_count: 120,
  },
},

{
  input: 'Birthday event with around 30 guests.',

  category: 'events',

  expectedAnswers: {
    guest_count: 30,
  },
},

{
  input: 'Help at a wedding reception for 180 people.',

  category: 'events',

  expectedAnswers: {
    guest_count: 180,
  },
},

{
  input: 'Small dinner for 12 guests.',

  category: 'events',

  expectedAnswers: {
    guest_count: 12,
  },
},

{
  input: 'Event setup for 75 attendees.',

  category: 'events',

  expectedAnswers: {
    guest_count: 75,
  },
},

{
  input: 'Need cleanup help after a party for 60 people.',

  category: 'events',

  expectedAnswers: {
    guest_count: 60,
  },
},

{
  input: 'Community event for roughly 250 guests.',

  category: 'events',

  expectedAnswers: {
    guest_count: 250,
  },
},

{
  input: 'Walk three dogs this evening.',

  category: 'pet_care',

  expectedAnswers: {
    pet_type: 'dog',
    pet_count: 3,
    care_type: [
      'walking',
    ],
  },
},

{
  input: 'Watch two cats for the afternoon.',

  category: 'pet_care',

  expectedAnswers: {
    pet_type: 'cat',
    pet_count: 2,
    care_type: [
      'sitting',
    ],
  },
},

{
  input: 'Feed and walk one dog.',

  category: 'pet_care',

  expectedAnswers: {
    pet_type: 'dog',
    pet_count: 1,
    care_type: [
      'feeding',
      'walking',
    ],
  },
},

{
  input: 'Sit with four cats and feed them.',

  category: 'pet_care',

  expectedAnswers: {
    pet_type: 'cat',
    pet_count: 4,
    care_type: [
      'sitting',
      'feeding',
    ],
  },
},

{
  input: 'Walk two dogs and watch them afterward.',

  category: 'pet_care',

  expectedAnswers: {
    pet_type: 'dog',
    pet_count: 2,
    care_type: [
      'walking',
      'sitting',
    ],
  },
},

{
  input: 'Feed three cats while I\'m away.',

  category: 'pet_care',

  expectedAnswers: {
    pet_type: 'cat',
    pet_count: 3,
    care_type: [
      'feeding',
    ],
  },
},

{
  input: 'Watch one dog for a few hours.',

  category: 'pet_care',

  expectedAnswers: {
    pet_type: 'dog',
    pet_count: 1,
    care_type: [
      'sitting',
    ],
  },
},

{
  input: 'Walk four dogs and feed them when you get back.',

  category: 'pet_care',

  expectedAnswers: {
    pet_type: 'dog',
    pet_count: 4,
    care_type: [
      'walking',
      'feeding',
    ],
  },
},

{
  input: 'Need someone today.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Can somebody help me with something at home?',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'I need a person for a quick job.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Need help ASAP, details later.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Looking for someone nearby.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Need a worker for about an hour.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Can someone come over tomorrow?',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'I have a small job.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Need help around the house.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Looking for general assistance.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Can someone handle this for me?',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Need a hand this weekend.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'I need someone experienced.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Quick task, shouldn\'t take long.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Need help at my place.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Can someone come by in the morning?',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'I\'ve got a job that needs doing.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Need somebody with tools.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Looking for a reliable person.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Need help with a few things.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Can somebody take care of this?',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Need a service person today.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'I have some work that needs attention.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Need someone to sort something out.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Looking for help later this week.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Need a person for a home task.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Can someone help for a couple hours?',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Need somebody to check something.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'I have a task but I\'m not sure what category it is.',

  category: 'other',

  expectedAnswers: {},
},

{
  input: 'Need help, will explain when you arrive.',

  category: 'other',

  expectedAnswers: {},
},
];

async function main(): Promise<void> {
  const failures: string[] = [];
  let categoryMismatches = 0;
  let expectedAnswerMismatches = 0;
  let failedCases = 0;

  for (const testCase of cases) {
    let caseFailed = false;
    const classification = await classifyTask(testCase.input);

    const expectedCategory = testCase.category === 'other' ? null : testCase.category;
    const expectsClarification = testCase.category === 'other';

    if (classification.category !== expectedCategory || (expectsClarification && !classification.needsClarification)) {
      categoryMismatches += 1;
      caseFailed = true;
      failures.push(
        [
          `Input: "${testCase.input}"`,
          'Mismatch type: category',
          `Expected: ${expectedCategory ?? 'undefined (needs clarification)'}`,
          `Actual: ${classification.category ?? 'undefined'}`,
        ].join('\\n'),
      );
    }

    const answers = extractIntakePrefill(
      testCase.input,
      testCase.category,
    ).answers;

    for (const [key, expected] of Object.entries(
      testCase.expectedAnswers,
    )) {
      const actual = answers[key];

      if (!answersEqual(key, actual, expected)) {
        expectedAnswerMismatches += 1;
        caseFailed = true;
        failures.push(
          [
            `Input: "${testCase.input}"`,
            `Mismatch type: expected answer (${key})`,
            `Expected: ${JSON.stringify(expected)}`,
            `Actual: ${JSON.stringify(actual)}`,
          ].join('\\n'),
        );
      }
    }

    if (caseFailed) {
      failedCases += 1;
    }
  }

  console.log(`Holdout 200 cases: ${cases.length}`);
  console.log(`Category mismatches: ${categoryMismatches}`);
  console.log(`Expected-answer mismatches: ${expectedAnswerMismatches}`);
  console.log(`Cases passed: ${cases.length - failedCases}`);
  console.log(`Cases failed: ${failedCases}`);

  if (failures.length > 0) {
    console.error(`\\nHoldout failures: ${failures.length}`);
    failures.forEach((failure, index) => {
      console.error(`\\n${index + 1}. ${failure}`);
    });
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
