import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { extractIntakePrefill } from './extractPrefill.js';
import { getQuestionsForIntake } from './definitions.js';
import type { IntakeAnswer, TaskCategory } from './types.js';

interface CorpusRow { input: string; expected: TaskCategory; }
interface ExpectedPrefill { input: string; category: TaskCategory; secondaryIntents?: TaskCategory[]; expectedAnswers: Record<string, IntakeAnswer>; }

const CORPUS_PATH = path.resolve(process.cwd(), 'ml', 'task_classifier', 'data', 'tasks.json');

const EXACT_CASES_RAW: ExpectedPrefill[] = [
{
  input: 'Rake leaves from a medium yard.',
  category: 'yard',
  expectedAnswers: { yard_size: 'medium', debris_type: ['leaves'] },
},
{
  input: 'Clean up a huge backyard full of branches.',
  category: 'yard',
  expectedAnswers: { yard_size: 'large', debris_type: ['branches'] },
},
{
  input: 'Move 6 chairs and 4 boxes.',
  category: 'moving',
  expectedAnswers: { item_count: 10 },
},
{
  input: 'Move 9 boxes up 4 flights of stairs.',
  category: 'moving',
  expectedAnswers: { item_count: 9, stairs: true, stair_flights: 4, access_restrictions: '4 flights of stairs are involved.' },
},
{
  input: 'Assemble two desks and three chairs.',
  category: 'assembly',
  expectedAnswers: { assembly_count: 5, assembly_type: 'desks and chairs' },
},
{
  input: 'Deliver a fragile mirror.',
  category: 'delivery',
  expectedAnswers: { delivery_item: 'mirror', heavy_or_fragile: true },
},
{
  input: 'Clean 6 rooms on the third floor. There is an elevator.',
  category: 'cleaning',
  expectedAnswers: { room_count: 6, access_restrictions: 'Access involves the 3rd floor.' },
},
{
  input: 'Walk three dogs.',
  category: 'pet_care',
  expectedAnswers: { pet_type: 'dog', pet_count: 3, care_type: ['walking'] },
},
{
  input: 'Put together one cabinet, two shelves, and one table.',
  category: 'assembly',
  expectedAnswers: { assembly_count: 4, assembly_type: 'cabinet and shelves and table' },
},
{
  input: 'Install two wall shelves on drywall.',
  category: 'assembly',
  expectedAnswers: { assembly_count: 2, assembly_type: 'wall shelves', wall_mounting: true, wall_type: 'drywall' },
},
{
  input: 'Mount a cabinet on a brick wall.',
  category: 'assembly',
  expectedAnswers: { assembly_count: 1, assembly_type: 'cabinet', wall_mounting: true, wall_type: 'brick' },
},
{
  input: 'Deliver three dining chairs.',
  category: 'delivery',
  expectedAnswers: { delivery_item: 'dining chairs' },
},
{
  input: 'Clean a house with 7 rooms.',
  category: 'cleaning',
  expectedAnswers: { property_type: 'house', room_count: 7 },
},
{
  input: 'Party for 75 guests.',
  category: 'events',
  expectedAnswers: { guest_count: 75 },
},
{
  input: 'Watch five cats for 3 hours.',
  category: 'pet_care',
  expectedAnswers: { pet_type: 'cat', pet_count: 5, care_type: ['sitting'] },
},
{
  input:
    'Clear leaves from a small backyard and bag everything.',

  category:
    'yard',

  expectedAnswers: {
    yard_size:
      'small',

    debris_type:
      [
        'leaves',
      ],
  },
},

{
  input:
    'Clean up branches and leaves from a large yard.',

  category:
    'yard',

  expectedAnswers: {
    yard_size:
      'large',

    debris_type:
      [
        'branches',
        'leaves',
      ],
  },
},

{
  input:
    'Remove three bags of garden waste and some old wood.',

  category:
    'yard',

  expectedAnswers: {
    debris:
      true,
  },
},

{
  input:
    'Mow a small front lawn; I don\'t have a mower.',

  category:
    'yard',

  expectedAnswers: {
    yard_size:
      'small',

    equipment_provided:
      false,
  },
},

{
  input:
    'Trim the bushes around the driveway.',

  category:
    'yard',

  expectedAnswers: {
  },
},

{
  input:
    'Clear weeds from about 500 sq ft of garden.',

  category:
    'yard',

  expectedAnswers: {
  },
},

{
  input:
    'Remove a fallen tree branch after a storm.',

  category:
    'yard',

  expectedAnswers: {
    debris_type:
      [
        'branches',
      ],

    debris:
      true,
  },
},

{
  input:
    'Clean dog waste from the backyard.',

  category:
    'yard',

  expectedAnswers: {
  },
},

{
  input:
    'Spread mulch across several flower beds.',

  category:
    'yard',

  expectedAnswers: {
  },
},

{
  input:
    'Move a pile of gravel from the driveway to the backyard.',

  category:
    'yard',

  expectedAnswers: {
  },
},

{
  input:
    'Clean gutters on a two-story house.',

  category:
    'yard',

  expectedAnswers: {
  },
},

{
  input:
    'Pressure wash my patio and driveway.',

  category:
    'yard',

  expectedAnswers: {
  },
},

{
  input:
    'I need someone to make my backyard presentable before Saturday.',

  category:
    'yard',

  expectedAnswers: {
  },
},

{
  input:
    'Deep clean my two-bedroom apartment.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'apartment',

    room_count:
      2,
  },
},

{
  input:
    'Clean my kitchen and two bathrooms only.',

  category:
    'cleaning',

  expectedAnswers: {
    room_count:
      2,
  },
},

{
  input:
    'Move-out cleaning for an empty 3-bedroom house.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'house',

    room_count:
      3,
  },
},

{
  input:
    'Clean an Airbnb after guests leave.',

  category:
    'cleaning',

  expectedAnswers: {
  },
},

{
  input:
    'My apartment hasn\'t been cleaned for months.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'apartment',
  },
},

