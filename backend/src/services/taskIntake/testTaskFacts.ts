import assert from 'node:assert/strict';

import { buildTaskFacts } from './buildTaskFacts.js';
import type { TaskFacts } from './taskFacts.js';

const CASES: Array<{
  input: string;
  expected: TaskFacts;
}> = [
  {
    input: 'Move a 200 pound dresser.',
    expected: {
      goal: 'moving',
      actions: [
        {
          type: 'move',
          object: 'dresser',
          evidence: 'move',
        },
      ],
      objects: [
        {
          type: 'dresser',
          description: '200 pound dresser',
        },
      ],
      measurements: {
        weight: 200,
      },
    },
  },
  {
    input: 'Need someone with a truck tomorrow.',
    expected: {
      resources: {
        required: ['truck'],
      },
      timing: {
        urgency: 'scheduled',
        dayReference: 'tomorrow',
      },
    },
  },
  {
    input: 'Move a sofa with no elevator.',
    expected: {
      goal: 'moving',
      actions: [
        {
          type: 'move',
          object: 'couch',
          evidence: 'move',
        },
      ],
      objects: [
        {
          type: 'couch',
          description: 'sofa',
        },
      ],
      access: {
        elevatorAvailable: false,
      },
    },
  },
  {
    input: 'Work can only happen between 9am and 11am.',
    expected: {
      timing: {
        urgency: 'scheduled',
        timeWindow: {
          start: '9am',
          end: '11am',
        },
      },
    },
  },
  {
    input: 'Move two couches up three flights.',
    expected: {
      goal: 'moving',
      actions: [
        {
          type: 'move',
          object: 'couch',
          quantity: 2,
          evidence: 'move',
        },
      ],
      objects: [
        {
          type: 'couch',
          quantity: 2,
          description: 'two couches',
        },
      ],
      access: {
        stairs: true,
        stairFlights: 3,
      },
    },
  },
  {
    input: 'Deliver a fragile mirror.',
    expected: {
      goal: 'delivery',
      actions: [
        {
          type: 'deliver',
          object: 'mirror',
          evidence: 'deliver',
        },
      ],
      objects: [
        {
          type: 'mirror',
          description: 'mirror',
        },
      ],
    },
  },
  {
    input: 'Move a piano from the second floor.',
    expected: {
      goal: 'moving',
      actions: [
        {
          type: 'move',
          object: 'piano',
          evidence: 'move',
        },
      ],
      objects: [
        {
          type: 'piano',
          description: 'piano',
        },
      ],
      location: {
        floor: 2,
      },
    },
  },
  {
    input: 'Move furniture through a narrow hallway.',
    expected: {
      goal: 'moving',
      location: { areas: ['hallway'] },
      actions: [
        {
          type: 'move',
          evidence: 'move',
        },
      ],
      access: {
        narrowAccess: true,
      },
    },
  },
  {
    input: 'Pick up a couch 15 miles away.',
    expected: {
      goal: 'delivery',
      actions: [
        {
          type: 'pickup',
          object: 'couch',
          evidence: 'pick up',
        },
      ],
      objects: [
        {
          type: 'couch',
          description: 'couch',
        },
      ],
      measurements: {
        distanceMiles: 15,
      },
    },
  },
  {
    input: 'Carry a cabinet through a 30 inch doorway.',
    expected: {
      goal: 'moving',
      actions: [
        {
          type: 'move',
          object: 'cabinet',
          evidence: 'carry',
        },
      ],
      objects: [
        {
          type: 'cabinet',
          description: 'cabinet',
        },
      ],
      measurements: {
        dimensions: ['30 inch'],
      },
    },
  },
  {
    input: 'Bring two chairs upstairs.',
    expected: {
      goal: 'delivery',
      actions: [
        {
          type: 'deliver',
          object: 'chair',
          quantity: 2,
          evidence: 'bring',
        },
      ],
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
    },
  },
  {
    input: 'I have a rake here for you.',
    expected: {
      resources: {
        provided: ['rake'],
      },
    },
  },
  {
    input: 'Please bring your own ladder.',
    expected: {
      resources: {
        required: ['ladder'],
      },
    },
  },
  {
    input: 'Need help ASAP.',
    expected: {
      timing: {
        urgency: 'asap',
      },
    },
  },
  {
    input: 'Pick it up today.',
    expected: {
      timing: {
        urgency: 'scheduled',
        dayReference: 'today',
      },
    },
  },
  {
    input: 'Deliver three shelves and install them.',
    expected: {
      goal: 'delivery',
      actions: [
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
      objects: [
        {
          type: 'shelf',
          quantity: 3,
          description: 'three shelves',
        },
      ],
    },
  },
  {
    input: 'Move a couch and mount a TV.',
    expected: {
      goal: 'moving',
      actions: [
        {
          type: 'move',
          object: 'couch',
          evidence: 'move',
        },
        {
          type: 'mount',
          object: 'tv',
          evidence: 'mount',
        },
      ],
      objects: [
        {
          type: 'couch',
          description: 'couch',
        },
        {
          type: 'tv',
          description: 'tv',
        },
      ],
    },
  },
  {
    input: 'Walk three dogs and feed them.',
    expected: {
      goal: 'pet care',
      actions: [
        {
          type: 'walk',
          object: 'dog',
          quantity: 3,
          evidence: 'walk',
        },
        {
          type: 'feed',
          object: 'dog',
          quantity: 3,
          evidence: 'feed',
        },
      ],
      objects: [
        {
          type: 'pet',
          quantity: 3,
          description: 'three dogs',
        },
      ],
    },
  },
  {
    input: 'Pick up a refrigerator and install it.',
    expected: {
      goal: 'delivery',
      actions: [
        {
          type: 'pickup',
          object: 'refrigerator',
          evidence: 'pick up',
        },
        {
          type: 'install',
          object: 'refrigerator',
          evidence: 'install',
        },
      ],
      objects: [
        {
          type: 'refrigerator',
          description: 'refrigerator',
        },
      ],
    },
  },
  {
    input: 'Clean the kitchen and bathroom.',
    expected: { goal: 'cleaning', actions: [{ type: 'clean', evidence: 'clean' }], location: { areas: ['kitchen', 'bathroom'] } },
  },
  {
    input: 'Clean the kitchen and downstairs bathroom.',
    expected: { goal: 'cleaning', actions: [{ type: 'clean', evidence: 'clean' }], location: { areas: ['kitchen', 'bathroom'] } },
  },
  {
    input: 'Move a couch from the garage.',
    expected: { goal: 'moving', objects: [{ type: 'couch', description: 'couch' }], location: { areas: ['garage'] }, actions: [{ type: 'move', object: 'couch', evidence: 'move' }] },
  },
  {
    input: 'Install shelves in the kitchen.',
    expected: { goal: 'installation', objects: [{ type: 'shelf', description: 'shelves' }], location: { areas: ['kitchen'] }, actions: [{ type: 'install', object: 'shelf', evidence: 'install' }] },
  },
  {
    input: 'Vacuum the living room, hallway, and bedroom.',
    expected: { goal: 'cleaning', location: { areas: ['living room', 'hallway', 'bedroom'] }, actions: [{ type: 'clean', evidence: 'vacuum' }] },
  },
];

const failures: string[] = [];

for (const testCase of CASES) {
  const actual = buildTaskFacts(testCase.input);

  try {
    assert.deepEqual(actual, testCase.expected);
  } catch (error) {
    failures.push(
      [
        testCase.input,
        `expected=${JSON.stringify(testCase.expected)}`,
        `actual=${JSON.stringify(actual)}`,
        error instanceof Error ? error.message : String(error),
      ].join(' | '),
    );
  }
}

if (failures.length > 0) {
  console.error(`Task fact failures: ${failures.length}/${CASES.length}`);

  for (const failure of failures) {
    console.error(`- ${failure}`);
  }

  process.exitCode = 1;
} else {
  console.log(`Task fact cases passed: ${CASES.length}/${CASES.length}`);
}
