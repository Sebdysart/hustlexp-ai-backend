/** Participant safety intake and Operations incident management routes. */
import { router } from '../trpc.js';
import { incidentAdminProcedures } from './incidentAdminRoutes.js';
import { incidentSafetyProcedures } from './incidentSafetyRoutes.js';

export const incidentsRouter = router({
  ...incidentSafetyProcedures,
  ...incidentAdminProcedures,
});

export default incidentsRouter;