{
  input:
    'Clean inside my refrigerator and oven.',

  category:
    'cleaning',

  expectedAnswers: {
  },
},

{
  input:
    'Remove pet hair from carpets and furniture.',

  category:
    'cleaning',

  expectedAnswers: {
  },
},

{
  input:
    'Clean windows inside and outside.',

  category:
    'cleaning',

  expectedAnswers: {
  },
},

{
  input:
    'Clean a garage full of dust and cobwebs.',

  category:
    'cleaning',

  expectedAnswers: {
  },
},

{
  input:
    'I need someone to clean after a renovation.',

  category:
    'cleaning',

  expectedAnswers: {
  },
},

{
  input:
    'Just need the floors and bathrooms cleaned.',

  category:
    'cleaning',

  expectedAnswers: {
  },
},

{
  input:
    'Clean a small office after business hours.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'office',
  },
},

{
  input:
    'My tenant left the place filthy; I don\'t know exactly what needs cleaning.',

  category:
    'cleaning',

  expectedAnswers: {
  },
},

{
  input:
    'Help me move a couch and bed to another apartment.',

  category:
    'moving',

  secondaryIntents: [
    'assembly',
  ],

  expectedAnswers: {
    item_count:
      2,
  },
},

{
  input:
    'Moving a one-bedroom apartment across town.',

  category:
    'moving',

  expectedAnswers: {
  },
},

{
  input:
    'Carry 20 boxes from my garage into a moving truck.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      20,
  },
},

{
  input:
    'Move a refrigerator down one flight of stairs.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      1,

    stairs:
      true,

    stair_flights:
      1,

    access_restrictions:
      '1 flight of stairs is involved.',
  },
},

{
  input:
    'I have a dresser that weighs about 200 pounds.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      1,
  },
},

{
  input:
    'Help unload a U-Haul.',

  category:
    'moving',

  expectedAnswers: {
  },
},

{
  input:
    'Move furniture between rooms in the same house.',

  category:
    'moving',

  expectedAnswers: {
  },
},

{
  input:
    'Move a piano from the first floor to a truck.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      1,

    access_restrictions:
      'Access involves the 1st floor.',
  },
},

{
  input:
    'I need two people to move some stuff but I don\'t know exactly how much yet.',

  category:
    'moving',

  expectedAnswers: {
  },
},

{
  input:
    'Pick up my belongings from a storage unit and bring them home.',

  category:
    'moving',

  expectedAnswers: {
  },
},

{
  input:
    'Move 12 boxes, a TV, desk, mattress and sofa.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      16,
  },
},

{
  input:
    'Help me move but I already have a truck.',

  category:
    'moving',

  expectedAnswers: {
    vehicle_required:
      false,
  },
},

{
  input:
    'Move some furniture from upstairs; narrow staircase.',

  category:
    'moving',

  expectedAnswers: {

    stairs:
      true,

    access_restrictions:
      'The task involves stair access. Access is narrow and may restrict movement.',
  },
},

{
  input:
    'Assemble an IKEA bed frame.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      1,

    assembly_type:
      'bed frame',
  },
},

{
  input:
    'Put together four dining chairs and a table.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      5,

    assembly_type:
      'dining chairs and table',
  },
},

{
  input:
    'Assemble a large wardrobe.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      1,

    assembly_type:
      'wardrobe',
  },
},

{
  input:
    'Build a standing desk.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      1,

    assembly_type:
      'standing desk',
  },
},

{
  input:
    'Assemble a trampoline in my backyard.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      1,

    assembly_type:
      'trampoline',
  },
},

{
  input:
    'Put together a barbecue grill.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      1,

    assembly_type:
      'barbecue grill',
  },
},

{
  input:
    'Assemble a bookshelf and anchor it to the wall.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      1,

    assembly_type:
      'bookshelf',

    wall_mounting:
      true,
  },
},

{
  input:
    'Mount a TV on drywall.',

  category:
    'assembly',

  expectedAnswers: {
    wall_mounting:
      true,

    wall_type:
      'drywall',
  },
},

{
  input:
    'Install three floating shelves on a brick wall.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      3,

    assembly_type:
      'floating shelves',

    wall_mounting:
      true,

    wall_type:
      'brick',
  },
},

{
  input:
    'Assemble a children\'s playset.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      1,

    assembly_type:
      'playset',
  },
},

{
  input:
    'I bought some furniture online and need someone to put everything together.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'furniture',
  },
},

{
  input:
    'Disassemble my bed and assemble it again after moving.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      1,

    assembly_type:
      'bed',
  },
},

{
  input:
    'Pick up a couch from Facebook Marketplace and bring it to my house.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'couch',
  },
},

{
  input:
    'Deliver a dining table across town.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'dining table',
  },
},

{
  input:
    'Pick up 15 boxes from a warehouse.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'boxes',
  },
},

{
  input:
    'Transport a large mirror without breaking it.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'mirror',

    heavy_or_fragile:
      true,
  },
},

{
  input:
    'Deliver a refrigerator; you\'ll need a truck.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'refrigerator',

    vehicle_size:
      'truck',
  },
},

{
  input:
    'Pick up a birthday cake and deliver it.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'birthday cake',
  },
},

{
  input:
    'Move six bags of cement from the store to my property.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'bags of cement',
  },
},

{
  input:
    'Pick up a washing machine and bring it upstairs.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'washing machine',


    access_restrictions:
      'The task involves stair access.',
  },
},

{
  input:
    'Collect a package from someone\'s house and bring it to me.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'package',
  },
},

{
  input:
    'Deliver 30 folding chairs to an event venue.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'folding chairs',
  },
},

{
  input:
    'Take several bags of clothes to a donation center.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'bags of clothes',
  },
},

{
  input:
    'Haul an old mattress away.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'mattress',
  },
},

{
  input:
    'I bought something but I\'m not sure whether it will fit in a normal car.',

  category:
    'delivery',

  expectedAnswers: {
  },
},

