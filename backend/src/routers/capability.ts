/** Capability profile, eligibility, credential, and worker-screening routes. */
import { router } from '../trpc.js';
import { capabilityCoreProcedures } from './capabilityCoreRoutes.js';
import { capabilityScreeningProcedures } from './capabilityScreeningRoutes.js';
import { capabilityWorkerStandingProcedures } from './capabilityWorkerStandingRoutes.js';

export const capabilityRouter = router({
  ...capabilityCoreProcedures,
  ...capabilityScreeningProcedures,
  ...capabilityWorkerStandingProcedures,
});

export default capabilityRouter;
