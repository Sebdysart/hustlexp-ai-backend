import { getKnownIntakeQuestionKeys, getQuestionsForIntake } from './definitions.js';
import type { IntakeAnswers, IntakeProfile, TaskCategory } from './types.js';

export function sanitizeIntakeAnswers(
  category: TaskCategory,
  answers: IntakeAnswers,
  secondaryIntents: readonly TaskCategory[] = [],
  profile: IntakeProfile | null = null,
): IntakeAnswers {
  const allowed = new Set(getQuestionsForIntake(category, secondaryIntents, profile).map((question) => question.key));
  const known = getKnownIntakeQuestionKeys();
  const sanitized: IntakeAnswers = {};
  for (const [key, value] of Object.entries(answers)) {
    if (!known.has(key) || allowed.has(key)) sanitized[key] = value;
  }
  if (sanitized.stairs !== true) delete sanitized.stair_flights;
  if (sanitized.large_items !== true) delete sanitized.large_item_details;
  delete sanitized.intake_profile;
  return sanitized;
}