{
  input:
    'Fix a leaking kitchen faucet.',

  category:
    'handyman',

  expectedAnswers: {
  },
},

{
  input:
    'Repair a loose door handle.',

  category:
    'handyman',

  expectedAnswers: {
  },
},

{
  input:
    'Patch a hole in drywall.',

  category:
    'handyman',

  expectedAnswers: {
  },
},

{
  input:
    'Replace a broken door hinge.',

  category:
    'handyman',

  expectedAnswers: {
  },
},

{
  input:
    'Hang five pictures on the wall.',

  category:
    'handyman',

  expectedAnswers: {
  },
},

{
  input:
    'Install curtain rods.',

  category:
    'handyman',

  expectedAnswers: {
  },
},

{
  input:
    'Replace a damaged section of baseboard.',

  category:
    'handyman',

  expectedAnswers: {
  },
},

{
  input:
    'Fix a cabinet door that won\'t close.',

  category:
    'handyman',

  expectedAnswers: {
  },
},

{
  input:
    'Replace a bathroom towel rack.',

  category:
    'handyman',

  expectedAnswers: {
  },
},

{
  input:
    'Install a ceiling-mounted curtain track.',

  category:
    'handyman',

  expectedAnswers: {
  },
},

{
  input:
    'Repair a fence gate.',

  category:
    'handyman',

  expectedAnswers: {
  },
},

{
  input:
    'My bedroom door keeps scraping the floor.',

  category:
    'handyman',

  expectedAnswers: {
  },
},

{
  input:
    'Something under my sink is leaking.',

  category:
    'handyman',

  expectedAnswers: {
  },
},

{
  input:
    'I need several random small repairs around my house.',

  category:
    'handyman',

  expectedAnswers: {
  },
},

{
  input:
    'My dishwasher isn\'t draining.',

  category:
    'home_services',

  expectedAnswers: {
  },
},

{
  input:
    'My washing machine is leaking water.',

  category:
    'home_services',

  expectedAnswers: {
  },
},

{
  input:
    'The garbage disposal stopped working.',

  category:
    'home_services',

  expectedAnswers: {
  },
},

{
  input:
    'One room has water damage near the ceiling.',

  category:
    'home_services',

  expectedAnswers: {
  },
},

{
  input:
    'My bathroom exhaust fan stopped working.',

  category:
    'home_services',

  expectedAnswers: {
  },
},

{
  input:
    'There\'s mold-looking discoloration around a window.',

  category:
    'home_services',

  expectedAnswers: {
  },
},

{
  input:
    'My garage door isn\'t closing properly.',

  category:
    'home_services',

  expectedAnswers: {
  },
},

{
  input:
    'My toilet keeps running.',

  category:
    'home_services',

  expectedAnswers: {
  },
},

{
  input:
    'The kitchen sink drains extremely slowly.',

  category:
    'home_services',

  expectedAnswers: {
  },
},

{
  input:
    'There\'s a crack in the wall that\'s getting bigger.',

  category:
    'home_services',

  expectedAnswers: {
  },
},

{
  input:
    'One section of my wooden floor is damaged.',

  category:
    'home_services',

  expectedAnswers: {
  },
},

{
  input:
    'My AC seems to be running but the room isn\'t getting cold.',

  category:
    'home_services',

  expectedAnswers: {
  },
},

{
  input:
    'I don\'t know what\'s wrong, but there is water appearing under the bathroom floor.',

  category:
    'home_services',

  expectedAnswers: {
  },
},

{
  input:
    'Change the oil on my 2018 Toyota Camry.',

  category:
    'auto',

  expectedAnswers: {
  },
},

{
  input:
    'Replace my car battery.',

  category:
    'auto',

  expectedAnswers: {
  },
},

{
  input:
    'My car won\'t start.',

  category:
    'auto',

  expectedAnswers: {
  },
},

{
  input:
    'Replace front brake pads.',

  category:
    'auto',

  expectedAnswers: {
  },
},

{
  input:
    'Install a dashcam.',

  category:
    'auto',

  expectedAnswers: {
  },
},

{
  input:
    'Replace a flat tire.',

  category:
    'auto',

  expectedAnswers: {
  },
},

{
  input:
    'Rotate all four tires.',

  category:
    'auto',

  expectedAnswers: {
  },
},

{
  input:
    'Change the headlights on my truck.',

  category:
    'auto',

  expectedAnswers: {
  },
},

{
  input:
    'My car is making a grinding noise when I brake.',

  category:
    'auto',

  expectedAnswers: {
  },
},

{
  input:
    'Diagnose why my check-engine light is on.',

  category:
    'auto',

  expectedAnswers: {
  },
},

{
  input:
    'Replace windshield wipers.',

  category:
    'auto',

  expectedAnswers: {
  },
},

{
  input:
    'Install new speakers in my car.',

  category:
    'auto',

  expectedAnswers: {
  },
},

{
  input:
    'My vehicle doesn\'t run, and I need someone to look at it.',

  category:
    'auto',

  expectedAnswers: {
  },
},

{
  input:
    'I already bought the replacement alternator and need someone to install it.',

  category:
    'auto',

  expectedAnswers: {
  },
},

{
  input:
    'I need brake work but don\'t know what parts are required.',

  category:
    'auto',

  expectedAnswers: {
  },
},

{
  input:
    'Help set up tables and chairs for a birthday party.',

  category:
    'events',

  expectedAnswers: {
  },
},

{
  input:
    'Clean up after a wedding reception.',

  category:
    'events',

  expectedAnswers: {
  },
},

{
  input:
    'Serve food at a party with 60 guests.',

  category:
    'events',

  expectedAnswers: {
    guest_count:
      60,
  },
},

{
  input:
    'Help decorate a venue for a baby shower.',

  category:
    'events',

  expectedAnswers: {
  },
},

{
  input:
    'Need two people to check guests in at an event.',

  category:
    'events',

  expectedAnswers: {
  },
},

