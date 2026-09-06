/** Controlled recurring work plus read-only legacy recurrence evidence. */
import { router } from '../trpc.js';
import { recurringControlledProcedures } from './recurringControlledRoutes.js';
import { recurringSeriesProcedures } from './recurringSeriesRoutes.js';

// Contract-v1 series remain readable for migration and historical evidence, but
// their public writers must not compete with the controlled-v2 lifecycle.
const legacyRecurringEvidenceProcedures = {
  listMine: recurringSeriesProcedures.listMine,
  getById: recurringSeriesProcedures.getById,
  listOccurrences: recurringSeriesProcedures.listOccurrences,
};

export const recurringTaskRouter = router({
  ...recurringControlledProcedures,
  ...legacyRecurringEvidenceProcedures,
});

export type RecurringTaskRouter = typeof recurringTaskRouter;
