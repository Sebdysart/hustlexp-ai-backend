import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { extractIntakePrefill } from './extractPrefill.js';
import { getQuestionsForIntake } from './definitions.js';
import type { IntakeAnswer, TaskCategory } from './types.js';

interface CorpusRow { input: string; expected: TaskCategory; }
interface ExpectedPrefill { input: string; category: TaskCategory; secondaryIntents?: TaskCategory[]; expectedAnswers: Record<string, IntakeAnswer>; }

const CORPUS_PATH = path.resolve(process.cwd(), 'ml', 'task_classifier', 'data', 'tasks.json');

const EXACT_CASES: ExpectedPrefill[] = [
{
  input:
    'Clear leaves from a small backyard and bag everything.',

  category: 'yard',

  expectedAnswers: {
    yard_size:
      'small',

    debris_type:
      true,

    debris_type: ['leaves'],
  },
},

{
  input:
    'Clean up branches and leaves from a large yard.',

  category: 'yard',

  expectedAnswers: {
    yard_size:
      'large',

    debris_type:
      'branches and leaves',
  },
},

{
  input:
    'Remove 6 bags of leaves from my front yard.',

  category: 'yard',

  expectedAnswers: {
    debris_type:
      true,

    debris_type: ['leaves'],
  },
},

{
  input:
    'Mow my small lawn. I have a mower you can use.',

  category: 'yard',

  expectedAnswers: {
    yard_size:
      'small',

    equipment_provided:
      true,
  },
},

{
  input:
    'Mow my backyard but you will need to bring a lawn mower.',

  category: 'yard',

  expectedAnswers: {
    equipment_provided:
      false,
  },
},

{
  input:
    'Clean up sticks, branches, and pine needles around the property.',

  category: 'yard',

  expectedAnswers: {
    debris_type:
      'sticks, branches, and pine needles',
  },
},

{
  input:
    'Clear an overgrown medium-sized backyard.',

  category: 'yard',

  expectedAnswers: {
    yard_size:
      'medium',
  },
},

{
  input:
    'Remove fallen branches from the backyard and haul them away.',

  category: 'yard',

  expectedAnswers: {
    debris_type:
      true,

    debris_type:
      'fallen branches',
  },
},

{
  input:
    'Clean a tiny front yard covered with leaves.',

  category: 'yard',

  expectedAnswers: {
    yard_size:
      'small',

    debris_type: ['leaves'],
  },
},

{
  input:
    'Yard cleanup after a storm. Lots of branches and loose debris.',

  category: 'yard',

  expectedAnswers: {
    debris_type:
      'branches and loose debris',
  },
},

{
  input:
    'Remove weeds and garden debris from a large backyard.',

  category: 'yard',

  expectedAnswers: {
    yard_size:
      'large',

    debris_type:
      'weeds and garden debris',
  },
},

{
  input:
    'Clean my yard but leave all collected debris in bags by the garage.',

  category: 'yard',

  expectedAnswers: {
    debris_type:
      false,

    special_constraints:
      'Collected debris should be left in bags by the garage.',
  },
},

{
  input:
    'Clear the backyard. Access is only through a narrow side gate.',

  category: 'yard',

  expectedAnswers: {
    access_restrictions:
      'Backyard access is only through a narrow side gate.',
  },
},

{
  input:
    'Remove leaves from my backyard. There is no outdoor power outlet.',

  category: 'yard',

  expectedAnswers: {
    special_constraints:
      'There is no outdoor power outlet.',
  },
},

{
  input:
    'Clean a large yard and remove all green waste afterward.',

  category: 'yard',

  expectedAnswers: {
    yard_size:
      'large',

    debris_type:
      true,

    debris_type:
      'green waste',
  },
},

{
  input:
    'Need someone to rake leaves. I have rakes and bags already.',

  category: 'yard',

  expectedAnswers: {
    debris_type: ['leaves'],

    equipment_provided:
      true,
  },
},

{
  input:
    'Clear branches from behind the house. You need to bring your own tools.',

  category: 'yard',

  expectedAnswers: {
    debris_type:
      'branches',

    equipment_provided:
      false,
  },
},

{
  input:
    'Backyard cleanup with leaves, weeds, and some old wood.',

  category: 'yard',

  expectedAnswers: {
    debris_type:
      'leaves, weeds, and old wood',
  },
},

{
  input:
    'Deep clean my 2-bedroom apartment.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'apartment',

    room_count:
      2,

    cleaning_type:
      'deep cleaning',
  },
},

{
  input:
    'Standard cleaning for a 3-bedroom house.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'house',

    room_count:
      3,

    cleaning_type:
      'standard cleaning',
  },
},

{
  input:
    'Move-out cleaning for my one-bedroom apartment.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'apartment',

    room_count:
      1,

    cleaning_type:
      'move-out cleaning',
  },
},