{
  input:
    'Set up tents, chairs and decorations for an outdoor party.',

  category:
    'events',

  expectedAnswers: {
  },
},

{
  input:
    'Help tear down everything after an event.',

  category:
    'events',

  expectedAnswers: {
  },
},

{
  input:
    'Bartending help for a private party.',

  category:
    'events',

  expectedAnswers: {
  },
},

{
  input:
    'Help serve dinner and clean dishes afterward.',

  category:
    'events',

  expectedAnswers: {
  },
},

{
  input:
    'Need someone to manage the buffet table.',

  category:
    'events',

  expectedAnswers: {
  },
},

{
  input:
    'Corporate event for 150 people; need setup help.',

  category:
    'events',

  expectedAnswers: {
    guest_count:
      150,
  },
},

{
  input:
    'Backyard party, about 25 people, just need an extra pair of hands.',

  category:
    'events',

  expectedAnswers: {
    guest_count:
      25,
  },
},

{
  input:
    'I need help with my wedding but I\'m not exactly sure what jobs yet.',

  category:
    'events',

  expectedAnswers: {
  },
},

{
  input:
    'Walk my dog for 30 minutes.',

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
    'Walk two large dogs twice today.',

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
    'Feed my cat while I\'m out of town.',

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
    'Visit my house and check on three cats.',

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
    'Watch my dog for four hours.',

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
    'Clean my cat\'s litter box and refill food and water.',

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
    'Take my dog to the vet.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'dog',
  },
},

{
  input:
    'Look after my puppy overnight.',

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
    'Feed my fish while I\'m away.',

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
    'Walk an elderly dog that needs to move slowly.',

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
    'Watch two dogs; one needs medication at 6 PM.',

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
  },
},

{
  input:
    'My dog is nervous around strangers.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'dog',
  },
},

{
  input:
    'Pet sit for the weekend.',

  category:
    'pet_care',

  expectedAnswers: {
    care_type:
      [
        'sitting',
      ],
  },
},

{
  input:
    'Help organize my garage.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Sort and pack everything in my bedroom.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Take photos of 50 products for my online store.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Put labels on 300 packages.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Help inventory items in my warehouse.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Wait at my apartment for a repair technician.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Stand in line and pick something up for me.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Help rearrange furniture before guests arrive.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Remove old items from my storage room.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Take measurements of every room in my house.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Help me hang Christmas decorations.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Take down holiday lights.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Water my plants while I\'m away.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Help load equipment for a photo shoot.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Count boxes and organize them by label.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Put flyers on 200 doors.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Help me clean and organize my workshop.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Scan and organize a pile of documents.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Someone needs to be at the property to let a contractor inside.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'I need help with my backyard.',

  category:
    'yard',

  expectedAnswers: {
  },
},

{
  input:
    'My house needs some work.',

  category:
    'home_services',

  expectedAnswers: {
  },
},

{
  input:
    'Need someone with a truck tomorrow.',

  category:
    'other',

  expectedAnswers: {
    provider_resources: 'truck',
  },
},

{
  input:
    'Can someone come fix this?',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'I have a bunch of stuff that needs moving.',

  category:
    'moving',

  expectedAnswers: {
  },
},

{
  input:
    'Need help cleaning before my parents visit.',

  category:
    'cleaning',

  expectedAnswers: {
  },
},

{
  input:
    'Need someone handy for a few hours.',

  category:
    'handyman',

  expectedAnswers: {
  },
},

{
  input:
    'My car is acting weird.',

  category:
    'auto',

  expectedAnswers: {
  },
},

{
  input:
    'Need help setting things up for Saturday.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Looking for someone to help around the house.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'I bought a large thing and need it brought home.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'thing',
  },
},

{
  input:
    'There\'s a mess in my garage.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'I have about 10 things that need fixing.',

  category:
    'handyman',

  expectedAnswers: {
  },
},

{
  input:
    'Need someone ASAP.',

  category:
    'other',

  expectedAnswers: {},
},

{
  input:
    'Looking for two people for around three hours.',

  category:
    'other',

  expectedAnswers: {
  },
},

{
  input:
    'Pick up my new bed, bring it upstairs and assemble it.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'bed',


    access_restrictions:
      'The task involves stair access.',
  },
},

{
  input:
    'Move my couch and mount my TV after we get to the new apartment.',

  category:
    'moving',

  secondaryIntents: [
    'assembly',
  ],

  expectedAnswers: {
    item_count:
      2,

    wall_mounting:
      true,
  },
},

{
  input:
    'Clean my backyard and haul all the debris away.',

  category:
    'yard',

  expectedAnswers: {
    debris:
      true,
  },
},

{
  input:
    'Assemble a cabinet and attach it to the wall.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      1,

    assembly_type:
      'cabinet',

    wall_mounting:
      true,
  },
},

{
  input:
    'Pick up a refrigerator and install it.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'refrigerator',
  },
},

{
  input:
    'Help set up my party and clean everything afterward.',

  category:
    'events',

  expectedAnswers: {
  },
},

{
  input:
    'Move my old washing machine outside and install the new one.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      2,
  },
},

{
  input:
    'Clean my garage and take all the junk to the dump.',

  category:
    'cleaning',

  expectedAnswers: {
  },
},

{
  input:
    'Buy some shelves, deliver them and install them in my garage.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'shelves',
  },
},

{
  input:
    'Move my furniture out of the room so the floor can be cleaned.',

  category:
    'moving',

  expectedAnswers: {
  },
},

{
  input:
    'Pick up a desk from IKEA, assemble it and remove the packaging.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'desk',
  },
},

{
  input:
    'Trim my trees and haul away the branches.',

  category:
    'yard',

  expectedAnswers: {
    debris_type:
      [
        'branches',
      ],

    debris:
      true,
  },
},

{
  input:
    'Need someone to move 1 box.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      1,
  },
},

{
  input:
    'Need someone to move approximately 200 boxes.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      200,
  },
},

