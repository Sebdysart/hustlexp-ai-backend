import { extractActionFacts } from './extractActionFacts.js';
import { extractAreaFacts } from './extractAreaFacts.js';
import { extractConstraintFacts } from './extractConstraintFacts.js';
import { extractGoalFact } from './extractGoalFact.js';
import { extractNumericFacts } from './extractNumericFacts.js';
import { extractObjectFacts } from './extractObjectFacts.js';
import { extractResourceFacts } from './extractResourceFacts.js';
import { extractTimingFacts } from './extractTimingFacts.js';
import { resolveObjectReferences } from './resolveObjectReferences.js';
import type { TaskFacts } from './taskFacts.js';

function normalizeDurationMinutes(value: number, evidence: string): number {
  return /\b(?:hours?|hrs?)\b/i.test(evidence) ? value * 60 : value;
}

export function buildTaskFacts(input: string): TaskFacts {
  const numericFacts = extractNumericFacts(input);
  const objectFacts = extractObjectFacts(input);
  const objectReferences = resolveObjectReferences(input, objectFacts);
  const constraintFacts = extractConstraintFacts(input);
  const resourceFacts = extractResourceFacts(input);
  const timingFacts = extractTimingFacts(input);
  const goalFact = extractGoalFact(input);
  const areaFacts = extractAreaFacts(input);

  const facts: TaskFacts = {};


  if (objectFacts.length > 0) {
    facts.objects = objectFacts.map((objectFact) => ({
      type: objectFact.object,
      ...(objectFact.quantity === null
        ? {}
        : { quantity: objectFact.quantity }),
      description: objectFact.evidence,
    }));
  }

  const petNumericFacts = numericFacts.filter(
    (fact) => fact.role === 'pet_count',
  );

  if (petNumericFacts.length > 0) {
    facts.objects ??= [];
    facts.objects.push({
      type: 'pet',
      quantity: petNumericFacts.reduce(
        (total, fact) => total + fact.value,
        0,
      ),
      description: petNumericFacts
        .map((fact) => fact.evidence)
        .join(' + '),
    });
  }

  const floorFact = constraintFacts.find(
    (fact) => fact.type === 'floor_access',
  );

  if (typeof floorFact?.value === 'number') {
    facts.location = {
      ...facts.location,
      floor: floorFact.value,
    };
  }

  if (areaFacts.length > 0) {
    facts.location = {
      ...facts.location,
      areas: areaFacts.map((fact) => fact.area),
    };
  }

  const stairsFact = constraintFacts.find(
    (fact) => fact.type === 'stairs',
  );

  const stairFlightsFact = constraintFacts.find(
    (fact) => fact.type === 'stair_flights',
  );

  const elevatorAvailableFact = constraintFacts.find(
    (fact) => fact.type === 'elevator_available',
  );

  const noElevatorFact = constraintFacts.find(
    (fact) => fact.type === 'no_elevator',
  );

  const narrowAccessFact = constraintFacts.find(
    (fact) => fact.type === 'narrow_access',
  );

  if (
    stairsFact ||
    stairFlightsFact ||
    elevatorAvailableFact ||
    noElevatorFact ||
    narrowAccessFact
  ) {
    facts.access = {};

    if (typeof stairsFact?.value === 'boolean') {
      facts.access.stairs = stairsFact.value;
    }

    if (typeof stairFlightsFact?.value === 'number') {
      facts.access.stairFlights = stairFlightsFact.value;
    }

    if (elevatorAvailableFact?.value === true) {
      facts.access.elevatorAvailable = true;
    }

    if (noElevatorFact?.value === true) {
      facts.access.elevatorAvailable = false;
    }

    if (narrowAccessFact?.value === true) {
      facts.access.narrowAccess = true;
    }
  }

  const durationFact = numericFacts.find(
    (fact) => fact.role === 'duration',
  );

  const distanceFact = numericFacts.find(
    (fact) => fact.role === 'distance',
  );

  const weightFact = numericFacts.find(
    (fact) => fact.role === 'weight',
  );

  const dimensionFacts = numericFacts.filter(
    (fact) => fact.role === 'dimension',
  );

  if (
    durationFact ||
    distanceFact ||
    weightFact ||
    dimensionFacts.length > 0
  ) {
    facts.measurements = {};

    if (typeof durationFact?.value === 'number') {
      facts.measurements.durationMinutes = normalizeDurationMinutes(
        durationFact.value,
        durationFact.evidence,
      );
    }

    if (typeof distanceFact?.value === 'number') {
      facts.measurements.distanceMiles = distanceFact.value;
    }

    if (typeof weightFact?.value === 'number') {
      facts.measurements.weight = weightFact.value;
    }

    if (dimensionFacts.length > 0) {
      facts.measurements.dimensions = dimensionFacts.map(
        (fact) => fact.evidence,
      );
    }
  }

  const providedResources = resourceFacts
    .filter((fact) => fact.mode === 'provided')
    .map((fact) => fact.resource);

  const requiredResources = resourceFacts
    .filter((fact) => fact.mode === 'required')
    .map((fact) => fact.resource);

  if (providedResources.length > 0 || requiredResources.length > 0) {
    facts.resources = {};

    if (providedResources.length > 0) {
      facts.resources.provided = [...new Set(providedResources)];
    }

    if (requiredResources.length > 0) {
      facts.resources.required = [...new Set(requiredResources)];
    }
  }

  if (
    timingFacts.urgency ||
    timingFacts.dayReference ||
    timingFacts.timeWindow
  ) {
    facts.timing = timingFacts;
  }

  // Prevent measurements from being interpreted as quantities.
  if (facts.objects) {
    for (const object of facts.objects) {
      if (
        object.quantity !== undefined &&
        numericFacts.some(
          (fact) =>
            ['weight', 'duration', 'distance', 'dimension'].includes(
              fact.role,
            ) &&
            fact.value === object.quantity &&
            object.description
              ?.toLowerCase()
              .includes(String(object.quantity)),
        )
      ) {
        delete object.quantity;
      }
    }
  }

  const actionObjects = (facts.objects ?? []).map(
    (object) => ({
      object: object.type,
      quantity: object.quantity,
      evidence: object.description,
    }),
  );

  const actionFacts = extractActionFacts(
    input,
    actionObjects,
    objectReferences,
  );

  for (const action of actionFacts) {
    if (
      action.quantity !== undefined &&
      numericFacts.some(
        (fact) =>
          ['weight', 'duration', 'distance', 'dimension'].includes(
            fact.role,
          ) && fact.value === action.quantity,
      )
    ) {
      delete action.quantity;
    }
  }

  if (actionFacts.length > 0) {
    facts.actions = actionFacts;
    const goalByActionType: Partial<Record<(typeof actionFacts)[number]['type'], string>> = {
        move: 'moving', deliver: 'delivery', pickup: 'delivery', assemble: 'assembly',
        install: 'installation', mount: 'installation', clean: 'cleaning', remove: 'removal',
        haul: 'removal', repair: 'repair', walk: 'pet care', feed: 'pet care', watch: 'pet care',
      };
    const derivedGoal = goalByActionType[actionFacts[0].type];
    if (derivedGoal) facts.goal = derivedGoal;
  } else if (goalFact) {
    facts.goal = goalFact.goal;
  }

  return facts;
}
