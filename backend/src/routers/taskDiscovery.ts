/** Task discovery, matching, explanation, search, and saved-search procedures. */
import { router } from '../trpc.js';
import { taskDiscoveryFeedProcedures } from './taskDiscoveryFeedRoutes.js';
import { taskDiscoverySearchProcedures } from './taskDiscoverySearchRoutes.js';

export const taskDiscoveryRouter = router({
  ...taskDiscoveryFeedProcedures,
  ...taskDiscoverySearchProcedures,
});
