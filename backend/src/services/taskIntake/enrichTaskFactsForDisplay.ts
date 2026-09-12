import type { TaskFacts } from './taskFacts.js';

type Answers = Record<string, unknown>;

function asAnswers(structured: unknown): Answers | null {
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return null;
  const answers = (structured as { answers?: unknown }).answers;
  return answers && typeof answers === 'object' && !Array.isArray(answers)
    ? answers as Answers
    : null;
}

function readable(value: string): string {
  return value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => readable(item));
}

function addUnique(target: string[], values: string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value);
}

export function enrichTaskFactsForDisplay(
  facts: TaskFacts,
  structured: unknown,
  _category?: unknown,
): TaskFacts {
  const answers = asAnswers(structured);
  if (!answers) return facts;

  const enriched: TaskFacts = { ...facts };
  const details = [...(facts.serviceDetails ?? [])];
  const resources = facts.resources ? { ...facts.resources } : {};

  for (const key of [
    'work_type', 'service_type', 'auto_service_type', 'cleaning_type',
    'assembly_type', 'delivery_item', 'task_goal', 'event_type',
  ]) {
    if (typeof answers[key] === 'string' && answers[key].trim()) {
      addUnique(details, [answers[key].trim()]);
    }
  }
  if (details.length) enriched.serviceDetails = details;

  const provided: string[] = [];
  const required: string[] = [];
  for (const key of ['required_tools']) addUnique(required, stringArray(answers[key]));
  for (const key of ['supplies_provided', 'equipment_provided', 'parts_provided']) {
    if (answers[key] === true) addUnique(provided, [readable(key.replace(/_provided$/, ''))]);
    if (answers[key] === false) addUnique(required, [readable(key.replace(/_provided$/, ''))]);
  }
  if (answers.materials_provided === true) addUnique(provided, ['materials']);
  if (answers.materials_provided === false) addUnique(required, ['materials']);
  if (provided.length) addUnique(resources.provided ??= [], provided);
  if (required.length) addUnique(resources.required ??= [], required);

  if (typeof answers.required_vehicle === 'string') {
    const vehicle = answers.required_vehicle.trim().toLowerCase();
    if (vehicle === 'none' || vehicle === 'no vehicle') resources.vehicleRequired = false;
    else if (vehicle) {
      resources.vehicleRequired ??= true;
      addUnique(resources.required ??= [], [vehicle]);
    }
  }
  if (typeof answers.vehicle_required === 'boolean') resources.vehicleRequired ??= answers.vehicle_required;
  if (Object.keys(resources).some((key) => (resources as Record<string, unknown>)[key] !== undefined)) enriched.resources = resources;

  const workerCount = Number(answers.required_worker_count);
  if (Number.isFinite(workerCount) && workerCount > 0) {
    enriched.staffing = { ...(facts.staffing ?? {}), workerCount: facts.staffing?.workerCount ?? workerCount };
  }

  if (typeof answers.preferred_window === 'string' && answers.preferred_window.trim()) {
    enriched.timing = { ...(facts.timing ?? {}), preference: facts.timing?.preference ?? readable(answers.preferred_window) };
  }

  return enriched;
}
