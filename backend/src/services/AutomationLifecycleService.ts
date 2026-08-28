import { AutomationLifecycleReadService } from './AutomationLifecycleReadService.js';
import { DispatchExpiryService } from './DispatchExpiryService.js';

export * from './AutomationLifecycleReadService.js';
export * from './DispatchExpiryService.js';

/** Stable facade used by the router and scheduler. */
export const AutomationLifecycleService = {
  ...AutomationLifecycleReadService,
  ...DispatchExpiryService,
};

export default AutomationLifecycleService;