{
  input:
    'Clean a 4-bedroom house before new tenants arrive.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'house',

    room_count:
      4,
  },
},

{
  input:
    'Deep clean my studio apartment. I have all the supplies_provided.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'apartment',

    cleaning_type:
      'deep cleaning',

    supplies_provided:
      true,
  },
},

{
  input:
    'Clean my apartment but please bring your own cleaning supplies_provided.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'apartment',

    supplies_provided:
      false,
  },
},

{
  input:
    'Clean 3 bedrooms and the kitchen.',

  category:
    'cleaning',

  expectedAnswers: {
    room_count:
      3,
  },
},

{
  input:
    'Post-renovation cleaning for a house.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'house',

    cleaning_type:
      'post-renovation cleaning',
  },
},

{
  input:
    'Clean an empty apartment after I move out.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'apartment',

    cleaning_type:
      'move-out cleaning',
  },
},

{
  input:
    'Need a deep clean of my 5-bedroom home.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'house',

    room_count:
      5,

    cleaning_type:
      'deep cleaning',
  },
},

{
  input:
    'Clean my small office after everyone leaves.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'office',

    special_constraints:
      'Cleaning must happen after everyone leaves.',
  },
},

{
  input:
    'Clean my house. supplies_provided are under the kitchen sink.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'house',

    supplies_provided:
      true,
  },
},

{
  input:
    'Deep clean 2 bedrooms. No cleaning products are available here.',

  category:
    'cleaning',

  expectedAnswers: {
    room_count:
      2,

    cleaning_type:
      'deep cleaning',

    supplies_provided:
      false,
  },
},

{
  input:
    'Clean a 2-bedroom Airbnb between guests.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'Airbnb',

    room_count:
      2,
  },
},

{
  input:
    'Move-in cleaning for a three-bedroom townhouse.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'townhouse',

    room_count:
      3,

    cleaning_type:
      'move-in cleaning',
  },
},

{
  input:
    'Clean my apartment but do not enter the locked bedroom.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'apartment',

    access_restrictions:
      'The locked bedroom must not be entered.',
  },
},

{
  input:
    'Need a basic cleaning of my 1-bedroom condo.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'condo',

    room_count:
      1,

    cleaning_type:
      'basic cleaning',
  },
},

{
  input:
    'Clean a vacant 6-bedroom house.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'house',

    room_count:
      6,
  },
},

{
  input:
    'Move 8 boxes to my new apartment.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      8,
  },
},

{
  input:
    'Carry 6 boxes up 3 flights of stairs.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      6,

    stairs:
      true,

    stair_flights:
      3,

    access_restrictions:
      '3 flights of stairs are involved.',
  },
},

{
  input:
    'Move 12 boxes. There is an elevator at both buildings.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      12,

    stairs:
      false,

    access_restrictions:
      'Elevators are available at both buildings.',
  },
},

{
  input:
    'Help move a couch, desk, and bed.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      3,
  },
},

{
  input:
    'Move 20 boxes and one heavy dresser.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      21,

    large_items:
      true,
  },
},

{
  input:
    'Move a 250-pound safe.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      1,

    large_items:
      true,
  },
},

{
  input:
    'I need help moving 10 boxes and I already have a truck.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      10,

    vehicle_required:
      false,
  },
},

{
  input:
    'Move 15 boxes. You will need to provide a van.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      15,

    vehicle_required:
      true,
  },
},

{
  input:
    'Carry a sofa up 5 flights with no elevator.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      1,

    large_items:
      true,

    stairs:
      true,

    stair_flights:
      5,

    access_restrictions:
      'There is no elevator and the sofa must be carried up 5 flights.',
  },
},

{
  input:
    'Move 4 dining chairs downstairs.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      4,

    stairs:
      true,
  },
},

{
  input:
    'Help unload 30 boxes from my moving truck.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      30,

    vehicle_required:
      false,
  },
},

{
  input:
    'Move a refrigerator and washing machine.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      2,

    large_items:
      true,
  },
},

{
  input:
    'Move 5 boxes through a narrow staircase.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      5,

    stairs:
      true,

    access_restrictions:
      'A narrow staircase must be used.',
  },
},

{
  input:
    'Move 40 boxes from a storage unit. Bring a truck.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      40,

    vehicle_required:
      true,
  },
},

{
  input:
    'Move one piano from the first floor.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      1,

    large_items:
      true,
  },
},

{
  input:
    'Move 7 boxes from the basement upstairs.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      7,

    stairs:
      true,
  },
},

{
  input:
    'Move 2 couches but the hallway is very narrow.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      2,

    large_items:
      true,

    access_restrictions:
      'The hallway is very narrow.',
  },
},

{
  input:
    'Move approximately 100 boxes using my rented truck.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      100,

    vehicle_required:
      false,
  },
},

