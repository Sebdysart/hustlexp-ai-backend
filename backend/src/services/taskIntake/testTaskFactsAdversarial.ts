import assert from 'node:assert/strict';
import { buildTaskFacts } from './buildTaskFacts.js';

const cases = [
  // ------------------------------------------------------------
  // MOVING / OBJECTS / ACCESS
  // ------------------------------------------------------------

  {
    input: 'Move two chairs upstairs.',
    expected: {
      goal: 'moving',
      objects: [
        {
          type: 'chair',
          quantity: 2,
          description: 'two chairs',
        },
      ],
      access: {
        stairs: true,
      },
      actions: [
        {
          type: 'move',
          object: 'chair',
          quantity: 2,
          evidence: 'move',
        },
      ],
    },
  },

  {
    input: 'Carry the dresser down three flights.',
    expected: {
      goal: 'moving',
      objects: [
        {
          type: 'dresser',
          description: 'dresser',
        },
      ],
      access: {
        stairs: true,
        stairFlights: 3,
      },
      actions: [
        {
          type: 'move',
          object: 'dresser',
          evidence: 'carry',
        },
      ],
    },
  },

  {
    input: 'Move the couch through a narrow hallway.',
    expected: {
      goal: 'moving',
      objects: [
        {
          type: 'couch',
          description: 'couch',
        },
      ],
      location: {
        areas: ['hallway'],
      },
      access: {
        narrowAccess: true,
      },
      actions: [
        {
          type: 'move',
          object: 'couch',
          evidence: 'move',
        },
      ],
    },
  },

  {
    input: 'Move the piano from the third floor with no elevator.',
    expected: {
      goal: 'moving',
      objects: [
        {
          type: 'piano',
          description: 'piano',
        },
      ],
      location: {
        floor: 3,
      },
      access: {
        elevatorAvailable: false,
      },
      actions: [
        {
          type: 'move',
          object: 'piano',
          evidence: 'move',
        },
      ],
    },
  },

  {
    input: 'Move four boxes from the garage.',
    expected: {
      goal: 'moving',
      objects: [
        {
          type: 'box',
          quantity: 4,
          description: 'four boxes',
        },
      ],
      location: {
        areas: ['garage'],
      },
      actions: [
        {
          type: 'move',
          object: 'box',
          quantity: 4,
          evidence: 'move',
        },
      ],
    },
  },

  {
    input: 'Carry a 150 pound cabinet.',
    expected: {
      goal: 'moving',
      objects: [
        {
          type: 'cabinet',
          description: '150 pound cabinet',
        },
      ],
      measurements: {
        weight: 150,
      },
      actions: [
        {
          type: 'move',
          object: 'cabinet',
          evidence: 'carry',
        },
      ],
    },
  },

  {
    input: 'Move a sofa through a 32 inch doorway.',
    expected: {
      goal: 'moving',
      objects: [
        {
          type: 'couch',
          description: 'sofa',
        },
      ],
      measurements: {
        dimensions: ['32 inch'],
      },
      actions: [
        {
          type: 'move',
          object: 'couch',
          evidence: 'move',
        },
      ],
    },
  },

  {
    input: 'Move a bed from the upstairs bedroom.',
    expected: {
      goal: 'moving',
      objects: [
        {
          type: 'bed',
          description: 'bed',
        },
      ],
      location: {
        areas: ['bedroom'],
      },
      actions: [
        {
          type: 'move',
          object: 'bed',
          evidence: 'move',
        },
      ],
    },
  },

  // ------------------------------------------------------------
  // DELIVERY / PICKUP / INSTALL
  // ------------------------------------------------------------

  {
    input: 'Deliver two mirrors.',
    expected: {
      goal: 'delivery',
      objects: [
        {
          type: 'mirror',
          quantity: 2,
          description: 'two mirrors',
        },
      ],
      actions: [
        {
          type: 'deliver',
          object: 'mirror',
          quantity: 2,
          evidence: 'deliver',
        },
      ],
    },
  },

  {
    input: 'Pick up three boxes and deliver them.',
    expected: {
      goal: 'delivery',
      objects: [
        {
          type: 'box',
          quantity: 3,
          description: 'three boxes',
        },
      ],
      actions: [
        {
          type: 'pickup',
          object: 'box',
          quantity: 3,
          evidence: 'pick up',
        },
        {
          type: 'deliver',
          object: 'box',
          quantity: 3,
          evidence: 'deliver',
        },
      ],
    },
  },

  {
    input: 'Pick up a washing machine and install it.',
    expected: {
      goal: 'delivery',
      objects: [
        {
          type: 'washing machine',
          description: 'washing machine',
        },
      ],
      actions: [
        {
          type: 'pickup',
          object: 'washing machine',
          evidence: 'pick up',
        },
        {
          type: 'install',
          object: 'washing machine',
          evidence: 'install',
        },
      ],
    },
  },

  {
    input: 'Deliver a refrigerator to the garage.',
    expected: {
      goal: 'delivery',
      objects: [
        {
          type: 'refrigerator',
          description: 'refrigerator',
        },
      ],
      location: {
        areas: ['garage'],
      },
      actions: [
        {
          type: 'deliver',
          object: 'refrigerator',
          evidence: 'deliver',
        },
      ],
    },
  },

  {
    input: 'Bring two shelves upstairs and install them.',
    expected: {
      goal: 'delivery',
      objects: [
        {
          type: 'shelf',
          quantity: 2,
          description: 'two shelves',
        },
      ],
      access: {
        stairs: true,
      },
      actions: [
        {
          type: 'deliver',
          object: 'shelf',
          quantity: 2,
          evidence: 'bring',
        },
        {
          type: 'install',
          object: 'shelf',
          quantity: 2,
          evidence: 'install',
        },
      ],
    },
  },

  {
    input: 'Deliver a fragile TV.',
    expected: {
      goal: 'delivery',
      objects: [
        {
          type: 'tv',
          description: 'tv',
        },
      ],
      actions: [
        {
          type: 'deliver',
          object: 'tv',
          evidence: 'deliver',
        },
      ],
    },
  },

  {
    input: 'Pick up a couch 20 miles away.',
    expected: {
      goal: 'delivery',
      objects: [
        {
          type: 'couch',
          description: 'couch',
        },
      ],
      measurements: {
        distanceMiles: 20,
      },
      actions: [
        {
          type: 'pickup',
          object: 'couch',
          evidence: 'pick up',
        },
      ],
    },
  },

  // ------------------------------------------------------------
  // ASSEMBLY / INSTALLATION
  // ------------------------------------------------------------

  {
    input: 'Assemble four chairs.',
    expected: {
      goal: 'assembly',
      objects: [
        {
          type: 'chair',
          quantity: 4,
          description: 'four chairs',
        },
      ],
      actions: [
        {
          type: 'assemble',
          object: 'chair',
          quantity: 4,
          evidence: 'assemble',
        },
      ],
    },
  },

  {
    input: 'Build a table in the dining room.',
    expected: {
      goal: 'assembly',
      objects: [
        {
          type: 'table',
          description: 'table',
        },
      ],
      location: {
        areas: ['dining room'],
      },
      actions: [
        {
          type: 'assemble',
          object: 'table',
          evidence: 'build',
        },
      ],
    },
  },

  {
    input: 'Install three shelves in the garage.',
    expected: {
      goal: 'installation',
      objects: [
        {
          type: 'shelf',
          quantity: 3,
          description: 'three shelves',
        },
      ],
      location: {
        areas: ['garage'],
      },
      actions: [
        {
          type: 'install',
          object: 'shelf',
          quantity: 3,
          evidence: 'install',
        },
      ],
    },
  },

  {
    input: 'Mount a TV in the bedroom.',
    expected: {
      goal: 'installation',
      objects: [
        {
          type: 'tv',
          description: 'tv',
        },
      ],
      location: {
        areas: ['bedroom'],
      },
      actions: [
        {
          type: 'mount',
          object: 'tv',
          evidence: 'mount',
        },
      ],
    },
  },

  {
    input: 'Assemble two cabinets and mount them.',
    expected: {
      goal: 'assembly',
      objects: [
        {
          type: 'cabinet',
          quantity: 2,
          description: 'two cabinets',
        },
      ],
      actions: [
        {
          type: 'assemble',
          object: 'cabinet',
          quantity: 2,
          evidence: 'assemble',
        },
        {
          type: 'mount',
          object: 'cabinet',
          quantity: 2,
          evidence: 'mount',
        },
      ],
    },
  },

  {
    input: 'Put together a desk and move it upstairs.',
    expected: {
      goal: 'assembly',
      objects: [
        {
          type: 'desk',
          description: 'desk',
        },
      ],
      access: {
        stairs: true,
      },
      actions: [
        {
          type: 'assemble',
          object: 'desk',
          evidence: 'put together',
        },
        {
          type: 'move',
          object: 'desk',
          evidence: 'move',
        },
      ],
    },
  },

  // ------------------------------------------------------------
  // CLEANING / AREAS
  // ------------------------------------------------------------

  {
    input: 'Clean the kitchen.',
    expected: {
      goal: 'cleaning',
      location: {
        areas: ['kitchen'],
      },
      actions: [
        {
          type: 'clean',
          evidence: 'clean',
        },
      ],
    },
  },

  {
    input: 'Vacuum the bedroom and hallway.',
    expected: {
      goal: 'cleaning',
      location: {
        areas: ['bedroom', 'hallway'],
      },
      actions: [
        {
          type: 'clean',
          evidence: 'vacuum',
        },
      ],
    },
  },

  {
    input: 'Mop the kitchen and bathroom.',
    expected: {
      goal: 'cleaning',
      location: {
        areas: ['kitchen', 'bathroom'],
      },
      actions: [
        {
          type: 'clean',
          evidence: 'mop',
        },
      ],
    },
  },

  {
    input: 'Clean the downstairs bathroom.',
    expected: {
      goal: 'cleaning',
      location: {
        areas: ['bathroom'],
      },
      actions: [
        {
          type: 'clean',
          evidence: 'clean',
        },
      ],
    },
  },

  {
    input: 'Vacuum the upstairs bedroom.',
    expected: {
      goal: 'cleaning',
      location: {
        areas: ['bedroom'],
      },
      actions: [
        {
          type: 'clean',
          evidence: 'vacuum',
        },
      ],
    },
  },

  {
    input: 'Scrub the bathroom tomorrow.',
    expected: {
      goal: 'cleaning',
      location: {
        areas: ['bathroom'],
      },
      timing: {
        urgency: 'scheduled',
        dayReference: 'tomorrow',
      },
      actions: [
        {
          type: 'clean',
          evidence: 'scrub',
        },
      ],
    },
  },

  // ------------------------------------------------------------
  // PET CARE
  // ------------------------------------------------------------

  {
    input: 'Walk two dogs.',
    expected: {
      goal: 'pet care',
      objects: [
        {
          type: 'pet',
          quantity: 2,
          description: 'two dogs',
        },
      ],
      actions: [
        {
          type: 'walk',
          object: 'dog',
          quantity: 2,
          evidence: 'walk',
        },
      ],
    },
  },

  {
    input: 'Feed three cats.',
    expected: {
      goal: 'pet care',
      objects: [
        {
          type: 'pet',
          quantity: 3,
          description: 'three cats',
        },
      ],
      actions: [
        {
          type: 'feed',
          object: 'cat',
          quantity: 3,
          evidence: 'feed',
        },
      ],
    },
  },

  {
    input: 'Watch two dogs and feed them.',
    expected: {
      goal: 'pet care',
      objects: [
        {
          type: 'pet',
          quantity: 2,
          description: 'two dogs',
        },
      ],
      actions: [
        {
          type: 'watch',
          object: 'dog',
          quantity: 2,
          evidence: 'watch',
        },
        {
          type: 'feed',
          object: 'dog',
          quantity: 2,
          evidence: 'feed',
        },
      ],
    },
  },

  {
    input: 'Walk one dog for two hours.',
    expected: {
      goal: 'pet care',
      objects: [
        {
          type: 'pet',
          quantity: 1,
          description: 'one dog',
        },
      ],
      measurements: {
        durationMinutes: 120,
      },
      actions: [
        {
          type: 'walk',
          object: 'dog',
          quantity: 1,
          evidence: 'walk',
        },
      ],
    },
  },

  {
    input: 'Watch the cat tomorrow.',
    expected: {
      goal: 'pet care',
      timing: {
        urgency: 'scheduled',
        dayReference: 'tomorrow',
      },
      actions: [
        {
          type: 'watch',
          object: 'cat',
          evidence: 'watch',
        },
      ],
    },
  },

  // ------------------------------------------------------------
  // RESOURCES
  // ------------------------------------------------------------

  {
    input: 'Need someone with a truck.',
    expected: {
      resources: {
        required: ['truck'],
      },
    },
  },

  {
    input: 'Bring your own drill.',
    expected: {
      resources: {
        required: ['drill'],
      },
    },
  },

  {
    input: 'I have a ladder here for you.',
    expected: {
      resources: {
        provided: ['ladder'],
      },
    },
  },

  {
    input: 'We have a mower.',
    expected: {
      resources: {
        provided: ['mower'],
      },
    },
  },

  {
    input: 'Provider needs a van.',
    expected: {
      resources: {
        required: ['van'],
      },
    },
  },

  {
    input: 'Bring your own tools.',
    expected: {
      resources: {
        required: ['tools'],
      },
    },
  },

  // ------------------------------------------------------------
  // TIMING
  // ------------------------------------------------------------

  {
    input: 'Need this done ASAP.',
    expected: {
      timing: {
        urgency: 'asap',
      },
    },
  },

  {
    input: 'Do this tomorrow.',
    expected: {
      timing: {
        urgency: 'scheduled',
        dayReference: 'tomorrow',
      },
    },
  },

  {
    input: 'Need this today.',
    expected: {
      timing: {
        urgency: 'scheduled',
        dayReference: 'today',
      },
    },
  },

  {
    input: 'Work can happen between 8am and 10am.',
    expected: {
      timing: {
        urgency: 'scheduled',
        timeWindow: {
          start: '8am',
          end: '10am',
        },
      },
    },
  },

  {
    input: 'Only available between 1:30pm and 4pm.',
    expected: {
      timing: {
        urgency: 'scheduled',
        timeWindow: {
          start: '1:30pm',
          end: '4pm',
        },
      },
    },
  },

  // ------------------------------------------------------------
  // AREA ORDER / MULTIPLE AREAS
  // ------------------------------------------------------------

  {
    input: 'Clean the bathroom, kitchen, and hallway.',
    expected: {
      goal: 'cleaning',
      location: {
        areas: ['bathroom', 'kitchen', 'hallway'],
      },
      actions: [
        {
          type: 'clean',
          evidence: 'clean',
        },
      ],
    },
  },

  {
    input: 'Vacuum the living room, bedroom, and office.',
    expected: {
      goal: 'cleaning',
      location: {
        areas: ['living room', 'bedroom', 'office'],
      },
      actions: [
        {
          type: 'clean',
          evidence: 'vacuum',
        },
      ],
    },
  },

  {
    input: 'Clean the backyard.',
    expected: {
      goal: 'cleaning',
      location: {
        areas: ['backyard'],
      },
      actions: [
        {
          type: 'clean',
          evidence: 'clean',
        },
      ],
    },
  },

  {
    input: 'Clean the front yard.',
    expected: {
      goal: 'cleaning',
      location: {
        areas: ['front yard'],
      },
      actions: [
        {
          type: 'clean',
          evidence: 'clean',
        },
      ],
    },
  },

  {
    input: 'Clean the yard.',
    expected: {
      goal: 'cleaning',
      location: {
        areas: ['yard'],
      },
      actions: [
        {
          type: 'clean',
          evidence: 'clean',
        },
      ],
    },
  },

  {
    input: 'Clean the patio and balcony.',
    expected: {
      goal: 'cleaning',
      location: {
        areas: ['patio', 'balcony'],
      },
      actions: [
        {
          type: 'clean',
          evidence: 'clean',
        },
      ],
    },
  },

  // ------------------------------------------------------------
  // MULTI-ACTION
  // ------------------------------------------------------------

  {
    input: 'Move the table and clean it.',
    expected: {
      goal: 'moving',
      objects: [
        {
          type: 'table',
          description: 'table',
        },
      ],
      actions: [
        {
          type: 'move',
          object: 'table',
          evidence: 'move',
        },
        {
          type: 'clean',
          object: 'table',
          evidence: 'clean',
        },
      ],
    },
  },

  {
    input: 'Deliver two cabinets and assemble them.',
    expected: {
      goal: 'delivery',
      objects: [
        {
          type: 'cabinet',
          quantity: 2,
          description: 'two cabinets',
        },
      ],
      actions: [
        {
          type: 'deliver',
          object: 'cabinet',
          quantity: 2,
          evidence: 'deliver',
        },
        {
          type: 'assemble',
          object: 'cabinet',
          quantity: 2,
          evidence: 'assemble',
        },
      ],
    },
  },

  {
    input: 'Move the TV and mount it.',
    expected: {
      goal: 'moving',
      objects: [
        {
          type: 'tv',
          description: 'tv',
        },
      ],
      actions: [
        {
          type: 'move',
          object: 'tv',
          evidence: 'move',
        },
        {
          type: 'mount',
          object: 'tv',
          evidence: 'mount',
        },
      ],
    },
  },

  {
    input: 'Pick up three shelves, deliver them, and install them.',
    expected: {
      goal: 'delivery',
      objects: [
        {
          type: 'shelf',
          quantity: 3,
          description: 'three shelves',
        },
      ],
      actions: [
        {
          type: 'pickup',
          object: 'shelf',
          quantity: 3,
          evidence: 'pick up',
        },
        {
          type: 'deliver',
          object: 'shelf',
          quantity: 3,
          evidence: 'deliver',
        },
        {
          type: 'install',
          object: 'shelf',
          quantity: 3,
          evidence: 'install',
        },
      ],
    },
  },

  // ------------------------------------------------------------
  // ACCESS FALSE-POSITIVE TRAPS
  // ------------------------------------------------------------

  {
    input: 'Clean the upstairs bedroom.',
    expected: {
      goal: 'cleaning',
      location: {
        areas: ['bedroom'],
      },
      actions: [
        {
          type: 'clean',
          evidence: 'clean',
        },
      ],
    },
  },

  {
    input: 'Repair the downstairs sink.',
    expected: {
      goal: 'repair',
      actions: [
        {
          type: 'repair',
          evidence: 'repair',
        },
      ],
    },
  },

  {
    input: 'Move the couch upstairs.',
    expected: {
      goal: 'moving',
      objects: [
        {
          type: 'couch',
          description: 'couch',
        },
      ],
      access: {
        stairs: true,
      },
      actions: [
        {
          type: 'move',
          object: 'couch',
          evidence: 'move',
        },
      ],
    },
  },

  {
    input: 'Bring the boxes downstairs.',
    expected: {
      goal: 'delivery',
      objects: [
        {
          type: 'box',
          description: 'boxes',
        },
      ],
      access: {
        stairs: true,
      },
      actions: [
        {
          type: 'deliver',
          object: 'box',
          evidence: 'bring',
        },
      ],
    },
  },

  // ------------------------------------------------------------
  // NUMBER ROLE TRAPS
  // ------------------------------------------------------------

  {
    input: 'Move a 300 pound piano.',
    expected: {
      goal: 'moving',
      objects: [
        {
          type: 'piano',
          description: '300 pound piano',
        },
      ],
      measurements: {
        weight: 300,
      },
      actions: [
        {
          type: 'move',
          object: 'piano',
          evidence: 'move',
        },
      ],
    },
  },

  {
    input: 'Walk two dogs for 90 minutes.',
    expected: {
      goal: 'pet care',
      objects: [
        {
          type: 'pet',
          quantity: 2,
          description: 'two dogs',
        },
      ],
      measurements: {
        durationMinutes: 90,
      },
      actions: [
        {
          type: 'walk',
          object: 'dog',
          quantity: 2,
          evidence: 'walk',
        },
      ],
    },
  },

  {
    input: 'Pick up three chairs 12 miles away.',
    expected: {
      goal: 'delivery',
      objects: [
        {
          type: 'chair',
          quantity: 3,
          description: 'three chairs',
        },
      ],
      measurements: {
        distanceMiles: 12,
      },
      actions: [
        {
          type: 'pickup',
          object: 'chair',
          quantity: 3,
          evidence: 'pick up',
        },
      ],
    },
  },

  {
    input: 'Move two cabinets through a 28 inch doorway.',
    expected: {
      goal: 'moving',
      objects: [
        {
          type: 'cabinet',
          quantity: 2,
          description: 'two cabinets',
        },
      ],
      measurements: {
        dimensions: ['28 inch'],
      },
      actions: [
        {
          type: 'move',
          object: 'cabinet',
          quantity: 2,
          evidence: 'move',
        },
      ],
    },
  },

  // ------------------------------------------------------------
  // NEGATION / CONSERVATIVE CASES
  // ------------------------------------------------------------

  {
    input: 'No elevator is available.',
    expected: {
      access: {
        elevatorAvailable: false,
      },
    },
  },

  {
    input: 'There is an elevator available.',
    expected: {
      access: {
        elevatorAvailable: true,
      },
    },
  },

  {
    input: 'No stairs are involved.',
    expected: {
      access: {
        stairs: false,
      },
    },
  },

  {
    input: 'The hallway is narrow.',
    expected: {
      location: {
        areas: ['hallway'],
      },
      access: {
        narrowAccess: true,
      },
    },
  },

  // ------------------------------------------------------------
  // CASUAL / MESSY WORDING
  // ------------------------------------------------------------

  {
    input: 'Need someone to move my couch upstairs tomorrow.',
    expected: {
      goal: 'moving',
      objects: [
        {
          type: 'couch',
          description: 'couch',
        },
      ],
      access: {
        stairs: true,
      },
      timing: {
        urgency: 'scheduled',
        dayReference: 'tomorrow',
      },
      actions: [
        {
          type: 'move',
          object: 'couch',
          evidence: 'move',
        },
      ],
    },
  },

  {
    input: 'Can someone bring a van and move two boxes?',
    expected: {
      goal: 'moving',
      objects: [
        {
          type: 'box',
          quantity: 2,
          description: 'two boxes',
        },
      ],
      resources: {
        required: ['van'],
      },
      actions: [
        {
          type: 'move',
          object: 'box',
          quantity: 2,
          evidence: 'move',
        },
      ],
    },
  },

  {
    input: 'Need the kitchen cleaned asap.',
    expected: {
      goal: 'cleaning',
      location: {
        areas: ['kitchen'],
      },
      timing: {
        urgency: 'asap',
      },
      actions: [
        {
          type: 'clean',
          evidence: 'cleaned',
        },
      ],
    },
  },

  {
    input: 'Need two shelves installed tomorrow.',
    expected: {
      goal: 'installation',
      objects: [
        {
          type: 'shelf',
          quantity: 2,
          description: 'two shelves',
        },
      ],
      timing: {
        urgency: 'scheduled',
        dayReference: 'tomorrow',
      },
      actions: [
        {
          type: 'install',
          object: 'shelf',
          quantity: 2,
          evidence: 'installed',
        },
      ],
    },
  },

  // ------------------------------------------------------------
  // INTENTIONALLY SPARSE / SHOULD NOT INVENT
  // ------------------------------------------------------------

  {
    input: 'Need some help tomorrow.',
    expected: {
      timing: {
        urgency: 'scheduled',
        dayReference: 'tomorrow',
      },
    },
  },

  {
    input: 'Need someone ASAP.',
    expected: {
      timing: {
        urgency: 'asap',
      },
    },
  },

  {
    input: 'Need help in the garage.',
    expected: {
      location: {
        areas: ['garage'],
      },
    },
  },

  {
    input: 'Need someone with tools.',
    expected: {
      resources: {
        required: ['tools'],
      },
    },
  },

  // ------------------------------------------------------------
  // CROSS-DOMAIN / LONGER TASKS
  // ------------------------------------------------------------

  {
    input: 'Pick up two cabinets, bring them upstairs, and install them in the kitchen.',
    expected: {
      goal: 'delivery',
      objects: [
        {
          type: 'cabinet',
          quantity: 2,
          description: 'two cabinets',
        },
      ],
      location: {
        areas: ['kitchen'],
      },
      access: {
        stairs: true,
      },
      actions: [
        {
          type: 'pickup',
          object: 'cabinet',
          quantity: 2,
          evidence: 'pick up',
        },
        {
          type: 'deliver',
          object: 'cabinet',
          quantity: 2,
          evidence: 'bring',
        },
        {
          type: 'install',
          object: 'cabinet',
          quantity: 2,
          evidence: 'install',
        },
      ],
    },
  },

  {
    input: 'Move the dresser from the bedroom to the garage.',
    expected: {
      goal: 'moving',
      objects: [
        {
          type: 'dresser',
          description: 'dresser',
        },
      ],
      location: {
        areas: ['bedroom', 'garage'],
      },
      actions: [
        {
          type: 'move',
          object: 'dresser',
          evidence: 'move',
        },
      ],
    },
  },

  {
    input: 'Clean the kitchen and bathroom between 9am and 11am.',
    expected: {
      goal: 'cleaning',
      location: {
        areas: ['kitchen', 'bathroom'],
      },
      timing: {
        urgency: 'scheduled',
        timeWindow: {
          start: '9am',
          end: '11am',
        },
      },
      actions: [
        {
          type: 'clean',
          evidence: 'clean',
        },
      ],
    },
  },

  {
    input: 'Move two chairs from the third floor with no elevator.',
    expected: {
      goal: 'moving',
      objects: [
        {
          type: 'chair',
          quantity: 2,
          description: 'two chairs',
        },
      ],
      location: {
        floor: 3,
      },
      access: {
        elevatorAvailable: false,
      },
      actions: [
        {
          type: 'move',
          object: 'chair',
          quantity: 2,
          evidence: 'move',
        },
      ],
    },
  },

  {
    input: 'Walk three dogs tomorrow between 7am and 8am.',
    expected: {
      goal: 'pet care',
      objects: [
        {
          type: 'pet',
          quantity: 3,
          description: 'three dogs',
        },
      ],
      timing: {
        urgency: 'scheduled',
        dayReference: 'tomorrow',
        timeWindow: {
          start: '7am',
          end: '8am',
        },
      },
      actions: [
        {
          type: 'walk',
          object: 'dog',
          quantity: 3,
          evidence: 'walk',
        },
      ],
    },
  },
];

let failures = 0;
for (const testCase of cases) {
  const actual = buildTaskFacts(testCase.input);
  try { assert.deepStrictEqual(actual, testCase.expected); }
  catch (error) { failures += 1; console.error(`- ${testCase.input}`, error); }
}
if (failures > 0) { console.error(`Task fact adversarial failures: ${failures}/${cases.length}`); process.exitCode = 1; }
else console.log(`Task fact adversarial cases passed: ${cases.length}/${cases.length}`);