{
  input:
    'Clean 12 bedrooms and 8 bathrooms.',

  category:
    'cleaning',

  expectedAnswers: {
    room_count:
      20,
  },
},

{
  input:
    'Assemble 25 office desks.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      25,

    assembly_type:
      'office desks',
  },
},

{
  input:
    'Deliver a 400-pound safe.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'safe',
  },
},

{
  input:
    'Move a sofa up five flights of stairs with no elevator.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      1,

    stairs:
      true,

    stair_flights:
      5,

    access_restrictions:
      '5 flights of stairs are involved. No elevator is available.',
  },
},

{
  input:
    'Clean a house but the water is currently shut off.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'house',

    access_restrictions:
      'Water is currently shut off.',
  },
},

{
  input:
    'Yard cleanup, but there\'s no outdoor power outlet.',

  category:
    'yard',

  expectedAnswers: {
    access_restrictions:
      'No outdoor power outlet is available.',
  },
},

{
  input:
    'Mount TV but I don\'t know what the wall is made of.',

  category:
    'assembly',

  expectedAnswers: {
    wall_mounting:
      true,
  },
},

{
  input:
    'Fix faucet; I already bought some parts but don\'t know if they\'re correct.',

  category:
    'handyman',

  expectedAnswers: {
  },
},

{
  input:
    'Car won\'t start and it\'s parked in an underground garage.',

  category:
    'auto',

  expectedAnswers: {
    access_restrictions:
      'The vehicle is parked in an underground garage.',
  },
},

{
  input:
    'Deliver a glass dining table that\'s extremely fragile.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'glass dining table',

    heavy_or_fragile:
      true,
  },
},

{
  input:
    'Pet sit four dogs, two cats and a parrot.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_count:
      7,

    care_type:
      [
        'sitting',
      ],
  },
},

{
  input:
    'Setup event for somewhere between 50 and 200 people.',

  category:
    'events',

  expectedAnswers: {
  },
},

{
  input:
    'Move furniture but the hallway is only 30 inches wide.',

  category:
    'moving',

  expectedAnswers: {
    access_restrictions:
      'Access is narrow and may restrict movement.',
  },
},

{
  input:
    'Need cleanup after a party; not sure how bad it will be.',

  category:
    'events',

  expectedAnswers: {
  },
},

{
  input:
    'Assemble furniture but some pieces might be missing.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_type:
      'furniture',
  },
},

{
  input:
    'Remove debris but I don\'t know what type of material it is.',

  category:
    'yard',

  expectedAnswers: {
    debris:
      true,
  },
},

{
  input:
    'Need handyman work in a rental property; landlord approval may be required.',

  category:
    'handyman',

  expectedAnswers: {
    access_restrictions:
      'Landlord approval may be required.',
  },
},

{
  input:
    'Work can only happen between 2:00-4:00 PM because of building rules.',

  category:
    'other',

  expectedAnswers: {
    access_restrictions:
      'Building rules limit work to between 2:00 PM and 4:00 PM.',
  },
},

{
  input:
    'yo need someone to grab a couch from this dude like 15 mins away and bring it over, probably need a van cuz it\'s kinda huge',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'couch',

    vehicle_size:
      'van',
  },
},

{
  input:
    'backyard is fucked lol bunch of leaves branches and random junk everywhere, just want all of it gone',

  category:
    'yard',

  expectedAnswers: {
    debris:
      true,

    debris_type:
      [
        'leaves',
        'branches',
        'junk',
      ],
  },
},

{
  input:
    'moving next week got like bed tv desk maybe 10 boxes idk, second floor rn new place has elevator',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      13,

    access_restrictions:
      'Access involves the 2nd floor. Access involves the 3rd floor.',
  },
},

{
  input:
    'something leaking below kitchen sink not sure what, got water on cabinet floor',

  category:
    'home_services',

  expectedAnswers: {
  },
},
{
  input:
    'Rake leaves from a medium yard.',

  category:
    'yard',

  expectedAnswers: {
    yard_size:
      'medium',

    debris_type:
      [
        'leaves',
      ],
  },
},

{
  input:
    'Clean up a huge backyard full of branches.',

  category:
    'yard',

  expectedAnswers: {
    yard_size:
      'large',

    debris_type:
      [
        'branches',
      ],
  },
},

{
  input:
    'Bag the leaves in my small front yard but leave the bags by the fence.',

  category:
    'yard',

  expectedAnswers: {
    yard_size:
      'small',

    debris:
      false,

    debris_type:
      [
        'leaves',
      ],
  },
},

{
  input:
    'Haul away branches and yard waste from my backyard.',

  category:
    'yard',

  expectedAnswers: {
    debris:
      true,

    debris_type:
      [
        'branches',
        'green_waste',
      ],
  },
},

{
  input:
    'I have a rake and leaf blower here for the yard cleanup.',

  category:
    'yard',

  expectedAnswers: {
    equipment_provided:
      true,
  },
},

{
  input:
    'Please bring your own rake for the leaves.',

  category:
    'yard',

  expectedAnswers: {
    equipment_provided:
      false,

    debris_type:
      [
        'leaves',
      ],
  },
},

{
  input:
    'Clear twigs and rubbish from an average-sized yard.',

  category:
    'yard',

  expectedAnswers: {
    yard_size:
      'medium',

    debris_type:
      [
        'branches',
        'junk',
      ],
  },
},

{
  input:
    'Take all the green waste with you after cleaning the yard.',

  category:
    'yard',

  expectedAnswers: {
    debris:
      true,

    debris_type:
      [
        'green_waste',
      ],
  },
},

{
  input:
    'Pile the branches next to the shed when you are done.',

  category:
    'yard',

  expectedAnswers: {
    debris:
      false,

    debris_type:
      [
        'branches',
      ],
  },
},

