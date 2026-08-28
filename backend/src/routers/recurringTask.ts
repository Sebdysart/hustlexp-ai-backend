/** Controlled recurring work and legacy recurring series routes. */
import { router } from '../trpc.js';
import { recurringControlledProcedures } from './recurringControlledRoutes.js';
import { recurringSeriesProcedures } from './recurringSeriesRoutes.js';

export const recurringTaskRouter = router({
  ...recurringControlledProcedures,
  ...recurringSeriesProcedures,
});

export type RecurringTaskRouter = typeof recurringTaskRouter;