{
  input:
    'Assemble 1 IKEA bed.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'bed',

    item_count:
      1,
  },
},

{
  input:
    'Assemble 6 dining chairs.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'dining chairs',

    item_count:
      6,
  },
},

{
  input:
    'Put together 3 bookshelves.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'bookshelves',

    item_count:
      3,
  },
},

{
  input:
    'Assemble a desk and mount it to the wall.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'desk',

    item_count:
      1,

    wall_mounting:
      true,
  },
},

{
  input:
    'Install 4 floating shelves on drywall.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'floating shelves',

    item_count:
      4,

    wall_mounting:
      true,

    wall_type:
      'drywall',
  },
},

{
  input:
    'Mount two shelves on a brick wall.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'shelves',

    item_count:
      2,

    wall_mounting:
      true,

    wall_type:
      'brick',
  },
},

{
  input:
    'Assemble one wardrobe. No wall mounting needed.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'wardrobe',

    item_count:
      1,

    wall_mounting:
      false,
  },
},

{
  input:
    'Build 5 office desks.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'office desks',

    item_count:
      5,
  },
},

{
  input:
    'Assemble a TV stand.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'TV stand',

    item_count:
      1,
  },
},

{
  input:
    'Put together 2 dressers and anchor both to drywall.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'dressers',

    item_count:
      2,

    wall_mounting:
      true,

    wall_type:
      'drywall',
  },
},

{
  input:
    'Assemble 8 patio chairs.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'patio chairs',

    item_count:
      8,
  },
},

{
  input:
    'Build a trampoline in the backyard.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'trampoline',

    item_count:
      1,
  },
},

{
  input:
    'Assemble a barbecue grill.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'barbecue grill',

    item_count:
      1,
  },
},

{
  input:
    'Mount one TV on concrete.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'TV',

    item_count:
      1,

    wall_mounting:
      true,

    wall_type:
      'concrete',
  },
},

{
  input:
    'Mount 3 cabinets on a plaster wall.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'cabinets',

    item_count:
      3,

    wall_mounting:
      true,

    wall_type:
      'plaster',
  },
},

{
  input:
    'Assemble 25 office desks. Nothing needs mounting.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'office desks',

    item_count:
      25,

    wall_mounting:
      false,
  },
},

{
  input:
    'Build one bookshelf but I do not know what the wall is made of.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'bookshelf',

    item_count:
      1,
  },
},

{
  input:
    'Assemble a crib and attach the included wall anchor.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'crib',

    item_count:
      1,

    wall_mounting:
      true,
  },
},

{
  input:
    'Deliver a couch. A van should be large enough.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'couch',

    vehicle_size:
      'van',
  },
},

{
  input:
    'Pick up a refrigerator and deliver it to my house.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'refrigerator',

    heavy_handling:
      true,
  },
},

{
  input:
    'Deliver a fragile glass table.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'glass table',

    fragile_handling:
      true,
  },
},

{
  input:
    'Pick up 10 boxes using a car.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'boxes',

    vehicle_size:
      'car',
  },
},

{
  input:
    'Transport a large sofa. You will need a pickup truck.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'sofa',

    vehicle_size:
      'pickup truck',

    heavy_handling:
      true,
  },
},

{
  input:
    'Deliver a birthday cake carefully.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'birthday cake',

    fragile_handling:
      true,
  },
},

{
  input:
    'Pick up a washing machine and deliver it upstairs.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'washing machine',

    heavy_handling:
      true,

    access_restrictions:
      'The washing machine must be delivered upstairs.',
  },
},

{
  input:
    'Deliver an antique mirror. It is extremely fragile.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'antique mirror',

    fragile_handling:
      true,
  },
},

{
  input:
    'Pick up a dining table using a cargo van.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'dining table',

    vehicle_size:
      'cargo van',
  },
},

{
  input:
    'Transport a 300-pound safe.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'safe',

    heavy_handling:
      true,
  },
},

{
  input:
    'Deliver flowers from the store to my house.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'flowers',
  },
},

{
  input:
    'Pick up lumber from the hardware store. A truck is required.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'lumber',

    vehicle_size:
      'truck',
  },
},

{
  input:
    'Deliver a computer monitor. Please handle it carefully.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'computer monitor',

    fragile_handling:
      true,
  },
},

{
  input:
    'Transport a heavy toolbox in a pickup.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'toolbox',

    vehicle_size:
      'pickup',

    heavy_handling:
      true,
  },
},

{
  input:
    'Deliver ceramic dishes without breaking them.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'ceramic dishes',

    fragile_handling:
      true,
  },
},

{
  input:
    'Pick up a mattress and bring it over in a van.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'mattress',

    vehicle_size:
      'van',
  },
},