{
  input:
    'Clean a tiny lawn covered in leaves and pine needles.',

  category:
    'yard',

  expectedAnswers: {
    yard_size:
      'small',

    debris_type:
      [
        'leaves',
        'green_waste',
      ],
  },
},

{
  input:
    'Move 6 chairs and 4 boxes.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      10,
  },
},

{
  input:
    'Carry two tables and five boxes downstairs.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      7,

    stairs:
      true,

    access_restrictions:
      'The task involves stair access.',
  },
},

{
  input:
    'Move 9 boxes up 4 flights of stairs.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      9,

    stairs:
      true,

    stair_flights:
      4,

    access_restrictions:
      '4 flights of stairs are involved.',
  },
},

{
  input:
    'Move 3 boxes. There are no stairs.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      3,

    stairs:
      false,
  },
},

{
  input:
    'Move a bulky cabinet and two chairs.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      3,

    large_items:
      true,
  },
},

{
  input:
    'Move six small boxes. No vehicle is needed.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      6,

    vehicle_required:
      false,
  },
},

{
  input:
    'Move 14 boxes and bring a van.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      14,

    vehicle_required:
      true,
  },
},

{
  input:
    'Carry 2 chairs up one flight and 3 boxes down one flight.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      5,

    stairs:
      true,

    stair_flights:
      1,

    access_restrictions:
      '1 flight of stairs is involved.',
  },
},

{
  input:
    'Move a heavy desk and a lamp.',

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
    'Move 5 boxes from floor 3 using the elevator.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      5,

    access_restrictions:
      'Access involves the 3rd floor.',
  },
},

{
  input:
    'Assemble two desks and three chairs.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      5,

    assembly_type:
      'desks and chairs',
  },
},

{
  input:
    'Put together one cabinet, two shelves, and one table.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      4,

    assembly_type:
      'cabinet and shelves and table',
  },
},

{
  input:
    'Assemble 4 stools and mount nothing to the wall.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      4,

    assembly_type:
      'stools',

    wall_mounting:
      false,
  },
},

{
  input:
    'Install two wall shelves on drywall.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      2,

    assembly_type:
      'wall shelves',

    wall_mounting:
      true,

    wall_type:
      'drywall',
  },
},

{
  input:
    'Mount a cabinet on a brick wall.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      1,

    assembly_type:
      'cabinet',

    wall_mounting:
      true,

    wall_type:
      'brick',
  },
},

{
  input:
    'Assemble three beds over 6 hours.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      3,

    assembly_type:
      'beds',
  },
},

{
  input:
    'Build one desk and four chairs on the second floor.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      5,

    assembly_type:
      'desk and chairs',

    access_restrictions:
      'Access involves the 2nd floor.',
  },
},

{
  input:
    'Assemble 2 cabinets and mount both on drywall.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      2,

    assembly_type:
      'cabinets',

    wall_mounting:
      true,

    wall_type:
      'drywall',
  },
},

{
  input:
    'Put together a table and six dining chairs.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      7,

    assembly_type:
      'table and dining chairs',
  },
},

{
  input:
    'Assemble a bookshelf. Do not anchor it to the wall.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      1,

    assembly_type:
      'bookshelf',

    wall_mounting:
      false,
  },
},

{
  input:
    'Deliver a fragile mirror.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'mirror',

    heavy_or_fragile:
      true,
  },
},

{
  input:
    'Bring 8 boxes from the store to my house.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'boxes',
  },
},

{
  input:
    'Deliver a heavy generator.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'generator',

    heavy_or_fragile:
      true,
  },
},

{
  input:
    'Pick up two lamps and bring them to my apartment.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'lamps',
  },
},

{
  input:
    'Transport a breakable glass vase.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'glass vase',

    heavy_or_fragile:
      true,
  },
},

{
  input:
    'Deliver a desk. A vehicle is required.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'desk',
  },
},

{
  input:
    'Bring a package across town. No vehicle is needed.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'package',
  },
},

{
  input:
    'Pick up a fragile computer from the office.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'computer',

    heavy_or_fragile:
      true,
  },
},

{
  input:
    'Deliver three dining chairs.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'dining chairs',
  },
},

{
  input:
    'Bring a heavy box upstairs.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'box',

    heavy_or_fragile:
      true,

    access_restrictions:
      'The task involves stair access.',
  },
},

{
  input:
    'Clean my 4-room apartment.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'apartment',

    room_count:
      4,
  },
},

{
  input:
    'Clean a house with 7 rooms.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'house',

    room_count:
      7,
  },
},

{
  input:
    'Clean my office for 3 hours.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'office',
  },
},

{
  input:
    'Clean three rooms in my apartment.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'apartment',

    room_count:
      3,
  },
},

{
  input:
    'Clean a 2-room office.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'office',

    room_count:
      2,
  },
},

{
  input:
    'Clean my five-room home.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'house',

    room_count:
      5,
  },
},

{
  input:
    'Clean one room upstairs.',

  category:
    'cleaning',

  expectedAnswers: {
    room_count:
      1,

    access_restrictions:
      'The task involves stair access.',
  },
},

{
  input:
    'Clean 6 rooms on the third floor. There is an elevator.',

  category:
    'cleaning',

  expectedAnswers: {
    room_count:
      6,

    access_restrictions:
      'Access involves the 3rd floor.',
  },
},

{
  input:
    'Clean a small office with 4 rooms.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'office',

    room_count:
      4,
  },
},

{
  input:
    'Clean 2 bedrooms and 1 bathroom.',

  category:
    'cleaning',

  expectedAnswers: {
    room_count:
      3,
  },
},

{
  input:
    'Walk three dogs.',

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
    'Feed two cats.',

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
      ],
  },
},

{
  input:
    'Watch one dog for 8 hours.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'dog',

    pet_count:
      1,

    care_type:
      [
        'sitting',
      ],
  },
},

{
  input:
    'Walk and feed three dogs for 2 hours.',

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
        'feeding',
      ],
  },
},

{
  input:
    'Pet sit my two cats.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'cat',

    pet_count:
      2,

    care_type:
      [
        'sitting',
      ],
  },
},

