import { buildTaskFacts } from './buildTaskFacts.js';
import { enrichTaskFactsForDisplay } from './enrichTaskFactsForDisplay.js';
import type { TaskFacts } from './taskFacts.js';

export function getTaskFactsForDisplay(options: {
  rawInput: unknown;
  category?: unknown;
  structured?: unknown;
}): TaskFacts | null {
  const { rawInput, category, structured } = options;
  if (typeof rawInput !== 'string' || rawInput.trim().length === 0) {
    return null;
  }

  try {
    return enrichTaskFactsForDisplay(buildTaskFacts(rawInput.trim()), structured, category);
  } catch (error) {
    console.error('[TaskFacts] Failed to build display facts.', error);
    return null;
  }
}