{
  input:
    'Deliver a piano to my house.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'piano',

    heavy_handling:
      true,
  },
},

{
  input:
    'Transport a glass cabinet. It is both heavy and fragile.',

  category:
    'delivery',

  expectedAnswers: {
    assembly_type:
      'glass cabinet',

    heavy_handling:
      true,

    fragile_handling:
      true,
  },
},

{
  input:
    'Fix a leaking kitchen faucet.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'leaking kitchen faucet',
  },
},

{
  input:
    'Repair a loose bedroom door handle.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'loose door handle',
  },
},

{
  input:
    'Patch a hole in drywall. I already have patching compound.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'drywall hole repair',

    materials:
      true,
  },
},

{
  input:
    'Fix my fence gate. Please bring the materials.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'fence gate repair',

    materials:
      false,
  },
},

{
  input:
    'Replace a broken cabinet hinge.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'cabinet hinge replacement',
  },
},

{
  input:
    'Repair a loose handrail.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'loose handrail repair',
  },
},

{
  input:
    'Hang a curtain rod. I already bought the hardware.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'curtain rod installation',

    materials:
      true,
  },
},

{
  input:
    'Replace damaged baseboard and bring replacement material.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'baseboard replacement',

    materials:
      false,
  },
},

{
  input:
    'Fix a door that scrapes against the floor.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'door adjustment',
  },
},

{
  input:
    'Repair a hole in the wall. A drill may be needed.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'wall repair',

    special_tools:
      'drill',
  },
},

{
  input:
    'Install a towel rack on tile. Bring a tile drill bit.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'towel rack installation',

    special_tools:
      'tile drill bit',
  },
},

{
  input:
    'Replace the latch on my backyard gate.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'gate latch replacement',
  },
},

{
  input:
    'Repair a loose shelf. I have screws and brackets.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'loose shelf repair',

    materials:
      true,
  },
},

{
  input:
    'Fix a broken closet door.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'closet door repair',
  },
},

{
  input:
    'Replace weather stripping around my front door.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'weather stripping replacement',
  },
},

{
  input:
    'Install a new mailbox. I already bought it.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'mailbox installation',

    materials:
      true,
  },
},

{
  input:
    'Repair a wooden step. You will need to bring replacement wood.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'wooden step repair',

    materials:
      false,
  },
},

{
  input:
    'Fix two loose cabinet doors using my tools.',

  category:
    'handyman',

  expectedAnswers: {
    work_type:
      'cabinet door repair',

    special_tools:
      'Tools are available on site.',
  },
},

{
  input:
    'My dishwasher is not draining.',

  category:
    'home_services',

  expectedAnswers: {
    service_type:
      'dishwasher repair',

    affected_area:
      'dishwasher',
  },
},

{
  input:
    'My washing machine is leaking onto the laundry room floor.',

  category:
    'home_services',

  expectedAnswers: {
    service_type:
      'washing machine repair',

    affected_area:
      'laundry room',

    existing_damage:
      'Water is leaking onto the floor.',
  },
},

{
  input:
    'The kitchen sink drains very slowly.',

  category:
    'home_services',

  expectedAnswers: {
    service_type:
      'drain repair',

    affected_area:
      'kitchen sink',
  },
},

{
  input:
    'My toilet keeps running.',

  category:
    'home_services',

  expectedAnswers: {
    service_type:
      'toilet repair',

    affected_area:
      'toilet',
  },
},

{
  input:
    'There is water damage on the living room ceiling.',

  category:
    'home_services',

  expectedAnswers: {
    affected_area:
      'living room ceiling',

    existing_damage:
      'Water damage is present.',
  },
},

{
  input:
    'The bathroom exhaust fan stopped working.',

  category:
    'home_services',

  expectedAnswers: {
    service_type:
      'exhaust fan repair',

    affected_area:
      'bathroom',
  },
},

{
  input:
    'My garage door will not close.',

  category:
    'home_services',

  expectedAnswers: {
    service_type:
      'garage door repair',

    affected_area:
      'garage door',
  },
},

{
  input:
    'There is a crack spreading across my bedroom wall.',

  category:
    'home_services',

  expectedAnswers: {
    affected_area:
      'bedroom wall',

    existing_damage:
      'A crack is spreading across the wall.',
  },
},

{
  input:
    'The garbage disposal in the kitchen stopped working.',

  category:
    'home_services',

  expectedAnswers: {
    service_type:
      'garbage disposal repair',

    affected_area:
      'kitchen',
  },
},

{
  input:
    'My AC runs but the bedroom stays hot.',

  category:
    'home_services',

  expectedAnswers: {
    service_type:
      'air conditioning repair',

    affected_area:
      'bedroom',
  },
},

{
  input:
    'There is mold-looking damage around the bathroom window.',

  category:
    'home_services',

  expectedAnswers: {
    affected_area:
      'bathroom window',

    existing_damage:
      'Mold-like discoloration is present around the window.',
  },
},