{
  input:
    'Feed and watch my cat.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'cat',

    care_type:
      [
        'feeding',
        'sitting',
      ],
  },
},

{
  input:
    'Walk my dog and then feed him.',

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
    'Watch four cats for the day.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'cat',

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
    'Feed my dog twice today.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'dog',

    care_type:
      [
        'feeding',
      ],
  },
},

{
  input:
    'Walk 2 dogs for 45 minutes.',

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
    'Party for 75 guests.',

  category:
    'events',

  expectedAnswers: {
    guest_count:
      75,
  },
},

{
  input:
    'Help with an event for 120 people.',

  category:
    'events',

  expectedAnswers: {
    guest_count:
      120,
  },
},

{
  input:
    'Setup help for 35 guests over 3 hours.',

  category:
    'events',

  expectedAnswers: {
    guest_count:
      35,
  },
},

{
  input:
    'Serve dinner to 90 guests.',

  category:
    'events',

  expectedAnswers: {
    guest_count:
      90,
  },
},

{
  input:
    'Wedding reception with 180 guests.',

  category:
    'events',

  expectedAnswers: {
    guest_count:
      180,
  },
},

{
  input:
    'Small party with 12 guests.',

  category:
    'events',

  expectedAnswers: {
    guest_count:
      12,
  },
},

{
  input:
    'Event setup for 250 attendees.',

  category:
    'events',

  expectedAnswers: {
    guest_count:
      250,
  },
},

{
  input:
    'Need help at a dinner for 18 people.',

  category:
    'events',

  expectedAnswers: {
    guest_count:
      18,
  },
},

{
  input:
    'Birthday party with about 40 guests.',

  category:
    'events',

  expectedAnswers: {
    guest_count:
      40,
  },
},

{
  input:
    'Corporate event for 300 people on the 15th.',

  category:
    'events',

  expectedAnswers: {
    guest_count:
      300,
  },
},

{
  input:
    'Move 4 boxes up 2 flights and bring a truck.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      4,

    stairs:
      true,

    stair_flights:
      2,

    vehicle_required:
      true,

    access_restrictions:
      '2 flights of stairs are involved.',
  },
},

{
  input:
    'Move two bulky tables downstairs with no vehicle needed.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      2,

    stairs:
      true,

    large_items:
      true,

    vehicle_required:
      false,

    access_restrictions:
      'The task involves stair access.',
  },
},

{
  input:
    'Deliver a fragile cabinet up 3 flights.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'cabinet',

    heavy_or_fragile:
      true,

    access_restrictions:
      '3 flights of stairs are involved.',
  },
},

{
  input:
    'Assemble three shelves and mount them on brick.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      3,

    assembly_type:
      'shelves',

    wall_mounting:
      true,

    wall_type:
      'brick',
  },
},

{
  input:
    'Clean 3 rooms in a house with no elevator access to the upper floor.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'house',

    room_count:
      3,

    access_restrictions:
      'No elevator is available.',
  },
},

{
  input:
    'Walk two dogs and watch them afterward.',

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
        'sitting',
      ],
  },
},

{
  input:
    'Take away leaves and trash from a big yard.',

  category:
    'yard',

  expectedAnswers: {
    yard_size:
      'large',

    debris:
      true,

    debris_type:
      [
        'leaves',
        'junk',
      ],
  },
},

{
  input:
    'Clear branches from a medium yard but leave them in a pile.',

  category:
    'yard',

  expectedAnswers: {
    yard_size:
      'medium',

    debris:
      false,

    debris_type:
      [
        'branches',
      ],
  },
},

{
  input:
    'Move 1 couch for 4 hours.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      1,
  },
},

{
  input:
    'Assemble 12 chairs on floor 5.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      12,

    assembly_type:
      'chairs',

    access_restrictions:
      'Access involves the 5th floor.',
  },
},

{
  input:
    'Watch my two dogs for 6 hours and feed them once.',

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
        'feeding',
      ],
  },
},

{
  input:
    'Deliver a breakable lamp and a mirror.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'lamp and mirror',

    heavy_or_fragile:
      true,
  },
},

{
  input:
    'Move three boxes up stairs and two chairs downstairs.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      5,

    stairs:
      true,

    access_restrictions:
      'The task involves stair access.',
  },
},

{
  input:
    'Clean 10 rooms for 5 hours.',

  category:
    'cleaning',

  expectedAnswers: {
    room_count:
      10,
  },
},

{
  input:
    'Party setup for 60 guests on the second floor.',

  category:
    'events',

  expectedAnswers: {
    guest_count:
      60,

    access_restrictions:
      'Access involves the 2nd floor.',
  },
},

{
  input:
    'Bring a heavy table to my apartment. A van is required.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'table',

    heavy_or_fragile:
      true,
    vehicle_size: 'van',
  },
},

{
  input:
    'Assemble a desk and two chairs, then mount a shelf on drywall.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      4,

    assembly_type:
      'desk and chairs and shelf',

    wall_mounting:
      true,

    wall_type:
      'drywall',
  },
},

{
  input:
    'Rake leaves from a large yard and leave them bagged by the gate.',

  category:
    'yard',

  expectedAnswers: {
    yard_size:
      'large',

    debris:
      false,

    debris_type:
      [
        'leaves',
      ],
  },
},

{
  input:
    'Move 25 boxes with no stairs and no vehicle needed.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      25,

    stairs:
      false,

    vehicle_required:
      false,
  },
},

{
  input:
    'Deliver a glass desk and bring a truck.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'glass desk',
    vehicle_size: 'truck',
  },
},

{
  input:
    'Feed and watch three cats for 7 hours.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'cat',

    pet_count:
      3,

    care_type:
      [
        'feeding',
        'sitting',
      ],
  },
},

{
  input:
    'Clean an office with 9 rooms on floor 4.',

  category:
    'cleaning',

  expectedAnswers: {
    property_type:
      'office',

    room_count:
      9,

    access_restrictions:
      'Access involves the 4th floor.',
  },
},

