import { buildTaskFacts } from './buildTaskFacts.js';
import type { TaskFacts } from './taskFacts.js';

export function getTaskFactsForDisplay(rawInput: unknown): TaskFacts | null {
  if (typeof rawInput !== 'string' || rawInput.trim().length === 0) {
    return null;
  }

  try {
    return buildTaskFacts(rawInput.trim());
  } catch (error) {
    console.error('[TaskFacts] Failed to build display facts.', error);
    return null;
  }
}