{
  input:
    'Water is appearing underneath my kitchen cabinets.',

  category:
    'home_services',

  expectedAnswers: {
    affected_area:
      'kitchen cabinets',

    existing_damage:
      'Water is appearing underneath the cabinets.',
  },
},

{
  input:
    'The wooden floor near my dishwasher is swollen from water.',

  category:
    'home_services',

  expectedAnswers: {
    affected_area:
      'floor near dishwasher',

    existing_damage:
      'The wooden floor is swollen from water.',
  },
},

{
  input:
    'My bathroom sink faucet has almost no water pressure.',

  category:
    'home_services',

  expectedAnswers: {
    service_type:
      'faucet diagnosis',

    affected_area:
      'bathroom sink',
  },
},

{
  input:
    'The bedroom ceiling has a wet stain.',

  category:
    'home_services',

  expectedAnswers: {
    affected_area:
      'bedroom ceiling',

    existing_damage:
      'A wet stain is present on the ceiling.',
  },
},

{
  input:
    'My freezer is no longer staying cold.',

  category:
    'home_services',

  expectedAnswers: {
    service_type:
      'freezer repair',

    affected_area:
      'freezer',
  },
},

{
  input:
    'One section of my hardwood floor is damaged.',

  category:
    'home_services',

  expectedAnswers: {
    affected_area:
      'hardwood floor',

    existing_damage:
      'One section of hardwood flooring is damaged.',
  },
},

{
  input:
    'The shower is leaking into the room below.',

  category:
    'home_services',

  expectedAnswers: {
    service_type:
      'shower leak repair',

    affected_area:
      'shower',

    existing_damage:
      'Water is leaking into the room below.',
  },
},

{
  input:
    'Change the oil on my 2020 Honda Civic.',

  category:
    'auto',

  expectedAnswers: {
    vehicle_details:
      '2020 Honda Civic',

    service_type:
      'oil change',
  },
},

{
  input:
    'Replace the battery in my 2018 Toyota Corolla.',

  category:
    'auto',

  expectedAnswers: {
    vehicle_details:
      '2018 Toyota Corolla',

    service_type:
      'battery replacement',
  },
},

{
  input:
    'My 2017 Ford Focus will not start.',

  category:
    'auto',

  expectedAnswers: {
    vehicle_details:
      '2017 Ford Focus',

    service_type:
      'no-start diagnosis',

    drivability:
      false,
  },
},

{
  input:
    'Replace the front brake pads on my 2021 Honda Accord.',

  category:
    'auto',

  expectedAnswers: {
    vehicle_details:
      '2021 Honda Accord',

    service_type:
      'front brake pad replacement',
  },
},

{
  input:
    'Install a dashcam in my Toyota Camry.',

  category:
    'auto',

  expectedAnswers: {
    vehicle_details:
      'Toyota Camry',

    service_type:
      'dashcam installation',
  },
},

{
  input:
    'Replace a flat tire on my Honda Civic.',

  category:
    'auto',

  expectedAnswers: {
    vehicle_details:
      'Honda Civic',

    service_type:
      'flat tire replacement',
  },
},

{
  input:
    'My car makes a grinding noise when braking.',

  category:
    'auto',

  expectedAnswers: {
    service_type:
      'brake diagnosis',
  },
},

{
  input:
    'My truck will not run and needs diagnosis.',

  category:
    'auto',

  expectedAnswers: {
    vehicle_details:
      'truck',

    service_type:
      'diagnosis',

    drivability:
      false,
  },
},

{
  input:
    'Replace my alternator. I already have the new part.',

  category:
    'auto',

  expectedAnswers: {
    service_type:
      'alternator replacement',

    parts_provided:
      true,
  },
},

{
  input:
    'Replace my brake pads but I do not have the parts.',

  category:
    'auto',

  expectedAnswers: {
    service_type:
      'brake pad replacement',

    parts_provided:
      false,
  },
},

{
  input:
    'Change the headlights on my 2019 Ford F-150.',

  category:
    'auto',

  expectedAnswers: {
    vehicle_details:
      '2019 Ford F-150',

    service_type:
      'headlight replacement',
  },
},

{
  input:
    'Install new speakers in my 2016 Civic.',

  category:
    'auto',

  expectedAnswers: {
    vehicle_details:
      '2016 Civic',

    service_type:
      'speaker installation',
  },
},

{
  input:
    'My check engine light came on but the car still drives normally.',

  category:
    'auto',

  expectedAnswers: {
    service_type:
      'check engine light diagnosis',

    drivability:
      true,
  },
},

{
  input:
    'My car overheats and cannot safely be driven.',

  category:
    'auto',

  expectedAnswers: {
    service_type:
      'overheating diagnosis',

    drivability:
      false,
  },
},

{
  input:
    'Rotate all four tires on my SUV.',

  category:
    'auto',

  expectedAnswers: {
    vehicle_details:
      'SUV',

    service_type:
      'tire rotation',
  },
},

{
  input:
    'Install new windshield wipers. I already bought them.',

  category:
    'auto',

  expectedAnswers: {
    service_type:
      'windshield wiper installation',

    parts_provided:
      true,
  },
},

{
  input:
    'My sedan has a dead battery and is parked underground.',

  category:
    'auto',

  expectedAnswers: {
    vehicle_details:
      'sedan',

    service_type:
      'dead battery service',

    drivability:
      false,

    access_restrictions:
      'The vehicle is parked in an underground garage.',
  },
},

{
  input:
    'Replace my starter. I have the replacement starter already.',

  category:
    'auto',

  expectedAnswers: {
    service_type:
      'starter replacement',

    parts_provided:
      true,
  },
},

{
  input:
    'Birthday party setup for 30 guests.',

  category:
    'events',

  expectedAnswers: {
    event_type:
      'birthday party',

    guest_count:
      30,

    setup:
      true,
  },
},

{
  input:
    'Help clean up after a wedding with 120 guests.',

  category:
    'events',

  expectedAnswers: {
    event_type:
      'wedding',

    guest_count:
      120,

    cleanup:
      true,
  },
},

{
  input:
    'Serve food at a dinner party for 20 people.',

  category:
    'events',

  expectedAnswers: {
    event_type:
      'dinner party',

    guest_count:
      20,

    serving:
      true,
  },
},

{
  input:
    'Setup and cleanup for a baby shower with 35 guests.',

  category:
    'events',

  expectedAnswers: {
    event_type:
      'baby shower',

    guest_count:
      35,

    setup:
      true,

    cleanup:
      true,
  },
},

{
  input:
    'Help serve food at a wedding for 80 guests.',

  category:
    'events',

  expectedAnswers: {
    event_type:
      'wedding',

    guest_count:
      80,

    serving:
      true,
  },
},

{
  input:
    'Set up tables and chairs for a corporate event with 150 people.',

  category:
    'events',

  expectedAnswers: {
    event_type:
      'corporate event',

    guest_count:
      150,

    setup:
      true,
  },
},

{
  input:
    'Cleanup help after a backyard party for 25 people.',

  category:
    'events',

  expectedAnswers: {
    event_type:
      'backyard party',

    guest_count:
      25,

    cleanup:
      true,
  },
},

{
  input:
    'Setup help for an outdoor wedding with 90 guests.',

  category:
    'events',

  expectedAnswers: {
    event_type:
      'wedding',

    guest_count:
      90,

    setup:
      true,
  },
},

{
  input:
    'Serve drinks at a private party for 40 guests.',

  category:
    'events',

  expectedAnswers: {
    event_type:
      'private party',

    guest_count:
      40,

    serving:
      true,
  },
},

{
  input:
    'Help set up and serve at a graduation party for 60 guests.',

  category:
    'events',

  expectedAnswers: {
    event_type:
      'graduation party',

    guest_count:
      60,

    setup:
      true,

    serving:
      true,
  },
},

{
  input:
    'Need cleanup after a company party for 200 people.',

  category:
    'events',

  expectedAnswers: {
    event_type:
      'company party',

    guest_count:
      200,

    cleanup:
      true,
  },
},

{
  input:
    'Set up decorations for a birthday with 15 guests.',

  category:
    'events',

  expectedAnswers: {
    event_type:
      'birthday party',

    guest_count:
      15,

    setup:
      true,
  },
},

{
  input:
    'Serve dinner and clean afterward for 50 guests.',

  category:
    'events',

  expectedAnswers: {
    guest_count:
      50,

    serving:
      true,

    cleanup:
      true,
  },
},

{
  input:
    'Help with wedding teardown for 100 guests.',

  category:
    'events',

  expectedAnswers: {
    event_type:
      'wedding',

    guest_count:
      100,

    cleanup:
      true,
  },
},

{
  input:
    'Setup a conference room for 70 attendees.',

  category:
    'events',

  expectedAnswers: {
    event_type:
      'conference',

    guest_count:
      70,

    setup:
      true,
  },
},

{
  input:
    'Party setup for somewhere between 50 and 100 people.',

  category:
    'events',

  expectedAnswers: {
    event_type:
      'party',

    setup:
      true,

    special_constraints:
      'Expected attendance is between 50 and 100 people.',
  },
},

{
  input:
    'Help serve at a small family gathering with 12 guests.',

  category:
    'events',

  expectedAnswers: {
    event_type:
      'family gathering',

    guest_count:
      12,

    serving:
      true,
  },
},