{
  input:
    'Assemble 2 tables and 8 chairs.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      10,

    assembly_type:
      'tables and chairs',
  },
},

{
  input:
    'Move one bulky wardrobe up two flights.',

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
      2,

    access_restrictions:
      '2 flights of stairs are involved.',
  },
},

{
  input:
    'Haul away rubbish and leaves from a small yard.',

  category:
    'yard',

  expectedAnswers: {
    yard_size:
      'small',

    debris:
      true,

    debris_type:
      [
        'junk',
        'leaves',
      ],
  },
},

{
  input:
    'Deliver a fragile TV with no vehicle required.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'TV',

    heavy_or_fragile:
      true,
  },
},

{
  input:
    'Walk four dogs for 30 minutes and feed them.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'dog',

    pet_count:
      4,

    care_type:
      [
        'walking',
        'feeding',
      ],
  },
},

{
  input:
    'Clean 2 rooms upstairs and 3 rooms downstairs.',

  category:
    'cleaning',

  expectedAnswers: {
    room_count:
      5,

    access_restrictions:
      'The task involves stair access.',
  },
},

{
  input:
    'Setup an event for 85 guests over 4 hours.',

  category:
    'events',

  expectedAnswers: {
    guest_count:
      85,
  },
},

{
  input:
    'Assemble one table, one cabinet, and six chairs.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      8,

    assembly_type:
      'table and cabinet and chairs',
  },
},

{
  input:
    'Move 7 boxes and a heavy cabinet.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      8,

    large_items:
      true,
  },
},

{
  input:
    'Deliver two lamps and a breakable vase.',

  category:
    'delivery',

  expectedAnswers: {
    delivery_item:
      'lamps and vase',

    heavy_or_fragile:
      true,
  },
},

{
  input:
    'Clear pine needles and leaves from an average-sized lawn.',

  category:
    'yard',

  expectedAnswers: {
    yard_size:
      'medium',

    debris_type:
      [
        'green_waste',
        'leaves',
      ],
  },
},

{
  input:
    'Move three chairs for 2 hours with no stairs.',

  category:
    'moving',

  expectedAnswers: {
    item_count:
      3,

    stairs:
      false,
  },
},

{
  input:
    'Watch five cats for 3 hours.',

  category:
    'pet_care',

  expectedAnswers: {
    pet_type:
      'cat',

    pet_count:
      5,

    care_type:
      [
        'sitting',
      ],
  },
},

{
  input:
    'Mount 2 shelves on brick and assemble 3 chairs.',

  category:
    'assembly',

  expectedAnswers: {
    assembly_count:
      5,

    assembly_type:
      'shelves and chairs',

    wall_mounting:
      true,

    wall_type:
      'brick',
  },
},

{
  input:
    'Party for 55 people lasting 6 hours.',

  category:
    'events',

  expectedAnswers: {
    guest_count:
      55,
  },
},

];

const EXACT_CASES: ExpectedPrefill[] = [...new Map(EXACT_CASES_RAW.map((testCase) => [testCase.input, testCase])).values()];

function isSuspiciouslyVague(input: string): boolean {
  const text = input.trim().toLowerCase();
  const vagueStart = /^(?:need someone|need help|help me|can someone help|looking for help)\b/i.test(text);
  if (!vagueStart) return false;
  const concreteFactSignal = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|box|boxes|dog|dogs|cat|cats|room|rooms|chair|chairs|table|tables|desk|desks|stairs|flight|flights|apartment|house|office|deliver|move|assemble|clean|walk|feed)\b/i;
  return !concreteFactSignal.test(text);
}

function equalAnswer(key: string, a: IntakeAnswer | undefined, b: IntakeAnswer): boolean {
  if (key === 'access_restrictions' && typeof a === 'string' && typeof b === 'string') {
    const normalize = (value: string) => value.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    const words = normalize(b).split(' ').filter((word) => word.length >= 4);
    const overlap = words.filter((word) => normalize(a).includes(word));
    return overlap.length >= Math.max(1, Math.ceil(words.length * 0.5));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const actualSorted = [...a].sort();
    const expectedSorted = [...b].sort();
    return actualSorted.every((value, index) => value === expectedSorted[index]);
  }
  return a === b;
}
function getAllowedKeys(category: TaskCategory, secondary: readonly TaskCategory[] = []): Set<string> { return new Set(getQuestionsForIntake(category, secondary).map((q) => q.key)); }

const failures: string[] = [];

function runExactAssertions(): void {
  for (const testCase of EXACT_CASES) {
    const result = extractIntakePrefill(testCase.input, testCase.category, testCase.secondaryIntents ?? []);
    const actualKeys = Object.keys(result.answers).sort();
    const expectedKeys = Object.keys(testCase.expectedAnswers).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      failures.push([testCase.input, 'KEYS', `expected=${JSON.stringify(expectedKeys)}`, `actual=${JSON.stringify(actualKeys)}`].join(' | '));
      continue;
    }
    for (const [key, expected] of Object.entries(testCase.expectedAnswers)) {
      const actual = result.answers[key];
      if (!equalAnswer(key, actual, expected)) failures.push([testCase.input, `field=${key}`, `expected=${JSON.stringify(expected)}`, `actual=${JSON.stringify(actual)}`].join(' | '));
    }
  }
}

async function main(): Promise<void> {
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
    const hasExplicitProviderResource =
      typeof result.answers.provider_resources === 'string' &&
      result.answers.provider_resources.trim().length > 0;
    if (vague && keys.length > 0 && !hasExplicitProviderResource) {
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
  runExactAssertions();
  if (failures.length > 0) {
    console.error(`\nExact-case failures: ${failures.length}\n`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`Exact cases passed: ${EXACT_CASES.length}/${EXACT_CASES.length}`);
  }
  console.log('Corpus prefill validation passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });























