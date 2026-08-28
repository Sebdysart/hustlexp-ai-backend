/** Squad lifecycle, membership, and multi-worker task routes. */
import { router } from '../trpc.js';
import { squadLifecycleProcedures } from './squadLifecycleRoutes.js';
import { squadMembershipProcedures } from './squadMembershipRoutes.js';
import { squadTaskCreateProcedures } from './squadTaskCreateRoute.js';
import { squadTaskParticipationProcedures } from './squadTaskParticipationRoutes.js';
import { squadTaskReadProcedures } from './squadTaskReadRoutes.js';

export const squadRouter = router({
  ...squadLifecycleProcedures,
  ...squadMembershipProcedures,
  ...squadTaskCreateProcedures,
  ...squadTaskReadProcedures,
  ...squadTaskParticipationProcedures,
});

export type SquadRouter = typeof squadRouter;