{
  input:
    'Setup and cleanup for an engagement party with 45 guests.',

  category:
    'events',

  expectedAnswers: {
    event_type:
      'engagement party',

    guest_count:
      45,

    setup:
      true,

    cleanup:
      true,
  },
},

{
  input:
    'Walk my dog.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'dog',

    care_type:
      [
        'walking',
      ],
  },
},

{
  input:
    'Walk my two dogs.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'dog',

    pet_count:
      2,

    care_type:
      [
        'walking',
      ],
  },
},

{
  input:
    'Feed my cat while I am away.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'cat',

    care_type:
      [
        'feeding',
      ],
  },
},

{
  input:
    'Watch my 3 cats for the afternoon.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'cat',

    pet_count:
      3,

    care_type:
      [
        'sitting',
      ],
  },
},

{
  input:
    'Walk and feed my dog.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'dog',

    care_type:
      [
        'walking',
        'feeding',
      ],
  },
},

{
  input:
    'Feed and check on my two cats.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'cat',

    pet_count:
      2,

    care_type:
      [
        'feeding',
        'sitting',
      ],
  },
},

{
  input:
    'Watch my puppy overnight.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'dog',

    care_type:
      [
        'sitting',
      ],
  },
},

{
  input:
    'Feed my fish while I am out of town.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'fish',

    care_type:
      [
        'feeding',
      ],
  },
},

{
  input:
    'Walk my elderly dog slowly for 20 minutes.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'dog',

    care_type:
      [
        'walking',
      ],

    special_instructions:
      'The dog is elderly and should be walked slowly.',
  },
},

{
  input:
    'Watch two dogs. One needs medication at 6 PM.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'dog',

    pet_count:
      2,

    care_type:
      [
        'sitting',
      ],

    special_instructions:
      'One dog needs medication at 6 PM.',
  },
},

{
  input:
    'Feed my parrot and refill its water.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'parrot',

    care_type:
      [
        'feeding',
      ],
  },
},

{
  input:
    'Pet sit my dog for the weekend.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'dog',

    care_type:
      [
        'sitting',
      ],
  },
},

{
  input:
    'Walk three dogs twice today.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'dog',

    pet_count:
      3,

    care_type:
      [
        'walking',
      ],
  },
},

{
  input:
    'Watch my cat. She is nervous around strangers.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'cat',

    care_type:
      [
        'sitting',
      ],

    special_instructions:
      'The cat is nervous around strangers.',
  },
},

{
  input:
    'Feed my two dogs and one cat.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_count:
      3,

    care_type:
      [
        'feeding',
      ],
  },
},

{
  input:
    'Take my dog outside and feed him afterward.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'dog',

    care_type:
      [
        'walking',
        'feeding',
      ],
  },
},

{
  input:
    'Check on my rabbit and give it food and water.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'rabbit',

    care_type:
      [
        'feeding',
      ],
  },
},

{
  input:
    'Watch four dogs for 5 hours.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'dog',

    pet_count:
      4,

    care_type:
      [
        'sitting',
      ],
  },
},

{
  input:
    'Organize my garage and sort everything into labeled boxes.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Organize the garage and sort items into labeled boxes.',
  },
},

{
  input:
    'Take photos of 40 products for my online store.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Take product photos for an online store.',

    approximate_scope:
      '40 products',
  },
},

{
  input:
    'Put shipping labels on 250 packages.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Apply shipping labels to packages.',

    approximate_scope:
      '250 packages',
  },
},

{
  input:
    'Count and organize approximately 100 boxes in my warehouse.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Count and organize warehouse boxes.',

    approximate_scope:
      'Approximately 100 boxes',
  },
},

{
  input:
    'Wait at my apartment for the internet technician.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Wait at the apartment for the internet technician.',
  },
},

{
  input:
    'Measure every room in my 3-bedroom house.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Measure every room in the house.',

    approximate_scope:
      '3-bedroom house',
  },
},

{
  input:
    'Put flyers on approximately 150 doors.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Distribute flyers door to door.',

    approximate_scope:
      'Approximately 150 doors',
  },
},

{
  input:
    'Scan and organize about 300 paper documents.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Scan and organize paper documents.',

    approximate_scope:
      'Approximately 300 documents',
  },
},

{
  input:
    'Water 25 plants while I am away.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Water plants.',

    approximate_scope:
      '25 plants',
  },
},

{
  input:
    'Help load camera equipment into a van.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Load camera equipment into a van.',

    provider_resources:
      'Physical loading assistance',
  },
},

{
  input:
    'Take down Christmas lights from a two-story house.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Take down Christmas lights.',

    access_restrictions:
      'Work is on a two-story house.',
  },
},

{
  input:
    'Stand in line and pick up my order when it is ready.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Wait in line and pick up an order.',
  },
},

{
  input:
    'Rearrange 12 desks in our office.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Rearrange office desks.',

    approximate_scope:
      '12 desks',
  },
},

{
  input:
    'Sort about 20 boxes of clothes into keep and donate piles.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Sort clothing into keep and donate groups.',

    approximate_scope:
      'Approximately 20 boxes',
  },
},

{
  input:
    'Inventory around 500 items in a storage room.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Inventory items in a storage room.',

    approximate_scope:
      'Approximately 500 items',
  },
},

{
  input:
    'Be at my house between 1 PM and 3 PM to let a contractor inside.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Provide property access to a contractor.',

    special_constraints:
      'Must be at the house between 1 PM and 3 PM.',
  },
},

{
  input:
    'Organize my workshop. You will need to bring storage bins.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Organize the workshop.',

    provider_resources:
      'Storage bins',

    special_constraints:
      'Provider must bring storage bins.',
  },
},

{
  input:
    'Help pack approximately 60 books into boxes.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Pack books into boxes.',

    approximate_scope:
      'Approximately 60 books',
  },
},

{
  input:
    'Remove old decorations from a storefront after closing time.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Remove old storefront decorations.',

    special_constraints:
      'Work must happen after closing time.',
  },
},

{
  input:
    'Check 80 boxes and write down which ones are damaged.',

  category:
    'other',

  expectedAnswers: {
    task_goal:
      'Inspect boxes and record damage.',

    approximate_scope:
      '80 boxes',
  },
},
];

function isSuspiciouslyVague(input: string): boolean {
  const text = input.trim().toLowerCase();
  const vagueStart = /^(?:need someone|need help|help me|can someone help|looking for help)\b/i.test(text);
  if (!vagueStart) return false;
  const concreteFactSignal = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|box|boxes|dog|dogs|cat|cats|room|rooms|chair|chairs|table|tables|desk|desks|stairs|flight|flights|apartment|house|office|deliver|move|assemble|clean|walk|feed)\b/i;
  return !concreteFactSignal.test(text);
}

function equalAnswer(a: IntakeAnswer | undefined, b: IntakeAnswer): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const actualSorted = [...a].sort();
    const expectedSorted = [...b].sort();
    return actualSorted.every((value, index) => value === expectedSorted[index]);
  }
  return a === b;
}
function getAllowedKeys(category: TaskCategory, secondary: readonly TaskCategory[] = []): Set<string> { return new Set(getQuestionsForIntake(category, secondary).map((q) => q.key)); }

function runExactAssertions(): void {
  let passed = 0;
  for (const testCase of EXACT_CASES) {
    const result = extractIntakePrefill(testCase.input, testCase.category, testCase.secondaryIntents ?? []);
    assert.deepEqual(Object.keys(result.answers).sort(), Object.keys(testCase.expectedAnswers).sort(), testCase.input);
    for (const [key, expected] of Object.entries(testCase.expectedAnswers)) assert.ok(equalAnswer(result.answers[key], expected), `${testCase.input}: ${key}`);
    passed += 1;
  }
  console.log(`Exact cases passed: ${passed}/${EXACT_CASES.length}`);
}

async function main(): Promise<void> {
  runExactAssertions();
  const corpus = JSON.parse(await readFile(CORPUS_PATH, 'utf8')) as CorpusRow[];
  let tasksWithPrefill = 0, totalFields = 0, invalidKeys = 0, vaguePrefills = 0;
  const fieldCounts = new Map<string, number>();
  for (const row of corpus) {
    const result = extractIntakePrefill(row.input, row.expected, []);
    const keys = Object.keys(result.answers);
    if (keys.length) tasksWithPrefill += 1;
    totalFields += keys.length;
    for (const key of keys) fieldCounts.set(key, (fieldCounts.get(key) ?? 0) + 1);
    const allowed = getAllowedKeys(row.expected);
    invalidKeys += keys.filter((key) => !allowed.has(key)).length;
    const vague = isSuspiciouslyVague(row.input);
    if (vague && keys.length > 0) {
      vaguePrefills += 1;
      console.log('\n[VAGUE PREFILL]');
      console.log(row.input);
      console.log(`category=${row.expected}`);
      console.log(JSON.stringify(result, null, 2));
    }
  }
  console.log(`Tasks checked: ${corpus.length}`);
  console.log(`Tasks with >= 1 prefill: ${tasksWithPrefill}/${corpus.length}`);
  console.log(`Average prefill fields/task: ${(totalFields / corpus.length).toFixed(2)}`);
  console.log(`Invalid-key prefills: ${invalidKeys}`);
  console.log(`Vague tasks with prefills: ${vaguePrefills}`);
  console.table([...fieldCounts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count })));
  assert.equal(invalidKeys, 0, 'Extractor emitted answer keys outside the active intake schema.');
  console.log('Corpus prefill validation passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });


